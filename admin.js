let globalSubjects = [];
let globalStreams = [];
let selectedSubjectsCart = [];
let globalStudents = [];
let activeStudentId = null;

// Configure PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

async function initAdmin() {
  await fetchStreamsAndSubjects();
  await fetchStudents();
}

async function fetchStreamsAndSubjects() {
  const { data: streams } = await supabaseClient.from('streams').select('*');
  const { data: subjects } = await supabaseClient.from('subjects').select('*');

  globalStreams = streams || [];
  globalSubjects = subjects || [];
}

// Cascading Level Change
function handleClassChange(prefix) {
  const classVal = document.getElementById(`${prefix}-class`).value;
  const streamSelect = document.getElementById(`${prefix}-stream`);
  const semesterGroup = document.getElementById(`${prefix}-semester-group`);

  streamSelect.innerHTML = '<option value="">-- Select Stream --</option>';
  streamSelect.disabled = !classVal;

  if (prefix === 'stu') {
    document.getElementById('stu-subject-picklist').innerHTML = 
      '<p style="color:var(--text-muted); font-size:0.85rem; padding: 10px; text-align: center;">Select Level and Stream above to view available subjects.</p>';
  } else if (prefix === 'upload') {
    const uploadSubject = document.getElementById('upload-subject');
    uploadSubject.innerHTML = '<option value="">-- Select Hierarchy First --</option>';
    uploadSubject.disabled = true;
  }

  if (classVal === 'bachelor') {
    semesterGroup.classList.remove('hidden');
  } else {
    semesterGroup.classList.add('hidden');
    const semSelect = document.getElementById(`${prefix}-semester`);
    if (semSelect) semSelect.value = '';
  }

  if (!classVal) return;

  const filteredStreams = globalStreams.filter(s => s.class_level === classVal);
  filteredStreams.forEach(stream => {
    const opt = document.createElement('option');
    opt.value = stream.id;
    opt.textContent = stream.stream_name;
    streamSelect.appendChild(opt);
  });
}

// Cascading Stream Change
function handleStreamChange(prefix) {
  const classVal = document.getElementById(`${prefix}-class`).value;
  
  if (prefix === 'stu') {
    loadAvailableSubjects('stu');
  } else if (prefix === 'upload') {
    if (classVal !== 'bachelor') {
      loadUploadSubjects();
    }
  }
}

// Load Picklist Items for Student Account Creation
function loadAvailableSubjects(prefix) {
  const classVal = document.getElementById('stu-class').value;
  const streamId = document.getElementById('stu-stream').value;
  const semesterVal = document.getElementById('stu-semester').value;
  const picklist = document.getElementById('stu-subject-picklist');

  picklist.innerHTML = '';

  if (!classVal || !streamId || (classVal === 'bachelor' && !semesterVal)) {
    picklist.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding: 10px; text-align: center;">Complete level, stream, and semester selections above.</p>';
    return;
  }

  const filtered = globalSubjects.filter(sub => {
    const matchClass = sub.class_level === classVal;
    const matchStream = sub.stream_id === streamId;
    const matchSem = classVal === 'bachelor' ? sub.semester === semesterVal : true;
    return matchClass && matchStream && matchSem;
  });

  if (filtered.length === 0) {
    picklist.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding: 10px; text-align: center;">No subjects found for this selection. Use "Create New Subject" button to add one.</p>';
    return;
  }

  const streamObj = globalStreams.find(s => s.id === streamId);
  const streamName = streamObj ? streamObj.stream_name : '';

  filtered.forEach(subject => {
    const isAdded = selectedSubjectsCart.some(s => s.id === subject.id);
    
    const item = document.createElement('div');
    item.className = `picklist-item ${isAdded ? 'added' : ''}`;
    
    const tagInfo = classVal === 'bachelor' ? `${streamName} | ${semesterVal} Sem` : `${streamName}`;

    item.innerHTML = `
      <div class="picklist-title">
        ${subject.subject_name}
        <span class="picklist-tag">${tagInfo}</span>
      </div>
      <button type="button" class="btn-toggle-add ${isAdded ? 'added' : ''}" onclick="toggleSubjectCart('${subject.id}')">
        ${isAdded ? '✓ Added' : '➕ Add'}
      </button>
    `;

    picklist.appendChild(item);
  });
}

function toggleSubjectCart(subjectId) {
  const subject = globalSubjects.find(s => s.id === subjectId);
  if (!subject) return;

  const index = selectedSubjectsCart.findIndex(s => s.id === subjectId);
  if (index > -1) {
    selectedSubjectsCart.splice(index, 1);
  } else {
    const streamObj = globalStreams.find(s => s.id === subject.stream_id);
    selectedSubjectsCart.push({
      ...subject,
      stream_name: streamObj ? streamObj.stream_name : ''
    });
  }

  renderCart();
  loadAvailableSubjects('stu');
}

function renderCart() {
  const cartContainer = document.getElementById('stu-cart-container');
  cartContainer.innerHTML = '';

  if (selectedSubjectsCart.length === 0) {
    cartContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding: 10px; text-align: center;">No subjects added yet. Use the ➕ buttons above to add subjects.</p>';
    return;
  }

  selectedSubjectsCart.forEach(subject => {
    const badge = document.createElement('div');
    badge.className = 'cart-badge';
    
    const metaTag = subject.class_level === 'bachelor' 
      ? `${subject.stream_name} - ${subject.semester} Sem` 
      : `${subject.stream_name}`;

    badge.innerHTML = `
      <span>🏷️ <b>${subject.subject_name}</b> <small>(${metaTag})</small></span>
      <span class="cart-badge-remove" onclick="toggleSubjectCart('${subject.id}')">✕</span>
    `;
    
    cartContainer.appendChild(badge);
  });
}

function loadUploadSubjects() {
  const classVal = document.getElementById('upload-class').value;
  const streamId = document.getElementById('upload-stream').value;
  const semesterVal = document.getElementById('upload-semester').value;
  const uploadSubject = document.getElementById('upload-subject');

  uploadSubject.innerHTML = '<option value="">-- Select Subject --</option>';

  if (!classVal || !streamId || (classVal === 'bachelor' && !semesterVal)) {
    uploadSubject.disabled = true;
    return;
  }

  const filtered = globalSubjects.filter(sub => {
    const matchClass = sub.class_level === classVal;
    const matchStream = sub.stream_id === streamId;
    const matchSem = classVal === 'bachelor' ? sub.semester === semesterVal : true;
    return matchClass && matchStream && matchSem;
  });

  filtered.forEach(subject => {
    const opt = document.createElement('option');
    opt.value = subject.id;
    opt.textContent = subject.subject_name;
    uploadSubject.appendChild(opt);
  });

  uploadSubject.disabled = false;
}

function toggleModalSemesterField() {
  const classLevel = document.getElementById('modal-class').value;
  const semGroup = document.getElementById('modal-semester-group');
  if (classLevel === 'bachelor') {
    semGroup.classList.remove('hidden');
  } else {
    semGroup.classList.add('hidden');
  }
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

async function addNewSubject() {
  const classLevel = document.getElementById('modal-class').value;
  const semesterVal = classLevel === 'bachelor' ? document.getElementById('modal-semester').value : null;
  const streamName = document.getElementById('modal-stream').value.trim();
  const subjectName = document.getElementById('modal-subject-name').value.trim();

  if (!streamName || !subjectName) {
    alert('Please complete stream and subject names.');
    return;
  }

  const cleanStreamName = streamName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const cleanSubjectName = subjectName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  
  const streamId = `${classLevel}-${cleanStreamName}`;
  const rawSubjectId = classLevel === 'bachelor' 
    ? `${streamId}-${semesterVal}-${cleanSubjectName}` 
    : `${streamId}-${cleanSubjectName}`;

  try {
    await supabaseClient
      .from('streams')
      .upsert([{ id: streamId, class_level: classLevel, stream_name: streamName }]);

    const { error } = await supabaseClient
      .from('subjects')
      .insert([{
        id: rawSubjectId,
        subject_name: subjectName,
        pdf_storage_path: `${rawSubjectId}/notes.pdf`,
        class_level: classLevel,
        stream_id: streamId,
        semester: semesterVal
      }]);

    if (error) throw error;

    alert(`✅ Subject "${subjectName}" created successfully!`);
    closeModal('subject-modal');
    
    await fetchStreamsAndSubjects();
    handleClassChange('stu');
    handleClassChange('upload');

  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// Student Form Submission
document.getElementById('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const name = document.getElementById('stu-name').value.trim();
  const phone = document.getElementById('stu-phone').value.trim();
  const username = document.getElementById('stu-username').value.trim();
  const password = document.getElementById('stu-password').value.trim();
  const display = document.getElementById('account-status-display');

  if (selectedSubjectsCart.length === 0) {
    alert('Please select at least one subject to enroll the student.');
    return;
  }

  display.style.color = 'var(--text-muted)';
  display.textContent = 'Processing student account and subject enrollments...';

  try {
    let { data: student, error } = await supabaseClient
      .from('students')
      .insert([{ username, password, full_name: name, phone_number: phone }])
      .select()
      .single();

    if (error && error.code === '23505') { 
      const { data: existing, error: fetchErr } = await supabaseClient
        .from('students')
        .select('*')
        .eq('username', username)
        .single();
      
      if (fetchErr || !existing) throw new Error('Could not fetch existing account.');
      student = existing;
    } else if (error) {
      throw error;
    }

    const courseMappings = selectedSubjectsCart.map(sub => ({
      student_id: student.id,
      subject_id: sub.id
    }));

    const { error: enrollError } = await supabaseClient
      .from('student_courses')
      .upsert(courseMappings, { onConflict: 'student_id,subject_id' });

    if (enrollError) throw enrollError;

    display.style.color = 'var(--success)';
    display.innerHTML = `✅ Success! Student Enrolled into ${selectedSubjectsCart.length} Subject(s).<br>Username: <b>${username}</b> | Password: <b>${password}</b>`;
    
    e.target.reset();
    selectedSubjectsCart = [];
    renderCart();
    handleClassChange('stu');
    await fetchStudents();

  } catch (err) {
    console.error(err);
    display.style.color = 'var(--danger)';
    display.textContent = `Error: ${err.message || 'Could not process enrollment.'}`;
  }
});

/**
 * Optimized CamScanner Image Compression Routine
 * Scaled down to 0.75 ratio and 0.40 quality to generate tiny file sizes
 */
async function compressCamScannerPdf(arrayBuffer, quality = 0.40, scale = 0.75) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const newPdfDoc = await PDFLib.PDFDocument.create();

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: scale });
    
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    await page.render({ canvasContext: context, viewport: viewport }).promise;

    const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
    const res = await fetch(jpegDataUrl);
    const jpegImageBytes = await res.arrayBuffer();

    const image = await newPdfDoc.embedJpg(jpegImageBytes);
    const newPage = newPdfDoc.addPage([viewport.width, viewport.height]);
    newPage.drawImage(image, {
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });
  }

  return await newPdfDoc.save({ useObjectStreams: true });
}

// Daily Document Update Logic
async function handleDocumentUpdate() {
  const subjectId = document.getElementById('upload-subject').value;
  const mode = document.getElementById('update-mode').value;
  const fileInput = document.getElementById('file-input');
  const statusDiv = document.getElementById('upload-status');

  if (!subjectId) {
    alert('Please select a subject first.');
    return;
  }

  if (!fileInput.files[0]) {
    alert('Please select a file to upload first.');
    return;
  }

  const newFile = fileInput.files[0];
  const storagePath = `${subjectId}/notes.pdf`;
  statusDiv.style.color = 'var(--text-main)';
  statusDiv.textContent = '⏳ Optimizing & Downsampling PDF... Please wait.';

  try {
    let finalPdfBytes;
    let finalPageCount = 0;

    if (mode === 'replace') {
      const arrayBuffer = await newFile.arrayBuffer();
      
      if (newFile.type === 'application/pdf') {
        finalPdfBytes = await compressCamScannerPdf(arrayBuffer, 0.40, 0.75);
      } else {
        const existingPdfDoc = await PDFLib.PDFDocument.create();
        let image;
        if (newFile.type.includes('jpeg') || newFile.type.includes('jpg')) {
          image = await existingPdfDoc.embedJpg(arrayBuffer);
        } else if (newFile.type.includes('png')) {
          image = await existingPdfDoc.embedPng(arrayBuffer);
        }
        const page = existingPdfDoc.addPage(PDFLib.PageSizes.A4);
        const { width, height } = page.getSize();
        const dims = image.scaleToFit(width - 40, height - 40);
        page.drawImage(image, {
          x: (width - dims.width) / 2,
          y: (height - dims.height) / 2,
          width: dims.width,
          height: dims.height,
        });
        finalPdfBytes = await existingPdfDoc.save({ useObjectStreams: true });
      }

      const tempDoc = await PDFLib.PDFDocument.load(finalPdfBytes);
      finalPageCount = tempDoc.getPageCount();
    } 
    else if (mode === 'append') {
      let existingPdfDoc;
      
      const { data: existingFile, error: downloadError } = await supabaseClient.storage
        .from(STORAGE_BUCKET)
        .download(storagePath);

      if (downloadError || !existingFile) {
        existingPdfDoc = await PDFLib.PDFDocument.create();
      } else {
        const existingBuffer = await existingFile.arrayBuffer();
        existingPdfDoc = await PDFLib.PDFDocument.load(existingBuffer, { ignoreEncryption: true });
      }

      const newFileBuffer = await newFile.arrayBuffer();

      if (newFile.type === 'application/pdf') {
        const compressedNewBytes = await compressCamScannerPdf(newFileBuffer, 0.40, 0.75);
        const tempDoc = await PDFLib.PDFDocument.load(compressedNewBytes);
        const copiedPages = await existingPdfDoc.copyPages(tempDoc, tempDoc.getPageIndices());
        copiedPages.forEach(page => existingPdfDoc.addPage(page));
      } 
      else if (newFile.type.includes('image')) {
        let image;
        if (newFile.type.includes('jpeg') || newFile.type.includes('jpg')) {
          image = await existingPdfDoc.embedJpg(newFileBuffer);
        } else if (newFile.type.includes('png')) {
          image = await existingPdfDoc.embedPng(newFileBuffer);
        }
        
        const page = existingPdfDoc.addPage(PDFLib.PageSizes.A4);
        const { width, height } = page.getSize();
        const dims = image.scaleToFit(width - 40, height - 40);
        
        page.drawImage(image, {
          x: (width - dims.width) / 2,
          y: (height - dims.height) / 2,
          width: dims.width,
          height: dims.height,
        });
      }

      finalPageCount = existingPdfDoc.getPageCount();
      finalPdfBytes = await existingPdfDoc.save({ useObjectStreams: true });
    }

    statusDiv.textContent = '☁️ Uploading compressed file to cloud storage...';
    const blob = new Blob([finalPdfBytes], { type: 'application/pdf' });
    
    const { error: uploadError } = await supabaseClient.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, blob, { upsert: true });

    if (uploadError) throw uploadError;

    await supabaseClient
      .from('subjects')
      .update({ total_pages: finalPageCount, last_updated: new Date() })
      .eq('id', subjectId);

    statusDiv.style.color = 'var(--success)';
    statusDiv.textContent = `✅ Success! Compressed & uploaded. Total pages: ${finalPageCount}`;
    fileInput.value = '';
  } catch (error) {
    console.error(error);
    statusDiv.style.color = 'var(--danger)';
    statusDiv.textContent = `❌ Error updating document: ${error.message}`;
  }
}

// Initialize student dropdown on page load
async function fetchStudents() {
  const { data: students, error } = await supabaseClient
    .from('students')
    .select('*')
    .order('full_name', { ascending: true });

  if (error) {
    console.error("Error fetching students:", error);
    return;
  }

  globalStudents = students || [];
  const select = document.getElementById('manage-student-select');
  if (!select) return;
  
  select.innerHTML = '<option value="">-- Select a Student --</option>';

  globalStudents.forEach(stu => {
    const opt = document.createElement('option');
    opt.value = stu.id;
    opt.textContent = `${stu.full_name} (@${stu.username})`;
    select.appendChild(opt);
  });
}

// Triggered when a student is selected from dropdown
async function handleStudentSelectChange() {
  const studentId = document.getElementById('manage-student-select').value;
  const container = document.getElementById('student-details-container');

  if (!studentId) {
    container.classList.add('hidden');
    activeStudentId = null;
    return;
  }

  activeStudentId = studentId;
  const student = globalStudents.find(s => s.id === studentId);
  document.getElementById('display-student-name').textContent = student ? student.full_name : '';
  
  container.classList.remove('hidden');
  await renderStudentEnrolledCourses(studentId);
}

// Fetch & Render enrolled subjects for active student
async function renderStudentEnrolledCourses(studentId) {
  const listContainer = document.getElementById('student-enrolled-list');
  listContainer.innerHTML = '<p style="color:var(--text-muted);">Loading enrollments...</p>';

  const { data: enrollments, error } = await supabaseClient
    .from('student_courses')
    .select('id, subject_id, subjects(*)')
    .eq('student_id', studentId);

  if (error) {
    listContainer.innerHTML = `<p style="color:var(--danger);">Error: ${error.message}</p>`;
    return;
  }

  if (!enrollments || enrollments.length === 0) {
    listContainer.innerHTML = '<p style="color:var(--text-muted); padding:10px;">No enrolled subjects for this student.</p>';
    return;
  }

  listContainer.innerHTML = '';
  enrollments.forEach(item => {
    const sub = item.subjects;
    if (!sub) return;

    const div = document.createElement('div');
    div.className = 'picklist-item';
    div.innerHTML = `
      <div class="picklist-title">
        <b>${sub.subject_name}</b>
        <span class="picklist-tag">${sub.class_level} | ${sub.semester || 'N/A'}</span>
      </div>
      <button type="button" class="btn-danger" style="padding:4px 10px; font-size:0.8rem; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;" onclick="removeSubjectFromStudent('${item.id}', '${sub.id}')">
        🗑️ Remove Course
      </button>
    `;
    listContainer.appendChild(div);
  });
}

// Fixed Remove subject from student 
async function removeSubjectFromStudent(enrollmentId, subjectId) {
  if (!confirm('Are you sure you want to remove this subject from the student?')) return;

  const { error } = await supabaseClient
    .from('student_courses')
    .delete()
    .eq('student_id', activeStudentId)
    .eq('subject_id', subjectId);

  if (error) {
    alert(`Error removing subject: ${error.message}`);
    console.error("Delete error:", error);
  } else {
    await renderStudentEnrolledCourses(activeStudentId);
  }
}

// Fixed Delete whole student account from database
async function deleteStudentAccount() {
  if (!activeStudentId) return;

  const student = globalStudents.find(s => s.id === activeStudentId);
  const studentName = student ? student.full_name : 'this student';

  if (!confirm(`🚨 Are you sure you want to permanently delete ${studentName}'s entire account? This action cannot be undone.`)) {
    return;
  }

  try {
    // Step 1: Delete student course enrollments
    const { error: coursesErr } = await supabaseClient
      .from('student_courses')
      .delete()
      .eq('student_id', activeStudentId);

    if (coursesErr) throw coursesErr;

    // Step 2: Delete the student profile
    const { error: studentErr } = await supabaseClient
      .from('students')
      .delete()
      .eq('id', activeStudentId);

    if (studentErr) throw studentErr;

    alert(`✅ ${studentName}'s account has been completely deleted.`);

    // Reset view & refresh list
    document.getElementById('student-details-container').classList.add('hidden');
    activeStudentId = null;
    await fetchStudents();

  } catch (err) {
    alert(`Error deleting student account: ${err.message}`);
    console.error("Account deletion error:", err);
  }
}

// Cascading UI logic for adding subject to selected student
function handleManageClassChange() {
  const classVal = document.getElementById('add-sub-class').value;
  const streamSelect = document.getElementById('add-sub-stream');
  const semGroup = document.getElementById('add-sub-sem-group');

  streamSelect.innerHTML = '<option value="">-- Select Stream --</option>';
  streamSelect.disabled = !classVal;

  if (classVal === 'bachelor') {
    semGroup.classList.remove('hidden');
  } else {
    semGroup.classList.add('hidden');
    const semSelect = document.getElementById('add-sub-semester');
    if (semSelect) semSelect.value = '';
    loadAddableSubjects();
  }

  if (!classVal) return;

  const filtered = globalStreams.filter(s => s.class_level === classVal);
  filtered.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.stream_name;
    streamSelect.appendChild(opt);
  });
}

function handleManageStreamChange() {
  const classVal = document.getElementById('add-sub-class').value;
  if (classVal !== 'bachelor') {
    loadAddableSubjects();
  }
}

function loadAddableSubjects() {
  const classVal = document.getElementById('add-sub-class').value;
  const streamId = document.getElementById('add-sub-stream').value;
  const semVal = document.getElementById('add-sub-semester').value;
  const subSelect = document.getElementById('add-sub-subject');

  subSelect.innerHTML = '<option value="">-- Select Subject --</option>';

  if (!classVal || !streamId || (classVal === 'bachelor' && !semVal)) {
    subSelect.disabled = true;
    return;
  }

  const filtered = globalSubjects.filter(sub => {
    const matchClass = sub.class_level === classVal;
    const matchStream = sub.stream_id === streamId;
    const matchSem = classVal === 'bachelor' ? sub.semester === semVal : true;
    return matchClass && matchStream && matchSem;
  });

  filtered.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.subject_name;
    subSelect.appendChild(opt);
  });

  subSelect.disabled = false;
}

// Save newly assigned subject to student
async function addSubjectToSelectedStudent() {
  const subjectId = document.getElementById('add-sub-subject').value;
  if (!activeStudentId || !subjectId) {
    alert('Select a subject to add.');
    return;
  }

  const { error } = await supabaseClient
    .from('student_courses')
    .upsert([{ student_id: activeStudentId, subject_id: subjectId }], { onConflict: 'student_id,subject_id' });

  if (error) {
    alert(`Error adding subject: ${error.message}`);
  } else {
    await renderStudentEnrolledCourses(activeStudentId);
    alert('✅ Subject added to student successfully!');
  }
}

window.addEventListener('DOMContentLoaded', initAdmin);