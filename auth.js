// Guest / Auth State Control
let currentStudentUser = null;

function openAuthModal(defaultTab = 'login') {
  switchAuthTab(defaultTab);
  document.getElementById('auth-modal').classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.add('hidden');
}

// Action guard for guest users
function requireAuthOrAction(actionType, courseSubject = null) {
  if (!currentStudentUser) {
    openAuthModal('login');
  } else {
    if (actionType === 'viewCourse' && courseSubject) {
      openCourseViewer(currentStudentUser, courseSubject);
    } else if (actionType === 'explore') {
      document.getElementById('enrolled-courses-list').scrollIntoView({ behavior: 'smooth' });
    }
  }
}

// Tab Switching Logic inside Modal
function switchAuthTab(tab) {
  const loginForm = document.getElementById('login-form');
  const signupContainer = document.getElementById('signup-form-container');
  const tabLogin = document.getElementById('tab-login');
  const tabSignup = document.getElementById('tab-signup');
  const errorDiv = document.getElementById('login-error');
  const successDiv = document.getElementById('login-success');

  errorDiv.classList.add('hidden');
  successDiv.classList.add('hidden');

  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    signupContainer.classList.add('hidden');
    tabLogin.classList.add('active');
    tabSignup.classList.remove('active');
  } else {
    loginForm.classList.add('hidden');
    signupContainer.classList.remove('hidden');
    tabLogin.classList.remove('active');
    tabSignup.classList.add('active');
  }
}

// Handle Standard Login
async function handleLogin(event) {
  event.preventDefault();
  
  const username = document.getElementById('username-input').value.trim();
  const password = document.getElementById('password-input').value.trim();
  const errorDiv = document.getElementById('login-error');

  errorDiv.classList.add('hidden');

  const { data: student, error } = await supabaseClient
    .from('students')
    .select('*')
    .eq('username', username)
    .eq('password', password)
    .single();

  if (error || !student) {
    errorDiv.textContent = 'Invalid username or password. Please try again.';
    errorDiv.classList.remove('hidden');
    return;
  }

  sessionStorage.setItem('student_user', JSON.stringify(student));
  currentStudentUser = student;
  closeAuthModal();
  updateUIForUser(student);
}

// 1. Send OTP to Phone
async function sendOtpCode() {
  const phone = document.getElementById('signup-phone').value.trim();
  const errorDiv = document.getElementById('login-error');
  const successDiv = document.getElementById('login-success');

  if (!phone) {
    errorDiv.textContent = 'Please enter a valid phone number with country code.';
    errorDiv.classList.remove('hidden');
    return;
  }

  errorDiv.classList.add('hidden');
  
  const { error } = await supabaseClient.auth.signInWithOtp({ phone: phone });

  if (error) {
    errorDiv.textContent = `OTP Request Error: ${error.message}`;
    errorDiv.classList.remove('hidden');
    return;
  }

  successDiv.textContent = '✅ Verification code sent via SMS.';
  successDiv.classList.remove('hidden');
  document.getElementById('otp-group').classList.remove('hidden');
  document.getElementById('complete-signup-btn').disabled = false;
}

// 2. Complete Phone + OTP Registration
document.getElementById('phone-otp-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const name = document.getElementById('signup-name').value.trim();
  const phone = document.getElementById('signup-phone').value.trim();
  const otp = document.getElementById('otp-input').value.trim();
  const password = document.getElementById('signup-password').value.trim();
  const errorDiv = document.getElementById('login-error');

  errorDiv.classList.add('hidden');

  const { error } = await supabaseClient.auth.verifyOtp({
    phone: phone,
    token: otp,
    type: 'sms'
  });

  if (error) {
    errorDiv.textContent = `Invalid OTP Code: ${error.message}`;
    errorDiv.classList.remove('hidden');
    return;
  }

  const generatedUsername = phone.replace(/[^0-9]/g, '');
  
  const { data: student, error: insertError } = await supabaseClient
    .from('students')
    .insert([{
      username: generatedUsername,
      password: password,
      full_name: name,
      phone_number: phone
    }])
    .select()
    .single();

  if (insertError) {
    errorDiv.textContent = `Account creation failed: ${insertError.message}`;
    errorDiv.classList.remove('hidden');
    return;
  }

  sessionStorage.setItem('student_user', JSON.stringify(student));
  currentStudentUser = student;
  closeAuthModal();
  updateUIForUser(student);
});

// Google OAuth Sign In
async function handleGoogleSignIn() {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });

  if (error) {
    const errorDiv = document.getElementById('login-error');
    errorDiv.textContent = `Google Sign-In Error: ${error.message}`;
    errorDiv.classList.remove('hidden');
  }
}

// Sync OAuth session callback
async function handleOAuthCallback() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    const user = session.user;
    
    let { data: student } = await supabaseClient
      .from('students')
      .select('*')
      .eq('username', user.email)
      .single();

    if (!student) {
      const { data: newStudent } = await supabaseClient
        .from('students')
        .insert([{
          username: user.email,
          password: 'OAuthAccount',
          full_name: user.user_metadata.full_name || 'Google User',
          phone_number: user.phone || ''
        }])
        .select()
        .single();
        
      student = newStudent;
    }

    if (student) {
      sessionStorage.setItem('student_user', JSON.stringify(student));
      currentStudentUser = student;
      updateUIForUser(student);
    }
  }
}

// Render Public Catalog OR Student's Specific Enrolled Courses
async function renderCourseCatalog(student = null) {
  const listContainer = document.getElementById('enrolled-courses-list');
  listContainer.innerHTML = '<p style="color:var(--text-muted); padding: 20px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading course catalog...</p>';

  if (student) {
    // Authenticated state: Load enrolled subjects
    const { data: enrollments, error } = await supabaseClient
      .from('student_courses')
      .select('*, subjects(*)')
      .eq('student_id', student.id);

    if (error || !enrollments || enrollments.length === 0) {
      listContainer.innerHTML = '<p style="color:var(--text-muted); padding: 20px;">No enrolled subjects found. Contact your teacher via the links below to get access.</p>';
      return;
    }

    listContainer.innerHTML = '';
    enrollments.forEach(item => {
      if (item.subjects) renderCourseCard(item.subjects, listContainer, true);
    });
  } else {
    // Guest State: Load all available subjects for public viewing
    const { data: subjects, error } = await supabaseClient
      .from('subjects')
      .select('*');

    if (error || !subjects || subjects.length === 0) {
      listContainer.innerHTML = '<p style="color:var(--text-muted); padding: 20px;">No public courses available right now.</p>';
      return;
    }

    listContainer.innerHTML = '';
    subjects.forEach(subject => {
      renderCourseCard(subject, listContainer, false);
    });
  }
}

function renderCourseCard(subject, container, isEnrolled) {
  const card = document.createElement('div');
  card.className = 'course-card';
  
  const tagSemester = subject.semester ? ` • ${subject.semester} Sem` : '';

  card.innerHTML = `
    <div>
      <div class="course-title">${subject.subject_name}</div>
      <div class="course-meta">
        <i class="fa-regular fa-file-pdf accent-text"></i>
        <span>${subject.total_pages || 0} Pages Available${tagSemester}</span>
      </div>
    </div>
    <div style="margin-top: 15px; display: flex; justify-content: space-between; align-items: center;">
      <span class="badge">${isEnrolled ? 'Enrolled' : 'Guest Preview'}</span>
      <i class="fa-solid fa-chevron-right accent-text"></i>
    </div>
  `;
  
  card.addEventListener('click', () => {
    requireAuthOrAction('viewCourse', subject);
  });
  
  container.appendChild(card);
}

function openCourseViewer(student, subject) {
  document.getElementById('homepage-section').classList.add('hidden');
  document.getElementById('reader-section').classList.remove('hidden');
  
  const sessionData = {
    studentName: student.full_name,
    studentPhone: student.phone_number,
    username: student.username,
    subjectName: subject.subject_name,
    pdfPath: subject.pdf_storage_path
  };

  window.initReader(sessionData);
}

function updateUIForUser(student) {
  if (student) {
    document.getElementById('nav-login-btn').classList.add('hidden');
    document.getElementById('nav-user-profile').classList.remove('hidden');
    document.getElementById('nav-user-name').textContent = student.full_name;
    renderCourseCatalog(student);
  } else {
    document.getElementById('nav-login-btn').classList.remove('hidden');
    document.getElementById('nav-user-profile').classList.add('hidden');
    renderCourseCatalog(null);
  }
}

function checkSession() {
  const savedUser = sessionStorage.getItem('student_user');
  if (savedUser) {
    currentStudentUser = JSON.parse(savedUser);
    updateUIForUser(currentStudentUser);
  } else {
    updateUIForUser(null);
    handleOAuthCallback();
  }
}

// Event Listeners
document.getElementById('login-form')?.addEventListener('submit', handleLogin);
document.getElementById('dash-logout-btn')?.addEventListener('click', () => {
  sessionStorage.clear();
  supabaseClient.auth.signOut();
  location.reload();
});
document.getElementById('back-to-dash-btn')?.addEventListener('click', () => {
  document.getElementById('reader-section').classList.add('hidden');
  document.getElementById('homepage-section').classList.remove('hidden');
});

window.addEventListener('DOMContentLoaded', checkSession);