// State variables
let currentStudentUser = null;
let allSubjectsCache = [];
let userEnrollmentsSet = new Set();
let activePaymentSubject = null;
let globalSessionGuardInterval = null;
let openingBook = false;

// The course list shows these columns to everyone. Where a book's file is stored is NOT public:
// it is only given (by get_book_path) to students allowed to read that book.
const SUBJECT_COLUMNS = 'id, subject_name, total_pages, class_level, stream_id, semester, price_npr, is_free, last_updated';

/* ==========================================
   GLOBAL SESSION GUARD
   ========================================== */
function startGlobalSessionGuard() {
  if (globalSessionGuardInterval) clearInterval(globalSessionGuardInterval);

  globalSessionGuardInterval = setInterval(async () => {
    const studentId = sessionStorage.getItem('studentId');
    const sessionToken = sessionStorage.getItem('sessionToken');

    if (!studentId || !sessionToken || typeof supabaseClient === 'undefined') return;

    try {
      const { data, error } = await supabaseClient.rpc('student_session_ok', {
        p_id: studentId,
        p_token: sessionToken
      });

      // A bad connection must not log the student out; only a clear "no" from the server does
      if (!error && data === false) {
        clearInterval(globalSessionGuardInterval);
        alert('Your account was logged in from another device or location.');
        sessionStorage.clear();
        window.location.reload();
      }
    } catch (e) {
      console.warn('Session check warning:', e);
    }
  }, 15000);
}

// Password Toggle Helper
function togglePasswordVisibility(inputId, iconElement) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const showPassword = input.type === 'password';
  input.type = showPassword ? 'text' : 'password';

  const icon = iconElement.querySelector('i') || iconElement;
  icon.classList.toggle('fa-eye', !showPassword);
  icon.classList.toggle('fa-eye-slash', showPassword);
  iconElement.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password');
  updateAuthBuddy();
}

function updateAuthBuddy() {
  const modal = document.getElementById('auth-modal');
  const loginIsActive = !document.getElementById('login-form')?.classList.contains('hidden');
  const activeForm = loginIsActive
    ? document.getElementById('login-form')
    : document.getElementById('phone-otp-form');
  const passwordIsVisible = [...(activeForm?.querySelectorAll('.auth-password') || [])]
    .some(input => input.type !== 'password');

  modal?.classList.toggle('auth-password-visible', passwordIsVisible);
}

let authReturnFocus = null;

function openAuthModal(defaultTab = 'login') {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  if (modal.classList.contains('hidden')) authReturnFocus = document.activeElement;
  switchAuthTab(defaultTab);
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('auth-modal-open');
  requestAnimationFrame(() => {
    const dialog = modal.querySelector('.auth-card');
    const firstField = defaultTab === 'signup' ? document.getElementById('signup-name') : document.getElementById('username-input');
    // Touch screens: do not pop the keyboard open straight away, so the whole sheet is visible first
    const touchOnly = window.matchMedia('(pointer: coarse)').matches;
    (touchOnly ? dialog : (firstField || dialog))?.focus();
  });
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('auth-modal-open');
  if (authReturnFocus && authReturnFocus.isConnected && typeof authReturnFocus.focus === 'function') {
    authReturnFocus.focus();
  }
  authReturnFocus = null;
}

function switchAuthTab(tab) {
  const loginForm = document.getElementById('login-form');
  const signupContainer = document.getElementById('signup-form-container');
  const tabLogin = document.getElementById('tab-login');
  const tabSignup = document.getElementById('tab-signup');
  const errorDiv = document.getElementById('login-error');
  const successDiv = document.getElementById('login-success');

  if (errorDiv) errorDiv.classList.add('hidden');
  if (successDiv) successDiv.classList.add('hidden');

  if (tab === 'login') {
    loginForm?.classList.remove('hidden');
    signupContainer?.classList.add('hidden');
    tabLogin?.classList.add('active');
    tabSignup?.classList.remove('active');
    tabLogin?.setAttribute('aria-selected', 'true');
    tabSignup?.setAttribute('aria-selected', 'false');
    tabLogin?.setAttribute('tabindex', '0');
    tabSignup?.setAttribute('tabindex', '-1');
    signupContainer?.setAttribute('aria-hidden', 'true');
    loginForm?.setAttribute('aria-hidden', 'false');
    document.getElementById('auth-kicker').textContent = 'THINKAHEAD STUDENT LIBRARY';
    document.getElementById('auth-title').textContent = 'Sign in';
    document.getElementById('auth-heading-copy').textContent = 'Open your study space and pick up where you left off.';
  } else {
    loginForm?.classList.add('hidden');
    signupContainer?.classList.remove('hidden');
    tabLogin?.classList.remove('active');
    tabSignup?.classList.add('active');
    tabLogin?.setAttribute('aria-selected', 'false');
    tabSignup?.setAttribute('aria-selected', 'true');
    tabLogin?.setAttribute('tabindex', '-1');
    tabSignup?.setAttribute('tabindex', '0');
    signupContainer?.setAttribute('aria-hidden', 'false');
    loginForm?.setAttribute('aria-hidden', 'true');
    document.getElementById('auth-kicker').textContent = 'THINKAHEAD STUDENT LIBRARY';
    document.getElementById('auth-title').textContent = 'Create account';
    document.getElementById('auth-heading-copy').textContent = 'Set up your space for learning and notes.';
  }
  updateAuthBuddy();
}

function setAuthButtonBusy(button, busy, busyLabel) {
  if (!button) return;
  const label = button.querySelector('[data-auth-label]');
  if (label) {
    if (!label.dataset.idleLabel) label.dataset.idleLabel = label.textContent;
    label.textContent = busy ? busyLabel : label.dataset.idleLabel;
  }
  button.disabled = busy;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// Keep modal keyboard use contained and let Escape/backdrop close it.
document.addEventListener('keydown', (event) => {
  const modal = document.getElementById('auth-modal');
  if (!modal || modal.classList.contains('hidden')) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    closeAuthModal();
    return;
  }

  if (event.key === 'Tab') {
    const focusable = [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

document.getElementById('auth-modal')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeAuthModal();
});

document.querySelector('.auth-tabs')?.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === 'Home' || event.key === 'ArrowLeft' ? 'login' : 'signup';
  switchAuthTab(target);
  document.getElementById(target === 'login' ? 'tab-login' : 'tab-signup')?.focus();
});

/* ==========================================
   GOOGLE SIGN-IN
   Google -> Supabase checks it -> the database says which student this is
   (student_google_login) -> the same student session the password login gives.
   The temporary Supabase sign-in is then dropped so the rest of the site works as before.
   ========================================== */
async function signInWithGoogle() {
  const errorDiv = document.getElementById('login-error');
  const button = document.getElementById('google-btn');
  if (errorDiv) errorDiv.classList.add('hidden');
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.querySelector('span').textContent = 'Connecting to Google…';
  }
  try {
    sessionStorage.setItem('google_login_pending', '1');
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { prompt: 'select_account' }
      }
    });
    if (error) throw error;
  } catch (e) {
    sessionStorage.removeItem('google_login_pending');
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.querySelector('span').textContent = 'Continue with Google';
    }
    if (errorDiv) {
      errorDiv.textContent = 'Could not start Google sign-in. Please try again.';
      errorDiv.classList.remove('hidden');
    }
  }
}

// Runs when the page loads after coming back from Google. Returns true if a student was signed in.
async function finishGoogleLogin() {
  if (!sessionStorage.getItem('google_login_pending')) return false;
  sessionStorage.removeItem('google_login_pending');

  try {
    const { data: sessionData } = await supabaseClient.auth.getSession();
    if (!sessionData || !sessionData.session) return false;

    const { data, error } = await supabaseClient.rpc('student_google_login');
    await supabaseClient.auth.signOut({ scope: 'local' }); // the temporary sign-in is no longer needed

    if (error || !data || data.ok !== true) {
      openAuthModal('login');
      const errorDiv = document.getElementById('login-error');
      if (errorDiv) {
        errorDiv.textContent = 'Google sign-in did not finish. Please try again.';
        errorDiv.classList.remove('hidden');
      }
      return false;
    }

    startStudentSession(data.student, data.token);
    return true;
  } catch (e) {
    console.warn('Google sign-in error:', e);
    return false;
  }
}

// Remember the logged-in student in this tab and show the dashboard.
// Only harmless details are kept in the browser (never the password).
function startStudentSession(student, token) {
  const safeStudent = {
    id: student.id,
    username: student.username,
    full_name: student.full_name,
    phone_number: student.phone_number,
    active_session_token: token
  };

  sessionStorage.setItem('student_user', JSON.stringify(safeStudent));
  sessionStorage.setItem('studentId', safeStudent.id);
  sessionStorage.setItem('sessionToken', token);

  currentStudentUser = safeStudent;
  closeAuthModal();
  updateUIForUser(safeStudent);
  startGlobalSessionGuard();
}

// Teacher login from the normal sign-in box (teachers use an email address, students never do)
async function handleTeacherLogin(email, password, errorDiv) {
  const show = (message) => {
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
  };

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      show(/invalid login credentials/i.test(error.message || '')
        ? 'Invalid email or password.'
        : 'Sign-in problem: ' + (error.message || 'unknown error'));
      return;
    }

    const { data: isAdmin } = await supabaseClient.rpc('is_admin');
    if (isAdmin !== true) {
      await supabaseClient.auth.signOut();
      show('This account is not allowed to manage the site.');
      return;
    }

    // The dashboard page sees the teacher is already signed in and opens straight away
    window.location.href = 'admin.html';
  } catch (e) {
    show('Could not reach the server. Please check your internet and try again.');
  }
}

// Login Handler
async function handleLogin(event) {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  const errorDiv = document.getElementById('login-error');
  setAuthButtonBusy(submitButton, true, 'Signing in…');

  try {
  const identifier = document.getElementById('username-input').value.trim();
  const password = document.getElementById('password-input').value.trim();

  errorDiv.classList.add('hidden');

  // Teacher shortcut: an email address in this box means "teacher login".
  // The teacher signs in right here and is taken straight to the dashboard.
  if (identifier.includes('@')) {
    await handleTeacherLogin(identifier, document.getElementById('password-input').value, errorDiv);
    return;
  }

  // The server checks the password and starts the session (the database is never read directly)
  const { data, error } = await supabaseClient.rpc('student_login', {
    p_identifier: identifier,
    p_password: password
  });

  if (error || !data) {
    errorDiv.textContent = 'Could not reach the server. Please check your internet and try again.';
    errorDiv.classList.remove('hidden');
    return;
  }

  if (data.ok !== true) {
    errorDiv.textContent = data.error === 'locked'
      ? 'Too many wrong attempts. Please wait 15 minutes and try again.'
      : 'Invalid username/phone or password. Please check your credentials.';
    errorDiv.classList.remove('hidden');
    return;
  }

  startStudentSession(data.student, data.token);
  } catch (error) {
    console.error('Sign-in failed:', error);
    errorDiv.textContent = 'Could not reach the server. Please check your internet and try again.';
    errorDiv.classList.remove('hidden');
  } finally {
    setAuthButtonBusy(submitButton, false);
  }
}

/* ==========================================
   UI DASHBOARD & COURSE RENDERING
   ========================================== */

// Master Load Data & Render Dashboard
async function updateUIForUser(student) {
  currentStudentUser = student;

  const loginBtn = document.getElementById('nav-login-btn');
  const userProfile = document.getElementById('nav-user-profile');
  const userNameEl = document.getElementById('nav-user-name');

  const heroBadge = document.getElementById('hero-badge');
  const heroTitle = document.getElementById('hero-title');
  const heroSubtitle = document.getElementById('hero-subtitle');
  const heroCtaBtn = document.getElementById('hero-cta-btn');

  const enrolledSec = document.getElementById('enrolled-section');
  const missingSec = document.getElementById('missing-section');

  missingSec?.classList.remove('hidden');

  // Parallelize initial fetch calls to eliminate network waterfalls
  const fetchPromises = [
    supabaseClient.from('subjects').select(SUBJECT_COLUMNS)
  ];

  if (window.CatalogFilter) {
    fetchPromises.push(window.CatalogFilter.init());
  }

  if (student) {
    fetchPromises.push(
      supabaseClient.rpc('get_my_course_ids', {
        p_id: student.id,
        p_token: sessionStorage.getItem('sessionToken') || ''
      })
    );
  }

  const results = await Promise.all(fetchPromises);
  const subjectsRes = results[0];
  allSubjectsCache = subjectsRes?.data || [];

  if (student) {
    loginBtn?.classList.add('hidden');
    userProfile?.classList.remove('hidden');
    if (userNameEl) userNameEl.textContent = student.full_name;
    if (window.StudentProfile) window.StudentProfile.attach(student);
    if (window.QuizModule) window.QuizModule.attach(student);

    if (heroBadge) heroBadge.innerHTML = '<i class="fa-solid fa-graduation-cap"></i> Student Dashboard';
    if (heroTitle) heroTitle.textContent = `Welcome back, ${student.full_name}!`;
    if (heroSubtitle) heroSubtitle.textContent = 'Manage your enrolled coursework, explore free reading books, or expand your study list.';
    if (heroCtaBtn) {
      heroCtaBtn.innerHTML = '<i class="fa-solid fa-circle-play"></i> Jump to Enrolled Subjects';
      heroCtaBtn.onclick = () => scrollToSection('enrolled-section');
    }

    enrolledSec?.classList.remove('hidden');

    const enrollmentsRes = results[results.length - 1];
    userEnrollmentsSet = new Set(enrollmentsRes?.data?.ids || []);
  } else {
    loginBtn?.classList.remove('hidden');
    userProfile?.classList.add('hidden');

    if (heroBadge) heroBadge.innerHTML = '<i class="fa-solid fa-book"></i> Public Portal';
    if (heroTitle) heroTitle.textContent = 'Master Your Engineering & Academic Studies';
    if (heroSubtitle) heroSubtitle.textContent = 'Access live notes, curated course files, dynamic updates, and high-yield academic resources curated by top faculty.';
    if (heroCtaBtn) {
      heroCtaBtn.innerHTML = '<i class="fa-solid fa-book-open"></i> Browse Free Books';
      heroCtaBtn.onclick = () => scrollToSection('free-books-section');
    }

    enrolledSec?.classList.add('hidden');
    userEnrollmentsSet.clear();
    if (window.StudentProfile) window.StudentProfile.detach();
    if (window.QuizModule) window.QuizModule.detach();
  }

  applyCatalogFilters();
}

window.applyCatalogFilters = function() {
  let filtered = allSubjectsCache;
  if (window.CatalogFilter) {
    filtered = window.CatalogFilter.filterSubjects(allSubjectsCache);
  }
  renderCategorizedSections(filtered);
};

// Render Categorized Sections using DocumentFragments for high performance
function renderCategorizedSections(subjectsList) {
  const enrolledGrid = document.getElementById('enrolled-courses-list');
  const freeBooksGrid = document.getElementById('free-books-list');
  const missingGrid = document.getElementById('missing-courses-list');

  if (enrolledGrid) enrolledGrid.innerHTML = '';
  if (freeBooksGrid) freeBooksGrid.innerHTML = '';
  if (missingGrid) missingGrid.innerHTML = '';

  const fragEnrolled = document.createDocumentFragment();
  const fragFree = document.createDocumentFragment();
  const fragMissing = document.createDocumentFragment();

  let enrolledCount = 0;
  let freeCount = 0;
  let missingCount = 0;

  const validSubjects = subjectsList.filter(subject => Number(subject.total_pages || 0) > 0);
  const sortedSubjects = [...validSubjects].sort((a, b) => (b.total_pages || 0) - (a.total_pages || 0));

  sortedSubjects.forEach(subject => {
    const isFree = subject.is_free === true || Number(subject.price_npr) === 0;
    const isEnrolled = userEnrollmentsSet.has(subject.id);

    if (currentStudentUser) {
      // 1. If enrolled, show in Enrolled section
      if (isEnrolled) {
        renderCard(subject, fragEnrolled, 'enrolled');
        enrolledCount++;
      }
      
      // 2. If free, also show in Free Books section (even if enrolled)
      if (isFree) {
        renderCard(subject, fragFree, 'free');
        freeCount++;
      } else if (!isEnrolled) {
        // 3. Otherwise, if paid and not enrolled, show in Premium/Missing section
        renderCard(subject, fragMissing, 'missing');
        missingCount++;
      }
    } else {
      if (isFree) {
        renderCard(subject, fragFree, 'guest_free');
        freeCount++;
      } else {
        renderCard(subject, fragMissing, 'guest_premium');
        missingCount++;
      }
    }
  });

  if (enrolledGrid) {
    if (currentStudentUser && enrolledCount === 0) {
      enrolledGrid.innerHTML = '<p class="empty-text">No enrolled subjects match your filter selection.</p>';
    } else {
      enrolledGrid.appendChild(fragEnrolled);
    }
  }

  if (freeBooksGrid) {
    if (freeCount === 0) {
      freeBooksGrid.innerHTML = '<p class="empty-text">No free books found for this selection.</p>';
    } else {
      freeBooksGrid.appendChild(fragFree);
    }
  }

  if (missingGrid) {
    if (missingCount === 0) {
      missingGrid.innerHTML = '<p class="empty-text">No additional premium courses found for this selection.</p>';
    } else {
      missingGrid.appendChild(fragMissing);
    }
  }
}

// Render Course Card Element
function renderCard(subject, container, cardType) {
  const card = document.createElement('div');
  card.className = 'course-card';

  const tagSem = subject.semester ? ` • ${subject.semester} Sem` : '';
  const priceNpr = Number(subject.price_npr || 0);

  let badgeHTML = '';
  let buttonHTML = '';

  if (cardType === 'enrolled') {
    badgeHTML = '<span class="badge enrolled">Enrolled</span>';
    buttonHTML = `<button class="btn-card-action" onclick="openCourseViewer(currentStudentUser, '${subject.id}')"><i class="fa-solid fa-book-open"></i> Read Notes</button>`;
  } else if (cardType === 'free') {
    badgeHTML = '<span class="badge free">Free Book</span>';
    buttonHTML = `<button class="btn-card-action free" onclick="openCourseViewer(currentStudentUser, '${subject.id}')"><i class="fa-solid fa-eye"></i> View Material</button>`;
  } else if (cardType === 'guest_free') {
    badgeHTML = '<span class="badge free">Free Book</span>';
    buttonHTML = `<button class="btn-card-action free" onclick="openAuthModal('login')"><i class="fa-solid fa-right-to-bracket"></i> Login to Read</button>`;
  } else if (cardType === 'missing') {
    badgeHTML = `<span class="badge price">NPR ${priceNpr}</span>`;
    buttonHTML = `<button class="btn-card-action pay" onclick="openPaymentModal('${subject.id}')"><i class="fa-solid fa-qrcode"></i> Buy / Enroll</button>`;
  } else if (cardType === 'guest_premium') {
    badgeHTML = `<span class="badge price">NPR ${priceNpr}</span>`;
    buttonHTML = `<button class="btn-card-action pay" onclick="openAuthModal('login')"><i class="fa-solid fa-lock"></i> Login to Unlock</button>`;
  }

  card.innerHTML = `
    <div>
      <div class="course-header-row">
        <div class="course-title">${subject.subject_name}</div>
        ${badgeHTML}
      </div>
      <div class="course-meta">
        <i class="fa-regular fa-file-pdf accent-text"></i>
        <span>${subject.total_pages || 0} Pages${tagSem}</span>
      </div>
    </div>
    <div class="card-footer-action">
      ${buttonHTML}
    </div>
  `;

  container.appendChild(card);
}

// Payment QR Modal Handler
function openPaymentModal(subjectId) {
  if (!currentStudentUser) {
    openAuthModal('login');
    return;
  }

  const subject = allSubjectsCache.find(s => s.id === subjectId);
  if (!subject) return;

  activePaymentSubject = subject;
  const priceNpr = Number(subject.price_npr || 0);

  document.getElementById('pay-subject-title').textContent = `Enroll in ${subject.subject_name}`;
  document.getElementById('pay-price-npr').textContent = `NPR ${priceNpr}`;
  document.getElementById('payment-modal').classList.remove('hidden');
}

function closePaymentModal() {
  document.getElementById('payment-modal').classList.add('hidden');
  activePaymentSubject = null;
}

function confirmPaymentRequest() {
  if (!activePaymentSubject) return;
  const priceNpr = Number(activePaymentSubject.price_npr || 0);
  const text = `Hello Teacher, I want to enroll in "${activePaymentSubject.subject_name}" for NPR ${priceNpr}. My username/phone is: ${currentStudentUser?.contact_phone || currentStudentUser?.phone_number || currentStudentUser?.username || ''}. I have attached my payment voucher screenshot.`;
  window.open(`https://wa.me/9779826109280?text=${encodeURIComponent(text)}`, '_blank');
  closePaymentModal();
}

// Course Viewer Launcher
async function openCourseViewer(student, subjectId) {
  const subject = allSubjectsCache.find(s => s.id === subjectId);
  if (!subject || openingBook) return;
  openingBook = true;

  try {
    const sessionToken = sessionStorage.getItem('sessionToken') || student?.active_session_token || '';

    // The server only answers for free books or books this student is enrolled in
    const { data, error } = await supabaseClient.rpc('get_book_path', {
      p_id: student?.id,
      p_token: sessionToken,
      p_subject_id: subject.id
    });

    if (error || !data || data.ok !== true) {
      const reason = data && data.error;
      if (reason === 'not_enrolled') {
        alert('You are not enrolled in this course yet. Please contact the teacher to unlock it.');
      } else if (reason === 'bad_token') {
        alert('Your login has ended. Please log in again.');
      } else {
        alert('Could not open this book. Please check your internet and try again.');
      }
      return;
    }

    document.getElementById('homepage-section')?.classList.add('hidden');
    document.getElementById('reader-section')?.classList.remove('hidden');

    const sessionData = {
      studentName: student?.full_name || 'Guest User',
      studentPhone: student?.phone_number || '',
      username: student?.username || 'guest',
      subjectId: subject.id,
      subjectName: subject.subject_name,
      pdfPath: data.path,
      studentId: student?.id || 'guest',
      sessionToken
    };

    if (typeof window.initReader === 'function') {
      window.initReader(sessionData);
    }
  } finally {
    openingBook = false;
  }
}

function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

async function checkSession() {
  if (await finishGoogleLogin()) return;
  const savedUser = sessionStorage.getItem('student_user');
  if (savedUser) {
    currentStudentUser = JSON.parse(savedUser);
    updateUIForUser(currentStudentUser);
    startGlobalSessionGuard();
  } else {
    updateUIForUser(null);
  }
}

/* ==========================================
   EVENT LISTENERS
   ========================================== */
document.getElementById('login-form')?.addEventListener('submit', handleLogin);

// Direct Sign Up Form Listener
document.getElementById('phone-otp-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitButton = e.currentTarget.querySelector('[type="submit"]');
  const errorDiv = document.getElementById('login-error');
  setAuthButtonBusy(submitButton, true, 'Creating account…');

  try {
  
  const name = document.getElementById('signup-name').value.trim();
  const phone = document.getElementById('signup-phone').value.trim();
  const password = document.getElementById('signup-password').value.trim();
  const confirmPassword = document.getElementById('signup-confirm-password').value.trim();
  if (errorDiv) errorDiv.classList.add('hidden');

  if (password !== confirmPassword) {
    if (errorDiv) {
      errorDiv.textContent = 'Passwords do not match. Please re-enter carefully.';
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  const { data, error } = await supabaseClient.rpc('student_signup', {
    p_name: name,
    p_phone: phone,
    p_password: password
  });

  if (error || !data) {
    if (errorDiv) {
      errorDiv.textContent = 'Could not reach the server. Please check your internet and try again.';
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  if (data.ok !== true) {
    const messages = {
      exists: 'This phone number already has an account. Please sign in, or ask your teacher to reset your password.',
      invalid_name: 'Please enter your full name.',
      invalid_phone: 'Please enter a valid phone number.',
      weak_password: 'Your password must be at least 6 characters.'
    };
    if (errorDiv) {
      errorDiv.textContent = messages[data.error] || 'Account creation failed. Please try again.';
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  startStudentSession(data.student, data.token);
  } catch (error) {
    console.error('Sign-up failed:', error);
    if (errorDiv) {
      errorDiv.textContent = 'Could not reach the server. Please check your internet and try again.';
      errorDiv.classList.remove('hidden');
    }
  } finally {
    setAuthButtonBusy(submitButton, false);
  }
});

document.getElementById('dash-logout-btn')?.addEventListener('click', () => {
  sessionStorage.clear();
  supabaseClient.auth.signOut();
  location.reload();
});

document.getElementById('back-to-dash-btn')?.addEventListener('click', () => {
  document.getElementById('reader-section')?.classList.add('hidden');
  document.getElementById('homepage-section')?.classList.remove('hidden');
});

window.addEventListener('DOMContentLoaded', checkSession);

function toggleMissionDrawer() {
  const drawer = document.getElementById('mission-drawer');
  if (drawer) drawer.classList.toggle('hidden');
}

function switchMissionLang(lang) {
  const enBtn = document.getElementById('tab-btn-en');
  const neBtn = document.getElementById('tab-btn-ne');
  const enContent = document.getElementById('mission-content-en');
  const neContent = document.getElementById('mission-content-ne');

  if (lang === 'en') {
    enBtn.classList.add('active');
    neBtn.classList.remove('active');
    enContent.classList.remove('hidden');
    neContent.classList.add('hidden');
  } else {
    neBtn.classList.add('active');
    enBtn.classList.remove('active');
    neContent.classList.remove('hidden');
    enContent.classList.add('hidden');
  }
}

/* ==========================================================
   PIP THE CAT + auth modal helpers (visual only; no auth logic)
   - eyes follow the mouse (mouse only, never touch)
   - while typing, Pip "reads along" with the caret
   - one small head-shake when an error message appears
   - passwords are hidden again whenever the modal closes
   - mobile: the card shrinks to the visible area above the keyboard
   The paws-over-eyes reaction is pure CSS, driven by
   updateAuthBuddy() above (it reads the real input type).
   ========================================================== */
(function initAuthExtras() {
  const modal = document.getElementById('auth-modal');
  const cat = document.getElementById('auth-cat');
  if (!modal) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function look(x, y) {
    if (!cat) return;
    cat.style.setProperty('--lx', x.toFixed(2));
    cat.style.setProperty('--ly', y.toFixed(2));
  }

  /* 1. Eyes follow the mouse, limited to a small range */
  if (cat) {
    let frame = 0, px = 0, py = 0;
    document.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || reduceMotion.matches || modal.classList.contains('hidden')) return;
      px = e.clientX;
      py = e.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = cat.getBoundingClientRect();
        const dx = px - (r.left + r.width / 2);
        const dy = py - (r.top + r.height * 0.6);
        const dist = Math.hypot(dx, dy) || 1;
        const strength = Math.min(1, dist / 160);   // looks harder the farther the mouse is, capped
        look((dx / dist) * strength, (dy / dist) * strength);
      });
    }, { passive: true });

    /* 2. Typing: look down and slide along with the caret (works on phones too) */
    modal.addEventListener('input', (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || reduceMotion.matches) return;
      const pos = el.selectionStart == null ? el.value.length : el.selectionStart;
      look(clamp(-0.85 + (pos / 20) * 1.7, -0.85, 0.85), 0.8);
    });
    modal.addEventListener('focusout', () => look(0, 0));

    /* 3. Error message appears -> one small shake */
    const err = document.getElementById('login-error');
    if (err) {
      new MutationObserver(() => {
        if (err.classList.contains('hidden')) return;
        cat.classList.remove('is-oops');
        void cat.offsetWidth;            // restart the animation
        cat.classList.add('is-oops');
      }).observe(err, { attributes: true, attributeFilter: ['class'] });
      cat.addEventListener('animationend', (e) => {
        if (e.animationName === 'cat-nope') cat.classList.remove('is-oops');
      });
    }
  }

  /* 4. When the modal closes: re-hide any revealed password and re-centre Pip */
  function resetPasswordVisibility() {
    modal.querySelectorAll('.auth-password').forEach((input) => {
      if (input.type === 'password') return;
      input.type = 'password';
      const toggle = input.parentElement && input.parentElement.querySelector('.auth-password-toggle');
      if (!toggle) return;
      const icon = toggle.querySelector('i');
      if (icon) { icon.classList.add('fa-eye'); icon.classList.remove('fa-eye-slash'); }
      toggle.setAttribute('aria-label', 'Show password');
    });
    updateAuthBuddy();
  }
  new MutationObserver(() => {
    if (!modal.classList.contains('hidden')) return;
    look(0, 0);
    resetPasswordVisibility();
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });

  /* 5. Phones: keep the card inside the visible area when the keyboard is open */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const setHeight = () => {
      if (vv.scale > 1.01) return;   // ignore pinch-zoom
      document.documentElement.style.setProperty('--au-vh', vv.height + 'px');
    };
    vv.addEventListener('resize', setHeight);
    setHeight();
  }
  modal.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !window.matchMedia('(max-width: 520px)').matches) return;
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' }), 300);
  });
})();
