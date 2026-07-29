/* ==========================================
   GLOBAL STATE & CONSTANTS
   ========================================== */
const SUPABASE_URL = "https://your-supabase-url.supabase.co"; 
const SUPABASE_ANON_KEY = "your-anon-key";
const STORAGE_BUCKET = "notes-pdf";

let supabaseClient = null;
let currentPdfDoc = null;
let totalPagesCount = 0;

/* ==========================================
   INITIALIZATION
   ========================================== */
document.addEventListener('DOMContentLoaded', () => {
  if (typeof supabase !== 'undefined') {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    console.error("Supabase client library not found.");
  }

  // Configure PDF.js worker
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
  }

  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');

  if (!token) {
    showError("Invalid or missing access token.");
    return;
  }

  verifyAndLoadSession(token);
});

/* ==========================================
   SESSION VERIFICATION
   ========================================== */
async function verifyAndLoadSession(token) {
  try {
    const { data, error } = await supabaseClient
      .from('pdf_sessions')
      .select('*')
      .eq('token', token)
      .single();

    if (error || !data) {
      showError("Session expired or invalid access token.");
      return;
    }

    if (new Date(data.expires_at) < new Date()) {
      showError("This view link has expired.");
      return;
    }

    initReader(data);

  } catch (err) {
    console.error("Error verifying session:", err);
    showError("An unexpected error occurred while loading the document.");
  }
}

/* ==========================================
   PDF READER ENGINE (PAGE 1 FIRST)
   ========================================== */
window.initReader = async function(sessionData) {
  const viewerContainer = document.getElementById('viewer-container');
  viewerContainer.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:30px;">⏳ Loading document...</p>';

  const { data: publicUrlData } = supabaseClient.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(sessionData.pdfPath);

  try {
    const loadingTask = pdfjsLib.getDocument({
      url: publicUrlData.publicUrl,
      disableAutoFetch: true,
      disableStream: false
    });

    currentPdfDoc = await loadingTask.promise;
    totalPagesCount = currentPdfDoc.numPages;
    
    document.getElementById('total-pages-label').textContent = `/ ${totalPagesCount}`;
    viewerContainer.innerHTML = '';

    // Step 1: Render Page 1 IMMEDIATELY
    const page1Wrapper = document.createElement('div');
    page1Wrapper.className = 'page-wrapper';
    page1Wrapper.id = 'page-1';
    page1Wrapper.style.margin = '15px 0';
    viewerContainer.appendChild(page1Wrapper);
    
    await renderSinglePage(1, page1Wrapper);

    // Step 2: Create lightweight placeholders for pages 2 to N
    for (let pageNum = 2; pageNum <= totalPagesCount; pageNum++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.id = `page-${pageNum}`;
      wrapper.style.minHeight = '800px'; 
      wrapper.style.display = 'flex';
      wrapper.style.justifyContent = 'center';
      wrapper.style.alignItems = 'center';
      wrapper.style.margin = '15px 0';
      
      viewerContainer.appendChild(wrapper);
    }

    // Step 3: Lazy load remaining pages on scroll
    setupLazyLoading();

  } catch (err) {
    console.error("PDF render error:", err);
    viewerContainer.innerHTML = '<p style="color:var(--danger); text-align:center; padding:30px;">❌ Failed to render document.</p>';
  }
};

/* ==========================================
   INTERSECTION OBSERVER
   ========================================== */
function setupLazyLoading() {
  const renderedPages = new Set([1]); // Page 1 already rendered

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const pageNum = parseInt(entry.target.id.replace('page-', ''));
        if (!renderedPages.has(pageNum)) {
          renderedPages.add(pageNum);
          renderSinglePage(pageNum, entry.target);
        }
      }
    });
  }, { 
    root: null,
    rootMargin: '200px 0px',
    threshold: 0.01 
  });

  document.querySelectorAll('.page-wrapper').forEach(wrapper => {
    if (wrapper.id !== 'page-1') {
      observer.observe(wrapper);
    }
  });
}

/* ==========================================
   SINGLE PAGE RENDERER
   ========================================== */
async function renderSinglePage(pageNum, wrapper) {
  try {
    const page = await currentPdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 0.9 }); // Reduced to 0.9 scale for instant canvas rasterization

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false }); // Disable alpha channel for faster rendering
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';

    wrapper.style.minHeight = 'auto';
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