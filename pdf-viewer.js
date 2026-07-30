/* ==========================================
   PDF READER ENGINE (PARALLEL BATCH LOADING - SECURED CANVAS)
   ========================================== */
let currentPdfDoc = null;
let totalPagesCount = 0;
let currentlyLoadedPage = 0;
const BATCH_SIZE = 10;
let isLoadingBatch = false;

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

window.initReader = async function(sessionData) {
  const viewerContainer = document.getElementById('viewer-container');
  if (!viewerContainer) return;

  currentlyLoadedPage = 0;
  isLoadingBatch = false;
  viewerContainer.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:30px;">⏳ Securing & loading document...</p>';

  if (!sessionData || !sessionData.pdfPath) {
    showError("No document path provided.");
    return;
  }

  const bucketName = (typeof STORAGE_BUCKET !== 'undefined') ? STORAGE_BUCKET : 'course-notes';

  try {
    // Authenticated download from private bucket
    const { data: blobData, error: downloadError } = await supabaseClient.storage
      .from(bucketName)
      .download(sessionData.pdfPath);

    if (downloadError || !blobData) {
      throw new Error(downloadError ? downloadError.message : "Failed to fetch secure document stream.");
    }

    const arrayBuffer = await blobData.arrayBuffer();

    const loadingTask = pdfjsLib.getDocument({
      data: arrayBuffer,
      disableAutoFetch: true,
      disableStream: false
    });

    currentPdfDoc = await loadingTask.promise;
    totalPagesCount = currentPdfDoc.numPages;
    
    const pageLabel = document.getElementById('total-pages-label');
    if (pageLabel) pageLabel.textContent = `/ ${totalPagesCount}`;
    
    viewerContainer.innerHTML = '';

    const pagesList = document.createElement('div');
    pagesList.id = 'pdf-pages-list';
    
    // Security: Block user selection and copy commands on container
    pagesList.style.userSelect = 'none';
    pagesList.style.webkitUserSelect = 'none';
    pagesList.style.webkitTouchCallout = 'none';
    
    viewerContainer.appendChild(pagesList);

    const loadMoreContainer = document.createElement('div');
    loadMoreContainer.id = 'load-more-container';
    loadMoreContainer.style.textAlign = 'center';
    loadMoreContainer.style.margin = '20px 0 40px 0';
    viewerContainer.appendChild(loadMoreContainer);

    await loadNextBatch();

    window.removeEventListener('scroll', handleScrollBatchLoad);
    window.addEventListener('scroll', handleScrollBatchLoad);

  } catch (err) {
    console.error("PDF render error:", err);
    showError(`Failed to load document: ${err.message}`);
  }
};

async function loadNextBatch() {
  if (isLoadingBatch || currentlyLoadedPage >= totalPagesCount) return;

  isLoadingBatch = true;
  const pagesList = document.getElementById('pdf-pages-list');
  const loadMoreContainer = document.getElementById('load-more-container');

  if (loadMoreContainer) {
    loadMoreContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.9rem;">⏳ Loading next batch of pages...</p>';
  }

  const startPage = currentlyLoadedPage + 1;
  const endPage = Math.min(currentlyLoadedPage + BATCH_SIZE, totalPagesCount);

  const renderTasks = [];
  for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.id = `page-${pageNum}`;
    wrapper.style.margin = '15px auto';
    wrapper.style.textAlign = 'center';
    wrapper.style.minHeight = '400px';
    pagesList.appendChild(wrapper);

    renderTasks.push(renderSinglePage(pageNum, wrapper));
  }

  currentlyLoadedPage = endPage;
  await Promise.all(renderTasks);

  isLoadingBatch = false;

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

let scrollDebounceTimeout = null;
function handleScrollBatchLoad() {
  if (currentlyLoadedPage >= totalPagesCount || isLoadingBatch) return;

  if (scrollDebounceTimeout) clearTimeout(scrollDebounceTimeout);

  scrollDebounceTimeout = setTimeout(() => {
    const scrollPosition = window.innerHeight + window.scrollY;
    const threshold = document.body.offsetHeight - 900;

    if (scrollPosition >= threshold) {
      loadNextBatch();
    }
  }, 100);
}

async function renderSinglePage(pageNum, wrapper) {
  try {
    const page = await currentPdfDoc.getPage(pageNum);
    const renderScale = 1.3; 
    const viewport = page.getViewport({ scale: renderScale });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';

    // DIRECT CANVAS PROTECTION
    canvas.oncontextmenu = () => false; // Prevent right click save
    canvas.style.pointerEvents = 'none'; // Prevents dragging/saving directly

    wrapper.appendChild(canvas);

    await page.render({ canvasContext: context, viewport: viewport }).promise;
    page.cleanup();

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

document.getElementById('jump-btn')?.addEventListener('click', async () => {
  const pageInput = document.getElementById('page-jump-input');
  const targetPage = parseInt(pageInput.value, 10);

  if (targetPage >= 1 && targetPage <= totalPagesCount) {
    while (currentlyLoadedPage < targetPage) {
      await loadNextBatch();
    }
    
    const targetElem = document.getElementById(`page-${targetPage}`);
    if (targetElem) {
      targetElem.scrollIntoView({ behavior: 'smooth' });
    }
  }
});