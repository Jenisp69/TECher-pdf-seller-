/* ==========================================
   ADVANCED INTERACTIVE PDF ENGINE (OPTIMIZED)
   ========================================== */

(() => {
  'use strict';

  // --- Core State Management ---
  let currentPdfDoc = null;
  let totalPagesCount = 0;
  let currentlyLoadedPage = 0;
  const BATCH_SIZE = 10;
  let isLoadingBatch = false;

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
     INITIALIZATION & PDF LOADING
     ========================================== */
  window.initReader = async function (sessionData) {
    const viewerContainer = document.getElementById('viewer-container');
    if (!viewerContainer) return;

    currentlyLoadedPage = 0;
    isLoadingBatch = false;
    zoomMultiplier = 1.0;

    updateZoomLabel();

    activeSubjectId = sessionData?.subjectName || 'course_doc';
    viewerContainer.innerHTML =
      '<p style="color:var(--text-muted); text-align:center; padding:30px;">⏳ Securing & loading document...</p>';

    if (!sessionData || !sessionData.pdfPath) {
      showError('No document path provided.');
      return;
    }

    const bucketName = typeof STORAGE_BUCKET !== 'undefined' ? STORAGE_BUCKET : 'course-notes';

    try {
      const { data: blobData, error: downloadError } = await supabaseClient.storage
        .from(bucketName)
        .download(sessionData.pdfPath);

      if (downloadError || !blobData) {
        throw new Error(downloadError ? downloadError.message : 'Failed to fetch secure document stream.');
      }

      const arrayBuffer = await blobData.arrayBuffer();

      const loadingTask = pdfjsLib.getDocument({
        data: arrayBuffer,
        disableAutoFetch: true,
        disableStream: false,
      });

      currentPdfDoc = await loadingTask.promise;
      totalPagesCount = currentPdfDoc.numPages;

      setTotalPages(totalPagesCount);

      viewerContainer.innerHTML = '';

      const firstPage = await currentPdfDoc.getPage(1);
      const unscaledViewport = firstPage.getViewport({ scale: 1.0 });
      const containerWidth = Math.min(viewerContainer.clientWidth || window.innerWidth, window.innerWidth);
      baseFitScale = containerWidth / unscaledViewport.width;
      firstPage.cleanup();

      const pagesList = document.createElement('div');
      pagesList.id = 'pdf-pages-list';
      pagesList.style.width = '100%';
      pagesList.style.userSelect = 'none';

      viewerContainer.appendChild(pagesList);

      const loadMoreContainer = document.createElement('div');
      loadMoreContainer.id = 'load-more-container';
      loadMoreContainer.style.textAlign = 'center';
      loadMoreContainer.style.margin = '20px 0 40px 0';
      viewerContainer.appendChild(loadMoreContainer);

      await loadNextBatch();

      setupPageObserver();
      setupTouchPinchZoom();

      window.removeEventListener('scroll', handleScrollBatchLoad);
      window.addEventListener('scroll', handleScrollBatchLoad, { passive: true });

      initToolbarAutoHide();
    } catch (err) {
      console.error('PDF render error:', err);
      showError(`Failed to load document: ${err.message}`);
    }
  };

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
      wrapper.style.position = 'relative';

      fragment.appendChild(wrapper);
      renderTasks.push({ pageNum, wrapper });
    }

    pagesList?.appendChild(fragment);

    await Promise.all(renderTasks.map((task) => renderSinglePage(task.pageNum, task.wrapper)));

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
     PAGE RENDERER (HIGH-DPI OPTIMIZED)
     ========================================== */
  async function renderSinglePage(pageNum, wrapper) {
    try {
      wrapper.innerHTML = '';
      const page = await currentPdfDoc.getPage(pageNum);

      const dpr = window.devicePixelRatio || 1;
      const effectiveScale = baseFitScale * zoomMultiplier;
      const viewport = page.getViewport({ scale: effectiveScale });

      wrapper.style.width = `${viewport.width}px`;

      // 1. PDF Canvas
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

      // 2. Drawing Canvas Overlay
      const drawCanvas = document.createElement('canvas');
      drawCanvas.className = 'draw-overlay';
      drawCanvas.width = viewport.width * dpr;
      drawCanvas.height = viewport.height * dpr;
      drawCanvas.style.position = 'absolute';
      drawCanvas.style.top = '0';
      drawCanvas.style.left = '0';
      drawCanvas.style.width = '100%';
      drawCanvas.style.height = '100%';
      drawCanvas.style.pointerEvents = isPenActive ? 'auto' : 'none';
      drawCanvas.style.cursor = 'crosshair';
      drawCanvas.style.touchAction = isPenActive ? 'none' : 'auto';

      wrapper.appendChild(drawCanvas);
      attachDrawingEvents(drawCanvas);

      // 3. Collapsible Note Tag
      const noteTrigger = document.createElement('button');
      noteTrigger.className = 'page-note-trigger';
      noteTrigger.innerHTML = `<i class="fa-solid fa-note-sticky"></i> Note`;

      const notePanel = document.createElement('div');
      notePanel.className = 'page-note-panel hidden';

      const noteBox = document.createElement('textarea');
      noteBox.placeholder = `📝 Page ${pageNum} note...`;

      const noteKey = `note_${activeSubjectId}_p${pageNum}`;
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
    } catch (err) {
      console.error(`Error rendering page ${pageNum}:`, err);
    }
  }

  /* ==========================================
     PINCH & ZOOM GESTURE ENGINE (MOBILE ONLY)
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

  /* ==========================================
     VIEWPORT PAGE OBSERVER
     ========================================== */
  function setupPageObserver() {
    if (pageObserver) pageObserver.disconnect();

    pageObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageNum = entry.target.dataset.pageNum;
            const pageInput = document.getElementById('page-jump-input');
            if (pageInput && document.activeElement !== pageInput) {
              pageInput.value = pageNum;
            }
          }
        });
      },
      {
        root: null,
        rootMargin: '-45% 0px -45% 0px',
        threshold: 0,
      }
    );

    document.querySelectorAll('.page-wrapper').forEach((p) => pageObserver.observe(p));
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
     PEN / DRAWING ENGINE (RAF OPTIMIZED)
     ========================================== */
  function attachDrawingEvents(canvas) {
    const ctx = canvas.getContext('2d');
    let isDrawing = false;
    let rafId = null;
    let lastPoint = null;

    const dpr = window.devicePixelRatio || 1;
    ctx.strokeStyle = '#ff3366';
    ctx.lineWidth = 3 * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    function getCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;

      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      return {
        x: (touch.clientX - rect.left) * scaleX,
        y: (touch.clientY - rect.top) * scaleY,
      };
    }

    function startDraw(e) {
      if (!isPenActive || (e.touches && e.touches.length > 1)) return;
      isDrawing = true;
      lastPoint = getCoords(e);
    }

    function draw(e) {
      if (!isDrawing || !isPenActive || (e.touches && e.touches.length > 1)) return;
      if (e.cancelable) e.preventDefault();

      const currentPoint = getCoords(e);

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
      isDrawing = false;
      lastPoint = null;
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
      const drawCanvas = targetPage.querySelector('.draw-overlay');
      if (drawCanvas) {
        const ctx = drawCanvas.getContext('2d');
        ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
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
     FLOATING TOOLBAR AUTO-HIDE
     ========================================== */
  function resetToolbarTimeout() {
    if (!floatingToolbar) return;

    floatingToolbar.classList.remove('hidden');
    if (toolbarTimer) clearTimeout(toolbarTimer);

    if (!isPenActive) {
      toolbarTimer = setTimeout(() => {
        floatingToolbar.classList.add('hidden');
      }, 3000);
    }
  }

  function initToolbarAutoHide() {
    const readerSection = document.getElementById('reader-section');
    if (!readerSection) return;

    readerSection.addEventListener('click', (e) => {
      if (isPenActive) return;
      if (floatingToolbar && floatingToolbar.contains(e.target)) return;

      if (floatingToolbar.classList.contains('hidden')) {
        resetToolbarTimeout();
      } else {
        floatingToolbar.classList.add('hidden');
        if (toolbarTimer) clearTimeout(toolbarTimer);
      }
    });

    resetToolbarTimeout();
  }

  function showError(msg) {
    const viewerContainer = document.getElementById('viewer-container');
    if (viewerContainer) {
      viewerContainer.innerHTML = `<p style="color:var(--danger); text-align:center; padding:30px;">⚠️ ${msg}</p>`;
    }
  }
})();s