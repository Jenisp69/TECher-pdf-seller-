/* ==========================================================
   ThinkAhead student Quiz (works with 7-quiz.sql)

   How it talks to the database: students have no Supabase sign-in (they log in with a token),
   so every call goes through a checked database function that receives the student's id +
   login token (quiz_list, quiz_submit_answer). Nothing here touches a table directly.

   The server decides if an answer is correct and how many points it earns. This file only
   shows what the server says. Nothing about answers or scores is kept in localStorage or
   sessionStorage (the only thing read from sessionStorage is the login token).

   auth.js calls QuizModule.attach(student) when a student is logged in and
   QuizModule.detach() when nobody is.
   ========================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    student: null,
    questions: [],
    total: 0,
    answeredCount: 0,
    tab: 'todo',
    loading: false,
    loaded: false,
    open: false,
    wired: false,
    picked: {},          // question id -> option number chosen but not submitted yet (screen only)
    sending: new Set(),  // question ids being submitted right now
    expiredShown: false
  };

  const MESSAGES = {
    network: "Couldn't reach the server. Check your internet and try again.",
    not_available: 'This question is no longer available.',
    not_found: 'This question is no longer available.',
    invalid_option: 'That option is not valid. Please pick one of the options shown.',
    invalid: 'Please choose an option first.'
  };

  /* ---------------- helpers ---------------- */
  function activeStudent() {
    return (typeof currentStudentUser !== 'undefined' && currentStudentUser) || state.student;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  const letter = (n) => String.fromCharCode(64 + Number(n));

  function sessionExpired() {
    if (state.expiredShown) return;
    state.expiredShown = true;
    alert('Your login has ended. Please log in again.');
    sessionStorage.clear();
    window.location.reload();
  }

  async function rpc(fn, args) {
    const s = activeStudent();
    if (!s) return { ok: false, error: 'network' };
    const token = sessionStorage.getItem('sessionToken') || s.active_session_token || '';
    try {
      const { data, error } = await supabaseClient.rpc(fn, Object.assign({ p_id: s.id, p_token: token }, args || {}));
      if (error || !data) return { ok: false, error: 'network' };
      if (data.ok !== true && data.error === 'bad_token') sessionExpired();
      return data;
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  function setStatus(message, kind) {
    const box = $('qz-status');
    if (!box) return;
    box.textContent = message || '';
    box.className = 'qz-status' + (message ? ' is-visible' : '') + (kind === 'err' ? ' is-error' : '');
  }

  /* ---------------- scores ---------------- */
  function renderScore() {
    const pts = String(state.total);
    const a = $('qz-points');
    if (a) a.textContent = pts;
    const b = $('qz-entry-points');
    if (b) b.textContent = pts;
    const pill = $('qz-entry-score');
    if (pill) pill.hidden = !state.loaded;
    const sub = $('qz-entry-sub');
    if (sub && state.loaded) {
      const open = state.questions.filter((q) => !q.answer).length;
      sub.textContent = state.questions.length === 0
        ? 'No questions yet. Check back soon.'
        : (open > 0 ? open + ' question' + (open === 1 ? '' : 's') + ' waiting for you.' : 'You have answered every question. Great job!');
    }
  }

  function renderTabs() {
    const todo = state.questions.filter((q) => !q.answer).length;
    const done = state.questions.length - todo;
    $('qz-count-todo').textContent = String(todo);
    $('qz-count-done').textContent = String(done);
    const tabs = { todo: $('qz-tab-todo'), done: $('qz-tab-done') };
    Object.keys(tabs).forEach((k) => {
      tabs[k].classList.toggle('active', state.tab === k);
      tabs[k].setAttribute('aria-selected', state.tab === k ? 'true' : 'false');
    });
  }

  /* ---------------- question cards ---------------- */
  function buildCard(q) {
    const card = el('article', 'qz-card');
    card.dataset.qid = q.id;
    const answered = !!q.answer;
    if (answered) card.classList.add('is-answered', q.answer.is_correct ? 'is-right' : 'is-wrong');

    const meta = el('div', 'qz-meta');
    meta.appendChild(el('span', 'qz-chip qz-chip-points', q.points + (q.points === 1 ? ' point' : ' points')));
    meta.appendChild(el('span', 'qz-chip', q.subject_name || 'General'));
    card.appendChild(meta);

    card.appendChild(el('p', 'qz-question', q.text));

    const group = el('div', 'qz-options');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Answer options');
    const picked = answered ? q.answer.selected_option_no : state.picked[q.id];
    const sending = state.sending.has(q.id);

    (q.options || []).forEach((o) => {
      const btn = el('button', 'qz-opt');
      btn.type = 'button';
      btn.dataset.no = String(o.option_no);
      btn.setAttribute('role', 'radio');
      btn.appendChild(el('span', 'qz-letter', letter(o.option_no)));
      btn.appendChild(el('span', 'qz-opt-text', o.text));
      const mark = el('span', 'qz-opt-mark');
      mark.setAttribute('aria-hidden', 'true');
      btn.appendChild(mark);

      const isPicked = picked === o.option_no;
      btn.setAttribute('aria-checked', isPicked ? 'true' : 'false');

      if (answered) {
        btn.disabled = true;
        if (isPicked && q.answer.is_correct) {
          btn.classList.add('is-correct');
          mark.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
        } else if (isPicked) {
          btn.classList.add('is-wrong');
          mark.innerHTML = '<i class="fa-solid fa-circle-xmark"></i>';
        } else if (o.option_no === q.answer.correct_option_no) {
          btn.classList.add('is-reveal');
          mark.innerHTML = '<i class="fa-solid fa-check"></i>';
          btn.appendChild(el('span', 'qz-reveal-tag', 'Correct answer'));
        }
      } else {
        if (isPicked) btn.classList.add('is-picked');
        btn.disabled = sending;
        btn.addEventListener('click', () => {
          state.picked[q.id] = o.option_no;
          refreshCard(q.id);
        });
      }
      group.appendChild(btn);
    });
    card.appendChild(group);

    if (answered) {
      const result = el('div', 'qz-result ' + (q.answer.is_correct ? 'is-right' : 'is-wrong'));
      result.setAttribute('role', 'status');
      result.textContent = q.answer.is_correct
        ? 'Correct! +' + q.answer.points_earned + (q.answer.points_earned === 1 ? ' point' : ' points')
        : 'Incorrect. 0 points. The correct answer is highlighted.';
      if (q.note) result.appendChild(el('span', 'qz-result-note', q.note));
      card.appendChild(result);
    } else {
      const foot = el('div', 'qz-foot');
      const msg = el('p', 'qz-msg');
      msg.setAttribute('aria-live', 'polite');
      if (q.error) msg.textContent = q.error;
      const submit = el('button', 'btn-primary-glass qz-submit', sending ? 'Checking…' : 'Submit answer');
      submit.type = 'button';
      submit.disabled = sending || !picked;
      if (sending) submit.setAttribute('aria-busy', 'true');
      submit.addEventListener('click', () => submitAnswer(q.id));
      foot.appendChild(msg);
      foot.appendChild(submit);
      card.appendChild(foot);
    }
    return card;
  }

  // Redraw ONE card in place (so a card you just answered stays on screen until you switch tabs)
  function refreshCard(id) {
    const q = state.questions.find((x) => x.id === id);
    const old = document.querySelector('.qz-card[data-qid="' + id + '"]');
    if (!q || !old) return;
    old.replaceWith(buildCard(q));
  }

  function renderList() {
    const list = $('qz-list');
    if (!list) return;
    list.textContent = '';
    renderTabs();

    const items = state.questions.filter((q) => (state.tab === 'todo' ? !q.answer : !!q.answer));
    if (!items.length) {
      let text;
      if (state.questions.length === 0) text = 'No quiz questions yet. Check back soon.';
      else if (state.tab === 'todo') text = "You're all caught up! You have answered every available question.";
      else text = "You haven't answered any questions yet.";
      list.appendChild(el('div', 'qz-empty', text));
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((q) => frag.appendChild(buildCard(q)));
    list.appendChild(frag);
  }

  /* ---------------- talking to the database ---------------- */
  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) setStatus('Loading questions…');
    const res = await rpc('quiz_list');
    state.loading = false;

    if (res && res.ok === true) {
      state.questions = res.questions || [];
      state.total = Number(res.total_points) || 0;
      state.answeredCount = Number(res.answered_count) || 0;
      state.loaded = true;
      setStatus('');
    } else if (!silent) {
      setStatus(MESSAGES[res && res.error] || MESSAGES.network, 'err');
    }
    renderScore();
    if (state.open) renderList();
  }

  async function submitAnswer(id) {
    const q = state.questions.find((x) => x.id === id);
    const option = state.picked[id];
    if (!q || q.answer || !option || state.sending.has(id)) return;

    q.error = '';
    state.sending.add(id);
    refreshCard(id);

    const res = await rpc('quiz_submit_answer', { p_question_id: id, p_option_no: option });
    state.sending.delete(id);

    if (res && res.ok === true) {
      q.answer = {
        selected_option_no: res.selected_option_no,
        is_correct: res.is_correct,
        points_earned: res.points_earned,
        correct_option_no: res.correct_option_no
      };
      if (res.already_answered) q.note = 'You had already answered this question, so your first answer is kept.';
      delete state.picked[id];
      state.total = Number(res.total_points) || 0;
      state.answeredCount = state.questions.filter((x) => x.answer).length;
      renderScore();
      renderTabs();
      refreshCard(id);
      return;
    }

    const code = res && res.error;
    q.error = MESSAGES[code] || MESSAGES.network;
    refreshCard(id);
    if (code === 'not_available' || code === 'not_found') load(true);   // it was archived: refresh the list
  }

  /* ---------------- open / close the Quiz screen ---------------- */
  function openQuiz() {
    if (!activeStudent()) return;
    state.open = true;
    $('homepage-section')?.classList.add('hidden');
    $('quiz-section')?.classList.remove('hidden');
    window.scrollTo(0, 0);
    renderList();
    load(false);              // always fetch fresh, so new questions appear
  }

  function closeQuiz() {
    state.open = false;
    $('quiz-section')?.classList.add('hidden');
    $('homepage-section')?.classList.remove('hidden');
    window.scrollTo(0, 0);
    renderScore();
  }

  function setTab(name) {
    state.tab = name;
    renderList();
  }

  /* ---------------- wiring (once) ---------------- */
  function wire() {
    if (state.wired) return;
    if (!$('quiz-section') || !$('qz-open-btn')) return;
    state.wired = true;
    $('qz-open-btn').addEventListener('click', openQuiz);
    $('quiz-back-btn').addEventListener('click', closeQuiz);
    $('qz-tab-todo').addEventListener('click', () => setTab('todo'));
    $('qz-tab-done').addEventListener('click', () => setTab('done'));
  }

  /* ---------------- public API (used by auth.js) ---------------- */
  window.QuizModule = {
    attach(student) {
      wire();
      if (!student) return;
      const same = state.student && state.student.id === student.id;
      state.student = student;
      if (!same) {
        state.questions = []; state.total = 0; state.answeredCount = 0;
        state.loaded = false; state.picked = {}; state.tab = 'todo';
      }
      $('quiz-entry-section')?.classList.remove('hidden');
      if (!state.loaded) load(true);          // quietly fetch the score for the entry card
    },
    detach() {
      if (state.open) closeQuiz();
      state.student = null; state.questions = []; state.total = 0; state.answeredCount = 0;
      state.loaded = false; state.picked = {};
      $('quiz-entry-section')?.classList.add('hidden');
    }
  };
})();
