// State variables
let currentStudentUser = null;
let allSubjectsCache = [];
let userEnrollmentsSet = new Set();
let activePaymentSubject = null;
let globalSessionGuardInterval = null;

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
      const { data, error } = await supabaseClient
        .from('students')
        .select('active_session_token')
        .eq('id', studentId)
        .single();

      if (error || !data || data.active_session_token !== sessionToken) {
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
  if (input.type === 'password') {
    input.type = 'text';
    iconElement.classList.remove('fa-eye');
    iconElement.classList.add('fa-eye-slash');
  } else {
    input.type = 'password';
    iconElement.classList.remove('fa-eye-slash');
    iconElement.classList.add('fa-eye');
  }
}

function openAuthModal(defaultTab = 'login') {
  switchAuthTab(defaultTab);
  document.getElementById('auth-modal').classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.add('hidden');
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
  } else {
    loginForm?.classList.add('hidden');
    signupContainer?.classList.remove('hidden');
    tabLogin?.classList.remove('active');
    tabSignup?.classList.add('active');
  }
}

// Login Handler
async function handleLogin(event) {
  event.preventDefault();
  
  const identifier = document.getElementById('username-input').value.trim();
  const password = document.getElementById('password-input').value.trim();
  const errorDiv = document.getElementById('login-error');

  errorDiv.classList.add('hidden');

  if (identifier === 'adminisgod' && password === 'godisadmin') {
    window.location.href = 'admin.html';
    return;
  }

  const cleanPhone = identifier.replace(/[^0-9]/g, '');

  const { data: students, error } = await supabaseClient
    .from('students')
    .select('*')
    .eq('password', password)
    .or(`username.eq.${identifier},phone_number.eq.${identifier},username.eq.${cleanPhone},full_name.ilike.%${identifier}%`);

  if (error || !students || students.length === 0) {
    errorDiv.textContent = 'Invalid username/phone or password. Please check your credentials.';
    errorDiv.classList.remove('hidden');
    return;
  }

  const student = students[0];
  const sessionToken = crypto.randomUUID();

  await supabaseClient
    .from('students')
    .update({ active_session_token: sessionToken })
    .eq('id', student.id);

  student.active_session_token = sessionToken;
  sessionStorage.setItem('student_user', JSON.stringify(student));
  sessionStorage.setItem('studentId', student.id);
  sessionStorage.setItem('sessionToken', sessionToken);

  currentStudentUser = student;
  closeAuthModal();
  updateUIForUser(student);
  startGlobalSessionGuard();
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

  // Fetch complete catalog
  const { data: subjects } = await supabaseClient.from('subjects').select('*');
  allSubjectsCache = subjects || [];

  if (window.CatalogFilter) {
    await window.CatalogFilter.init();
  }

  missingSec?.classList.remove('hidden');

  if (student) {
    loginBtn?.classList.add('hidden');
    userProfile?.classList.remove('hidden');
    if (userNameEl) userNameEl.textContent = student.full_name;

    if (heroBadge) heroBadge.innerHTML = '<i class="fa-solid fa-graduation-cap"></i> Student Dashboard';
    if (heroTitle) heroTitle.textContent = `Welcome back, ${student.full_name}!`;
    if (heroSubtitle) heroSubtitle.textContent = 'Manage your enrolled coursework, explore free reading books, or expand your study list.';
    if (heroCtaBtn) {
      heroCtaBtn.innerHTML = '<i class="fa-solid fa-circle-play"></i> Jump to Enrolled Subjects';
      heroCtaBtn.onclick = () => scrollToSection('enrolled-section');
    }

    enrolledSec?.classList.remove('hidden');

    const { data: enrollments } = await supabaseClient
      .from('student_courses')
      .select('subject_id')
      .eq('student_id', student.id);

    userEnrollmentsSet = new Set((enrollments || []).map(e => e.subject_id));
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

// Render Categorized Sections
function renderCategorizedSections(subjectsList) {
  const enrolledGrid = document.getElementById('enrolled-courses-list');
  const freeBooksGrid = document.getElementById('free-books-list');
  const missingGrid = document.getElementById('missing-courses-list');

  if (enrolledGrid) enrolledGrid.innerHTML = '';
  if (freeBooksGrid) freeBooksGrid.innerHTML = '';
  if (missingGrid) missingGrid.innerHTML = '';

  let enrolledCount = 0;
  let freeCount = 0;
  let missingCount = 0;

  const validSubjects = subjectsList.filter(subject => Number(subject.total_pages || 0) > 0);
  const sortedSubjects = [...validSubjects].sort((a, b) => (b.total_pages || 0) - (a.total_pages || 0));

  sortedSubjects.forEach(subject => {
    const isFree = subject.is_free === true || Number(subject.price_npr) === 0;
    const isEnrolled = userEnrollmentsSet.has(subject.id);

    if (currentStudentUser) {
      if (isEnrolled) {
        if (enrolledGrid) renderCard(subject, enrolledGrid, 'enrolled');
        enrolledCount++;
      } else if (isFree) {
        if (freeBooksGrid) renderCard(subject, freeBooksGrid, 'free');
        freeCount++;
      } else {
        if (missingGrid) renderCard(subject, missingGrid, 'missing');
        missingCount++;
      }
    } else {
      if (isFree) {
        if (freeBooksGrid) renderCard(subject, freeBooksGrid, 'guest_free');
        freeCount++;
      } else {
        if (missingGrid) renderCard(subject, missingGrid, 'guest_premium');
        missingCount++;
      }
    }
  });

  if (currentStudentUser && enrolledCount === 0 && enrolledGrid) {
    enrolledGrid.innerHTML = '<p class="empty-text">No enrolled subjects match your filter selection.</p>';
  }
  if (freeCount === 0 && freeBooksGrid) {
    freeBooksGrid.innerHTML = '<p class="empty-text">No free books found for this selection.</p>';
  }
  if (missingCount === 0 && missingGrid) {
    missingGrid.innerHTML = '<p class="empty-text">No additional premium courses found for this selection.</p>';
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
  const text = `Hello Teacher, I want to enroll in "${activePaymentSubject.subject_name}" for NPR ${priceNpr}. My username/phone is: ${currentStudentUser?.phone_number || ''}. I have attached my payment voucher screenshot.`;
  window.open(`https://wa.me/9779826109280?text=${encodeURIComponent(text)}`, '_blank');
  closePaymentModal();
}

// Course Viewer Launcher
function openCourseViewer(student, subjectId) {
  const subject = allSubjectsCache.find(s => s.id === subjectId);
  if (!subject) return;

  document.getElementById('homepage-section')?.classList.add('hidden');
  document.getElementById('reader-section')?.classList.remove('hidden');

  const sessionData = {
    studentName: student?.full_name || 'Guest User',
    studentPhone: student?.phone_number || '',
    username: student?.username || 'guest',
    subjectName: subject.subject_name,
    pdfPath: subject.pdf_storage_path,
    studentId: student?.id || 'guest',
    sessionToken: sessionStorage.getItem('sessionToken') || student?.active_session_token || ''
  };

  if (typeof window.initReader === 'function') {
    window.initReader(sessionData);
  }
}

function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

function checkSession() {
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
  
  const name = document.getElementById('signup-name').value.trim();
  const phone = document.getElementById('signup-phone').value.trim();
  const password = document.getElementById('signup-password').value.trim();
  const confirmPassword = document.getElementById('signup-confirm-password').value.trim();
  const errorDiv = document.getElementById('login-error');

  if (errorDiv) errorDiv.classList.add('hidden');

  if (password !== confirmPassword) {
    if (errorDiv) {
      errorDiv.textContent = 'Passwords do not match. Please re-enter carefully.';
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  const generatedUsername = phone.replace(/[^0-9]/g, '');
  const sessionToken = crypto.randomUUID();
  
  const studentPayload = {
    username: generatedUsername,
    password,
    full_name: name,
    phone_number: phone,
    active_session_token: sessionToken
  };

  const { data: student, error: insertError } = await supabaseClient
    .from('students')
    .upsert([studentPayload], { onConflict: 'username' })
    .select()
    .single();

  if (insertError) {
    if (errorDiv) {
      errorDiv.textContent = `Account creation failed: ${insertError.message}`;
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  sessionStorage.setItem('student_user', JSON.stringify(student));
  sessionStorage.setItem('studentId', student.id);
  sessionStorage.setItem('sessionToken', sessionToken);

  currentStudentUser = student;
  closeAuthModal();
  updateUIForUser(student);
  startGlobalSessionGuard();
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