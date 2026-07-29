pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let currentPdfDoc = null;
let totalPagesCount = 0;

window.initReader = async function(sessionData) {
  const viewerContainer = document.getElementById('viewer-container');
  viewerContainer.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:30px;">⏳ Loading encrypted notes...</p>';

  const { data: publicUrlData } = supabaseClient.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(sessionData.pdfPath);

  try {
    const loadingTask = pdfjsLib.getDocument(publicUrlData.publicUrl);
    currentPdfDoc = await loadingTask.promise;
    totalPagesCount = currentPdfDoc.numPages;
    
    document.getElementById('total-pages-label').textContent = `/ ${totalPagesCount}`;
    viewerContainer.innerHTML = '';

    for (let pageNum = 1; pageNum <= totalPagesCount; pageNum++) {
      await renderPage(pageNum, sessionData);
    }
  } catch (err) {
    viewerContainer.innerHTML = '<p style="color:var(--danger); text-align:center; padding:30px;">❌ Could not load notes. No document uploaded for this subject yet.</p>';
  }
};

async function renderPage(pageNum, sessionData) {
  const page = await currentPdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.5 });

  const wrapper = document.createElement('div');
  wrapper.className = 'page-wrapper';
  wrapper.id = `page-${pageNum}`;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  wrapper.appendChild(canvas);
  document.getElementById('viewer-container').appendChild(wrapper);

  await page.render({ canvasContext: context, viewport: viewport }).promise;
  applyWatermark(context, canvas.width, canvas.height, sessionData);
}

function applyWatermark(ctx, width, height, sessionData) {
  ctx.save();
  ctx.font = 'bold 20px Arial';
  ctx.fillStyle = 'rgba(239, 68, 68, 0.22)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-Math.PI / 6);

  const text = `${sessionData.studentName.toUpperCase()} (${sessionData.username}) - ${sessionData.studentPhone}`;
  
  for (let x = -width; x < width * 2; x += 380) {
    for (let y = -height; y < height * 2; y += 160) {
      ctx.fillText(text, x - (width / 2), y - (height / 2));
    }
  }
  ctx.restore();
}

document.getElementById('jump-btn').addEventListener('click', () => {
  const pageNum = parseInt(document.getElementById('page-jump-input').value);
  if (pageNum >= 1 && pageNum <= totalPagesCount) {
    document.getElementById(`page-${pageNum}`).scrollIntoView({ behavior: 'smooth' });
  } else {
    alert(`Please enter a valid page number between 1 and ${totalPagesCount}`);
  }
});

document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && ['p', 's', 'u', 'c'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    alert('Security Alert: Printing, saving, and copying are disabled.');
  }
});