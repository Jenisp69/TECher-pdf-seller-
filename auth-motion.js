/* ==========================================================
   ThinkAhead sign-in modal: motion and phone behaviour
   (auth-motion.js, load it right after auth.js)

   This file only adds feel. It never talks to Supabase and never
   changes how signing in works. It wraps three existing functions
   from auth.js (open / close / switch tab), always calls the
   original function, and does nothing if the modal
   markup is missing.

   What it adds
   1. Marks which switcher option is active, and makes the hidden
      form inert (not clickable, not focusable, ignored by screen readers).
   2. Smoothly animates the height when you switch forms.
   3. A short exit animation when the modal closes.
   4. Phones: swipe the sheet down to close it.
   5. Phones: lifts the sheet above the on-screen keyboard.
   6. Touch screens: Pip glances around now and then, since there is no cursor.
   ========================================================== */
(function () {
  'use strict';

  var modal = document.getElementById('auth-modal');
  var card = modal && modal.querySelector('.auth-card');
  var tabs = modal && modal.querySelector('.auth-tabs');
  var panelsBox = document.getElementById('auth-panels');
  var loginPanel = document.getElementById('login-form');
  var signupPanel = document.getElementById('signup-form-container');
  var cat = document.getElementById('auth-cat');
  if (!modal || !card || !tabs || !panelsBox || !loginPanel || !signupPanel) return;

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var phoneSheet = window.matchMedia('(max-width: 560px)');
  var noHover = window.matchMedia('(hover: none)');

  var EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
  var EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';

  /* ------------------------------------------------------
     1. Switcher state + inert hidden form
     ------------------------------------------------------ */
  function syncPanels() {
    var signupActive = loginPanel.classList.contains('hidden');
    tabs.setAttribute('data-active', signupActive ? 'signup' : 'login');
    loginPanel.inert = signupActive;
    signupPanel.inert = !signupActive;
  }

  if ('MutationObserver' in window) {
    var panelWatcher = new MutationObserver(syncPanels);
    panelWatcher.observe(loginPanel, { attributes: true, attributeFilter: ['class'] });
    panelWatcher.observe(signupPanel, { attributes: true, attributeFilter: ['class'] });
  }
  syncPanels();

  /* ------------------------------------------------------
     2. Smooth height when switching forms
     ------------------------------------------------------ */
  var heightAnimation = null;

  function animateHeight(before) {
    var after = panelsBox.getBoundingClientRect().height;
    if (Math.abs(after - before) < 2) return;

    var animation = panelsBox.animate(
      [{ height: before + 'px' }, { height: after + 'px' }],
      { duration: 260, easing: EASE_OUT }
    );
    heightAnimation = animation;
    panelsBox.style.overflow = 'hidden';

    // cancel and finish events arrive later; only the newest animation may undo the clipping
    function end() {
      if (heightAnimation !== animation) return;
      heightAnimation = null;
      panelsBox.style.overflow = '';
    }
    animation.onfinish = end;
    animation.oncancel = end;
  }

  var baseSwitch = window.switchAuthTab;
  if (typeof baseSwitch === 'function') {
    window.switchAuthTab = function () {
      var visible = !modal.classList.contains('hidden');
      var before = visible ? panelsBox.getBoundingClientRect().height : 0;
      if (heightAnimation) heightAnimation.cancel();

      var result = baseSwitch.apply(this, arguments);
      syncPanels();

      if (visible && before > 0 && !reduced.matches && panelsBox.animate) animateHeight(before);
      return result;
    };
  }

  /* ------------------------------------------------------
     3. Opening and closing
     ------------------------------------------------------ */
  var closing = false;
  var closeToken = 0;
  var activeAnimations = [];
  var dragOffset = 0;

  function cancelExitAnimations() {
    activeAnimations.forEach(function (a) { try { a.cancel(); } catch (e) { /* already gone */ } });
    activeAnimations = [];
  }

  var baseOpen = window.openAuthModal;
  if (typeof baseOpen === 'function') {
    window.openAuthModal = function () {
      if (modal.classList.contains('hidden')) {
        // opening hides the page scrollbar; CSS gives that width back so the page behind does not shift
        var scrollbar = window.innerWidth - document.documentElement.clientWidth;
        document.documentElement.style.setProperty('--au-scrollbar', Math.max(0, scrollbar) + 'px');
      }
      modal.scrollTop = 0;
      closeToken++;            // an unfinished close must not hide the modal we are opening
      closing = false;
      cancelExitAnimations();
      card.style.transform = '';
      dragOffset = 0;
      var result = baseOpen.apply(this, arguments);
      syncPanels();
      syncKeyboard();
      return result;
    };
  }

  var baseClose = window.closeAuthModal;
  if (typeof baseClose === 'function') {
    window.closeAuthModal = function () {
      var self = this;
      var args = arguments;

      if (closing) return;
      if (modal.classList.contains('hidden') || reduced.matches || !card.animate) {
        return baseClose.apply(self, args);
      }

      closing = true;
      var token = ++closeToken;
      var asSheet = phoneSheet.matches;
      var duration = asSheet ? 210 : 140;
      var finished = false;

      function finish() {
        if (finished) return;
        finished = true;
        if (token !== closeToken) return;   // the modal was opened again meanwhile
        closing = false;
        baseClose.apply(self, args);
        cancelExitAnimations();
        card.style.transform = '';
        dragOffset = 0;
      }

      var cardFrames = asSheet
        ? [{ transform: 'translateY(' + dragOffset + 'px)' }, { transform: 'translateY(100%)' }]
        : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(0.985)' }];

      var cardAnim = card.animate(cardFrames, {
        duration: duration,
        easing: asSheet ? EASE_IN : 'ease-out',
        fill: 'forwards'
      });
      // phones: fade only the dimming so the sheet stays solid while it slides away; desktop fades the whole dialog
      var dimFrames = asSheet
        ? [{ backgroundColor: getComputedStyle(modal).backgroundColor }, { backgroundColor: 'rgba(0, 0, 0, 0)' }]
        : [{ opacity: 1 }, { opacity: 0 }];
      var dimAnim = modal.animate(dimFrames, {
        duration: duration,
        easing: 'linear',
        fill: 'forwards'
      });
      activeAnimations = [cardAnim, dimAnim];

      cardAnim.finished.then(finish, finish);
      setTimeout(finish, duration + 250);   // safety net: the modal always closes
    };
  }

  /* ------------------------------------------------------
     4. Phones: swipe the sheet down to close it
        Only the drag handle and the logo row start a drag, so
        scrolling the form is never affected.
     ------------------------------------------------------ */
  var body = modal.querySelector('.auth-body');
  var drag = null;

  function startsDrag(target) {
    if (!target || !target.closest) return false;
    if (target.closest('button, a, input')) return false;
    if (!target.closest('.auth-grabber, .auth-brand-row')) return false;
    if (target.closest('.auth-brand-row') && body && body.scrollTop > 2) return false;
    return true;
  }

  card.addEventListener('pointerdown', function (e) {
    if (!phoneSheet.matches || closing || !startsDrag(e.target)) return;
    drag = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0, moved: false };
    try { card.setPointerCapture(e.pointerId); } catch (err) { /* not critical */ }
  });

  card.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dy = Math.max(0, e.clientY - drag.startY);
    var dt = Math.max(1, e.timeStamp - drag.lastT);
    drag.velocity = 0.8 * drag.velocity + 0.2 * ((e.clientY - drag.lastY) / dt);
    drag.lastY = e.clientY;
    drag.lastT = e.timeStamp;
    if (dy > 4) drag.moved = true;
    if (!drag.moved) return;
    dragOffset = dy;
    card.style.transform = 'translateY(' + dy + 'px)';
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var finishedDrag = drag;
    drag = null;
    try { card.releasePointerCapture(e.pointerId); } catch (err) { /* not critical */ }
    if (!finishedDrag.moved) return;

    if (dragOffset > 96 || finishedDrag.velocity > 0.55) {
      window.closeAuthModal();
    } else {
      var from = dragOffset;
      dragOffset = 0;
      card.style.transform = '';
      if (card.animate && !reduced.matches) {
        card.animate([{ transform: 'translateY(' + from + 'px)' }, { transform: 'none' }], { duration: 240, easing: EASE_OUT });
      }
    }
  }
  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);

  /* ------------------------------------------------------
     5. Phones: lift the sheet above the on-screen keyboard
        iOS keeps the page the same size and shows the keyboard on
        top of it; Android Chrome does the same by default. The
        visual viewport tells us how much the keyboard covers.
     ------------------------------------------------------ */
  function inputIsFocused() {
    var active = document.activeElement;
    return !!(active && modal.contains(active) && active.tagName === 'INPUT');
  }

  /* A keyboard covers well over 100px and only appears while a field is focused. Browser toolbars growing
     or shrinking while the sheet opens also change the visual viewport by a few dozen pixels; treating that
     as a keyboard would lift the sheet off the bottom edge and let the page show underneath. */
  function syncKeyboard() {
    var vv = window.visualViewport;
    if (!vv || vv.scale > 1.01) return;
    var covered = Math.round(window.innerHeight - vv.height - vv.offsetTop);
    var lift = covered >= 100 && inputIsFocused() ? covered : 0;
    modal.style.setProperty('--au-kb', lift + 'px');
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncKeyboard);
    window.visualViewport.addEventListener('scroll', syncKeyboard);
  }
  modal.addEventListener('focusin', syncKeyboard);
  modal.addEventListener('focusout', function () { setTimeout(syncKeyboard, 0); });
  syncKeyboard();

  /* ------------------------------------------------------
     6. Touch screens: Pip looks around now and then
        (the cursor-following eyes only work with a mouse).
        Idle only: it stops while someone is typing or a password is shown.
     ------------------------------------------------------ */
  var glanceTimer = 0;
  var settleTimer = 0;

  function someoneIsTyping() {
    var active = document.activeElement;
    return !!(active && modal.contains(active) && active.tagName === 'INPUT');
  }

  function look(x, y) {
    cat.style.setProperty('--lx', String(x));
    cat.style.setProperty('--ly', String(y));
  }

  function scheduleGlance() {
    clearTimeout(glanceTimer);
    glanceTimer = setTimeout(function () {
      var canGlance = !modal.classList.contains('hidden') &&
        !reduced.matches &&
        !someoneIsTyping() &&
        !modal.classList.contains('auth-password-visible');

      if (canGlance) {
        var side = Math.random() < 0.5 ? -1 : 1;
        look((side * (0.45 + Math.random() * 0.4)).toFixed(2), 0.2);
        clearTimeout(settleTimer);
        settleTimer = setTimeout(function () {
          if (!someoneIsTyping()) look(0, 0);
        }, 1100);
      }
      if (!modal.classList.contains('hidden')) scheduleGlance();
    }, 3500 + Math.random() * 3500);
  }

  function stopGlancing() {
    clearTimeout(glanceTimer);
    clearTimeout(settleTimer);
  }

  if (cat && 'MutationObserver' in window) {
    new MutationObserver(function () {
      if (modal.classList.contains('hidden')) {
        stopGlancing();
      } else if (noHover.matches) {
        scheduleGlance();
      }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
})();
