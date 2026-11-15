/* ==========================================================
   ThinkAhead navigation (menu drawer, dashboard views, browser Back/Forward)

   - Students: the dashboard has views (courses | free | premium | about). One is shown at a time, chosen
     from the bottom tab bar (phones), the header links (desktop) or the menu drawer.
   - The Quiz and the book reader are their own screens. They are still opened by the existing code
     (quiz.js / auth.js); this file only WATCHES which screen is open and keeps the browser history in step.
   - Guests: the page stays the normal landing page; the links just scroll to a section.

   History: ?view=courses|free|premium|about|quiz|read (query string, never the # fragment, because
   Supabase's Google sign-in returns its tokens in the # fragment). While a Google callback may still be
   in flight this file does not touch the address bar at all.

   auth.js calls ThinkNav.setCounts(...) and ThinkNav.ready(student) after it has rendered the dashboard.
   quiz.js announces its unanswered count with the "quiz:summary" event.
   ========================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const HOME_VIEWS = ['courses', 'free', 'premium', 'about'];
  const LABELS = { courses: 'My Courses', free: 'Free Books', premium: 'Premium Courses', about: 'About and support', quiz: 'Quiz' };
  const GUEST_TARGET = { free: 'free-books-section', premium: 'missing-section', about: 'bottom-mission-section' };

  const state = {
    view: HOME_VIEWS.indexOf(new URLSearchParams(location.search).get('view')) > -1
      ? new URLSearchParams(location.search).get('view') : 'courses',
    explicit: false,      // true once the student picked a view themselves
    counts: {},
    pending: null,        // 'quiz' if it was requested before the quiz code was ready
    quizUrlHandled: false,
    lastScreen: 'home',
    restoring: false,     // a screen change caused by Back/Forward (must not add history entries)
    drawerOpen: false,
    lastFocus: null,
    wired: false
  };

  const isStudent = () => root.classList.contains('is-student');
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- history helpers ---------------- */
  function viewFromUrl() {
    try { return new URLSearchParams(location.search).get('view'); } catch (e) { return null; }
  }
  function buildUrl(v) { return location.pathname + '?view=' + encodeURIComponent(v); }

  // true while a Google sign-in redirect may still be processed: do not write to the address bar then
  function oauthInFlight() {
    try { if (sessionStorage.getItem('google_login_pending')) return true; } catch (e) { /* ignore */ }
    return /access_token=|refresh_token=|provider_token=|error_description=/.test(location.hash) ||
      /[?&](code|error|error_description)=/.test(location.search);
  }

  function hist(kind, v) {
    if (!isStudent() || oauthInFlight() || !window.history || !history.pushState) return;
    const st = { tv: 1, v: v };
    try {
      if (kind === 'push') history.pushState(st, '', buildUrl(v));
      else history.replaceState(st, '', buildUrl(v));
    } catch (e) { /* history problems must never block navigation */ }
  }

  /* ---------------- screens (home | quiz | reader), watched not controlled ---------------- */
  function currentScreen() {
    const r = $('reader-section');
    const q = $('quiz-section');
    if (r && !r.classList.contains('hidden')) return 'reader';
    if (q && !q.classList.contains('hidden')) return 'quiz';
    return 'home';
  }

  function onScreenChange() {
    const s = currentScreen();
    document.body.setAttribute('data-screen', s);
    syncCurrent();
    if (s === state.lastScreen) return;
    state.lastScreen = s;
    if (s === 'home') window.scrollTo(0, 0);
    if (!isStudent() || state.restoring) return;

    if (s === 'quiz') hist('push', 'quiz');
    else if (s === 'reader') hist('push', 'read');
    else if (history.state && (history.state.v === 'quiz' || history.state.v === 'read')) {
      history.back();   // in-app Back button: also step the browser history back
    }
  }

  /* ---------------- dashboard views ---------------- */
  function applyView(v) {
    if (HOME_VIEWS.indexOf(v) === -1) v = 'courses';
    state.view = v;
    document.body.setAttribute('data-view', v);
    syncCurrent();
  }

  // aria-current marks where the student is, in every navigation list at once
  function syncCurrent() {
    const here = currentScreen() === 'quiz' ? 'quiz' : state.view;
    document.querySelectorAll('[data-nav]').forEach((el) => {
      const on = isStudent() && !el.dataset.scroll && el.dataset.nav === here;
      if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
  }

  function announce(text) {
    const live = $('nav-live');
    if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); }
  }

  function afterSwitch(sectionId) {
    const el = sectionId && $(sectionId);
    if (el) el.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
    else window.scrollTo(0, 0);
  }

  function guestScroll(view, sectionId) {
    const el = $(sectionId || GUEST_TARGET[view] || '');
    if (el) el.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  function openQuiz() {
    const btn = $('qz-open-btn');
    const entry = $('quiz-entry-section');
    if (!btn || !entry || entry.classList.contains('hidden')) { state.pending = 'quiz'; return; }
    btn.click();   // quiz.js opens its own screen exactly as before
  }

  function go(view, opts) {
    opts = opts || {};
    if (!isStudent()) { guestScroll(view, opts.scroll); return; }
    if (view === 'quiz') { if (currentScreen() === 'home') openQuiz(); return; }
    if (currentScreen() !== 'home') return;
    if (HOME_VIEWS.indexOf(view) === -1) view = 'courses';
    state.explicit = true;
    const changed = view !== state.view;
    applyView(view);
    if (changed && opts.push !== false) hist('push', view);
    if (changed) announce(LABELS[view]);
    afterSwitch(opts.scroll);
  }

  /* ---------------- Back / Forward ---------------- */
  function onPopState(e) {
    if (!isStudent()) return;
    const v = (e.state && e.state.v) || viewFromUrl();
    const screen = currentScreen();

    if (v === 'quiz') {
      if (screen === 'home') { state.restoring = true; openQuiz(); setTimeout(() => { state.restoring = false; }, 0); }
      return;
    }
    if (v === 'read') {
      // a reader page cannot be rebuilt from the address, so land on the dashboard instead
      if (screen === 'reader') return;
      hist('replace', state.view);
      return;
    }
    if (screen === 'reader') {
      state.restoring = true; $('back-to-dash-btn') && $('back-to-dash-btn').click();
      setTimeout(() => { state.restoring = false; }, 0);
    } else if (screen === 'quiz') {
      state.restoring = true; $('quiz-back-btn') && $('quiz-back-btn').click();
      setTimeout(() => { state.restoring = false; }, 0);
    }
    if (HOME_VIEWS.indexOf(v) > -1) { applyView(v); announce(LABELS[v]); window.scrollTo(0, 0); }
    else applyView(state.view);
  }

  /* ---------------- menu drawer ---------------- */
  function drawerFocusables() {
    return Array.prototype.slice.call($('nav-drawer').querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.disabled && el.offsetParent !== null);
  }

  function openDrawer() {
    const d = $('nav-drawer');
    const o = $('nav-overlay');
    if (!d || !o || state.drawerOpen) return;
    state.drawerOpen = true;
    state.lastFocus = document.activeElement;
    o.hidden = false; d.hidden = false;
    d.removeAttribute('inert'); d.setAttribute('aria-hidden', 'false');
    $('nav-menu-btn').setAttribute('aria-expanded', 'true');
    document.body.classList.add('nav-open');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      d.classList.add('is-open'); o.classList.add('is-open');
      const close = d.querySelector('.nav-close'); if (close) close.focus();
    }));
  }

  function closeDrawer(restoreFocus) {
    const d = $('nav-drawer');
    const o = $('nav-overlay');
    if (!d || !o || !state.drawerOpen) return;
    state.drawerOpen = false;
    d.classList.remove('is-open'); o.classList.remove('is-open');
    $('nav-menu-btn').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('nav-open');
    setTimeout(() => {
      if (state.drawerOpen) return;
      d.hidden = true; o.hidden = true;
      d.setAttribute('inert', ''); d.setAttribute('aria-hidden', 'true');
    }, reduceMotion() ? 0 : 360);
    if (restoreFocus !== false) {
      const back = state.lastFocus && document.contains(state.lastFocus) ? state.lastFocus : $('nav-menu-btn');
      if (back && back.focus) back.focus();
    }
  }

  function onKeydown(e) {
    if (!state.drawerOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    const items = drawerFocusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---------------- badges ---------------- */
  function setBadge(name, n) {
    document.querySelectorAll('[data-badge="' + name + '"]').forEach((el) => {
      const show = n > 0;
      el.hidden = !show;
      el.textContent = n > 9 ? '9+' : String(n);
      el.setAttribute('aria-label', n + (name === 'quiz' ? ' unanswered' : ' enrolled'));
    });
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    if (state.wired) return;
    state.wired = true;

    const menuBtn = $('nav-menu-btn');
    if (menuBtn) menuBtn.addEventListener('click', () => (state.drawerOpen ? closeDrawer() : openDrawer()));
    document.querySelectorAll('.nav-close').forEach((b) => b.addEventListener('click', () => closeDrawer()));
    const overlay = $('nav-overlay');
    if (overlay) overlay.addEventListener('click', () => closeDrawer());
    document.addEventListener('keydown', onKeydown);
    const drawer = $('nav-drawer');
    if (drawer) drawer.setAttribute('inert', '');

    window.matchMedia('(min-width: 769px)').addEventListener('change', (m) => { if (m.matches) closeDrawer(false); });

    // one click handler for every [data-nav] link/button (tab bar, header, drawer, empty states)
    document.addEventListener('click', (e) => {
      const el = e.target.closest && e.target.closest('[data-nav]');
      if (el) {
        e.preventDefault();
        if (state.drawerOpen) closeDrawer(false);
        go(el.dataset.nav, { scroll: el.dataset.scroll || null });
        return;
      }
      const act = e.target.closest && e.target.closest('[data-action="login"]');
      if (act) {
        if (state.drawerOpen) closeDrawer(false);
        if (typeof openAuthModal === 'function') openAuthModal('login');
      }
    });

    ['homepage-section', 'quiz-section', 'reader-section'].forEach((id) => {
      const node = $(id);
      if (node && 'MutationObserver' in window) {
        new MutationObserver(onScreenChange).observe(node, { attributes: true, attributeFilter: ['class'] });
      }
    });
    window.addEventListener('popstate', onPopState);

    window.addEventListener('quiz:summary', (e) => {
      const d = e.detail || {};
      setBadge('quiz', d.loaded ? d.open : 0);
    });

    onScreenChange();
  }

  /* ---------------- public API (used by auth.js) ---------------- */
  function setCounts(c) {
    state.counts = c || {};
    setBadge('courses', state.counts.courses || 0);
  }

  function ready(student) {
    wire();
    if (!student) {
      // guests keep a clean address; the landing page is one page
      if (viewFromUrl() && !oauthInFlight()) { try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } }
      syncCurrent();
      return;
    }
    try { history.scrollRestoration = 'manual'; } catch (e) { /* ignore */ }

    const urlView = viewFromUrl();
    let v = state.view;
    if (!state.explicit) {
      if (HOME_VIEWS.indexOf(urlView) > -1) v = urlView;
      else if (urlView === 'quiz') v = 'courses';
      else v = (state.counts.courses > 0) ? 'courses' : 'free';   // never land on an empty "My Courses"
    }
    applyView(v);
    if (!(history.state && history.state.tv)) hist('replace', v);

    let want = state.pending;
    if (!want && urlView === 'quiz' && !state.quizUrlHandled) want = 'quiz';
    state.quizUrlHandled = true;
    state.pending = null;
    if (want === 'quiz') openQuiz();
  }

  window.ThinkNav = { ready: ready, setCounts: setCounts, go: go, openDrawer: openDrawer, closeDrawer: closeDrawer };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
