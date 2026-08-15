/* ==========================================
   ADVANCED INTERACTIVE PDF ENGINE (VRAM OPTIMIZED)
   ========================================== */
// --- Helper: Extract Genuine Google Drive File ID ---
function getGoogleDriveId(urlOrId) {
  if (!urlOrId) return null;

  // Extract /d/FILE_ID or id=FILE_ID
  const match = urlOrId.match(/(?:\/d\/|id=|\/file\/d\/|^)([a-zA-Z0-9_-]{25,50})/);
  if (!match) return null;

  const candidate = match[1];

  // Ignore Google Apps Script Deployment IDs (which start with 'AKfy')
  if (candidate.startsWith('AKfy')) return null;

  return candidate;
}


(() => {
  'use strict';

  // --- Hardware Capability Detection ---
  const isLowEndMobile = (navigator.hardwareConcurrency || 4) <= 4 || window.innerWidth <= 768;
  const BATCH_SIZE = isLowEndMobile ? 3 : 10;

  // --- Core State Management ---
  let currentPdfDoc = null;
  let totalPagesCount = 0;
  let currentlyLoadedPage = 0;
  let isLoadingBatch = false;
  let documentChunks = []; 

  // --- Layout & View Settings ---
  let baseFitScale = 1.0;
  let zoomMultiplier = 1.0;
  let isPenActive = false;
  let activeSubjectId = 'default_subject';

  // --- Gestures & UI Timers ---
  let initialPinchDistance = null;
  let initialZoomMultiplier = 1.0;
  let toolbarTimer = null;
  let pageObserver = null;
  let scrollDebounceTimeout = null;

  // --- PDF.js Worker Setup ---
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  /* ==========================================
     STROKE STORAGE HELPERS
     ========================================== */
  function getStrokeStorageKey(pageNum) {
    return `strokes_${activeSubjectId}_p${pageNum}`;
  }

  function getSavedStrokes(pageNum) {
    try {
      return JSON.parse(localStorage.getItem(getStrokeStorageKey(pageNum)) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveStroke(pageNum, strokeData) {
    if (!strokeData || strokeData.length < 2) return;
    const strokes = getSavedStrokes(pageNum);
    strokes.push(strokeData);
    localStorage.setItem(getStrokeStorageKey(pageNum), JSON.stringify(strokes));
  }

  function clearSavedStrokes(pageNum) {
    localStorage.removeItem(getStrokeStorageKey(pageNum));
  }

  function redrawSavedStrokes(canvas, pageNum) {
    const ctx = canvas.getContext('2d');
    const strokes = getSavedStrokes(pageNum);
    if (!strokes.length) return;

    const dpr = window.devicePixelRatio || 1;
  
    ctx.strokeStyle = '#ff3366';
    ctx.lineWidth = 3 * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    strokes.forEach((stroke) => {
      if (!stroke || stroke.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x * canvas.width, stroke[0].y * canvas.height);

      for (let i = 1; i < stroke.length; i++) {
        ctx.lineTo(stroke[i].x * canvas.width, stroke[i].y * canvas.height);
      }
      ctx.stroke();
    });
  }

/* ==========================================
   INITIALIZATION & PDF LOADING 
   ========================================== */
window.initReader = async function (sessionData) {
  const viewerContainer = document.getElementById('viewer-container');
  if (!viewerContainer || !sessionData || !sessionData.pdfPath) return;

  currentlyLoadedPage = 0;
  isLoadingBatch = false;
  zoomMultiplier = 1.0;
  activeSubjectId = sessionData.subjectName || 'course_doc';
  documentChunks = [];

  // === COOL MINECRAFT LOADER HTML ===
  const loaderHTML = `
    <div class="pixel-loader-container">
      <div class="chicken-stage"><div class="pixel-chicken"></div></div>
      <div class="pixel-progress-track"><div class="pixel-progress-fill"></div></div>
      <div class="pixel-loading-text" id="loading-text-anim">Initializing...</div>
    </div>
  `;
  viewerContainer.innerHTML = loaderHTML;

 // === DYNAMIC PROGRESS HELPER WITH AUTOMATED TICKER ===
  let currentPercent = 5;
  let stuckTicks = 0;

  const updateProgress = (percent, text) => {
    currentPercent = Math.max(currentPercent, percent); // Ensures bar only moves forward
    const fill = document.querySelector('.pixel-progress-fill');
    const textEl = document.getElementById('loading-text-anim');
    if (fill) fill.style.width = currentPercent + '%';
    if (textEl && text) textEl.innerText = text;
  };

  // Smooth fake progress tick: Gradually moves up to 60% while waiting for network
  const progressInterval = setInterval(() => {
    if (currentPercent < 60) {
      currentPercent += 3; // Creeps up 3% every 350ms
      if (currentPercent > 60) currentPercent = 60;
    } else {
      // Once it hits 60%, start counting how long we've been waiting for the download
      stuckTicks++; 
    }

    // Default progression messages
    let msg = "Connecting to database...";
    if (currentPercent >= 20) msg = "Summoning pages...";
    if (currentPercent >= 40) msg = "Heavy lifting! Hang tight...";
    
    // If stuck at 60% for ~3.5s (10 ticks)
    if (stuckTicks > 10) msg = "Still brewing... large file detected...";
    
    // If stuck at 60% for ~7s (20 ticks)
    if (stuckTicks > 20) msg = "takes less than 15 seconds...";

    // If stuck at 60% for ~10.2s (32 ticks)
    if (stuckTicks > 32) msg = "Almost done...";


    updateProgress(currentPercent, msg);
  }, 350);

  try {
    updateProgress(5, "Connecting to database...");

    const isChunkedDriveFormat = sessionData.pdfPath.includes(':');
    if (!isChunkedDriveFormat) {
      // --- LEGACY SUPABASE ROUTE ---
      const bucketName = typeof STORAGE_BUCKET !== 'undefined' ? STORAGE_BUCKET : 'course-notes';
      const { data: blobData, error: downloadError } = await supabaseClient.storage
        .from(bucketName).download(sessionData.pdfPath);

      if (downloadError || !blobData) throw new Error(downloadError ? downloadError.message : 'Failed to fetch.');

      const arrayBuffer = await blobData.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({
        data: arrayBuffer.slice(0),
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
        cMapPacked: true,
      });

      const docInstance = await loadingTask.promise;
      totalPagesCount = docInstance.numPages;
      setTotalPages(totalPagesCount);

      documentChunks = [{ fileId: 'legacy_supabase', startPage: 1, endPage: totalPagesCount, pageCount: totalPagesCount, docInstance: docInstance, isFetching: false }];
    
    } else {
      // --- NEW GOOGLE DRIVE CHUNKED ROUTE ---
      const chunksData = sessionData.pdfPath.split(',');
      let currentStartPage = 1;

      documentChunks = chunksData.map(chunkStr => {
        const [id, pagesStr] = chunkStr.split(':');
        const pagesCount = parseInt(pagesStr, 10);
        const chunkObj = { fileId: id, startPage: currentStartPage, endPage: currentStartPage + pagesCount - 1, pageCount: pagesCount, docInstance: null, isFetching: false };
        currentStartPage += pagesCount;
        return chunkObj;
      });

      totalPagesCount = currentStartPage - 1;
      setTotalPages(totalPagesCount);
      
      // Heavy network fetch occurs here while ticker smoothly climbs up to 60%
      await fetchAndLoadChunk(documentChunks[0]);
    }

    // --- NETWORK COMPLETE: STOP TICKER & BOOST PROGRESS ---
    clearInterval(progressInterval);
    updateProgress(85, "Generating pages...");
    
    const firstPage = await documentChunks[0].docInstance.getPage(1);
    const unscaledViewport = firstPage.getViewport({ scale: 1.0 });
    const containerWidth = Math.min(viewerContainer.clientWidth || window.innerWidth, window.innerWidth);
    baseFitScale = containerWidth / unscaledViewport.width;
    firstPage.cleanup();

    // FULLY DONE: 100%
    updateProgress(100, "Done!");

    // Wait exactly 400 milliseconds so you can visually see it hit 100% before it vanishes
    await new Promise(resolve => setTimeout(resolve, 400));

    // --- SHARED UI INITIALIZATION ---
    viewerContainer.innerHTML = ''; // Clear loader
    
    const pagesList = document.createElement('div');
    pagesList.id = 'pdf-pages-list';
    pagesList.style.width = '100%';
    viewerContainer.appendChild(pagesList);

    const loadMoreContainer = document.createElement('div');
    loadMoreContainer.id = 'load-more-container';
    viewerContainer.appendChild(loadMoreContainer);

    await loadNextBatch(); 
    setupPageObserver();
    setupTouchPinchZoom();
    initToolbarToggle(); // (This contains the click-to-hide fix we did earlier!)

    if (isChunkedDriveFormat) preloadRemainingChunks();

  } catch (err) {
    clearInterval(progressInterval); // Clean up timer on error
    console.error('PDF Init Error:', err);
    viewerContainer.innerHTML = `<p style="color:red; text-align:center; margin-top: 20px;">Failed to load document: ${err.message}</p>`;
  }
};


// Background worker to silently load the rest of the file
  async function preloadRemainingChunks() {
    for (let i = 1; i < documentChunks.length; i++) {
      await fetchAndLoadChunk(documentChunks[i]);
    }
  }

  // Network fetcher that resolves a chunk ID via the Apps Script Proxy
  async function fetchAndLoadChunk(chunk) {
    if (chunk.docInstance || chunk.isFetching) return;
    chunk.isFetching = true;

    try {
      const proxyUrl = `${GOOGLE_APPS_SCRIPT_URL}?fileId=${chunk.fileId}`;
      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error('Proxy connection failed.');
      
      const resJson = await response.json();
      if (resJson.status !== 'success') throw new Error('Proxy file fetch failed.');

      const binaryStr = window.atob(resJson.base64Data);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);

      const loadingTask = pdfjsLib.getDocument({
        data: bytes.buffer,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
        cMapPacked: true,
      });
      
      chunk.docInstance = await loadingTask.promise;
    } catch (err) {
      console.warn(`Failed to preload chunk covering pages ${chunk.startPage}-${chunk.endPage}:`, err);
    } finally {
      chunk.isFetching = false;
    }
  }



  /* ==========================================
     BATCH PAGE LOADER
     ========================================== */
  async function loadNextBatch() {
    if (isLoadingBatch || currentlyLoadedPage >= totalPagesCount) return;

    isLoadingBatch = true;
    const pagesList = document.getElementById('pdf-pages-list');
    const loadMoreContainer = document.getElementById('load-more-container');

    if (loadMoreContainer) {
      loadMoreContainer.innerHTML =
        '<p style="color:var(--text-muted); font-size:0.9rem;">⏳ Loading next batch of pages...</p>';
    }

    const startPage = currentlyLoadedPage + 1;
    const endPage = Math.min(currentlyLoadedPage + BATCH_SIZE, totalPagesCount);

    const renderTasks = [];
    const fragment = document.createDocumentFragment();

    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.id = `page-${pageNum}`;
      wrapper.dataset.pageNum = pageNum;
      wrapper.dataset.rendered = 'false';
      wrapper.style.position = 'relative';
      wrapper.style.minHeight = '400px';

      fragment.appendChild(wrapper);
      renderTasks.push({ pageNum, wrapper });
    }

    pagesList?.appendChild(fragment);

    if (isLowEndMobile) {
      for (const task of renderTasks) {
        await renderSinglePage(task.pageNum, task.wrapper);
      }
    } else {
      await Promise.all(renderTasks.map((task) => renderSinglePage(task.pageNum, task.wrapper)));
    }

    currentlyLoadedPage = endPage;
    isLoadingBatch = false;

    if (loadMoreContainer) {
      if (currentlyLoadedPage < totalPagesCount) {
        loadMoreContainer.innerHTML = `
          <button id="btn-load-more-pages" style="padding: 10px 20px; background: var(--accent); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">
            Load More Pages (${currentlyLoadedPage} / ${totalPagesCount})
          </button>
        `;
        document.getElementById('btn-load-more-pages')?.addEventListener('click', loadNextBatch, { once: true });
      } else {
        loadMoreContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">✅ End of Document</p>';
      }
    }
  }

  /* ==========================================
     PAGE RENDERER
     ========================================== */
/* ==========================================
     PAGE RENDERER (RACE-CONDITION PATCHED)
     ========================================== */
  async function renderSinglePage(globalPageNum, wrapper) {
    // 1. Lock to prevent async race conditions (Stops duplicated stacked pages)
    if (wrapper.dataset.rendered === 'true' || wrapper.dataset.isRendering === 'true') return;
    wrapper.dataset.isRendering = 'true';

    try {
      // 2. Clear out any artifacts (duplicate canvases, note buttons) from previous renders
      wrapper.innerHTML = '';

      // 3. Locate which physical chunk holds this logical page
      const chunk = documentChunks.find(c => globalPageNum >= c.startPage && globalPageNum <= c.endPage);
      
      if (!chunk) return;

      // 4. Wait for background load if user scrolls faster than preload
      if (!chunk.docInstance) {
        wrapper.innerHTML = `<p style="text-align:center; padding:50px; color:var(--text-muted);">Fetching page ${globalPageNum} data...</p>`;
        
        // STABILITY FIX: If another page in this chunk triggered the download, wait for it!
        while (chunk.isFetching) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // If it still hasn't loaded after waiting, trigger the fetch
        if (!chunk.docInstance) {
          await fetchAndLoadChunk(chunk);
        }
        wrapper.innerHTML = ''; 
      }

      // 5. Map global page (e.g. 15) to local chunk page (e.g. 5)
      const localPageNum = (globalPageNum - chunk.startPage) + 1;
      const page = await chunk.docInstance.getPage(localPageNum);

      const dpr = window.devicePixelRatio || 1;
      const effectiveScale = baseFitScale * zoomMultiplier;
      const viewport = page.getViewport({ scale: effectiveScale });

      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.minHeight = `${viewport.height}px`;

      // 6. Standard UI Canvas Generation
      const pdfCanvas = document.createElement('canvas');
      const context = pdfCanvas.getContext('2d', { alpha: false });

      pdfCanvas.width = viewport.width * dpr;
      pdfCanvas.height = viewport.height * dpr;
      pdfCanvas.style.width = `${viewport.width}px`;
      pdfCanvas.style.height = `${viewport.height}px`;
      pdfCanvas.style.display = 'block';

      context.scale(dpr, dpr);
      pdfCanvas.oncontextmenu = () => false;
      wrapper.appendChild(pdfCanvas);

      // 7. Draw overlay & setup notes
      const drawCanvas = document.createElement('canvas');
      drawCanvas.className = 'draw-overlay';
      drawCanvas.width = viewport.width * dpr;
      drawCanvas.height = viewport.height * dpr;
      Object.assign(drawCanvas.style, {
        position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
        pointerEvents: isPenActive ? 'auto' : 'none', cursor: 'crosshair', touchAction: isPenActive ? 'none' : 'auto'
      });

      wrapper.appendChild(drawCanvas);
      attachDrawingEvents(drawCanvas, globalPageNum);

      // 8. Notes UI 
      const noteTrigger = document.createElement('button');
      noteTrigger.className = 'page-note-trigger';
      noteTrigger.innerHTML = `<i class="fa-solid fa-note-sticky"></i> Note`;

      const notePanel = document.createElement('div');
      notePanel.className = 'page-note-panel hidden';

      const noteBox = document.createElement('textarea');
      noteBox.placeholder = `📝 Page ${globalPageNum} note...`;

      const noteKey = `note_${activeSubjectId}_p${globalPageNum}`;
      noteBox.value = localStorage.getItem(noteKey) || '';

      noteBox.addEventListener('input', (e) => {
        localStorage.setItem(noteKey, e.target.value);
      });

      notePanel.appendChild(noteBox);

      noteTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        notePanel.classList.toggle('hidden');
      });

      wrapper.appendChild(noteTrigger);
      wrapper.appendChild(notePanel);

      await page.render({ canvasContext: context, viewport }).promise;
      page.cleanup();
      
      wrapper.dataset.rendered = 'true';

    } catch (err) {
      console.error(`Error rendering global page ${globalPageNum}:`, err);
      wrapper.innerHTML = `<p style="color:red; text-align:center;">Failed to render page ${globalPageNum}</p>`;
    } finally {
      // 9. Always unlock the element, even if rendering fails!
      wrapper.dataset.isRendering = 'false';
    }
  }

  /* ==========================================
     VRAM CLEANUP & RE-RENDER OBSERVER
     ========================================== */
  function unloadOffscreenCanvas(wrapper) {
    const canvases = wrapper.querySelectorAll('canvas');
    if (canvases.length > 0) {
      canvases.forEach((canvas) => {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
      });
      wrapper.dataset.rendered = 'false';
    }
  }

/* ==========================================
   INFINITE SCROLL & PAGE OBSERVER
   ========================================== */
function setupPageObserver() {
  if (pageObserver) pageObserver.disconnect();

  pageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(async (entry) => {
        const wrapper = entry.target;
        const pageNum = parseInt(wrapper.dataset.pageNum, 10);

        if (entry.isIntersecting) {
          if (wrapper.dataset.rendered === 'false') {
            await renderSinglePage(pageNum, wrapper);
          }

          const pageInput = document.getElementById('page-jump-input');
          if (pageInput && document.activeElement !== pageInput) {
            pageInput.value = pageNum;
          }

          // --- 5-PAGE INFINITE SCROLL TRIGGER ---
          // Automatically trigger loading the next batch when reader reaches within 5 pages of the end
          if (!isLoadingBatch && currentlyLoadedPage < totalPagesCount && (currentlyLoadedPage - pageNum <= 20)) {
            await loadNextBatch();
            setupPageObserver();
          }
        } else {
          if (isLowEndMobile && wrapper.dataset.rendered === 'true') {
            unloadOffscreenCanvas(wrapper);
          }
        }
      });
    },
    {
      root: null,
      rootMargin: '300px 0px 300px 0px',
      threshold: 0,
    }
  );

  document.querySelectorAll('.page-wrapper').forEach((p) => pageObserver.observe(p));
}



  /* ==========================================
     PINCH & ZOOM GESTURE ENGINE
     ========================================== */
  function setupTouchPinchZoom() {
    const readerSection = document.getElementById('reader-section');
    if (!readerSection) return;

    const isMobileTouch =
      ('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.innerWidth <= 768;

    if (!isMobileTouch) return;

    function getDistance(touch1, touch2) {
      const dx = touch1.clientX - touch2.clientX;
      const dy = touch1.clientY - touch2.clientY;
      return Math.hypot(dx, dy);
    }

    readerSection.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2 && !isPenActive) {
          initialPinchDistance = getDistance(e.touches[0], e.touches[1]);
          initialZoomMultiplier = zoomMultiplier;
        }
      },
      { passive: true }
    );

    readerSection.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 2 && initialPinchDistance && !isPenActive) {
          if (e.cancelable) e.preventDefault();

          const currentDistance = getDistance(e.touches[0], e.touches[1]);
          const factor = currentDistance / initialPinchDistance;
          const newMultiplier = Math.min(Math.max(initialZoomMultiplier * factor, 0.5), 3.0);

          if (Math.abs(newMultiplier - zoomMultiplier) > 0.05) {
            zoomMultiplier = newMultiplier;
            updateZoomLabel();
          }
        }
      },
      { passive: false }
    );

    readerSection.addEventListener('touchend', async (e) => {
      if (initialPinchDistance !== null && e.touches.length < 2) {
        initialPinchDistance = null;
        await reRenderLoadedPages();
      }
    });
  }

  function updateZoomLabel() {
    const zoomLabel = document.getElementById('zoom-label');
    if (zoomLabel) {
      zoomLabel.textContent = `${Math.round(zoomMultiplier * 100)}%`;
    }
  }

  function getMostVisiblePageElement() {
    const pages = document.querySelectorAll('.page-wrapper');
    const viewportCenter = window.innerHeight / 2;
    let closestPage = null;
    let minDistance = Infinity;

    pages.forEach((page) => {
      const rect = page.getBoundingClientRect();
      const pageCenter = rect.top + rect.height / 2;
      const distance = Math.abs(viewportCenter - pageCenter);

      if (distance < minDistance) {
        minDistance = distance;
        closestPage = page;
      }
    });

    return closestPage;
  }

  /* ==========================================
     DRAWING ENGINE
     ========================================== */
  function attachDrawingEvents(canvas, pageNum) {
    const ctx = canvas.getContext('2d');
    let isDrawing = false;
    let rafId = null;
    let lastPoint = null;
    let currentStroke = [];

    const dpr = window.devicePixelRatio || 1;
    ctx.strokeStyle = '#ff3366';
    ctx.lineWidth = 3 * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    redrawSavedStrokes(canvas, pageNum);

    function getCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;

      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      const canvasX = (touch.clientX - rect.left) * scaleX;
      const canvasY = (touch.clientY - rect.top) * scaleY;

      return {
        x: canvasX,
        y: canvasY,
        relX: canvasX / canvas.width,
        relY: canvasY / canvas.height,
      };
    }

    function startDraw(e) {
      if (!isPenActive || (e.touches && e.touches.length > 1)) return;
      isDrawing = true;
      const pt = getCoords(e);
      lastPoint = pt;
      currentStroke = [{ x: pt.relX, y: pt.relY }];
    }

    function draw(e) {
      if (!isDrawing || !isPenActive || (e.touches && e.touches.length > 1)) return;
      if (e.cancelable) e.preventDefault();

      const currentPoint = getCoords(e);
      currentStroke.push({ x: currentPoint.relX, y: currentPoint.relY });

      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (!lastPoint) return;
        ctx.beginPath();
        ctx.moveTo(lastPoint.x, lastPoint.y);
        ctx.lineTo(currentPoint.x, currentPoint.y);
        ctx.stroke();
        lastPoint = currentPoint;
      });
    }

    function stopDraw() {
      if (isDrawing && currentStroke.length > 1) {
        saveStroke(pageNum, currentStroke);
      }
      isDrawing = false;
      lastPoint = null;
      currentStroke = [];
      if (rafId) cancelAnimationFrame(rafId);
    }

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDraw);
    canvas.addEventListener('mouseleave', stopDraw);

    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', stopDraw);
    canvas.addEventListener('touchcancel', stopDraw);
  }

  /* ==========================================
     FLOATING TOOLBAR CONTROLS
     ========================================== */
  const penBtn = document.getElementById('floating-pen-btn');
  const penText = document.getElementById('pen-text');
  const clearBtn = document.getElementById('floating-clear-btn');
  const jumpInput = document.getElementById('page-jump-input');
  const totalPagesLabel = document.getElementById('total-pages-count');
  const floatingToolbar = document.getElementById('floating-toolbar');

  function setTotalPages(count) {
    if (totalPagesLabel) totalPagesLabel.textContent = count;
    if (jumpInput) jumpInput.max = count;
  }

  penBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    isPenActive = !isPenActive;

    penBtn.classList.toggle('active', isPenActive);
    if (penText) penText.textContent = isPenActive ? 'Pen: On' : 'Pen: Off';

    document.querySelectorAll('.draw-overlay').forEach((canvas) => {
      canvas.style.pointerEvents = isPenActive ? 'auto' : 'none';
      canvas.style.touchAction = isPenActive ? 'none' : 'auto';
    });

    resetToolbarTimeout();
  });

  clearBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const targetPage = getMostVisiblePageElement();
    if (targetPage) {
      const pageNum = parseInt(targetPage.dataset.pageNum, 10);
      const drawCanvas = targetPage.querySelector('.draw-overlay');

      if (drawCanvas) {
        const ctx = drawCanvas.getContext('2d');
        ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      }

      if (!isNaN(pageNum)) {
        clearSavedStrokes(pageNum);
      }
    }
    resetToolbarTimeout();
  });

  jumpInput?.addEventListener('change', async (e) => {
    e.stopPropagation();
    const targetPage = parseInt(jumpInput.value, 10);

    if (targetPage >= 1 && targetPage <= totalPagesCount) {
      while (currentlyLoadedPage < targetPage) {
        await loadNextBatch();
      }
      setupPageObserver();

      const targetElem = document.getElementById(`page-${targetPage}`);
      targetElem?.scrollIntoView({ behavior: 'smooth' });
    }
    resetToolbarTimeout();
  });

  document.getElementById('zoom-in-btn')?.addEventListener('click', async () => {
    zoomMultiplier = Math.min(zoomMultiplier + 0.25, 3.0);
    updateZoomLabel();
    await reRenderLoadedPages();
  });

  document.getElementById('zoom-out-btn')?.addEventListener('click', async () => {
    if (zoomMultiplier <= 0.35) return;
    zoomMultiplier = Math.max(zoomMultiplier - 0.25, 0.35);
    updateZoomLabel();
    await reRenderLoadedPages();
  });

  async function reRenderLoadedPages() {
    const loadedPagesCount = currentlyLoadedPage;
    for (let pageNum = 1; pageNum <= loadedPagesCount; pageNum++) {
      const wrapper = document.getElementById(`page-${pageNum}`);
      if (wrapper) {
        wrapper.dataset.rendered = 'false';
        await renderSinglePage(pageNum, wrapper);
      }
    }
    setupPageObserver();
  }

  function handleScrollBatchLoad() {
    if (currentlyLoadedPage >= totalPagesCount || isLoadingBatch) return;

    if (scrollDebounceTimeout) clearTimeout(scrollDebounceTimeout);

    scrollDebounceTimeout = setTimeout(() => {
      const scrollPosition = window.innerHeight + window.scrollY;
      const threshold = document.body.offsetHeight - 900;

      if (scrollPosition >= threshold) {
        loadNextBatch();
        setupPageObserver();
      }
    }, 100);
  }

 /* ==========================================
   FLOATING TOOLBAR CONTROLS (CLICK ONLY)
   ========================================== */

// We empty this out so the toolbar no longer auto-hides after 3 seconds!
function resetToolbarTimeout() {
  // Purposely left blank to kill the auto-hide timer bug
}

// Replaces initToolbarAutoHide
function initToolbarToggle() {
  const viewerContainer = document.getElementById('viewer-container');
  const floatingToolbar = document.getElementById('floating-toolbar');
  
  if (!viewerContainer || !floatingToolbar) return;

  // Listen for clicks on the entire viewer container
  viewerContainer.addEventListener('click', (e) => {
    
    // 1. If drawing pen is ON, do not hide the toolbar
    if (typeof isPenActive !== 'undefined' && isPenActive) return;

    // 2. If the user clicked directly ON the toolbar or its buttons, do not hide it
    if (floatingToolbar.contains(e.target)) return;

    // 3. Otherwise, they clicked a blank spot on the PDF -> Toggle!
    floatingToolbar.classList.toggle('hidden');
  });
}
 

 

  function showError(msg) {
    const viewerContainer = document.getElementById('viewer-container');
    if (viewerContainer) {
      viewerContainer.innerHTML = `<p style="color:var(--danger); text-align:center; padding:30px;">⚠️ ${msg}</p>`;
    }
  }
})();