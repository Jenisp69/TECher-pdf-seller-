/* ==========================================
   CATALOG FILTER (levels > streams > semesters), 100% driven by the database

   Nothing here knows the name of a level, stream or semester:
     levels     public.levels (if the public key may read it), otherwise taken from the level ids that
                streams / subjects already carry (shown as a tidied version of the id)
     streams    public.streams
     semesters  whatever distinct `semester` values the listed subjects in the current selection have

   A row only appears when it has something to choose:
     - the Level row needs 2 or more levels
     - the Stream row needs at least 1 stream that has a listed subject
     - the Semester row appears only when subjects in the current selection actually have a semester

   So when a teacher adds a level, stream or subject (or renames them, or starts using semesters),
   the filter follows on the next page load, with no code change.

   Public API used by auth.js: CatalogFilter.init(), .filterSubjects(list), .hasActive(), .clear()
   ========================================== */

const CatalogFilter = (() => {
  const sel = { level: null, stream: null, semester: null };

  let streams = [];       // rows of public.streams
  let levelRows = [];     // rows of public.levels (may stay empty if not readable)
  let catalog = [];       // subjects handed in by auth.js (public columns only)
  let signature = '';

  const $ = (id) => document.getElementById(id);

  /* ---------- data ---------- */
  async function fetchStreams() {
    try {
      const { data, error } = await supabaseClient.from('streams').select('*');
      if (error) throw error;
      streams = data || [];
    } catch (e) {
      console.error('Error loading streams for filter:', e);
    }
  }

  async function fetchLevels() {
    try {
      const { data, error } = await supabaseClient.from('levels').select('id, name, display_order');
      if (error) throw error;
      levelRows = data || [];
    } catch (e) {
      levelRows = [];   // not readable with the public key: names are derived from the ids instead
    }
  }

  const isListed = (sub) => Number(sub.total_pages || 0) > 0;

  function prettyId(id) {
    return String(id).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }

  // natural order for values like "1st", "2nd", "10th", or any text
  function compareNatural(a, b) {
    const na = parseInt(String(a).match(/\d+/) || [NaN], 10);
    const nb = parseInt(String(b).match(/\d+/) || [NaN], 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  // "1st" -> "1st Sem"; anything a teacher typed in another style is shown exactly as typed
  function semesterLabel(value) {
    return /^\d+(st|nd|rd|th)$/i.test(value) ? value + ' Sem' : value;
  }

  const hasCatalog = () => catalog.length > 0;

  function listedStreamIds() {
    const ids = new Set();
    catalog.forEach((s) => { if (isListed(s) && s.stream_id) ids.add(s.stream_id); });
    return ids;
  }

  function visibleStreams() {
    if (!hasCatalog()) return streams;
    const listed = listedStreamIds();
    return streams.filter((s) => listed.has(s.id));
  }

  function levelList() {
    const vs = visibleStreams();
    const ids = new Set(vs.map((s) => s.class_level).filter(Boolean));
    catalog.forEach((s) => { if (isListed(s) && s.class_level) ids.add(s.class_level); });
    const byId = new Map(levelRows.map((l) => [l.id, l]));
    return [...ids]
      .map((id) => {
        const row = byId.get(id);
        return { id, name: row && row.name ? row.name : prettyId(id), order: row ? Number(row.display_order) || 0 : 9999 };
      })
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  function streamsInScope() {
    return visibleStreams()
      .filter((s) => !sel.level || s.class_level === sel.level)
      .sort((a, b) => String(a.stream_name).localeCompare(String(b.stream_name), undefined, { numeric: true }));
  }

  function semestersInScope() {
    const found = new Set();
    if (!sel.stream) return [];     // semesters are scoped to a chosen stream, so the row stays short until then
    catalog.forEach((s) => {
      if (!isListed(s) || !s.semester) return;
      if (sel.level && s.class_level !== sel.level) return;
      if (sel.stream && s.stream_id !== sel.stream) return;
      found.add(String(s.semester));
    });
    return [...found].sort(compareNatural);
  }

  /* ---------- rendering ---------- */
  function pill(label, active, onClick, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill-btn' + (active ? ' active' : '') + (extraClass ? ' ' + extraClass : '');
    b.textContent = label;
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.addEventListener('click', onClick);
    return b;
  }

  function fillRow(rowId, pillsId, items) {
    const row = $(rowId);
    const box = $(pillsId);
    if (!row || !box) return;
    box.textContent = '';
    row.hidden = items.length === 0;
    items.forEach((p) => box.appendChild(p));
  }

  function renderBar() {
    const bar = $('catalog-filter-bar');
    if (!bar) return;

    const levels = levelList();
    const strs = streamsInScope();
    const sems = semestersInScope();

    // drop selections that no longer exist (renamed, removed, or no listed subjects any more)
    if (sel.level && !levels.some((l) => l.id === sel.level)) sel.level = null;
    if (sel.stream && !strs.some((s) => s.id === sel.stream)) sel.stream = null;
    if (sel.semester && !sems.includes(sel.semester)) sel.semester = null;

    const levelPills = [];
    if (levels.length > 1) {
      levelPills.push(pill('All', !sel.level, () => pick('level', null)));
      levels.forEach((l) => levelPills.push(pill(l.name, sel.level === l.id, () => pick('level', l.id))));
    }

    const streamPills = [];
    if (strs.length > 0) {
      streamPills.push(pill('All', !sel.stream, () => pick('stream', null)));
      strs.forEach((s) => streamPills.push(pill(s.stream_name, sel.stream === s.id, () => pick('stream', s.id))));
    }

    const semPills = [];
    if (sems.length > 0) {
      semPills.push(pill('All', !sel.semester, () => pick('semester', null)));
      sems.forEach((v) => semPills.push(pill(semesterLabel(v), sel.semester === v, () => pick('semester', v))));
    }

    // one small "Clear filters" pill at the start of the first visible row when something is selected
    if (hasActive()) {
      const clear = pill('Clear filters', false, clearAll, 'pill-clear');
      clear.removeAttribute('aria-pressed');
      const first = levelPills.length ? levelPills : (streamPills.length ? streamPills : semPills);
      first.unshift(clear);
    }

    fillRow('filter-level-group', 'filter-level-pills', levelPills);
    fillRow('filter-stream-group', 'filter-stream-pills', streamPills);
    fillRow('filter-semester-group', 'filter-semester-pills', semPills);

    // nothing to filter by at all: hide the whole bar
    bar.hidden = levelPills.length === 0 && streamPills.length === 0 && semPills.length === 0;
    updateSummary(levels, strs);
  }

  // phone toggle: "Civil Engineering · 1st Sem" + a count badge when something is selected
  function updateSummary(levels, strs) {
    const sum = $('filter-summary');
    const cnt = $('filter-count');
    if (!sum || !cnt) return;
    const parts = [];
    const lv = levels.find((l) => l.id === sel.level);
    const st = strs.find((s) => s.id === sel.stream);
    if (lv) parts.push(lv.name);
    if (st) parts.push(st.stream_name);
    if (sel.semester) parts.push(semesterLabel(sel.semester));
    sum.textContent = parts.length ? parts.join(' · ') : 'All resources';
    const n = parts.length;
    cnt.hidden = n === 0;
    cnt.textContent = String(n);
  }

  function apply() {
    renderBar();
    if (typeof window.applyCatalogFilters === 'function') window.applyCatalogFilters();
  }

  function pick(key, value) {
    sel[key] = value;
    if (key === 'level') { sel.stream = null; sel.semester = null; }
    if (key === 'stream') { sel.semester = null; }
    apply();
  }

  function hasActive() {
    return !!(sel.level || sel.stream || sel.semester);
  }

  function clearAll() {
    sel.level = null; sel.stream = null; sel.semester = null;
    apply();
  }

  /* ---------- public ---------- */
  async function initFilter() {
    await Promise.all([fetchStreams(), fetchLevels()]);
    renderBar();
  }

  function filterSubjects(subjects) {
    // auth.js hands in the full list every time it re-renders; if the data changed, rebuild the rows
    const sig = subjects.map((s) => s.id + ':' + (s.total_pages || 0) + ':' + (s.stream_id || '') + ':' + (s.semester || '')).join('|')
      + '#' + streams.length + '#' + levelRows.length;
    if (sig !== signature) {
      signature = sig;
      catalog = subjects;
      renderBar();
    }
    return subjects.filter((sub) => {
      const okLevel = !sel.level || sub.class_level === sel.level;
      const okStream = !sel.stream || sub.stream_id === sel.stream;
      const okSemester = !sel.semester || String(sub.semester) === sel.semester;
      return okLevel && okStream && okSemester;
    });
  }

  return { init: initFilter, refreshStreams: initFilter, filterSubjects, hasActive, clear: clearAll };
})();

// phone filter toggle (the rows are always visible on larger screens)
document.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('#filter-toggle');
  if (!t) return;
  const bar = document.getElementById('filter-bar');
  const open = bar.classList.toggle('is-open');
  t.setAttribute('aria-expanded', open ? 'true' : 'false');
});

// Mission section language switch (phones show one language at a time)
function switchMissionLang(lang) {
  const contentEn = document.getElementById('mission-content-en');
  const contentNe = document.getElementById('mission-content-ne');
  const btnEn = document.getElementById('tab-btn-en');
  const btnNe = document.getElementById('tab-btn-ne');

  if (lang === 'en') {
    contentEn?.classList.remove('hidden');
    contentNe?.classList.add('hidden');
    btnEn?.classList.add('active');
    btnNe?.classList.remove('active');
  } else {
    contentNe?.classList.remove('hidden');
    contentEn?.classList.add('hidden');
    btnNe?.classList.add('active');
    btnEn?.classList.remove('active');
  }
}

// Smooth scrolling utility
function scrollToSection(sectionId) {
  const el = document.getElementById(sectionId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// "Clear filters" buttons inside empty states (built by auth.js) call this
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-action="clear-filters"]');
  if (btn) CatalogFilter.clear();
});

// Listen for broadcast events across tabs to update filters live
window.addEventListener('storage', (e) => {
  if (e.key === 'catalog_updated') {
    CatalogFilter.refreshStreams();
  }
});

window.CatalogFilter = CatalogFilter;
window.switchMissionLang = switchMissionLang;
window.scrollToSection = scrollToSection;
