/* ==========================================================
   ThinkAhead profile system (works with 5-profile.sql)

   How it talks to the database: students have no Supabase sign-in (they log in with a
   token), so every call below goes through a checked database function that receives
   the student's id + login token. Nothing here touches a table directly.

   auth.js calls StudentProfile.attach(student) when someone is logged in and
   StudentProfile.detach() when nobody is. The logout button (#dash-logout-btn) stays
   the one auth.js already handles; it just lives inside the drawer now.
   ========================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const HUES = [215, 250, 278, 318, 345, 10, 165, 190];   // avatar colours that keep white text readable
  const AVATAR_PX = 256;                                  // photos are shrunk to 256 x 256
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;               // refuse originals above 8 MB
  const MAX_DATA_URL_CHARS = 110000;                      // the database accepts up to 120000
  const MAX_EMAILS = 5;
  const NAME_RE_BAD = /[<>\u0000-\u001f\u007f]/;
  const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,19}$/;
  const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
  const TAB_ORDER = ['profile', 'contact', 'security'];

  const state = {
    student: null,
    profile: null,
    emails: [],
    loaded: false,
    loading: false,
    failed: false,
    pendingAvatar: null,
    open: false,
    wired: false,
    lastFocus: null,
    armedRemove: null,
    expiredShown: false
  };

  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- small helpers ---------------- */
  function activeStudent() {
    return (typeof currentStudentUser !== 'undefined' && currentStudentUser) || state.student;
  }

  function hueFor(seed) {
    let h = 0;
    const text = String(seed || 'x');
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return HUES[h % HUES.length];
  }

  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean).map((p) => Array.from(p)[0]);
    if (!parts.length) return '?';
    const pick = parts.length === 1 ? parts[0] : parts[0] + parts[parts.length - 1];
    return pick.toUpperCase();
  }

  function setAvatar(root, src, initials, hue) {
    if (!root) return;
    root.style.setProperty('--pf-h', hue);
    const img = root.querySelector('img');
    const ini = root.querySelector('.pf-initials');
    if (img) {
      if (src) { img.src = src; img.hidden = false; }
      else { img.removeAttribute('src'); img.hidden = true; }
    }
    if (ini) { ini.hidden = !!src; ini.textContent = initials; }
  }

  function toast(message, kind) {
    const box = $('pf-toasts');
    if (!box) return;
    const t = document.createElement('div');
    t.className = 'pf-toast ' + (kind === 'err' ? 'err' : 'ok');
    const icon = document.createElement('i');
    icon.className = kind === 'err' ? 'fa-solid fa-circle-exclamation' : 'fa-solid fa-circle-check';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = message;
    t.appendChild(icon);
    t.appendChild(text);
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => t.remove(), kind === 'err' ? 5200 : 3200);
  }

  // Shows a spinner and blocks double clicks; when it ends the button goes back to how it was.
  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      btn.dataset.prevDisabled = btn.disabled ? '1' : '';
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    } else {
      btn.disabled = btn.dataset.prevDisabled === '1';
      btn.removeAttribute('aria-busy');
    }
    btn.classList.toggle('is-busy', busy);
  }

  function flashDone(btn, doneText) {
    if (!btn) return;
    const original = btn.textContent;
    btn.classList.add('is-done');
    btn.textContent = doneText || 'Saved';
    setTimeout(() => { btn.classList.remove('is-done'); btn.textContent = original; }, 1400);
  }

  function setError(id, message) {
    const p = $(id);
    if (p) p.textContent = message || '';
    const inputId = {
      'pf-name-error': 'pf-name-input', 'pf-phone-error': 'pf-phone-input', 'pf-email-error': 'pf-email-input',
      'pf-pw-current-error': 'pf-pw-current', 'pf-pw-new-error': 'pf-pw-new', 'pf-pw-confirm-error': 'pf-pw-confirm'
    }[id];
    const input = inputId && $(inputId);
    if (input) {
      input.classList.toggle('is-invalid', !!message);
      if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  }

  const MESSAGES = {
    network: "Couldn't reach the server. Check your internet and try again.",
    invalid_name: 'Please enter a name of 2 to 80 characters, without < or >.',
    invalid_phone: 'Please enter a valid phone number (7 to 15 digits).',
    invalid_email: 'Please enter a valid email address.',
    same_as_primary: 'That is already your sign-in email.',
    exists: 'You already added that email.',
    limit: 'You can add up to ' + MAX_EMAILS + ' emails. Remove one first.',
    wrong_password: 'That is not your current password.',
    weak_password: 'Your new password must be 6 to 100 characters.',
    same_password: 'Your new password must be different from the current one.',
    locked: 'Too many wrong attempts. Please wait 15 minutes and try again.',
    no_password: "This account doesn't use a password.",
    too_big: 'That photo is too large. Try a smaller one.',
    invalid_image: 'That file is not a usable photo.'
  };
  const messageFor = (code) => MESSAGES[code] || 'Something went wrong. Please try again.';

  /* ---------------- talking to the database ---------------- */
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
      if (data.ok !== true && data.error === 'bad_token') { sessionExpired(); }
      return data;
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }

  function persistStudent() {
    const s = activeStudent();
    if (!s || !state.profile) return;
    s.full_name = state.profile.full_name || s.full_name;
    s.contact_phone = state.profile.contact_phone || '';
    try { sessionStorage.setItem('student_user', JSON.stringify(s)); } catch (e) { /* storage problems must never block the page */ }
  }

  /* ---------------- rendering ---------------- */
  function displayName() {
    const s = activeStudent();
    return (state.profile && state.profile.full_name) || (s && s.full_name) || 'Student';
  }

  function methodOf() {
    if (state.profile) return state.profile.method;
    const s = activeStudent();
    return s && /@/.test(s.username || '') ? 'google' : 'password';
  }

  function renderIdentity() {
    const s = activeStudent();
    if (!s) return;
    const name = displayName();
    const initials = initialsOf(name);
    const hue = hueFor(s.id);
    const avatar = state.pendingAvatar || (state.profile && state.profile.avatar) || null;
    const savedAvatar = (state.profile && state.profile.avatar) || null;

    const navName = $('nav-user-name');
    if (navName) navName.textContent = name;
    setAvatar($('nav-avatar'), savedAvatar, initials, hue);
    setAvatar($('pf-avatar-btn'), avatar, initials, hue);

    const title = $('pf-title');
    if (title) title.textContent = name;

    const isGoogle = methodOf() === 'google';
    const handle = $('pf-handle');
    if (handle) {
      const email = (state.profile && state.profile.email) || s.username || '';
      handle.textContent = isGoogle ? email : '@' + (s.username || '');
    }
    const chip = $('pf-method-chip');
    if (chip) {
      chip.querySelector('i').className = isGoogle ? 'fa-brands fa-google' : 'fa-solid fa-key';
      chip.querySelector('span').textContent = isGoogle ? 'Signed in with Google' : 'Signed in with password';
    }

    const hero = $('hero-title');
    if (hero) hero.textContent = 'Welcome back, ' + name + '!';
    persistStudent();
  }

  function renderPhotoActions() {
    const pending = !!state.pendingAvatar;
    const hasPhoto = !!(state.profile && state.profile.avatar);
    $('pf-photo-upload').hidden = pending;
    $('pf-photo-remove').hidden = pending || !hasPhoto;
    $('pf-photo-use').hidden = !pending;
    $('pf-photo-cancel').hidden = !pending;
    $('pf-avatar-wrap').classList.toggle('is-pending', pending);
    $('pf-photo-upload').querySelector('i').nextSibling.textContent = hasPhoto ? ' Replace photo' : ' Upload photo';
  }

  function renderForms() {
    const p = state.profile;
    const s = activeStudent();
    $('pf-name-input').value = (p && p.full_name) || (s && s.full_name) || '';
    $('pf-username').value = (p && p.username) || (s && s.username) || '';
    $('pf-phone-input').value = (p && p.contact_phone) || '';
    setError('pf-name-error', '');
    setError('pf-phone-error', '');
    updateNameState();
    updatePhoneState();
    renderSecurity();
    renderEmails();
    renderPhotoActions();
  }

  function renderSecurity() {
    const p = state.profile;
    const s = activeStudent();
    const isGoogle = methodOf() === 'google';
    const hasPassword = !!(p && p.has_password);

    $('pf-method-icon').className = isGoogle ? 'fa-brands fa-google' : 'fa-solid fa-key';
    $('pf-method-title').textContent = isGoogle ? 'Google account' : 'Username and password';
    $('pf-method-sub').textContent = isGoogle ? ((p && p.email) || (s && s.username) || '') : ((p && p.username) || (s && s.username) || '');

    $('pf-sec-email-field').hidden = !isGoogle;
    $('pf-sec-email').value = isGoogle ? ((p && p.email) || (s && s.username) || '') : '';

    const loginPhone = (p && p.login_phone) || '';
    $('pf-sec-phone-field').hidden = isGoogle || !loginPhone;
    $('pf-sec-phone').value = loginPhone;

    const showForm = !isGoogle && hasPassword && !state.failed;
    $('pf-password-section').hidden = !showForm;
    const info = $('pf-password-info');
    if (showForm) {
      info.hidden = true;
    } else {
      info.hidden = false;
      $('pf-password-info-text').textContent = isGoogle
        ? 'You sign in with Google, so there is no password to change here. Your Google account keeps your password and security settings.'
        : (state.failed ? 'Reload your details to see the password options.' : "Password changes aren't available for this account. Please ask your teacher.");
    }
  }

  function renderEmails() {
    const list = $('pf-email-list');
    list.textContent = '';
    state.emails.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'pf-email-row';

      const text = document.createElement('span');
      text.className = 'pf-email-text';
      text.textContent = item.email;

      const tag = document.createElement('span');
      tag.className = 'pf-tag';
      tag.textContent = item.verified ? 'Verified' : 'Unverified';

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'pf-btn pf-btn-danger pf-btn-sm';
      rm.setAttribute('aria-label', 'Remove ' + item.email);
      rm.dataset.id = item.id;
      rm.textContent = state.armedRemove === item.id ? 'Sure?' : 'Remove';

      li.appendChild(text);
      li.appendChild(tag);
      li.appendChild(rm);
      list.appendChild(li);
    });
    $('pf-email-empty').hidden = state.emails.length > 0;
    list.hidden = state.emails.length === 0;
    const full = state.emails.length >= MAX_EMAILS;
    $('pf-email-input').disabled = full;
    $('pf-email-add').disabled = full;
    if (full) setError('pf-email-error', 'You have reached the limit of ' + MAX_EMAILS + ' emails.');
  }

  /* ---------------- loading ---------------- */
  function fallbackProfile() {
    const s = activeStudent() || {};
    const google = /@/.test(s.username || '');
    return {
      full_name: s.full_name || 'Student', username: s.username || '', login_phone: s.phone_number || '',
      email: google ? s.username : null, method: google ? 'google' : 'password',
      has_password: !google, contact_phone: s.contact_phone || '', avatar: null
    };
  }

  async function loadProfile(silent) {
    if (state.loading) return;
    state.loading = true;
    const drawer = $('pf-drawer');
    if (!silent) drawer.classList.add('is-loading');
    const res = await rpc('get_my_profile');
    state.loading = false;
    drawer.classList.remove('is-loading');

    if (res && res.ok === true) {
      state.profile = res.profile;
      state.emails = res.emails || [];
      state.loaded = true;
      state.failed = false;
      $('pf-banner').hidden = true;
    } else {
      state.failed = true;
      if (!state.profile) state.profile = fallbackProfile();
      if (!silent) $('pf-banner').hidden = false;
    }
    renderIdentity();
    renderForms();
  }

  /* ---------------- name + phone ---------------- */
  const cleanName = (v) => v.replace(/\s+/g, ' ').trim();

  function nameProblem(value) {
    const v = cleanName(value);
    if (v.length < 2 || v.length > 80) return 'Please enter a name of 2 to 80 characters.';
    if (NAME_RE_BAD.test(v)) return 'Names can\'t contain < or >.';
    return '';
  }
  function phoneProblem(value) {
    const v = value.trim();
    if (!v) return '';
    const digits = v.replace(/\D/g, '');
    if (!PHONE_RE.test(v) || digits.length < 7 || digits.length > 15) return 'Please enter a valid phone number (7 to 15 digits).';
    return '';
  }

  function updateNameState() {
    const input = $('pf-name-input');
    const saved = (state.profile && state.profile.full_name) || '';
    const changed = cleanName(input.value) !== saved;
    $('pf-name-save').disabled = !changed || !!nameProblem(input.value);
    $('pf-name-cancel').disabled = !changed;
  }
  function updatePhoneState() {
    const input = $('pf-phone-input');
    const saved = (state.profile && state.profile.contact_phone) || '';
    const changed = input.value.trim() !== saved;
    $('pf-phone-save').disabled = !changed || !!phoneProblem(input.value);
    $('pf-phone-cancel').disabled = !changed;
  }

  async function saveName(event) {
    event.preventDefault();
    const input = $('pf-name-input');
    const problem = nameProblem(input.value);
    setError('pf-name-error', problem);
    if (problem) return;
    const btn = $('pf-name-save');
    setBusy(btn, true);
    const res = await rpc('update_my_profile', { p_full_name: cleanName(input.value), p_contact_phone: null });
    setBusy(btn, false);
    if (res.ok === true) {
      state.profile.full_name = res.full_name;
      renderIdentity();
      input.value = res.full_name;
      updateNameState();
      flashDone(btn, 'Saved');
      btn.disabled = true;
      toast('Name updated');
    } else {
      updateNameState();
      const msg = messageFor(res.error);
      setError('pf-name-error', msg);
      toast(msg, 'err');
    }
  }

  async function savePhone(event) {
    event.preventDefault();
    const input = $('pf-phone-input');
    const problem = phoneProblem(input.value);
    setError('pf-phone-error', problem);
    if (problem) return;
    const btn = $('pf-phone-save');
    setBusy(btn, true);
    const res = await rpc('update_my_profile', { p_full_name: null, p_contact_phone: input.value.trim() });
    setBusy(btn, false);
    if (res.ok === true) {
      state.profile.contact_phone = res.contact_phone || '';
      persistStudent();
      input.value = state.profile.contact_phone;
      updatePhoneState();
      flashDone(btn, 'Saved');
      btn.disabled = true;
      toast(state.profile.contact_phone ? 'Contact phone saved' : 'Contact phone removed');
    } else {
      updatePhoneState();
      const msg = messageFor(res.error);
      setError('pf-phone-error', msg);
      toast(msg, 'err');
    }
  }

  /* ---------------- contact emails ---------------- */
  async function addEmail(event) {
    event.preventDefault();
    const input = $('pf-email-input');
    const value = input.value.trim().toLowerCase();
    if (!EMAIL_RE.test(value) || value.length > 254) { setError('pf-email-error', MESSAGES.invalid_email); return; }
    setError('pf-email-error', '');
    const btn = $('pf-email-add');
    setBusy(btn, true);
    const res = await rpc('add_my_email', { p_email: value });
    setBusy(btn, false);
    if (res.ok === true) {
      state.emails = res.emails || [];
      input.value = '';
      renderEmails();
      toast('Email added');
    } else {
      const msg = messageFor(res.error);
      setError('pf-email-error', msg);
      toast(msg, 'err');
    }
  }

  async function removeEmail(id, button) {
    if (state.armedRemove !== id) {                   // first click asks "Sure?", second click removes
      state.armedRemove = id;
      renderEmails();
      setTimeout(() => { if (state.armedRemove === id) { state.armedRemove = null; renderEmails(); } }, 3000);
      return;
    }
    state.armedRemove = null;
    setBusy(button, true);
    const res = await rpc('remove_my_email', { p_email_id: id });
    if (res.ok === true) {
      state.emails = res.emails || [];
      setError('pf-email-error', '');
      renderEmails();
      toast('Email removed');
    } else {
      setBusy(button, false);
      renderEmails();
      toast(messageFor(res.error), 'err');
    }
  }

  /* ---------------- profile photo ---------------- */
  async function looksLikeImage(file) {
    const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const webp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    return jpeg || png || webp;
  }

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  // Validate the file, centre-crop to a square, shrink to 256 px and re-encode as JPEG.
  // Re-encoding also strips hidden data (location, camera info) from the original.
  async function fileToAvatar(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('type');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('size');
    if (!(await looksLikeImage(file))) throw new Error('type');

    const bmp = await loadBitmap(file);
    const w = bmp.width || bmp.naturalWidth;
    const h = bmp.height || bmp.naturalHeight;
    if (!w || !h) throw new Error('decode');
    const side = Math.min(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_PX;
    canvas.height = AVATAR_PX;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, (w - side) / 2, (h - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
    if (bmp.close) bmp.close();

    for (const quality of [0.86, 0.72, 0.58]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= MAX_DATA_URL_CHARS) return url;
    }
    throw new Error('size');
  }

  async function onFileChosen() {
    const input = $('pf-file');
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      state.pendingAvatar = await fileToAvatar(file);
      renderIdentity();
      renderPhotoActions();
      $('pf-photo-use').focus();
    } catch (e) {
      const reason = e && e.message;
      toast(reason === 'size' ? 'That photo is too large. Please choose one under 8 MB.'
        : reason === 'type' ? 'Please choose a JPG, PNG or WebP photo.'
        : "That photo couldn't be opened. Try another one.", 'err');
    }
  }

  function cancelPendingPhoto() {
    state.pendingAvatar = null;
    renderIdentity();
    renderPhotoActions();
  }

  async function usePendingPhoto() {
    if (!state.pendingAvatar) return;
    const btn = $('pf-photo-use');
    setBusy(btn, true);
    const res = await rpc('set_my_avatar', { p_avatar: state.pendingAvatar });
    setBusy(btn, false);
    btn.disabled = false;
    if (res.ok === true) {
      state.profile.avatar = res.avatar;
      state.pendingAvatar = null;
      renderIdentity();
      renderPhotoActions();
      toast('Profile photo updated');
    } else {
      toast(messageFor(res.error), 'err');
    }
  }

  let removeArmTimer = null;
  async function removePhoto() {
    const btn = $('pf-photo-remove');
    const label = btn.querySelector('span');
    if (!btn.dataset.armed) {                         // first click asks "Sure?", second click removes
      btn.dataset.armed = '1';
      label.textContent = 'Sure?';
      removeArmTimer = setTimeout(() => { delete btn.dataset.armed; label.textContent = 'Remove'; }, 3000);
      return;
    }
    clearTimeout(removeArmTimer);
    delete btn.dataset.armed;
    label.textContent = 'Remove';
    setBusy(btn, true);
    const res = await rpc('set_my_avatar', { p_avatar: '' });
    setBusy(btn, false);
    btn.disabled = false;
    if (res.ok === true) {
      state.profile.avatar = null;
      renderIdentity();
      renderPhotoActions();
      toast('Profile photo removed');
    } else {
      toast(messageFor(res.error), 'err');
    }
  }

  /* ---------------- password ---------------- */
  function strengthLevel(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 6) score++;
    if (pw.length >= 10) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    if (pw.length < 6) return 1;
    return Math.min(4, Math.max(1, score));
  }

  async function changePassword(event) {
    event.preventDefault();
    const cur = $('pf-pw-current').value;
    const next = $('pf-pw-new').value;
    const conf = $('pf-pw-confirm').value;
    setError('pf-pw-current-error', '');
    setError('pf-pw-new-error', '');
    setError('pf-pw-confirm-error', '');

    let bad = false;
    if (!cur.trim()) { setError('pf-pw-current-error', 'Enter your current password.'); bad = true; }
    if (next.trim().length < 6) { setError('pf-pw-new-error', 'Use at least 6 characters.'); bad = true; }
    else if (next.trim().length > 100) { setError('pf-pw-new-error', 'Use 100 characters or fewer.'); bad = true; }
    else if (cur.trim() && next.trim() === cur.trim()) { setError('pf-pw-new-error', MESSAGES.same_password); bad = true; }
    if (next !== conf) { setError('pf-pw-confirm-error', 'The two passwords do not match.'); bad = true; }
    if (bad) return;

    const btn = $('pf-pw-save');
    setBusy(btn, true);
    const res = await rpc('change_my_password', { p_current: cur, p_new: next });
    setBusy(btn, false);

    if (res.ok === true) {
      const s = activeStudent();
      sessionStorage.setItem('sessionToken', res.token);
      if (s) { s.active_session_token = res.token; sessionStorage.setItem('student_user', JSON.stringify(s)); }
      ['pf-pw-current', 'pf-pw-new', 'pf-pw-confirm'].forEach((id) => { $(id).value = ''; });
      $('pf-meter').dataset.level = '0';
      flashDone(btn, 'Password updated');
      toast('Password updated. Other devices were signed out.');
      setTimeout(() => window.location.reload(), 1600);   // a clean restart with the new login token
    } else if (res.error === 'wrong_password' || res.error === 'locked') {
      setError('pf-pw-current-error', messageFor(res.error));
    } else if (res.error === 'weak_password' || res.error === 'same_password') {
      setError('pf-pw-new-error', messageFor(res.error));
    } else {
      toast(messageFor(res.error), 'err');
    }
  }

  /* ---------------- tabs ---------------- */
  function setTab(name, focus) {
    const index = Math.max(0, TAB_ORDER.indexOf(name));
    TAB_ORDER.forEach((t, i) => {
      const tab = $('pf-tab-' + t);
      const on = i === index;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $('pf-panel-' + t).hidden = !on;
    });
    $('pf-tab-indicator').style.setProperty('--pf-i', index);
    if (focus) $('pf-tab-' + TAB_ORDER[index]).focus();
  }

  /* ---------------- open / close ---------------- */
  function focusables() {
    return Array.from($('pf-drawer').querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null && el.type !== 'hidden');
  }

  function openDrawer(tab) {
    if (!activeStudent() || state.open) return;
    state.open = true;
    state.lastFocus = document.activeElement;
    const drawer = $('pf-drawer');
    const overlay = $('pf-overlay');
    overlay.hidden = false;
    drawer.hidden = false;
    drawer.removeAttribute('inert');
    drawer.setAttribute('aria-hidden', 'false');
    $('profile-trigger').setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    setTab(tab || 'profile');
    renderIdentity();
    renderForms();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      drawer.classList.add('is-open');
      overlay.classList.add('is-open');
      $('pf-close').focus();
    }));
    if (!state.loaded || state.failed) loadProfile(false);
  }

  function closeDrawer() {
    if (!state.open) return;
    state.open = false;
    const drawer = $('pf-drawer');
    const overlay = $('pf-overlay');
    drawer.classList.remove('is-open');
    overlay.classList.remove('is-open');
    $('profile-trigger').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (state.pendingAvatar) cancelPendingPhoto();
    state.armedRemove = null;
    setTimeout(() => {
      if (state.open) return;
      drawer.hidden = true;
      overlay.hidden = true;
      drawer.setAttribute('inert', '');
      drawer.setAttribute('aria-hidden', 'true');
    }, reduceMotion() ? 0 : 470);
    const back = state.lastFocus && document.contains(state.lastFocus) ? state.lastFocus : $('profile-trigger');
    if (back && back.focus) back.focus();
  }

  function onKeydown(event) {
    if (!state.open) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); return; }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (!$('pf-drawer').contains(document.activeElement)) { event.preventDefault(); first.focus(); }
  }

  /* ---------------- wiring (once) ---------------- */
  function wire() {
    if (state.wired) return;
    if (!$('pf-drawer') || !$('profile-trigger')) return;
    state.wired = true;

    $('pf-drawer').setAttribute('inert', '');
    $('profile-trigger').addEventListener('click', () => (state.open ? closeDrawer() : openDrawer('profile')));
    $('pf-close').addEventListener('click', closeDrawer);
    $('pf-overlay').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', onKeydown);

    TAB_ORDER.forEach((t) => {
      $('pf-tab-' + t).addEventListener('click', () => setTab(t));
      $('pf-tab-' + t).addEventListener('keydown', (e) => {
        const i = TAB_ORDER.indexOf(t);
        let next = null;
        if (e.key === 'ArrowRight') next = (i + 1) % TAB_ORDER.length;
        else if (e.key === 'ArrowLeft') next = (i + TAB_ORDER.length - 1) % TAB_ORDER.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = TAB_ORDER.length - 1;
        if (next !== null) { e.preventDefault(); setTab(TAB_ORDER[next], true); }
      });
    });

    $('pf-retry').addEventListener('click', () => loadProfile(false));

    $('pf-profile-form').addEventListener('submit', saveName);
    $('pf-name-input').addEventListener('input', () => { setError('pf-name-error', ''); updateNameState(); });
    $('pf-name-cancel').addEventListener('click', () => { $('pf-name-input').value = (state.profile && state.profile.full_name) || ''; setError('pf-name-error', ''); updateNameState(); });

    $('pf-phone-form').addEventListener('submit', savePhone);
    $('pf-phone-input').addEventListener('input', () => { setError('pf-phone-error', ''); updatePhoneState(); });
    $('pf-phone-cancel').addEventListener('click', () => { $('pf-phone-input').value = (state.profile && state.profile.contact_phone) || ''; setError('pf-phone-error', ''); updatePhoneState(); });

    $('pf-email-form').addEventListener('submit', addEmail);
    $('pf-email-input').addEventListener('input', () => setError('pf-email-error', ''));
    $('pf-email-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-id]');
      if (btn) removeEmail(btn.dataset.id, btn);
    });

    $('pf-avatar-btn').addEventListener('click', () => $('pf-file').click());
    $('pf-photo-upload').addEventListener('click', () => $('pf-file').click());
    $('pf-file').addEventListener('change', onFileChosen);
    $('pf-photo-use').addEventListener('click', usePendingPhoto);
    $('pf-photo-cancel').addEventListener('click', cancelPendingPhoto);
    $('pf-photo-remove').addEventListener('click', removePhoto);

    $('pf-password-form').addEventListener('submit', changePassword);
    $('pf-pw-new').addEventListener('input', (e) => { $('pf-meter').dataset.level = String(strengthLevel(e.target.value)); setError('pf-pw-new-error', ''); });
    $('pf-pw-current').addEventListener('input', () => setError('pf-pw-current-error', ''));
    $('pf-pw-confirm').addEventListener('input', () => setError('pf-pw-confirm-error', ''));
    document.querySelectorAll('.pf-eye').forEach((eye) => {
      eye.addEventListener('click', () => {
        const input = $(eye.dataset.target);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        eye.querySelector('i').className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
      });
    });
  }

  /* ---------------- public API (used by auth.js) ---------------- */
  window.StudentProfile = {
    attach(student) {
      wire();
      if (!student) return;
      const same = state.student && state.student.id === student.id;
      state.student = student;
      if (!same) {
        state.profile = null; state.emails = []; state.loaded = false; state.failed = false; state.pendingAvatar = null;
      }
      renderIdentity();
      if (!state.loaded) loadProfile(true);      // quietly fetch the saved photo and details
    },
    detach() {
      if (state.open) closeDrawer();
      state.student = null; state.profile = null; state.emails = []; state.loaded = false; state.failed = false; state.pendingAvatar = null;
    },
    open: openDrawer,
    close: closeDrawer
  };
})();
