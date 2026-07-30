/* ==========================================
   PDF READER ENGINE (BATCH LOADING - 10 PAGES)
   ========================================== */
let currentPdfDoc = null;
let totalPagesCount = 0;
let currentlyLoadedPage = 0;
const BATCH_SIZE = 10;
let isLoadingBatch = false;

// Set PDF.js Worker globally (v3.11.174 matching HTML)
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

window.initReader = async function(sessionData) {
  const viewerContainer = document.getElementById('viewer-container');
  if (!viewerContainer) return;

  // Reset internal state
  currentlyLoadedPage = 0;
  isLoadingBatch = false;
  viewerContainer.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:30px;">⏳ Loading document...</p>';

  if (!sessionData || !sessionData.pdfPath) {
    showError("No document path provided.");
    return;
  }

  // Use globally configured STORAGE_BUCKET ('course-notes')
  const bucketName = (typeof STORAGE_BUCKET !== 'undefined') ? STORAGE_BUCKET : 'course-notes';
  const { data: publicUrlData } = supabaseClient.storage
    .from(bucketName)
    .getPublicUrl(sessionData.pdfPath);

  if (!publicUrlData || !publicUrlData.publicUrl) {
    showError("Failed to resolve storage URL.");
    return;
  }

  try {
    const loadingTask = pdfjsLib.getDocument({
      url: publicUrlData.publicUrl,
      disableAutoFetch: true,
      disableStream: false
    });

    currentPdfDoc = await loadingTask.promise;
    totalPagesCount = currentPdfDoc.numPages;
    
    const pageLabel = document.getElementById('total-pages-label');
    if (pageLabel) pageLabel.textContent = `/ ${totalPagesCount}`;
    
    viewerContainer.innerHTML = '';

    // Create container for rendered page wrappers
    const pagesList = document.createElement('div');
    pagesList.id = 'pdf-pages-list';
    viewerContainer.appendChild(pagesList);

    // Create load trigger element at the bottom
    const loadMoreContainer = document.createElement('div');
    loadMoreContainer.id = 'load-more-container';
    loadMoreContainer.style.textAlign = 'center';
    loadMoreContainer.style.margin = '20px 0 40px 0';
    viewerContainer.appendChild(loadMoreContainer);

    // Render initial batch of 10 pages
    await loadNextBatch();

    // Scroll listener for auto-loading next 10 pages on reach bottom
    window.removeEventListener('scroll', handleScrollBatchLoad);
    window.addEventListener('scroll', handleScrollBatchLoad);

  } catch (err) {
    console.error("PDF render error:", err);
    showError("Failed to render document. Ensure PDF exists in 'course-notes' storage bucket.");
  }
};

/* ==========================================
   BATCH LOAD ENGINE (10 PAGES PER CALL)
   ========================================== */
async function loadNextBatch() {
  if (isLoadingBatch || currentlyLoadedPage >= totalPagesCount) return;

  isLoadingBatch = true;
  const pagesList = document.getElementById('pdf-pages-list');
  const loadMoreContainer = document.getElementById('load-more-container');

  if (loadMoreContainer) {
    loadMoreContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.9rem;">⏳ Loading next 10 pages...</p>';
  }

  const startPage = currentlyLoadedPage + 1;
  const endPage = Math.min(currentlyLoadedPage + BATCH_SIZE, totalPagesCount);

  for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.id = `page-${pageNum}`;
    wrapper.style.margin = '15px auto';
    wrapper.style.textAlign = 'center';
    pagesList.appendChild(wrapper);

    await renderSinglePage(pageNum, wrapper);
    currentlyLoadedPage = pageNum;
  }

  isLoadingBatch = false;

  // Update UI loader status
  if (currentlyLoadedPage < totalPagesCount) {
    if (loadMoreContainer) {
      loadMoreContainer.innerHTML = `
        <button id="btn-load-more-pages" style="padding: 10px 20px; background: var(--accent); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">
          Load More Pages (${currentlyLoadedPage} / ${totalPagesCount})
        </button>
      `;
      document.getElementById('btn-load-more-pages')?.addEventListener('click', loadNextBatch);
    }
  } else {
    if (loadMoreContainer) {
      loadMoreContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">✅ End of Document</p>';
    }
  }
}

/* ==========================================
   AUTO-SCROLL DETECTOR FOR BATCH LOADING
   ========================================== */
function handleScrollBatchLoad() {
  if (currentlyLoadedPage >= totalPagesCount || isLoadingBatch) return;

  const scrollPosition = window.innerHeight + window.scrollY;
  const threshold = document.body.offsetHeight - 800;

  if (scrollPosition >= threshold) {
    loadNextBatch();
  }
}

/* ==========================================
   PAGE RENDERER
   ========================================== */
async function renderSinglePage(pageNum, wrapper) {
  try {
    const page = await currentPdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';

    wrapper.appendChild(canvas);

    await page.render({ canvasContext: context, viewport: viewport }).promise;

  } catch (err) {
    console.error(`Error rendering page ${pageNum}:`, err);
  }
}

function showError(message) {
  const viewerContainer = document.getElementById('viewer-container');
  if (viewerContainer) {
    viewerContainer.innerHTML = `<div style="color:var(--danger); text-align:center; padding:40px; font-weight:bold;">❌ ${message}</div>`;
  }
}

/* ==========================================
   PAGE JUMP CONTROL (FETCHES BATCH IF UNLOADED)
   ========================================== */
document.getElementById('jump-btn')?.addEventListener('click', async () => {
  const pageInput = document.getElementById('page-jump-input');
  const targetPage = parseInt(pageInput.value, 10);

  if (targetPage >= 1 && targetPage <= totalPagesCount) {
    // If target page isn't rendered yet, pull batches until target page is loaded
    while (currentlyLoadedPage < targetPage) {
      await loadNextBatch();
    }
    
    const targetElem = document.getElementById(`page-${targetPage}`);
    if (targetElem) {
      targetElem.scrollIntoView({ behavior: 'smooth' });
    }
  }
});