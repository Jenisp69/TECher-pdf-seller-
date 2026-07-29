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

  // Parse session token from URL parameter
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

    // Check expiration
    if (new Date(data.expires_at) < new Date()) {
      showError("This view link has expired.");
      return;
    }

    // Load PDF Viewer
    initReader(data);

  } catch (err) {
    console.error("Error verifying session:", err);
    showError("An unexpected error occurred while loading the document.");
  }
}

/* ==========================================
   PDF READER ENGINE (LAZY LOADED / NO WATERMARK)
   ========================================== */
window.initReader = async function(sessionData) {
  const viewerContainer = document.getElementById('viewer-container');
  viewerContainer.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:30px;">⏳ Loading document...</p>';

  const { data: publicUrlData } = supabaseClient.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(sessionData.pdfPath);

  try {
    const loadingTask = pdfjsLib.getDocument(publicUrlData.publicUrl);
    currentPdfDoc = await loadingTask.promise;
    totalPagesCount = currentPdfDoc.numPages;
    
    document.getElementById('total-pages-label').textContent = `/ ${totalPagesCount}`;
    viewerContainer.innerHTML = '';

    // Create lightweight placeholder elements for all pages so the native scrollbar scales correctly
    for (let pageNum = 1; pageNum <= totalPagesCount; pageNum++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.id = `page-${pageNum}`;
      wrapper.style.minHeight = '1100px'; // Allocate vertical space for smooth scrolling
      wrapper.style.display = 'flex';
      wrapper.style.justifyContent = 'center';
      wrapper.style.alignItems = 'center';
      wrapper.style.margin = '20px 0';
      
      viewerContainer.appendChild(wrapper);
    }

    // Initialize IntersectionObserver to render pages only when visible in viewport
    setupLazyLoading();

  } catch (err) {
    console.error("PDF render error:", err);
    viewerContainer.innerHTML = '<p style="color:var(--danger); text-align:center; padding:30px;">❌ Failed to render document.</p>';
  }
};

/* ==========================================
   INTERSECTION OBSERVER (VIRTUALIZATION)
   ========================================== */
function setupLazyLoading() {
  const renderedPages = new Set();

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
    rootMargin: '400px 0px', // Pre-render pages 400px before scrolling into view
    threshold: 0.01 
  });

  document.querySelectorAll('.page-wrapper').forEach(wrapper => observer.observe(wrapper));
}

/* ==========================================
   SINGLE PAGE RENDERER
   ========================================== */
async function renderSinglePage(pageNum, wrapper) {
  try {
    const page = await currentPdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.2 }); // Reduced scale from 1.5 to 1.2 for faster load and lower RAM usage

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';
    canvas.style.boxShadow = '0 4px 10px rgba(0,0,0,0.15)';

    wrapper.style.minHeight = 'auto'; // Remove pre-allocated minHeight once canvas renders
    wrapper.appendChild(canvas);

    await page.render({ canvasContext: context, viewport: viewport }).promise;

  } catch (err) {
    console.error(`Error rendering page ${pageNum}:`, err);
  }
}

/* ==========================================
   UI UTILITIES
   ========================================== */
function showError(message) {
  const viewerContainer = document.getElementById('viewer-container');
  if (viewerContainer) {
    viewerContainer.innerHTML = `<div style="color:var(--danger); text-align:center; padding:40px; font-weight:bold;">❌ ${message}</div>`;
  }
}