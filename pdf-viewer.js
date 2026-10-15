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

  // --- Core State Management ---
  let currentPdfDoc = null;
  let totalPagesCount = 0;
  let documentChunks = []; 

  // --- Layout & View Settings ---
  let baseFitScale = 1.0;
  let zoomMultiplier = 1.0;
  let isPenActive = false;
  let activeSubjectId = 'default_subject';
  let activeStudentId = 'guest';

  // --- Page slots (one empty box per page, drawn only when near the screen) ---
  let pageWrappers = [];
  let pageHeightRatio = 1.414;      // page height / page width, measured from page 1
  let layoutWidth = 0;              // page width in pixels at 100% zoom
  const visiblePages = new Set();   // pages currently near the screen
  let scrollListenerAttached = false;
  let scrollTicking = false;
  let toolbarToggleBound = false;

  // --- Gestures & UI Timers ---
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
  // Everything a student draws or writes is saved per student, per book, on this device
  function storageScope() {
    return `${activeStudentId}_${activeSubjectId}`;
  }

  function getStrokeStorageKey(pageNum) {
    return `strokes_${storageScope()}_p${pageNum}`;
  }

  function getNoteStorageKey(pageNum) {
    return `note_${storageScope()}_p${pageNum}`;
  }

  function getNotePrefix() {
    return `note_${storageScope()}_p`;
  }

  // Older versions saved pen strokes and notes under the book's NAME (and the very first ones
  // without the student's id at all). Move them once to this student + the book's id.
  function migrateLegacyStorage(subjectName) {
    try {
      const rules = [];
      [...new Set([subjectName, activeSubjectId].filter(Boolean))].forEach((name) => {
        // oldest format: no student id
        rules.push({ kind: 'strokes', prefix: `strokes_${name}_p` });
        rules.push({ kind: 'note', prefix: `note_${name}_p` });
      });
      if (subjectName && subjectName !== activeSubjectId) {
        // previous format: student id + book name
        rules.push({ kind: 'strokes', prefix: `strokes_${activeStudentId}_${subjectName}_p` });
        rules.push({ kind: 'note', prefix: `note_${activeStudentId}_${subjectName}_p` });
      }

      const moves = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        for (const rule of rules) {
          if (key.startsWith(rule.prefix)) {
            moves.push([key, `${rule.kind}_${storageScope()}_p${key.slice(rule.prefix.length)}`]);
          }
        }
      }
      moves.forEach(([oldKey, newKey]) => {
        const value = localStorage.getItem(oldKey);
        if (value !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, value);
        localStorage.removeItem(oldKey);
      });
    } catch (e) {
      // storage problems must never stop the book from opening
    }
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
    markDirty('s', pageNum);
  }

  function clearSavedStrokes(pageNum) {
    localStorage.removeItem(getStrokeStorageKey(pageNum));
    markDirty('s', pageNum);
  }

  const CLOUD_SYNC_ENABLED = true;   // set to false to switch ALL online saving off (notes then stay on the device only)
  const CLOUD_PULL_DELAY_MS = 1500; // fetch saved notes this long AFTER the book opens, so they never slow the book down
  const SYNC_DELAY_MS = 2000;       // wait this long after the last change before saving online
  const SYNC_BATCH_PAGES = 25;      // pages sent in one request
  const SYNC_MAX_FAILURES = 8;      // give up for this visit after this many failed attempts in a row
  const STROKE_SCALE = 10000;       // pen points are saved as whole numbers (1 = 0.01% of the page)
  const STROKE_MIN_STEP = 6;        // pen points closer than this are skipped (about 1 pixel)

  // Describes the book that is open: { studentId, token, subjectId, scope }. null = no online saving.
  let cloud = null;
  let syncTimer = null;
  let lastPullAt = 0;

  // Pages with changes that are not saved online yet. Kept on the device so nothing is lost if the tab closes.
  // Keys look like "n12" (note on page 12) or "s12" (pen strokes on page 12); the value counts the changes.
  function readDirty(ctx) {
    try {
      return JSON.parse(localStorage.getItem(`dirty_${ctx.scope}`) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function writeDirty(ctx, dirty) {
    try {
      if (Object.keys(dirty).length) localStorage.setItem(`dirty_${ctx.scope}`, JSON.stringify(dirty));
      else localStorage.removeItem(`dirty_${ctx.scope}`);
    } catch (e) {
      // storage problems must never stop reading
    }
  }

  // kind: 'n' = note, 's' = pen strokes
  function markDirty(kind, pageNum) {
    if (!cloud) return;
    const dirty = readDirty(cloud);
    const key = `${kind}${pageNum}`;
    dirty[key] = (dirty[key] || 0) + 1;
    writeDirty(cloud, dirty);
    scheduleSync();
  }

  function scheduleSync() {
    if (!cloud) return;
    const ctx = cloud;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => cloudPush(ctx), SYNC_DELAY_MS);
  }

  function readLocalStrokes(scope, page) {
    try {
      return JSON.parse(localStorage.getItem(`strokes_${scope}_p${page}`) || '[]');
    } catch (e) {
      return [];
    }
  }

  // Pen strokes are saved in a compact form: whole numbers, each point stored as the
  // distance from the previous one, and points closer than about a pixel skipped.
  function packStrokes(strokes) {
    const packed = [];
    (strokes || []).forEach((stroke) => {
      if (!stroke || stroke.length < 2) return;
      const out = [];
      let px = 0;
      let py = 0;
      stroke.forEach((pt, i) => {
        const x = Math.round(pt.x * STROKE_SCALE);
        const y = Math.round(pt.y * STROKE_SCALE);
        const isFirst = out.length === 0;
        const isLast = i === stroke.length - 1;
        if (!isFirst && !isLast && Math.abs(x - px) + Math.abs(y - py) < STROKE_MIN_STEP) return;
        out.push(isFirst ? x : x - px, isFirst ? y : y - py);
        px = x;
        py = y;
      });
      if (out.length >= 4) packed.push(out);
    });
    return JSON.stringify(packed);
  }

  function unpackStrokes(text) {
    try {
      return JSON.parse(text || '[]').map((flat) => {
        const stroke = [];
        let x = 0;
        let y = 0;
        for (let i = 0; i + 1 < flat.length; i += 2) {
          x += flat[i];
          y += flat[i + 1];
          stroke.push({ x: x / STROKE_SCALE, y: y / STROKE_SCALE });
        }
        return stroke;
      }).filter((stroke) => stroke.length > 1);
    } catch (e) {
      return [];
    }
  }

  // Send the unsaved pages to the database
  async function cloudPush(ctx) {
    if (!ctx || ctx.disabled || ctx.pushing) return;
    ctx.pushing = true;
    try {
      for (let round = 0; round < 40; round++) {
        const dirty = readDirty(ctx);
        const keys = Object.keys(dirty);
        if (!keys.length) break;

        const pages = [...new Set(keys.map((k) => parseInt(k.slice(1), 10)))].slice(0, SYNC_BATCH_PAGES);
        const items = pages.map((page) => {
          const item = { page };
          // an empty note / empty strokes list means "deleted" and is saved as such
          if (dirty['n' + page]) item.note = localStorage.getItem(`note_${ctx.scope}_p${page}`) || '';
          if (dirty['s' + page]) item.strokes = packStrokes(readLocalStrokes(ctx.scope, page));
          return item;
        });

        const { data, error } = await supabaseClient.rpc('save_my_annotations', {
          p_student_id: ctx.studentId,
          p_token: ctx.token,
          p_subject_id: ctx.subjectId,
          p_items: items
        });
        if (error) throw error;
        if (!data || data.ok !== true) {
          if (data && data.error === 'bad_token') { ctx.disabled = true; return; } // logged in somewhere else
          throw new Error((data && data.error) || 'Unknown error');
        }
        if (data.skipped && data.skipped.length) {
          console.warn('Some pages could not be saved online (too big):', data.skipped);
        }

        // Forget what was sent, unless it changed again while sending
        const now = readDirty(ctx);
        keys.forEach((k) => {
          if (pages.includes(parseInt(k.slice(1), 10)) && now[k] === dirty[k]) delete now[k];
        });
        writeDirty(ctx, now);
        ctx.failures = 0;
      }
    } catch (e) {
      ctx.failures = (ctx.failures || 0) + 1;
      console.warn('Saving notes online failed, will retry:', e);
      if (ctx.failures >= SYNC_MAX_FAILURES) {
        ctx.disabled = true; // the unsent list stays on the device and is tried again next time
      } else {
        setTimeout(() => cloudPush(ctx), Math.min(SYNC_DELAY_MS * Math.pow(2, ctx.failures), 5 * 60 * 1000));
      }
    } finally {
      ctx.pushing = false;
    }
  }

  // Get this student's notes and pen strokes for the open book from the database
  async function cloudPull(ctx) {
    if (!ctx || ctx.disabled) return;
    try {
      const { data, error } = await supabaseClient.rpc('get_my_annotations', {
        p_student_id: ctx.studentId,
        p_token: ctx.token,
        p_subject_id: ctx.subjectId
      });
      if (error) throw error;
      if (!data || data.ok !== true) {
        if (data && data.error === 'bad_token') ctx.disabled = true;
        return;
      }
      lastPullAt = Date.now();

      const dirty = readDirty(ctx);
      const changedPages = new Set();
      const knownNote = new Set();
      const knownStrokes = new Set();

      // The database wins, except for pages with changes on this device that are not saved yet
      (data.rows || []).forEach((row) => {
        const page = row.page;

        if (row.note !== null && row.note !== undefined) {
          knownNote.add(page);
          if (!dirty['n' + page]) {
            const key = `note_${ctx.scope}_p${page}`;
            if ((localStorage.getItem(key) || '') !== row.note) {
              if (row.note) localStorage.setItem(key, row.note);
              else localStorage.removeItem(key);
              changedPages.add(page);
            }
          }
        }

        if (row.strokes !== null && row.strokes !== undefined) {
          knownStrokes.add(page);
          if (!dirty['s' + page]) {
            if (packStrokes(readLocalStrokes(ctx.scope, page)) !== row.strokes) {
              const key = `strokes_${ctx.scope}_p${page}`;
              const strokes = unpackStrokes(row.strokes);
              if (strokes.length) localStorage.setItem(key, JSON.stringify(strokes));
              else localStorage.removeItem(key);
              changedPages.add(page);
            }
          }
        }
      });

      // Anything written on this device that the database has never seen is sent up once
      const notePrefix = `note_${ctx.scope}_p`;
      const strokePrefix = `strokes_${ctx.scope}_p`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key.startsWith(notePrefix)) {
          const page = parseInt(key.slice(notePrefix.length), 10);
          if (!isNaN(page) && !knownNote.has(page) && !dirty['n' + page] && localStorage.getItem(key)) dirty['n' + page] = 1;
        } else if (key.startsWith(strokePrefix)) {
          const page = parseInt(key.slice(strokePrefix.length), 10);
          if (!isNaN(page) && !knownStrokes.has(page) && !dirty['s' + page] && readLocalStrokes(ctx.scope, page).length) dirty['s' + page] = 1;
        }
      }
      writeDirty(ctx, dirty);
      if (Object.keys(dirty).length) setTimeout(() => cloudPush(ctx), SYNC_DELAY_MS);

      // Redraw pages on screen whose notes or strokes just changed
      if (cloud === ctx) {
        changedPages.forEach((page) => {
          const wrapper = pageWrappers[page - 1];
          if (wrapper && wrapper.dataset.rendered === 'true') {
            unloadOffscreenCanvas(wrapper);
            if (visiblePages.has(page)) renderSinglePage(page, wrapper);
          }
        });
      }
    } catch (e) {
      console.warn('Loading notes from the database failed (they stay on this device):', e);
    }
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

  // Send anything still waiting from the previous book before switching
  if (cloud) cloudPush(cloud);

  zoomMultiplier = 1.0;
  activeSubjectId = sessionData.subjectId || sessionData.subjectName || 'course_doc';
  activeStudentId = sessionData.studentId || 'guest';
  migrateLegacyStorage(sessionData.subjectName);

  // Online saving: only for logged-in students, and only when the book's real id is known
  const syncToken = sessionData.sessionToken || '';
  cloud = (CLOUD_SYNC_ENABLED && activeStudentId !== 'guest' && syncToken && sessionData.subjectId && typeof supabaseClient !== 'undefined')
    ? { studentId: activeStudentId, token: syncToken, subjectId: activeSubjectId, scope: storageScope() }
    : null;
  pageWrappers = [];
  visiblePages.clear();
  const searchBox = document.getElementById('note-search-input');
  if (searchBox) searchBox.value = '';
  document.getElementById('note-search-results')?.classList.add('hidden');
  documentChunks = [];
  stopReaderLoading();      // stop anything left over from a previous book
  readerStopped = false;
  readerSession++;
  activeFetches = 0;
  preloadEnabled = false;
  currentReadPage = 1;

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
        const chunkObj = { fileId: id, startPage: currentStartPage, endPage: currentStartPage + pagesCount - 1, pageCount: pagesCount, docInstance: null, isFetching: false, session: readerSession };
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
    layoutWidth = containerWidth;
    pageHeightRatio = unscaledViewport.height / unscaledViewport.width;
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

    // One empty, correctly sized slot per page, so scrolling and "jump to page" work instantly
    buildPagePlaceholders(pagesList);
    setupPageObserver();
    initToolbarToggle();
    startScrollTracking();

    preloadEnabled = true;
    updateCurrentPage();   // page 1: starts loading the pieces ahead

    // Lowest priority: bring in notes and pen strokes saved on other devices a moment after the book is open
    if (cloud) {
      const pullCtx = cloud;
      setTimeout(() => { if (cloud === pullCtx) cloudPull(pullCtx); }, CLOUD_PULL_DELAY_MS);
    }

  } catch (err) {
    clearInterval(progressInterval); // Clean up timer on error
    console.error('PDF Init Error:', err);
    viewerContainer.innerHTML = `<p style="color:red; text-align:center; margin-top: 20px;">Failed to load document: ${err.message}</p>`;
  }
};


/* ==========================================
     SMART LOADING
     - keeps a moving window of pages loaded ahead of the reader
     - downloads a few pieces at the same time
     - saves pieces on the device so reopening a book is instant
     - stops everything when the student leaves the book
     ========================================== */
  const PRELOAD_AHEAD_PAGES = 50;    // keep this many pages ahead of the reader loaded
  const PRELOAD_BEHIND_PAGES = 10;   // also keep a few pages behind the reader ready
  const KEEP_BEHIND_PAGES = 40;      // free memory for pieces further behind than this
  const KEEP_AHEAD_PAGES = 120;      // ...or further ahead than this
  const MAX_PARALLEL_FETCHES = 3;    // pieces downloaded at the same time
  const CACHE_ENABLED = true;        // set to false to switch the saved copies off
  const CACHE_DB_NAME = 'thinkahead_chunk_cache';
  const CACHE_MAX_BYTES = 300 * 1024 * 1024;

  let currentReadPage = 1;
  let activeFetches = 0;
  let preloadEnabled = false;
  let readerStopped = false;
  let readerSession = 0;
  const activeControllers = new Set();

  // If the fast route fails, skip it for 60 seconds, then try it again
  let directRetryAt = 0;

  /* ---- Saved copies on the student's device (IndexedDB) ---- */
  let cacheDbPromise = null;

  function openCacheDb() {
    if (!CACHE_ENABLED || typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (!cacheDbPromise) {
      cacheDbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(CACHE_DB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore('chunks');                    // key = file id, value = the PDF piece
            db.createObjectStore('meta', { keyPath: 'id' });   // {id, size, lastUsed}
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    }
    return cacheDbPromise;
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function cacheGet(fileId) {
    try {
      const db = await openCacheDb();
      if (!db) return null;
      const data = await idbRequest(db.transaction('chunks').objectStore('chunks').get(fileId));
      if (!data) return null;
      db.transaction('meta', 'readwrite').objectStore('meta')
        .put({ id: fileId, size: data.byteLength, lastUsed: Date.now() });
      return data;
    } catch (e) {
      return null;
    }
  }

  async function cachePrune(db) {
    const all = await idbRequest(db.transaction('meta').objectStore('meta').getAll());
    let total = all.reduce((sum, m) => sum + (m.size || 0), 0);
    if (total <= CACHE_MAX_BYTES) return;
    all.sort((a, b) => a.lastUsed - b.lastUsed); // oldest first
    const tx = db.transaction(['chunks', 'meta'], 'readwrite');
    for (const m of all) {
      if (total <= CACHE_MAX_BYTES * 0.85) break;
      tx.objectStore('chunks').delete(m.id);
      tx.objectStore('meta').delete(m.id);
      total -= (m.size || 0);
    }
  }

  async function cachePut(fileId, buffer) {
    try {
      const db = await openCacheDb();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['chunks', 'meta'], 'readwrite');
        tx.objectStore('chunks').put(buffer, fileId);
        tx.objectStore('meta').put({ id: fileId, size: buffer.byteLength, lastUsed: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      await cachePrune(db);
    } catch (e) {
      // the saved copy is a bonus, so any problem here is ignored
    }
  }

  /* ---- Stop everything when the student leaves the book ---- */
  function stopReaderLoading() {
    readerStopped = true;
    activeControllers.forEach((c) => { try { c.abort(); } catch (e) {} });
    activeControllers.clear();
  }

  /* ---- Free memory for pieces far away from the reader ---- */
  function releaseFarAway() {
    for (const chunk of documentChunks) {
      const farBehind = chunk.endPage < currentReadPage - KEEP_BEHIND_PAGES;
      const farAhead = chunk.startPage > currentReadPage + KEEP_AHEAD_PAGES;
      if ((farBehind || farAhead) && chunk.docInstance && !chunk.isFetching) {
        const doc = chunk.docInstance;
        chunk.docInstance = null;
        try { Promise.resolve(doc.destroy()).catch(() => {}); } catch (e) {}
      }
    }
  }

  /* ---- Keep the pages around the reader loaded: current piece first, then ahead, then just behind ---- */
  function preloadAhead(pageNum) {
    if (!preloadEnabled || readerStopped) return;
    if (!documentChunks.length || documentChunks[0].fileId === 'legacy_supabase') return;

    currentReadPage = pageNum;
    const firstWanted = pageNum - PRELOAD_BEHIND_PAGES;
    const lastWanted = pageNum + PRELOAD_AHEAD_PAGES;

    const idx = documentChunks.findIndex(c => pageNum >= c.startPage && pageNum <= c.endPage);
    if (idx === -1) return;

    const order = [idx];
    for (let i = idx + 1; i < documentChunks.length && documentChunks[i].startPage <= lastWanted; i++) order.push(i);
    for (let i = idx - 1; i >= 0 && documentChunks[i].endPage >= firstWanted; i--) order.push(i);

    // After a jump, stop downloads that are no longer near the reader
    const wanted = new Set(order);
    documentChunks.forEach((c, i) => {
      if (c.isFetching && !wanted.has(i) && c.controller) {
        try { c.controller.abort(); } catch (e) {}
      }
    });

    for (const i of order) {
      if (activeFetches >= MAX_PARALLEL_FETCHES) break;
      const chunk = documentChunks[i];
      if (chunk.docInstance || chunk.isFetching) continue;
      if ((chunk.failCount || 0) >= 2) continue; // stop retrying a piece that keeps failing
      fetchAndLoadChunk(chunk); // not awaited, pieces load side by side
    }
    releaseFarAway();
  }

  /* ---- Get one piece: saved copy first, then fast route, then the old script route ---- */
  async function fetchAndLoadChunk(chunk) {
    if (chunk.docInstance || chunk.isFetching) return;
    if (readerStopped || chunk.session !== readerSession) return;

    const mySession = readerSession;
    chunk.isFetching = true;
    activeFetches++;
    const controller = new AbortController();
    activeControllers.add(controller);
    chunk.controller = controller;

    try {
      let bytes = null;
      let fromCache = false;

      // 1. SAVED COPY on this device (instant)
      const cached = await cacheGet(chunk.fileId);
      if (controller.signal.aborted) return; // the student already left the book
      if (cached) {
        bytes = new Uint8Array(cached);
        fromCache = true;
      }

      // 2. FAST ROUTE: straight from Google Drive (no Apps Script, no base64)
      if (!bytes && Date.now() >= directRetryAt && typeof GOOGLE_DRIVE_API_KEY !== 'undefined' && GOOGLE_DRIVE_API_KEY) {
        try {
          const directUrl = `https://www.googleapis.com/drive/v3/files/${chunk.fileId}?alt=media&key=${GOOGLE_DRIVE_API_KEY}`;
          const directRes = await fetch(directUrl, { signal: controller.signal });
          if (!directRes.ok) throw new Error('Direct Drive status ' + directRes.status);
          bytes = new Uint8Array(await directRes.arrayBuffer());
        } catch (directErr) {
          if (directErr && directErr.name === 'AbortError') throw directErr;
          console.warn('Direct Drive load failed, using backup route:', directErr);
          directRetryAt = Date.now() + 60000;
          bytes = null;
        }
      }

      // 3. BACKUP ROUTE: the old Apps Script proxy
      if (!bytes) {
        const proxyUrl = `${GOOGLE_APPS_SCRIPT_URL}?fileId=${chunk.fileId}`;
        const response = await fetch(proxyUrl, { signal: controller.signal });
        if (!response.ok) throw new Error('Proxy connection failed.');

        const resJson = await response.json();
        if (resJson.status !== 'success') throw new Error('Proxy file fetch failed.');

        const binaryStr = window.atob(resJson.base64Data);
        const len = binaryStr.length;
        bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
      }

      // Keep a copy on this device for next time (before pdf.js takes over the bytes)
      if (!fromCache) cachePut(chunk.fileId, bytes.slice().buffer);

      const loadingTask = pdfjsLib.getDocument({
        data: bytes.buffer,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
        cMapPacked: true,
      });

      chunk.docInstance = await loadingTask.promise;
      chunk.failCount = 0;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // the student left the book, not a failure
      chunk.failCount = (chunk.failCount || 0) + 1;
      console.warn(`Failed to load chunk covering pages ${chunk.startPage}-${chunk.endPage}:`, err);
    } finally {
      activeControllers.delete(controller);
      chunk.isFetching = false;
      if (mySession === readerSession) {
        activeFetches = Math.max(0, activeFetches - 1);
        if (!readerStopped) preloadAhead(currentReadPage);
      }
    }
  }



  /* ==========================================
     PAGE SLOTS
     One empty box per page. A page is drawn only while it is near the screen.
     ========================================== */
  function estimatedPageHeight() {
    return Math.round(layoutWidth * zoomMultiplier * pageHeightRatio);
  }

  function buildPagePlaceholders(pagesList) {
    pageWrappers = [];
    const fragment = document.createDocumentFragment();
    const height = estimatedPageHeight();

    for (let pageNum = 1; pageNum <= totalPagesCount; pageNum++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.id = `page-${pageNum}`;
      wrapper.dataset.pageNum = pageNum;
      wrapper.dataset.rendered = 'false';
      wrapper.style.position = 'relative';
      wrapper.style.minHeight = `${height}px`;
      wrapper.innerHTML = `<p class="page-placeholder">Page ${pageNum}</p>`;
      pageWrappers.push(wrapper);
      fragment.appendChild(wrapper);
    }
    pagesList.appendChild(fragment);
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

      const noteKey = getNoteStorageKey(globalPageNum);
      noteBox.value = localStorage.getItem(noteKey) || '';
      noteTrigger.classList.toggle('has-note', noteBox.value.trim().length > 0);

      noteBox.addEventListener('input', (e) => {
        const text = e.target.value;
        if (text.trim()) localStorage.setItem(noteKey, text);
        else localStorage.removeItem(noteKey);
        noteTrigger.classList.toggle('has-note', text.trim().length > 0);
        markDirty('n', globalPageNum);
      });

      // Clicking inside the note must not hide the toolbar
      notePanel.addEventListener('click', (e) => e.stopPropagation());

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
      if (!visiblePages.has(globalPageNum)) unloadOffscreenCanvas(wrapper); // scrolled away while drawing

    } catch (err) {
      console.error(`Error rendering global page ${globalPageNum}:`, err);
      wrapper.innerHTML = '';
      const failMsg = document.createElement('p');
      failMsg.className = 'page-placeholder';
      failMsg.textContent = `Couldn't load page ${globalPageNum}. `;
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-sm';
      retryBtn.textContent = 'Tap to retry';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const failedChunk = documentChunks.find(c => globalPageNum >= c.startPage && globalPageNum <= c.endPage);
        if (failedChunk) failedChunk.failCount = 0;
        renderSinglePage(globalPageNum, wrapper);
      });
      failMsg.appendChild(retryBtn);
      wrapper.appendChild(failMsg);
    } finally {
      // 9. Always unlock the element, even if rendering fails!
      wrapper.dataset.isRendering = 'false';
    }
  }

  /* ==========================================
     VRAM CLEANUP & RE-RENDER OBSERVER
     ========================================== */
  function unloadOffscreenCanvas(wrapper) {
    if (wrapper.dataset.rendered !== 'true') return;
    wrapper.querySelectorAll('canvas').forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    wrapper.innerHTML = `<p class="page-placeholder">Page ${wrapper.dataset.pageNum}</p>`;
    wrapper.dataset.rendered = 'false';
  }

/* ==========================================
   PAGE OBSERVER: draws pages near the screen, frees pages far from it
   ========================================== */
function setupPageObserver() {
  if (pageObserver) pageObserver.disconnect();
  visiblePages.clear();

  const margin = isLowEndMobile ? 1000 : 1500;

  pageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const wrapper = entry.target;
        const pageNum = parseInt(wrapper.dataset.pageNum, 10);

        if (entry.isIntersecting) {
          visiblePages.add(pageNum);
          if (wrapper.dataset.rendered === 'false') renderSinglePage(pageNum, wrapper);
        } else {
          visiblePages.delete(pageNum);
          unloadOffscreenCanvas(wrapper);
        }
      });
    },
    {
      root: null,
      rootMargin: `${margin}px 0px ${margin}px 0px`,
      threshold: 0,
    }
  );

  pageWrappers.forEach((wrapper) => pageObserver.observe(wrapper));
}

/* ==========================================
   WHICH PAGE IS THE STUDENT ON? (drives the loading window)
   ========================================== */
function startScrollTracking() {
  if (scrollListenerAttached) return;
  scrollListenerAttached = true;
  window.addEventListener('scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;
    setTimeout(() => {
      scrollTicking = false;
      updateCurrentPage();
    }, 150);
  }, { passive: true });
}

function updateCurrentPage() {
  if (!pageWrappers.length || readerStopped) return;

  // Binary search for the first page whose bottom edge is below the middle of the screen
  const center = window.innerHeight / 2;
  let lo = 0;
  let hi = pageWrappers.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pageWrappers[mid].getBoundingClientRect().bottom < center) lo = mid + 1;
    else hi = mid;
  }

  const pageNum = lo + 1;
  currentReadPage = pageNum;

  const pageInput = document.getElementById('page-jump-input');
  if (pageInput && document.activeElement !== pageInput) pageInput.value = pageNum;

  preloadAhead(pageNum);
}

function jumpToPage(target) {
  const pageNum = Math.min(Math.max(parseInt(target, 10) || 1, 1), totalPagesCount || 1);
  const wrapper = document.getElementById(`page-${pageNum}`);
  if (!wrapper) return;
  wrapper.scrollIntoView({ behavior: 'auto', block: 'start' }); // instant, no scrolling past hundreds of pages
  updateCurrentPage();
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

  jumpInput?.addEventListener('change', (e) => {
    e.stopPropagation();
    jumpToPage(jumpInput.value);
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
    // New zoom: resize every slot, drop the old drawings, and let the observer redraw the pages near the screen
    const height = estimatedPageHeight();
    pageWrappers.forEach((wrapper) => {
      wrapper.style.minHeight = `${height}px`;
      wrapper.style.width = '';
      unloadOffscreenCanvas(wrapper);
    });
    setupPageObserver();
  }

  /* ==========================================
     NOTE SEARCH (searches this student's notes in the open book)
     ========================================== */
  function searchMyNotes(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const prefix = getNotePrefix();
    const results = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const pageNum = parseInt(key.slice(prefix.length), 10);
      const text = localStorage.getItem(key) || '';
      const at = text.toLowerCase().indexOf(q);
      if (isNaN(pageNum) || at === -1) continue;

      const from = Math.max(0, at - 25);
      const snippet = (from > 0 ? '…' : '') + text.slice(from, at + q.length + 45).replace(/\s+/g, ' ');
      results.push({ pageNum, snippet });
    }
    return results.sort((a, b) => a.pageNum - b.pageNum).slice(0, 30);
  }

  function renderNoteSearchResults(query) {
    const box = document.getElementById('note-search-results');
    if (!box) return;
    box.innerHTML = '';

    if (!query.trim()) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');

    const results = searchMyNotes(query);
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'note-result-empty';
      empty.textContent = 'No notes found in this book.';
      box.appendChild(empty);
      return;
    }

    results.forEach((r) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'note-result-item';
      const label = document.createElement('b');
      label.textContent = `Page ${r.pageNum}`;
      const snippet = document.createElement('span');
      snippet.textContent = r.snippet;
      item.appendChild(label);
      item.appendChild(snippet);
      item.addEventListener('click', () => {
        box.classList.add('hidden');
        jumpToPage(r.pageNum);
      });
      box.appendChild(item);
    });
  }

  const noteSearchInput = document.getElementById('note-search-input');
  noteSearchInput?.addEventListener('input', () => renderNoteSearchResults(noteSearchInput.value));
  noteSearchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      noteSearchInput.value = '';
      renderNoteSearchResults('');
    }
  });
  document.addEventListener('click', (e) => {
    const inside = e.target && e.target.closest && e.target.closest('.note-search-wrapper');
    if (!inside) document.getElementById('note-search-results')?.classList.add('hidden');
  });

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
  if (toolbarToggleBound) return;   // otherwise every book opened adds one more listener
  toolbarToggleBound = true;

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
 

 

  document.getElementById('back-to-dash-btn')?.addEventListener('click', stopReaderLoading);

  // Save the notes online when the student leaves the book, switches app, or the internet returns
  document.getElementById('back-to-dash-btn')?.addEventListener('click', () => { if (cloud) cloudPush(cloud); });
  window.addEventListener('pagehide', () => { if (cloud) cloudPush(cloud); });
  window.addEventListener('online', () => { if (cloud) cloudPush(cloud); });
  document.addEventListener('visibilitychange', () => {
    if (!cloud) return;
    if (document.visibilityState === 'hidden') {
      cloudPush(cloud);                              // before the phone puts the page to sleep
    } else if (Date.now() - lastPullAt > 60000) {
      cloudPull(cloud);                              // pick up changes made on another device
    }
  });

  function showError(msg) {
    const viewerContainer = document.getElementById('viewer-container');
    if (viewerContainer) {
      viewerContainer.innerHTML = `<p style="color:var(--danger); text-align:center; padding:30px;">⚠️ ${msg}</p>`;
    }
  }
})();