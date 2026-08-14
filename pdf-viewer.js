/* ==========================================
   ADVANCED INTERACTIVE PDF ENGINE (VRAM OPTIMIZED)
   ========================================== */

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
     STREAMING FETCH HELPER
     ========================================== */
  async function fetchStreamWithProgress(url, statusCallback, statusPrefix = '⏳ Downloading') {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
    const reader = response.body.getReader();
    let receivedLength = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedLength += value.length;

      const mbReceived = (receivedLength / (1024 * 1024)).toFixed(1);
      const mbTotal = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(1) : null;
      const calculatedPct = totalBytes ? Math.min(80, Math.round((receivedLength / totalBytes) * 70) + 15) : null;

      statusCallback(
        mbTotal
          ? `${statusPrefix}: ${mbReceived} MB / ${mbTotal} MB...`
          : `${statusPrefix}: ${mbReceived} MB...`,
        calculatedPct
      );
    }

    const concatenated = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
      concatenated.set(chunk, position);
      position += chunk.length;
    }
    return concatenated;
  }

  /* ==========================================
     BACKGROUND SPECULATIVE PRELOAD ENGINE
     ========================================== */
  const pdfBufferCache = new Map();

  /**
   * Background fetcher that streams document binary into RAM before user clicks.
   */
  async function preloadDocumentPayload(subjectId, pdfPath) {
    if (!pdfPath || pdfBufferCache.has(subjectId)) return;

    try {
      const driveMatch = pdfPath.match(/[-_a-zA-Z0-9]{25,}/);
      let arrayBuffer = null;

      if (pdfPath.startsWith('http') && driveMatch && typeof GOOGLE_APPS_SCRIPT_URL !== 'undefined') {
        const proxyUrl = `${GOOGLE_APPS_SCRIPT_URL}?fileId=${driveMatch[0]}`;
        const response = await fetch(proxyUrl);
        if (!response.ok) return;

        const rawTextBytes = await response.arrayBuffer();
        const base64String = new TextDecoder().decode(rawTextBytes).trim();

        if (!base64String.startsWith('ERROR:')) {
          const dataUrl = `data:application/pdf;base64,${base64String}`;
          const blobRes = await fetch(dataUrl);
          arrayBuffer = await blobRes.arrayBuffer();
        }
      } else if (pdfPath.startsWith('http')) {
        const res = await fetch(pdfPath);
        if (res.ok) arrayBuffer = await res.arrayBuffer();
      } else {
        const bucketName = typeof STORAGE_BUCKET !== 'undefined' ? STORAGE_BUCKET : 'course-notes';
        const { data: blobData } = await supabaseClient.storage.from(bucketName).download(pdfPath);
        if (blobData) arrayBuffer = await blobData.arrayBuffer();
      }

      if (arrayBuffer) {
        pdfBufferCache.set(subjectId, arrayBuffer);
        console.log(`⚡ [Preload Complete] Payload cached for subject: ${subjectId}`);
      }
    } catch (err) {
      console.warn(`[Background Preload Non-Fatal Error] ${subjectId}:`, err);
    }
  }

  /**
   * Hook to call as soon as student logs in or course list renders.
   */
  window.preloadAllStudentCourses = function (enrolledSubjects) {
    if (!Array.isArray(enrolledSubjects)) return;

    // Stagger requests slightly to prevent browser socket starvation
    enrolledSubjects.forEach((sub, index) => {
      if (sub.pdf_storage_path) {
        setTimeout(() => {
          preloadDocumentPayload(sub.id, sub.pdf_storage_path);
        }, index * 800);
      }
    });
  };

  /* ==========================================
     INITIALIZATION & PDF LOADING (CACHE-AWARE)
     ========================================== */
  window.initReader = async function (sessionData) {
    const viewerContainer = document.getElementById('viewer-container');
    if (!viewerContainer) return;

    currentlyLoadedPage = 0;
    isLoadingBatch = false;
    zoomMultiplier = 1.0;
    updateZoomLabel();

    activeSubjectId = sessionData?.subjectName || 'course_doc';

    // --- Dynamic Dynamic Progress Bar Controller ---
    let currentPercent = 5;
    let targetPercent = 10;
    let progressInterval = null;
    let lastText = '';

    const renderStatus = (text, percent) => {
      viewerContainer.innerHTML = `
        <div style="text-align:center; padding:40px 20px;">
          <p style="color:var(--text-muted, #a0aec0); font-size: 0.95rem; margin:0;">${text}</p>
          <div style="width: 80%; max-width: 320px; height: 6px; background: rgba(255,255,255,0.1); border-radius: 4px; margin: 14px auto 0 auto; overflow: hidden;">
            <div style="width: ${percent}%; height: 100%; background: var(--accent, #007bff); transition: width 0.25s ease-out;"></div>
          </div>
        </div>`;
    };

    const startProgressLoop = () => {
      if (progressInterval) clearInterval(progressInterval);
      progressInterval = setInterval(() => {
        if (currentPercent < targetPercent) {
          currentPercent += Math.max(0.3, (targetPercent - currentPercent) * 0.15);
        } else if (targetPercent < 88) {
          // Continuous, natural crawl while waiting on slow network/proxy responses
          currentPercent += (88 - currentPercent) * 0.02 + 0.1;
        }
        renderStatus(lastText, Math.min(Math.round(currentPercent), 99));
      }, 150);
    };

    const updateStatus = (text, forcedPercent = null) => {
      lastText = text;
      if (forcedPercent !== null) {
        targetPercent = Math.max(targetPercent, forcedPercent);
      }
      if (!progressInterval) startProgressLoop();
    };

    const stopProgressLoop = () => {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    };

    if (!sessionData || !sessionData.pdfPath) {
      showError('No document path provided.');
      return;
    }

    try {
      let arrayBuffer = null;
      const pdfPath = sessionData.pdfPath;

      // --- CHECK 1: Instant RAM Cache Hit ---
      if (pdfBufferCache.has(activeSubjectId)) {
        updateStatus('⚡ Instantly launching cached document payload...', 90);
        arrayBuffer = pdfBufferCache.get(activeSubjectId);
      }
      // --- CHECK 2: Cache Miss -> Stream from Network with Dynamic Progress Bar ---
      else {
        updateStatus('⏳ Securing & establishing document stream...', 15);
        startProgressLoop();

        const driveMatch = pdfPath ? pdfPath.match(/[-_a-zA-Z0-9]{25,}/) : null;

        if (pdfPath.startsWith('http://') || pdfPath.startsWith('https://')) {
          if (driveMatch) {
            const fileId = driveMatch[0];
            if (typeof GOOGLE_APPS_SCRIPT_URL !== 'undefined') {
              const proxyUrl = `${GOOGLE_APPS_SCRIPT_URL}?fileId=${fileId}`;

              const rawTextBytes = await fetchStreamWithProgress(
                proxyUrl,
                (msg, pct) => updateStatus(msg, pct || 45),
                '⏳ Fetching document payload via proxy'
              );

              updateStatus('⚡ Decoding binary stream (C++ engine)...', 80);
              const base64String = new TextDecoder().decode(rawTextBytes).trim();

              if (base64String.startsWith('ERROR:')) {
                throw new Error(base64String);
              }

              const dataUrl = `data:application/pdf;base64,${base64String}`;
              const blobRes = await fetch(dataUrl);
              arrayBuffer = await blobRes.arrayBuffer();
            } else {
              throw new Error('Google Apps Script proxy URL is undefined.');
            }
          } else {
            const concatenated = await fetchStreamWithProgress(
              pdfPath,
              (msg, pct) => updateStatus(msg, pct || 50),
              '⏳ Downloading document stream'
            );
            arrayBuffer = concatenated.buffer;
          }
        } else {
          const bucketName = typeof STORAGE_BUCKET !== 'undefined' ? STORAGE_BUCKET : 'course-notes';
          const { data: blobData, error: downloadError } = await supabaseClient.storage
            .from(bucketName)
            .download(pdfPath);

          if (downloadError || !blobData) {
            throw new Error(downloadError ? downloadError.message : 'Failed to fetch secure document stream.');
          }
          arrayBuffer = await blobData.arrayBuffer();
        }

        // Cache for subsequent opens
        pdfBufferCache.set(activeSubjectId, arrayBuffer);
      }

      updateStatus('🚀 Initializing PDF render worker...', 95);

      // CLONE ArrayBuffer using .slice(0) to prevent worker detachment of cached buffer
      const loadingTask = pdfjsLib.getDocument({
        data: arrayBuffer.slice(0),
        disableAutoFetch: true,
        disableStream: false,
      });

      currentPdfDoc = await loadingTask.promise;
      totalPagesCount = currentPdfDoc.numPages;

      stopProgressLoop();
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
      stopProgressLoop();
      console.error('PDF render error:', err);
      showError(`Failed to load document: ${err.message}`);
    }
  };

  /* ==========================================
     BATCH PAGE LOADER (ADAPTIVE EXECUTOR)
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

    // Adaptive rendering strategy based on device capability
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
     PAGE RENDERER (VRAM-AWARE)
     ========================================== */
  async function renderSinglePage(pageNum, wrapper) {
    if (wrapper.dataset.rendered === 'true' && wrapper.querySelector('canvas')) return;

    try {
      wrapper.innerHTML = '';
      const page = await currentPdfDoc.getPage(pageNum);

      const dpr = window.devicePixelRatio || 1;
      const effectiveScale = baseFitScale * zoomMultiplier;
      const viewport = page.getViewport({ scale: effectiveScale });

      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.minHeight = `${viewport.height}px`;

      // 1. PDF Render Canvas
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

      // 2. Drawing Overlay Canvas
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
      attachDrawingEvents(drawCanvas, pageNum);

      // 3. Persistent Page Note UI
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
      wrapper.dataset.rendered = 'true';
    } catch (err) {
      console.error(`Error rendering page ${pageNum}:`, err);
    }
  }

  /* ==========================================
     VRAM CLEANUP & RE-RENDER OBSERVER
     ========================================== */
  function unloadOffscreenCanvas(wrapper) {
    const canvases = wrapper.querySelectorAll('canvas');
    if (canvases.length > 0) {
      canvases.forEach((canvas) => {
        canvas.width = 0; // Release VRAM allocation instantly
        canvas.height = 0;
        canvas.remove();
      });
      wrapper.dataset.rendered = 'false';
    }
  }

  function setupPageObserver() {
    if (pageObserver) pageObserver.disconnect();

    pageObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach(async (entry) => {
          const wrapper = entry.target;
          const pageNum = parseInt(wrapper.dataset.pageNum, 10);

          if (entry.isIntersecting) {
            // Re-render canvas if unloaded by VRAM garbage collector
            if (wrapper.dataset.rendered === 'false') {
              await renderSinglePage(pageNum, wrapper);
            }

            const pageInput = document.getElementById('page-jump-input');
            if (pageInput && document.activeElement !== pageInput) {
              pageInput.value = pageNum;
            }
          } else {
            // Unload canvas from DOM if page is far off-screen on low-end hardware
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
     DRAWING ENGINE (RAF OPTIMIZED)
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
})();