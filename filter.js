/* ==========================================
   DYNAMIC FILTER HIERARCHY MANAGER
   ========================================== */

const CatalogFilter = (() => {
  let selectedStream = null;
  let selectedSemester = null;

  let globalStreams = [];

  async function initFilter() {
    await fetchStreams();
    renderStreamPills();
    renderSemesterPills();
  }

  async function fetchStreams() {
    try {
      const { data, error } = await supabaseClient.from('streams').select('*');
      if (error) throw error;
      globalStreams = data || [];
    } catch (e) {
      console.error('Error loading streams for filter:', e);
    }
  }

  function renderStreamPills() {
    const streamGroup = document.getElementById('filter-stream-group');
    const container = document.getElementById('filter-stream-pills');
    if (!streamGroup || !container) return;

    container.innerHTML = '';
    streamGroup.classList.remove('hidden');

    // "All Streams" Pill
    const allPill = document.createElement('button');
    allPill.className = `pill-btn ${!selectedStream ? 'active' : ''}`;
    allPill.textContent = 'All Streams / Faculties';
    allPill.onclick = () => selectStream(null);
    container.appendChild(allPill);

    // Dynamically populated from database streams
    globalStreams.forEach(stream => {
      const pill = document.createElement('button');
      pill.className = `pill-btn ${selectedStream === stream.id ? 'active' : ''}`;
      pill.textContent = stream.stream_name;
      pill.onclick = () => selectStream(stream.id);
      container.appendChild(pill);
    });
  }

  function selectStream(streamId) {
    selectedStream = streamId;
    selectedSemester = null; // Reset semester filter on stream change

    renderStreamPills();
    renderSemesterPills();

    if (typeof window.applyCatalogFilters === 'function') {
      window.applyCatalogFilters();
    }
  }

  function renderSemesterPills() {
    const semGroup = document.getElementById('filter-semester-group');
    const container = document.getElementById('filter-semester-pills');
    if (!semGroup || !container) return;

    // Determine if selected stream belongs to Bachelor level
    const activeStreamObj = globalStreams.find(s => s.id === selectedStream);
    const isBachelor = activeStreamObj && activeStreamObj.class_level === 'bachelor';

    if (!selectedStream || !isBachelor) {
      semGroup.classList.add('hidden');
      return;
    }

    const semesters = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
    container.innerHTML = '';
    semGroup.classList.remove('hidden');

    const allPill = document.createElement('button');
    allPill.className = `pill-btn ${!selectedSemester ? 'active' : ''}`;
    allPill.textContent = 'All Semesters';
    allPill.onclick = () => selectSemester(null);
    container.appendChild(allPill);

    semesters.forEach(sem => {
      const pill = document.createElement('button');
      pill.className = `pill-btn ${selectedSemester === sem ? 'active' : ''}`;
      pill.textContent = `${sem} Sem`;
      pill.onclick = () => selectSemester(sem);
      container.appendChild(pill);
    });
  }

  function selectSemester(sem) {
    selectedSemester = sem;
    renderSemesterPills();

    if (typeof window.applyCatalogFilters === 'function') {
      window.applyCatalogFilters();
    }
  }

  function filterSubjects(subjects) {
    return subjects.filter(sub => {
      const matchStream = !selectedStream || sub.stream_id === selectedStream;
      const matchSem = selectedSemester ? sub.semester === selectedSemester : true;

      return matchStream && matchSem;
    });
  }

  return {
    init: initFilter,
    refreshStreams: initFilter,
    filterSubjects
  };
})();

// Listen for broadcast events across tabs to update filters live
window.addEventListener('storage', (e) => {
  if (e.key === 'catalog_updated') {
    CatalogFilter.refreshStreams();
  }
});

window.CatalogFilter = CatalogFilter;


