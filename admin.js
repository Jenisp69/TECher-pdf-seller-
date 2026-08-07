const DEFAULT_CLASSES = [
  { id: '11', name: 'Class 11' },
  { id: '12', name: 'Class 12' },
  { id: 'bachelor', name: 'Bachelor Level' }
];

// Load persisted classes or fall back to default list
let globalClasses = JSON.parse(localStorage.getItem('admin_global_classes')) || DEFAULT_CLASSES;
let globalSubjects = [];
let globalStreams = [];
let selectedSubjectsCart = [];
let globalStudents = [];
let activeStudentId = null;

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

function saveClassesToStorage() {
  localStorage.setItem('admin_global_classes', JSON.stringify(globalClasses));
}

async function initAdmin() {
  await fetchStreamsAndSubjects();
  await fetchStudents();
  populateClassDropdowns();
}

function populateClassDropdowns() {
  const dropdownIds = ['mgr-class', 'stu-class', 'upload-class', 'add-sub-class'];

  dropdownIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    const currentVal = el.value;
    el.innerHTML = '<option value="">-- Select Class --</option>';

    globalClasses.forEach(cls => {
      const opt = document.createElement('option');
      opt.value = cls.id;
      opt.textContent = cls.name;
      el.appendChild(opt);
    });

    if (currentVal) el.value = currentVal;
  });
}

/* ==========================================
   Hierarchy & Dynamic Streams/Classes Manager
   ========================================== */

async function fetchStreamsAndSubjects() {
  const { data: streams } = await supabaseClient.from('streams').select('*');
  const { data: subjects } = await supabaseClient.from('subjects').select('*');

  globalStreams = streams || [];
  globalSubjects = subjects || [];
}

function handleClassChange(prefix) {
  const classVal = document.getElementById(`${prefix}-class`).value;
  const streamSelect = document.getElementById(`${prefix}-stream`);
  const semesterGroup = document.getElementById(`${prefix}-semester-group`);

  streamSelect.innerHTML = '<option value="">-- Select Stream --</option>';
  streamSelect.disabled = !classVal;

  if (prefix === 'mgr') {
    const addStreamBtn = document.getElementById('mgr-add-stream-btn');
    const addSubjectBtn = document.getElementById('mgr-add-subject-btn');
    if (addStreamBtn) addStreamBtn.disabled = !classVal;
    if (addSubjectBtn) addSubjectBtn.disabled = true;
    document.getElementById('mgr-subject-list').innerHTML = 
      '<p style="color:var(--text-muted); font-size:0.85rem; padding: 10px; text-align: center;">Select hierarchy above to list and manage subjects.</p>';
  } else if (prefix === 'stu') {
    document.getElementById('stu-subject-picklist').innerHTML = 
      '<p style="color:var(--text-muted); font-size:0.85rem; padding: 10px; text-align: center;">Select Level and Stream above to view available subjects.</p>';
  } else if (prefix === 'upload') {
    const uploadSubject = document.getElementById('upload-subject');
    uploadSubject.innerHTML = '<option value="">-- Select Hierarchy First --</option>';
    uploadSubject.disabled = true;
  }

  if (classVal === 'bachelor') {
    if (semesterGroup) semesterGroup.classList.remove('hidden');
  } else {
    if (semesterGroup) semesterGroup.classList.add('hidden');
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

function handleStreamChange(prefix) {
  const classVal = document.getElementById(`${prefix}-class`).value;
  const streamId = document.getElementById(`${prefix}-stream`).value;

  if (prefix === 'mgr') {
    const addSubjectBtn = document.getElementById('mgr-add-subject-btn');
    if (addSubjectBtn) addSubjectBtn.disabled = !streamId;
    if (classVal !== 'bachelor') {
      loadManagerSubjects();
    }
  } else if (prefix === 'stu') {
    loadAvailableSubjects('stu');
  } else if (prefix === 'upload') {
    if (classVal !== 'bachelor') {
      loadUploadSubjects();
    }
  }
}

/* Persistent Dynamic Class Handlers */
function promptAddNewClass() {
  const name = prompt("Enter New Level / Class Name (e.g. Master Level, Diploma):");
  if (!name || !name.trim()) return;

  const cleanName = name.trim();
  const val = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_');

  if (globalClasses.some(c => c.id === val)) {
    return alert('Level already exists.');
  }

  globalClasses.push({ id: val, name: cleanName });
  saveClassesToStorage();
  populateClassDropdowns();

  document.getElementById('mgr-class').value = val;
  handleClassChange('mgr');
}

async function renameSelectedClass() {
  const classVal = document.getElementById('mgr-class').value;
  if (!classVal) return alert('Please select a Class / Level to rename.');

  const clsObj = globalClasses.find(c => c.id === classVal);
  const newName = prompt('Enter new Level / Class Name:', clsObj ? clsObj.name : '');

  if (newName && newName.trim()) {
    clsObj.name = newName.trim();
    saveClassesToStorage();
    
    await supabaseClient
      .from('streams')
      .update({ class_level: classVal })
      .eq('class_level', classVal);

    populateClassDropdowns();
    document.getElementById('mgr-class').value = classVal;
    alert('✅ Level updated!');
  }
}

async function deleteSelectedClass() {
  const classVal = document.getElementById('mgr-class').value;
  if (!classVal) return alert('Please select a Class / Level to delete.');

  if (!confirm('🚨 Are you sure? Removing this Level will delete associated streams and subjects.')) return;

  try {
    const { data: streams } = await supabaseClient
      .from('streams')
      .select('id')
      .eq('class_level', classVal);
      
    if (streams && streams.length > 0) {
      const streamIds = streams.map(s => s.id);
      await supabaseClient.from('subjects').delete().in('stream_id', streamIds);
      await supabaseClient.from('streams').delete().eq('class_level', classVal);
    }

    globalClasses = globalClasses.filter(c => c.id !== classVal);
    saveClassesToStorage();
    populateClassDropdowns();
    handleClassChange('mgr');
    await fetchStreamsAndSubjects();
    alert('✅ Level and associated data removed.');
  } catch (err) {
    alert(`Error deleting level: ${err.message}`);
  }
}

async function promptAddNewStream() {
  const classVal = document.getElementById('mgr-class').value;
  if (!classVal) return alert('Please select a Level / Class first.');

  const streamName = prompt('Enter New Stream / Faculty Name:');
  if (!streamName || !streamName.trim()) return;

  const cleanStreamName = streamName.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  const streamId = `${classVal}-${cleanStreamName}`;

  try {
    const { error } = await supabaseClient
      .from('streams')
      .upsert([{ id: streamId, class_level: classVal, stream_name: streamName.trim() }]);

    if (error) throw error;

    alert(`✅ Stream "${streamName}" added successfully!`);
    await fetchStreamsAndSubjects();
    handleClassChange('mgr');
    document.getElementById('mgr-stream').value = streamId;
    handleStreamChange('mgr');

  } catch (err) {
    alert(`Error adding stream: ${err.message}`);
  }
}

async function promptAddNewSubject() {
  const classVal = document.getElementById('mgr-class').value;
  const streamId = document.getElementById('mgr-stream').value;
  const semVal = document.getElementById('mgr-semester').value;

  if (!classVal || !streamId) {
    return alert('Please select Class and Stream first.');
  }

  if (classVal === 'bachelor' && !semVal) {
    return alert('Please select a Semester for Bachelor level.');
  }

  const subjectName = prompt('Enter New Subject Name:');
  if (!subjectName || !subjectName.trim()) return;

  const priceInput = prompt('Enter Course Price in NPR (Enter 0 for Free):', '0');
  const priceNpr = parseFloat(priceInput) || 0;

  const cleanSubjectName = subjectName.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  const rawSubjectId = classVal === 'bachelor'
    ? `${streamId}-${semVal}-${cleanSubjectName}`
    : `${streamId}-${cleanSubjectName}`;

  try {
    const { error } = await supabaseClient
      .from('subjects')
      .insert([{
        id: rawSubjectId,
        subject_name: subjectName.trim(),
        pdf_storage_path: `${rawSubjectId}/notes.pdf`,
        class_level: classVal,
        stream_id: streamId,
        semester: classVal === 'bachelor' ? semVal : null,
        price_npr: priceNpr,
        is_free: priceNpr === 0
      }]);

    if (error) throw error;

    alert(`✅ Subject "${subjectName}" created with price NPR ${priceNpr}!`);
    await fetchStreamsAndSubjects();
    loadManagerSubjects();

  } catch (err) {
    alert(`Error adding subject: ${err.message}`);
  }
}

function loadManagerSubjects() {
  const classVal = document.getElementById('mgr-class').value;
  const streamId = document.getElementById('mgr-stream').value;
  const semVal = document.getElementById('mgr-semester').value;
  const listContainer = document.getElementById('mgr-subject-list');

  listContainer.innerHTML = '';

  if (!classVal || !streamId || (classVal === 'bachelor' && !semVal)) {
    listContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding: 10px; text-align: center;">Complete level, stream, and semester selections above.</p>';
    return;
  }

  const filtered = globalSubjects.filter(sub => {
    const matchClass = sub.class_level === classVal;
    const matchStream = sub.stream_id === streamId;
    const matchSem = classVal === 'bachelor' ? sub.semester === semVal : true;
    return matchClass && matchStream && matchSem;
  });

  if (filtered.length === 0) {
    listContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding: 10px; text-align: center;">No subjects found under this selection. Click ➕ Add Subject above to create one.</p>';
    return;
  }

  filtered.forEach(sub => {
    const item = document.createElement('div');
    item.className = 'picklist-item';
    item.innerHTML = `
      <div class="picklist-title">
        <b>${sub.subject_name}</b>
        <span class="picklist-tag">${sub.class_level} | ${sub.semester || 'All'} | NPR ${sub.price_npr || 0} (${sub.total_pages || 0} Pages)</span>
      </div>
      <div style="display:flex; gap:6px;">
        <button type="button" style="padding:4px 8px; font-size:0.75rem; width: auto;" onclick="editSubjectPrice('${sub.id}', ${sub.price_npr || 0})">💰 Price</button>
        <button type="button" style="padding:4px 8px; font-size:0.75rem; width: auto;" onclick="renameSubject('${sub.id}', '${sub.subject_name}')">✏️ Rename</button>
        <button type="button" class="btn-danger" style="padding:4px 8px; font-size:0.75rem; width: auto;" onclick="deleteSubject('${sub.id}', '${sub.subject_name}')">🗑️ Remove</button>
      </div>
    `;
    listContainer.appendChild(item);
  });
}

async function editSubjectPrice(subjectId, currentPrice) {
  const newPriceInput = prompt('Enter new Price in NPR (0 for Free):', currentPrice);
  if (newPriceInput === null) return;

  const newPrice = parseFloat(newPriceInput);
  if (isNaN(newPrice) || newPrice < 0) {
    return alert('Invalid price entered.');
  }

  const { error } = await supabaseClient
    .from('subjects')
    .update({ 
      price_npr: newPrice,
      is_free: newPrice === 0 
    })
    .eq('id', subjectId);

  if (error) {
    alert(`Error updating price: ${error.message}`);
  } else {
    alert(`✅ Price updated successfully! New Price: NPR ${newPrice}`);
    await fetchStreamsAndSubjects();
    loadManagerSubjects();
  }
}

async function renameSelectedStream() {
  const streamId = document.getElementById('mgr-stream').value;
  if (!streamId) return alert('Select a stream first.');

  const streamObj = globalStreams.find(s => s.id === streamId);
  const newName = prompt('Enter new Stream / Faculty name:', streamObj ? streamObj.stream_name : '');

  if (newName && newName.trim()) {
    const { error } = await supabaseClient
      .from('streams')
      .update({ stream_name: newName.trim() })
      .eq('id', streamId);

    if (error) alert(`Error: ${error.message}`);
    else {
      alert('✅ Stream renamed successfully!');
      await fetchStreamsAndSubjects();
      const currentClass = document.getElementById('mgr-class').value;
      handleClassChange('mgr');
      document.getElementById('mgr-class').value = currentClass;
      document.getElementById('mgr-stream').value = streamId;
    }
  }
}

async function deleteSelectedStream() {
  const streamId = document.getElementById('mgr-stream').value;
  if (!streamId) return alert('Select a stream first.');

  if (!confirm('🚨 Are you sure? Deleting a stream will remove ALL subjects attached to it!')) return;

  try {
    const { data: subs } = await supabaseClient.from('subjects').select('id').eq('stream_id', streamId);
    if (subs && subs.length > 0) {
      const subIds = subs.map(s => s.id);
      await supabaseClient.from('student_courses').delete().in('subject_id', subIds);
      await supabaseClient.from('subjects').delete().eq('stream_id', streamId);
    }

    const { error } = await supabaseClient.from('streams').delete().eq('id', streamId);
    if (error) throw error;

    alert('✅ Stream deleted successfully!');
    await fetchStreamsAndSubjects();
    handleClassChange('mgr');
  } catch (err) {
    alert(`Error deleting stream: ${err.message}`);
  }
}

async function renameSubject(subjectId, currentName) {
  const newName = prompt('Enter new Subject Name:', currentName);
  if (newName && newName.trim() && newName !== currentName) {
    const { error } = await supabaseClient
      .from('subjects')
      .update({ subject_name: newName.trim() })
      .eq('id', subjectId);

    if (error) alert(`Error: ${error.message}`);
    else {
      alert('✅ Subject renamed successfully!');
      await fetchStreamsAndSubjects();
      loadManagerSubjects();
    }
  }
}

async function deleteSubject(subjectId, subjectName) {
  if (!confirm(`🚨 Delete "${subjectName}"? Students enrolled in this course will lose access.`)) return;

  try {
    await supabaseClient.from('student_courses').delete().eq('subject_id', subjectId);

    const { error } = await supabaseClient.from('subjects').delete().eq('id', subjectId);
    if (error) throw error;

    alert(`✅ Subject "${subjectName}" removed.`);
    await fetchStreamsAndSubjects();
    loadManagerSubjects();
  } catch (err) {
    alert(`Error removing subject: ${err.message}`);
  }
}

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
    picklist.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding: 10px; text-align: center;">No subjects found for this selection.</p>';
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
        <span class="picklist-tag">${tagInfo} | NPR ${subject.price_npr || 0}</span>
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
      <span>🏷️ <b>${subject.subject_name}</b> <small>(${metaTag} - NPR ${subject.price_npr || 0})</small></span>
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
    opt.textContent = `${subject.subject_name} (NPR ${subject.price_npr || 0})`;
    uploadSubject.appendChild(opt);
  });

  uploadSubject.disabled = false;
}

document.getElementById('account-form')?.addEventListener('submit', async (e) => {
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
      .insert([{ 
        username, 
        password, 
        full_name: name, 
        phone_number: phone,
        active_session_token: null 
      }])
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

async function compressCamScannerPdf(arrayBuffer, quality = 0.65, scale = 1.2, onProgress = null) {
  const pdf = await pdfjsLib.getDocument({ 
    data: arrayBuffer,
    disableFontFace: true 
  }).promise;
  
  const newPdfDoc = await PDFLib.PDFDocument.create();

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    
    const baseViewport = page.getViewport({ scale: 1.0 });
    const renderViewport = page.getViewport({ scale: scale });
    
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    canvas.height = renderViewport.height;
    canvas.width = renderViewport.width;

    await page.render({ canvasContext: context, viewport: renderViewport }).promise;

    const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
    const res = await fetch(jpegDataUrl);
    const jpegImageBytes = await res.arrayBuffer();

    const image = await newPdfDoc.embedJpg(jpegImageBytes);
    
    const newPage = newPdfDoc.addPage([baseViewport.width, baseViewport.height]);
    newPage.drawImage(image, {
      x: 0,
      y: 0,
      width: baseViewport.width,
      height: baseViewport.height,
    });

    page.cleanup();

    if (onProgress) {
      onProgress(pageNum, pdf.numPages);
    }
  }

  return await newPdfDoc.save({ useObjectStreams: true });
}

async function handleDocumentUpdate(qualityMode = 'auto') {
  const subjectId = document.getElementById('upload-subject').value;
  const mode = document.getElementById('update-mode').value;
  const fileInput = document.getElementById('file-input');
  const statusDiv = document.getElementById('upload-status');
  const progressContainer = document.getElementById('progress-container');
  const progressBar = document.getElementById('progress-bar');

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

  let targetQuality = 0.65;
  let targetScale = 1.2;

  if (qualityMode === 'high') {
    targetQuality = 0.85;
    targetScale = 1.8;
  } else if (qualityMode === 'standard') {
    targetQuality = 0.50;
    targetScale = 1.0;
  } else if (qualityMode === 'auto') {
    targetQuality = 0.65;
    targetScale = 1.2;
  }

  statusDiv.style.color = 'var(--text-main)';
  statusDiv.textContent = `⏳ Preparing document (${qualityMode.toUpperCase()} mode)...`;
  if (progressContainer) progressContainer.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '0%';

  const updateProgress = (current, total, stage = 'Compressing') => {
    const percent = Math.round((current / total) * 100);
    if (progressBar) progressBar.style.width = `${percent}%`;
    statusDiv.textContent = `⚙️ ${stage} Page ${current} / ${total} (${percent}%)`;
  };

  try {
    let finalPdfBytes;
    let finalPageCount = 0;

    if (mode === 'replace') {
      const arrayBuffer = await newFile.arrayBuffer();
      
      if (newFile.type === 'application/pdf') {
        finalPdfBytes = await compressCamScannerPdf(arrayBuffer, targetQuality, targetScale, (curr, total) => {
          updateProgress(curr, total, 'Optimizing Scanned Document');
        });
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
        finalPdfBytes = await compressCamScannerPdf(newFileBuffer, targetQuality, targetScale, (curr, total) => {
          updateProgress(curr, total, 'Compressing Appended Pages');
        });
        const tempDoc = await PDFLib.PDFDocument.load(finalPdfBytes);
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

    statusDiv.textContent = '☁️ Saving file to cloud storage...';
    if (progressBar) progressBar.style.width = '95%';

    const blob = new Blob([finalPdfBytes], { type: 'application/pdf' });
    
    const { error: uploadError } = await supabaseClient.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, blob, { upsert: true });

    if (uploadError) throw uploadError;

    await supabaseClient
      .from('subjects')
      .update({ total_pages: finalPageCount, last_updated: new Date() })
      .eq('id', subjectId);

    if (progressBar) progressBar.style.width = '100%';
    statusDiv.style.color = 'var(--success)';
    statusDiv.textContent = `✅ Success! PDF optimized & saved (${qualityMode.toUpperCase()} Mode). Total pages: ${finalPageCount}`;
    fileInput.value = '';
  } catch (error) {
    console.error(error);
    statusDiv.style.color = 'var(--danger)';
    statusDiv.textContent = `❌ Error updating document: ${error.message}`;
  } finally {
    setTimeout(() => {
      if (progressContainer) progressContainer.classList.add('hidden');
    }, 4000);
  }
}

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
        <span class="picklist-tag">${sub.class_level} | ${sub.semester || 'N/A'} | NPR ${sub.price_npr || 0}</span>
      </div>
      <button type="button" class="btn-danger" style="padding:4px 10px; font-size:0.8rem; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; width: auto;" onclick="removeSubjectFromStudent('${item.id}', '${sub.id}')">
        🗑️ Remove Course
      </button>
    `;
    listContainer.appendChild(div);
  });
}

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

async function deleteStudentAccount() {
  if (!activeStudentId) return;

  const student = globalStudents.find(s => s.id === activeStudentId);
  const studentName = student ? student.full_name : 'this student';

  if (!confirm(`🚨 Are you sure you want to permanently delete ${studentName}'s entire account? This action cannot be undone.`)) {
    return;
  }

  try {
    const { error: coursesErr } = await supabaseClient
      .from('student_courses')
      .delete()
      .eq('student_id', activeStudentId);

    if (coursesErr) throw coursesErr;

    const { error: studentErr } = await supabaseClient
      .from('students')
      .delete()
      .eq('id', activeStudentId);

    if (studentErr) throw studentErr;

    alert(`✅ ${studentName}'s account has been completely deleted.`);

    document.getElementById('student-details-container').classList.add('hidden');
    activeStudentId = null;
    await fetchStudents();

  } catch (err) {
    alert(`Error deleting student account: ${err.message}`);
    console.error("Account deletion error:", err);
  }
}

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
    opt.textContent = `${s.subject_name} (NPR ${s.price_npr || 0})`;
    subSelect.appendChild(opt);
  });

  subSelect.disabled = false;
}

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

(function enforceStrictLock() {
  const isUnlocked = sessionStorage.getItem('admin_authenticated');
  
  if (!isUnlocked) {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    
    const devToolsCheck = setInterval(() => {
      const overlay = document.getElementById('admin-lock-overlay');
      const authenticated = sessionStorage.getItem('admin_authenticated');
      
      if (!authenticated && (!overlay || overlay.style.display === 'none')) {
        clearInterval(devToolsCheck);
        alert('Security violation: DevTools bypass detected.');
        window.location.href = 'index.html';
      }
    }, 500);
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      const overlay = document.getElementById('admin-lock-overlay');
      if (overlay) overlay.remove();
    });
  }
})();

async function handleAdminLogin(event) {
  event.preventDefault();
  const user = document.getElementById('admin-user-input').value.trim();
  const pass = document.getElementById('admin-pass-input').value.trim();
  const errorDiv = document.getElementById('admin-lock-error');

  errorDiv.style.display = 'none';

  if (user === 'adminisgod' && pass === 'godisadmin') {
    sessionStorage.setItem('admin_authenticated', 'true');
    
    const overlay = document.getElementById('admin-lock-overlay');
    if (overlay) overlay.remove();

    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';

    initAdmin();
  } else {
    errorDiv.textContent = 'Invalid Admin ID or Password.';
    errorDiv.style.display = 'block';
  }
}

window.addEventListener('DOMContentLoaded', initAdmin);