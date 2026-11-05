/* ==========================================================
   ThinkAhead teacher dashboard: Quiz questions + student scores (works with 7-quiz.sql)

   Every call goes through a database function that checks the teacher's sign-in itself
   (is_admin()), so nothing here can be used by anyone who is not signed in as the teacher.
   Question and option text is always put on the page with textContent (never innerHTML),
   so nothing a teacher types can run as code.

   admin.js calls AdminQuiz.init() once, after the teacher has signed in.
   ========================================================== */
(function () {
  'use strict';

  const OPTION_COUNT = 4;   // keep in step with c_min / c_max inside _quiz_check_options (7-quiz.sql)

  const $ = (id) => document.getElementById(id);

  const state = {
    questions: [],
    students: [],
    editing: null,        // the question being edited, or null when creating
    showArchived: false,
    started: false,
    detailsOpen: new Set()
  };

  const ERRORS = {
    not_admin: 'Please sign in as the teacher again.',
    invalid_text: 'The question must be 1 to 1000 characters.',
    invalid_points: 'Points must be a whole number from 1 to 1000.',
    invalid_options: 'The options are not valid.',
    option_count: 'A question needs exactly ' + OPTION_COUNT + ' options.',
    invalid_option_text: 'Each option must be 1 to 300 characters.',
    duplicate_option: 'Two options are the same. Make every option different.',
    invalid_correct: 'Tick which option is the correct one.',
    invalid_subject: 'That subject no longer exists. Pick another one, or General.',
    not_found: 'That question no longer exists. Refresh the list.',
    locked_correct_option: 'Students have already answered this question, so the correct option is locked.',
    locked_points: 'Students have already answered this question, so the points are locked.',
    locked_options: 'Students have already answered this question, so the number of options is locked.'
  };

  const letter = (n) => String.fromCharCode(64 + Number(n));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  async function call(fn, args) {
    try {
      const { data, error } = await supabaseClient.rpc(fn, args || {});
      if (error) {
        const missing = /could not find the function|schema cache/i.test(error.message || '');
        return { ok: false, error: missing ? 'missing' : 'network', message: error.message };
      }
      return data || { ok: false, error: 'network' };
    } catch (e) {
      return { ok: false, error: 'network', message: String((e && e.message) || e) };
    }
  }

  function say(res) {
    if (res && res.error === 'missing') return 'The quiz database part is not installed yet. Run 7-quiz.sql in Supabase first.';
    if (res && res.error === 'network') return "Couldn't reach the server. Check your internet and try again.";
    return ERRORS[res && res.error] || 'Something went wrong. Please try again.';
  }

  /* ---------------- the form ---------------- */
  function buildOptionRows() {
    const box = $('aq-options');
    box.textContent = '';
    for (let i = 1; i <= OPTION_COUNT; i++) {
      const row = el('div', 'aq-option-row');

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'aq-correct';
      radio.value = String(i);
      radio.id = 'aq-correct-' + i;
      radio.setAttribute('aria-label', 'Option ' + letter(i) + ' is the correct answer');

      const badge = el('span', 'aq-letter', letter(i));

      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'aq-opt-' + i;
      input.maxLength = 300;
      input.autocomplete = 'off';
      input.placeholder = 'Option ' + letter(i);
      input.setAttribute('aria-label', 'Option ' + letter(i) + ' text');

      row.appendChild(radio);
      row.appendChild(badge);
      row.appendChild(input);
      box.appendChild(row);
    }
  }

  function fillSubjects(selected) {
    const select = $('aq-subject');
    select.textContent = '';
    const general = document.createElement('option');
    general.value = '';
    general.textContent = 'General (no subject)';
    select.appendChild(general);

    const subjects = (typeof globalSubjects !== 'undefined' && Array.isArray(globalSubjects)) ? globalSubjects : [];
    const streams = (typeof globalStreams !== 'undefined' && Array.isArray(globalStreams)) ? globalStreams : [];
    subjects.forEach((s) => {
      const stream = streams.find((x) => x.id === s.stream_id);
      const parts = [];
      if (stream) parts.push(stream.stream_name);
      if (s.semester) parts.push(s.semester + ' sem');
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.subject_name + (parts.length ? ' (' + parts.join(' · ') + ')' : '');
      select.appendChild(opt);
    });
    select.value = selected || '';
  }

  function setFormError(message, ok) {
    const box = $('aq-form-error');
    box.textContent = message || '';
    box.classList.toggle('is-ok', !!ok);
  }

  function readForm() {
    const options = [];
    for (let i = 1; i <= OPTION_COUNT; i++) options.push($('aq-opt-' + i).value.trim());
    const checked = document.querySelector('input[name="aq-correct"]:checked');
    return {
      text: $('aq-text').value.trim(),
      points: Number($('aq-points').value),
      subject: $('aq-subject').value,
      options,
      correct: checked ? Number(checked.value) : 0
    };
  }

  function checkForm(f) {
    if (!f.text) return 'Type the question first.';
    if (f.options.some((o) => !o)) return 'Fill in all ' + OPTION_COUNT + ' options.';
    const lowered = f.options.map((o) => o.toLowerCase().replace(/\s+/g, ' '));
    if (new Set(lowered).size !== lowered.length) return ERRORS.duplicate_option;
    if (!f.correct) return ERRORS.invalid_correct;
    if (!Number.isInteger(f.points) || f.points < 1 || f.points > 1000) return ERRORS.invalid_points;
    return '';
  }

  function resetForm() {
    state.editing = null;
    $('aq-form').reset();
    $('aq-points').value = '1';
    fillSubjects('');
    $('aq-form-title').textContent = 'New question';
    $('aq-save-btn').textContent = 'Save question';
    $('aq-cancel-btn').classList.add('hidden');
    $('aq-lock-note').classList.add('hidden');
    $('aq-points').disabled = false;
    document.querySelectorAll('input[name="aq-correct"]').forEach((r) => { r.disabled = false; });
  }

  function startEdit(q) {
    state.editing = q;
    setFormError('');
    fillSubjects(q.subject_id || '');
    $('aq-text').value = q.text;
    $('aq-points').value = String(q.points);
    (q.options || []).forEach((o) => {
      const input = $('aq-opt-' + o.option_no);
      if (input) input.value = o.text;
    });
    const radio = $('aq-correct-' + q.correct_option_no);
    if (radio) radio.checked = true;

    const locked = q.attempts > 0;
    $('aq-points').disabled = locked;
    document.querySelectorAll('input[name="aq-correct"]').forEach((r) => { r.disabled = locked; });
    $('aq-lock-note').classList.toggle('hidden', !locked);

    $('aq-form-title').textContent = 'Edit question';
    $('aq-save-btn').textContent = 'Save changes';
    $('aq-cancel-btn').classList.remove('hidden');
    $('aq-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('aq-text').focus();
  }

  async function onSubmit(event) {
    event.preventDefault();
    const f = readForm();
    const problem = checkForm(f);
    setFormError(problem);
    if (problem) return;

    const btn = $('aq-save-btn');
    const idleText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const args = {
      p_text: f.text,
      p_points: f.points,
      p_subject_id: f.subject || null,
      p_options: f.options,
      p_correct_option_no: f.correct
    };
    const res = state.editing
      ? await call('admin_quiz_update_question', Object.assign({ p_question_id: state.editing.id }, args))
      : await call('admin_quiz_create_question', args);

    btn.disabled = false;
    btn.textContent = idleText;

    if (res.ok === true) {
      const wasEditing = !!state.editing;
      resetForm();
      setFormError(wasEditing ? 'Question updated.' : 'Question saved.', true);
      await loadQuestions();
    } else {
      setFormError(say(res));
    }
  }

  /* ---------------- question list ---------------- */
  async function loadQuestions() {
    const box = $('aq-list');
    if (!state.questions.length) box.textContent = 'Loading…';
    const res = await call('admin_quiz_list');
    if (res.ok !== true) {
      box.textContent = '';
      box.appendChild(el('p', 'aq-empty is-error', say(res)));
      return;
    }
    state.questions = res.questions || [];
    renderQuestions();
  }

  function renderQuestions() {
    const box = $('aq-list');
    box.textContent = '';
    const items = state.questions.filter((q) => state.showArchived || !q.archived);
    if (!items.length) {
      box.appendChild(el('p', 'aq-empty', state.questions.length
        ? 'No active questions. Tick "Show archived" to see archived ones.'
        : 'No questions yet. Create the first one above.'));
      return;
    }
    items.forEach((q) => box.appendChild(questionCard(q)));
  }

  function questionCard(q) {
    const locked = q.attempts > 0;
    const card = el('div', 'aq-card' + (q.archived ? ' is-archived' : ''));

    const head = el('div', 'aq-card-head');
    head.appendChild(el('div', 'aq-card-text', q.text));
    const badges = el('div', 'aq-badges');
    if (q.archived) badges.appendChild(el('span', 'aq-badge aq-badge-arch', 'Archived'));
    if (locked) badges.appendChild(el('span', 'aq-badge aq-badge-lock', 'Locked'));
    head.appendChild(badges);
    card.appendChild(head);

    const meta = el('div', 'aq-meta');
    meta.appendChild(el('span', '', q.points + (q.points === 1 ? ' point' : ' points')));
    meta.appendChild(el('span', '', q.subject_name || 'General'));
    meta.appendChild(el('span', '', q.attempts + (q.attempts === 1 ? ' attempt' : ' attempts') +
      (q.attempts ? ' (' + q.correct_attempts + ' correct)' : '')));
    card.appendChild(meta);

    const list = el('ol', 'aq-opts');
    (q.options || []).forEach((o) => {
      const li = el('li', o.option_no === q.correct_option_no ? 'is-correct' : '');
      li.appendChild(el('b', '', letter(o.option_no) + '.'));
      li.appendChild(el('span', 'aq-opt-text', o.text));
      if (o.option_no === q.correct_option_no) li.appendChild(el('span', 'aq-tick', '✓ correct'));
      if (q.attempts) li.appendChild(el('span', 'aq-picks', o.picks + ' picked'));
      list.appendChild(li);
    });
    card.appendChild(list);

    const actions = el('div', 'aq-card-actions');
    const edit = el('button', 'aq-btn-sm', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => startEdit(q));
    const arch = el('button', 'aq-btn-sm' + (q.archived ? '' : ' aq-btn-danger'), q.archived ? 'Restore' : 'Archive');
    arch.type = 'button';
    arch.addEventListener('click', () => toggleArchive(q, arch));
    actions.appendChild(edit);
    actions.appendChild(arch);
    card.appendChild(actions);
    return card;
  }

  async function toggleArchive(q, button) {
    if (!q.archived && !confirm('Archive this question?\n\nStudents will no longer see it. All answers and scores are kept, and you can restore it any time.')) return;
    button.disabled = true;
    const res = await call('admin_quiz_set_archived', { p_question_id: q.id, p_archived: !q.archived });
    if (res.ok !== true) {
      button.disabled = false;
      alert(say(res));
      return;
    }
    if (state.editing && state.editing.id === q.id) resetForm();
    await loadQuestions();
    loadScores();
  }

  /* ---------------- student scores ---------------- */
  async function loadScores() {
    const box = $('aq-scores');
    if (!state.students.length) box.textContent = 'Loading…';
    const res = await call('admin_quiz_student_scores');
    if (res.ok !== true) {
      box.textContent = '';
      box.appendChild(el('p', 'aq-empty is-error', say(res)));
      return;
    }
    state.students = res.students || [];
    renderScores();
  }

  function renderScores() {
    const box = $('aq-scores');
    box.textContent = '';
    const term = ($('aq-score-search').value || '').trim().toLowerCase();
    const items = state.students.filter((s) =>
      !term || (s.full_name || '').toLowerCase().includes(term) || (s.username || '').toLowerCase().includes(term));

    if (!items.length) {
      box.appendChild(el('p', 'aq-empty', state.students.length ? 'No student matches your search.' : 'No students yet.'));
      return;
    }

    items.forEach((s) => {
      const row = el('div', 'aq-score-row');
      const line = el('div', 'aq-score-line');

      const who = el('div', 'aq-score-who');
      who.appendChild(el('b', '', s.full_name));
      who.appendChild(el('span', 'aq-muted', '@' + s.username));
      line.appendChild(who);

      line.appendChild(el('div', 'aq-score-num',
        s.points + ' pts · ' + s.correct + '/' + s.answered + ' correct'));

      const btn = el('button', 'aq-btn-sm', state.detailsOpen.has(s.student_id) ? 'Hide' : 'Details');
      btn.type = 'button';
      btn.disabled = s.answered === 0;
      btn.addEventListener('click', () => toggleDetails(s, row, btn));
      line.appendChild(btn);
      row.appendChild(line);

      if (state.detailsOpen.has(s.student_id)) fillDetails(s, row);
      box.appendChild(row);
    });
  }

  async function toggleDetails(student, row, button) {
    if (state.detailsOpen.has(student.student_id)) {
      state.detailsOpen.delete(student.student_id);
      row.querySelector('.aq-details')?.remove();
      button.textContent = 'Details';
      return;
    }
    state.detailsOpen.add(student.student_id);
    button.textContent = 'Hide';
    fillDetails(student, row);
  }

  async function fillDetails(student, row) {
    const panel = el('div', 'aq-details', 'Loading…');
    row.appendChild(panel);
    const res = await call('admin_quiz_student_answers', { p_student_id: student.student_id });
    if (!state.detailsOpen.has(student.student_id)) return;
    panel.textContent = '';
    if (res.ok !== true) {
      panel.appendChild(el('span', 'aq-empty is-error', say(res)));
      return;
    }
    (res.answers || []).forEach((a) => {
      const item = el('div', 'aq-answer ' + (a.is_correct ? 'is-right' : 'is-wrong'));
      item.appendChild(el('div', 'aq-answer-q', a.question + (a.archived ? '  (archived)' : '')));
      item.appendChild(el('div', 'aq-answer-a',
        'Picked: ' + a.selected + (a.is_correct ? '' : '   ·   Correct: ' + a.correct)));
      item.appendChild(el('div', 'aq-muted',
        (a.is_correct ? '+' + a.points_earned + ' pts' : '0 pts') + ' · ' + new Date(a.answered_at).toLocaleString()));
      panel.appendChild(item);
    });
  }

  /* ---------------- start ---------------- */
  function init() {
    if (state.started) return;
    if (!$('aq-form')) return;
    state.started = true;

    buildOptionRows();
    resetForm();

    $('aq-form').addEventListener('submit', onSubmit);
    $('aq-cancel-btn').addEventListener('click', () => { resetForm(); setFormError(''); });
    $('aq-show-archived').addEventListener('change', (e) => { state.showArchived = e.target.checked; renderQuestions(); });
    $('aq-refresh-btn').addEventListener('click', () => { fillSubjects($('aq-subject').value); loadQuestions(); });
    $('aq-scores-refresh-btn').addEventListener('click', loadScores);
    $('aq-score-search').addEventListener('input', renderScores);

    loadQuestions();
    loadScores();
  }

  window.AdminQuiz = { init, reload: () => { loadQuestions(); loadScores(); } };
})();
