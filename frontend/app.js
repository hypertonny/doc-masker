/* ════════════════════════════════════════════════════════════
   DocMasker — Application Logic
   ════════════════════════════════════════════════════════════ */

const API = '';   // Same-origin: FastAPI serves frontend

// ── State ────────────────────────────────────────────────────
let state = {
  sessions: [],           // array of { sessionId, filename, entities, previews, pageCount, ocrUsed }
  activeSessionIndex: 0,
  currentPage: 0,
  activeFilter: 'ALL',
  scaleX: 1, scaleY: 1,
  drawMode: false,
  zoomLevel: 1.0,
};

function getActiveSession() {
  return state.sessions[state.activeSessionIndex];
}

// ── DOM refs ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const uploadZone    = $('upload-zone');
const fileInput     = $('file-input');
const browseBtn     = $('browse-btn');
const uploadFilename= $('upload-filename');
const analyzeBtn    = $('analyze-btn');
const prevPageBtn   = $('prev-page');
const nextPageBtn   = $('next-page');
const pageCounter   = $('page-counter');
const pdfCanvas     = $('pdf-canvas');
const highlightLayer= $('highlight-layer');
const entityList    = $('entity-list');
const filterPills   = $('filter-pills');
const selectAllBtn  = $('select-all-btn');
const deselectAllBtn= $('deselect-all-btn');
const redactBtn     = $('redact-btn');
const downloadBtn   = $('download-btn');
const startOverBtn  = $('start-over-btn');
const ocrBadge      = $('ocr-badge');
const toast         = $('toast');

// ── Toast ─────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  toastTimer = setTimeout(() => toast.className = 'toast hidden', 3500);
}

// ── Steps ─────────────────────────────────────────────────────
function setStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = $(`step-${i}`);
    el.className = 'step ' + (i < n ? 'done' : i === n ? 'active' : '');
  }
}

// ── Panel show ────────────────────────────────────────────────
function showPanel(id) {
  ['panel-upload','panel-processing','panel-review','panel-done'].forEach(pid => {
    $(pid).classList.toggle('hidden', pid !== id);
  });
}

// ── Upload Zone ───────────────────────────────────────────────
let selectedFiles = [];

browseBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
uploadZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

uploadZone.addEventListener('dragover', e => {
  e.preventDefault(); uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});

function handleFiles(files) {
  if (!files || files.length === 0) return;
  const pdfs = Array.from(files).filter(f => f.type === 'application/pdf');
  if (pdfs.length === 0) {
    showToast('Please upload PDF files.', 'error'); return;
  }
  selectedFiles = pdfs;
  if (pdfs.length === 1) {
    uploadFilename.textContent = `📄  ${pdfs[0].name}  (${formatBytes(pdfs[0].size)})`;
  } else {
    uploadFilename.textContent = `📄  ${pdfs.length} files selected`;
  }
  uploadFilename.classList.remove('hidden');
  analyzeBtn.disabled = false;
}

analyzeBtn.addEventListener('click', () => {
  if (selectedFiles.length === 0) return;
  uploadAndAnalyze(selectedFiles);
});

// ── Upload + Analyze ──────────────────────────────────────────
async function uploadAndAnalyze(files) {
  showPanel('panel-processing');
  setStep(2);
  state.sessions = [];
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    setProgress(10 + (i / files.length) * 80, `Uploading & Analyzing ${file.name} (${i+1}/${files.length})`, 'This might take a moment...', 'proc-upload', 'active');
    
    const form = new FormData();
    form.append('file', file);
    
    const modeEl = document.querySelector('input[name="redaction-mode"]:checked');
    const selectedMode = modeEl ? modeEl.value : 'COMBO';
    const aiInst = $('ai-instructions').value.trim();
    
    if (selectedMode === 'KEYWORDS_ONLY') {
      if (!aiInst) {
        showToast('Keywords Only mode requires at least one keyword below.', 'error');
        showPanel('panel-upload');
        setStep(1);
        return;
      }
      form.append('ai_instructions', aiInst);
      form.append('ai_only', 'true');   // skip Presidio entirely
      form.append('ai_eval', 'false');
    } else if (selectedMode === 'MODEL_ONLY') {
      form.append('ai_only', 'false');
      form.append('ai_eval', 'false');
    } else {
      // COMBO: model + keywords
      if (aiInst) form.append('ai_instructions', aiInst);
      form.append('ai_only', 'false');
      form.append('ai_eval', 'false');
    }
    
    try {
      const res = await fetch(`${API}/api/upload`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const checkedIds = new Set();
      data.entities.forEach(ent => {
        if (ent.type === 'AI_INSTRUCTION') checkedIds.add(ent.id);
      });
      
      state.sessions.push({
        sessionId: data.session_id,
        filename: data.filename,
        entities: data.entities,
        previews: data.previews,
        pageCount: data.page_count,
        ocrUsed: data.ocr_used,
        manualRegions: [],
        checkedEntityIds: checkedIds
      });
    } catch (e) {
      showToast(`Failed on ${file.name}: ${e.message}`, 'error');
    }
  }

  if (state.sessions.length === 0) {
    showPanel('panel-upload');
    setStep(1);
    return;
  }

  setProgress(100, 'Ready!', 'All documents processed.', '', '');
  await sleep(300);

  state.activeSessionIndex = 0;
  state.currentPage = 0;
  state.activeFilter = 'ALL';
  state.drawMode = false;

  buildReviewUI();
  showPanel('panel-review');
  setStep(3);
}

// ── Progress helpers ──────────────────────────────────────────
function setProgress(pct, title, sub, stepId, stepState) {
  $('progress-fill').style.width = pct + '%';
  $('processing-title').textContent = title;
  $('processing-sub').textContent = sub;
  if (stepId) {
    const el = $(stepId);
    el.classList.remove('active', 'done');
    if (stepState) el.classList.add(stepState);
  }
}
function markDone(id) {
  const el = $(id);
  el.classList.remove('active');
  el.classList.add('done');
}
function markSkipped(id) {
  const el = $(id);
  el.classList.remove('active');
  el.querySelector('.proc-dot').style.background = 'var(--text-dim)';
  el.querySelector('span').textContent += ' (skipped)';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Build Review UI ───────────────────────────────────────────
function buildReviewUI() {
  const sess = getActiveSession();

  // Document switcher setup
  const docSwitcherWrap = $('doc-switcher-wrap');
  const docSwitcher = $('doc-switcher');
  if (state.sessions.length > 1) {
    if (docSwitcherWrap) docSwitcherWrap.classList.remove('hidden');
    docSwitcher.innerHTML = state.sessions.map((s, i) => 
      `<option value="${i}">📄 ${s.filename}</option>`
    ).join('');
    docSwitcher.value = state.activeSessionIndex;
    
    // Ensure we only bind this once
    docSwitcher.onchange = (e) => {
      // Save current selections to session
      saveSelectionsToSession();
      state.activeSessionIndex = parseInt(e.target.value, 10);
      state.currentPage = 0;
      state.zoomLevel = 1.0;
      applyZoom();
      buildReviewUI();
    };
  } else {
    if (docSwitcherWrap) docSwitcherWrap.classList.add('hidden');
  }

  // OCR badge
  ocrBadge.classList.toggle('hidden', !sess.ocrUsed);

  // Filter pills
  const types = [...new Set(sess.entities.map(e => e.type))].sort();
  filterPills.innerHTML = `<button class="pill active" data-type="ALL">All</button>`;
  types.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'pill';
    btn.dataset.type = t;
    btn.textContent = t.replace(/_/g,' ');
    filterPills.appendChild(btn);
  });
  filterPills.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => applyFilter(p.dataset.type));
  });

  // Entity list
  renderEntityList();

  // Page nav
  pageCounter.textContent = `Page 1 / ${sess.pageCount}`;
  renderPage(0);
  updateStats();

  // Select/deselect all
  selectAllBtn.onclick = () => {
    visibleItems().forEach(cb => cb.checked = true);
    syncRedactBtn(); updateStats(); renderPage(state.currentPage);
  };
  deselectAllBtn.onclick = () => {
    document.querySelectorAll('.entity-checkbox').forEach(cb => cb.checked = false);
    syncRedactBtn(); updateStats(); renderPage(state.currentPage);
  };

  // Page nav buttons
  prevPageBtn.onclick = () => changePage(-1);
  nextPageBtn.onclick = () => changePage(1);

  // Zoom Controls
  const zoomInBtn    = $('zoom-in-btn');
  const zoomOutBtn   = $('zoom-out-btn');
  const zoomResetBtn = $('zoom-reset-btn');
  if (zoomInBtn) {
    zoomInBtn.onclick = () => {
      if (state.zoomLevel < 2.5) {
        state.zoomLevel += 0.15;
        applyZoom();
      }
    };
  }
  if (zoomOutBtn) {
    zoomOutBtn.onclick = () => {
      if (state.zoomLevel > 0.5) {
        state.zoomLevel -= 0.15;
        applyZoom();
      }
    };
  }
  if (zoomResetBtn) {
    zoomResetBtn.onclick = () => {
      state.zoomLevel = 1.0;
      applyZoom();
    };
  }

  // Draw mode toggle
  const drawModeBtn = $('draw-mode-btn');
  const canvasWrap  = $('pdf-canvas-wrap');
  drawModeBtn.onclick = () => {
    state.drawMode = !state.drawMode;
    drawModeBtn.classList.toggle('active', state.drawMode);
    canvasWrap.classList.toggle('draw-active', state.drawMode);
    if (state.drawMode) showToast('Draw mode ON — drag on the PDF to mark a region', '');
  };

  // Redact button
  redactBtn.onclick = doRedact;

  // Search & Redact bar
  const searchInput = $('search-input');
  const searchBtn   = $('search-btn');

  async function doSearch() {
    const query = searchInput.value.trim();
    if (!query) { showToast('Enter a search term.', 'error'); return; }
    searchBtn.disabled = true;
    searchBtn.textContent = '…';
    try {
      let totalOccurrences = 0;
      let docsFoundIn = 0;

      // Loop through all uploaded documents (Global Search)
      for (let sess of state.sessions) {
        const res = await fetch(`${API}/api/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sess.sessionId, query }),
        });
        
        if (!res.ok) {
          console.error(`Search failed for ${sess.filename}`);
          continue;
        }
        
        const data = await res.json();
        if (data.matches.length > 0) {
          docsFoundIn++;
          totalOccurrences += data.total;
          
          data.matches.forEach(match => {
            // Check if already manually added
            if (sess.entities.find(e => e.type === 'MANUAL_SEARCH' && e.text === match.text)) return;
            sess.entities.push(match);
            sess.checkedEntityIds.add(match.id);
          });
        }
      }

      if (totalOccurrences === 0) {
        showToast(`"${query}" not found in any document.`, '');
        return;
      }

      // Update UI for the currently active document
      if (!filterPills.querySelector('[data-type="MANUAL_SEARCH"]')) {
        const pill = document.createElement('button');
        pill.className = 'pill';
        pill.dataset.type = 'MANUAL_SEARCH';
        pill.textContent = 'Manual';
        pill.addEventListener('click', () => applyFilter('MANUAL_SEARCH'));
        filterPills.appendChild(pill);
      }
      
      renderEntityList();
      syncRedactBtn(); 
      updateStats(); 
      renderPage(state.currentPage);
      
      showToast(`Found ${totalOccurrences} occurrence${totalOccurrences === 1 ? '' : 's'} across ${docsFoundIn} document${docsFoundIn === 1 ? '' : 's'} — auto-selected.`, 'success');
      searchInput.value = '';
      entityList.scrollTop = entityList.scrollHeight;
    } catch (e) {
      showToast(`Search failed: ${e.message}`, 'error');
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Find';
    }
  }

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
}


function saveSelectionsToSession() {
  const sess = getActiveSession();
  sess.checkedEntityIds = new Set(
    [...document.querySelectorAll('.entity-checkbox:checked')].map(cb => cb.dataset.entityId)
  );
}

function renderEntityList() {
  const sess = getActiveSession();
  entityList.innerHTML = '';

  if (!sess.entities.length) {
    entityList.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-muted);font-size:0.88rem;">
      No PII entities detected in this document.
    </div>`;
    return;
  }

  sess.entities.forEach(ent => {
    const isChecked = sess.checkedEntityIds.has(ent.id) || ent.type === 'MANUAL_SEARCH' || ent.type === 'AI_INSTRUCTION';
    appendEntityItem(ent, isChecked);
  });
}

function appendEntityItem(ent, autoCheck = false) {
  // Remove the "no entities" placeholder if present
  const placeholder = entityList.querySelector('div[style]');
  if (placeholder) placeholder.remove();

  const item = document.createElement('div');
  item.className = 'entity-item';
  item.dataset.entityId = ent.id;
  item.dataset.type = ent.type;

  const pages = [...new Set(ent.spans.map(s => s.page + 1))].join(', ');
  const scoreLabel = ent.type === 'MANUAL_SEARCH' ? '🔍 manual' : `⬆ ${Math.round(ent.score * 100)}%`;

  item.innerHTML = `
    <input type="checkbox" class="entity-checkbox" id="cb-${ent.id}" data-entity-id="${ent.id}" ${autoCheck ? 'checked' : ''} />
    <div class="entity-color-dot" style="background:${ent.color}"></div>
    <div class="entity-body">
      <div class="entity-text" title="${escHtml(ent.text)}">${escHtml(ent.text)}</div>
      <div class="entity-meta">
        <span class="entity-type" style="background:${ent.color}22;color:${ent.color}">
          ${ent.type.replace(/_/g, ' ')}
        </span>
        <span class="entity-score">${scoreLabel}</span>
        <span class="entity-pages">p.${pages}</span>
      </div>
    </div>`;

  if (autoCheck) item.classList.add('selected');

  const cb = item.querySelector('.entity-checkbox');
  cb.addEventListener('change', () => {
    item.classList.toggle('selected', cb.checked);
    syncRedactBtn(); updateStats(); renderPage(state.currentPage);
  });
  item.addEventListener('click', e => {
    if (e.target === cb) return;
    cb.checked = !cb.checked;
    item.classList.toggle('selected', cb.checked);
    syncRedactBtn(); updateStats(); renderPage(state.currentPage);
    if (ent.spans.length) changePage(ent.spans[0].page - state.currentPage);
  });

  entityList.appendChild(item);
}

function applyFilter(type) {
  state.activeFilter = type;
  filterPills.querySelectorAll('.pill').forEach(p => {
    p.classList.toggle('active', p.dataset.type === type);
  });
  document.querySelectorAll('.entity-item').forEach(item => {
    item.classList.toggle('hidden-filter',
      type !== 'ALL' && item.dataset.type !== type);
  });
}

function visibleItems() {
  return [...document.querySelectorAll('.entity-item:not(.hidden-filter) .entity-checkbox')];
}
function syncRedactBtn() {
  saveSelectionsToSession();
  let any = false;
  state.sessions.forEach(sess => {
    if (sess.checkedEntityIds && sess.checkedEntityIds.size > 0) any = true;
  });
  redactBtn.disabled = !any;
}
function updateStats() {
  const sess = getActiveSession();
  const all = sess.entities.length;
  const sel = [...document.querySelectorAll('.entity-checkbox:checked')].length;
  const types = [...new Set(sess.entities.map(e => e.type))].length;
  $('stat-total').textContent    = all;
  $('stat-selected').textContent = sel;
  $('stat-types').textContent    = types;
}

function applyZoom() {
  const z = state.zoomLevel || 1.0;
  pdfCanvas.style.transform = `scale(${z})`;
  highlightLayer.style.transform = `scale(${z})`;
  pdfCanvas.style.transformOrigin = 'top center';
  highlightLayer.style.transformOrigin = 'top center';
  const zoomText = $('zoom-level-text');
  if (zoomText) zoomText.textContent = `${Math.round(z * 100)}%`;
}

// ── Page Rendering ────────────────────────────────────────────
function changePage(delta) {
  const sess = getActiveSession();
  const next = state.currentPage + delta;
  if (next < 0 || next >= sess.pageCount) return;
  state.currentPage = next;
  pageCounter.textContent = `Page ${next + 1} / ${sess.pageCount}`;
  renderPage(next);
}

function renderPage(pageNum) {
  const sess = getActiveSession();
  const preview = sess.previews[pageNum];
  if (!preview) return;

  const img = new Image();
  img.onload = () => {
    pdfCanvas.width  = img.naturalWidth;
    pdfCanvas.height = img.naturalHeight;
    const ctx = pdfCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // Apply active zoom level
    applyZoom();

    // Scale factors (PDF units → canvas pixels)
    state.scaleX = img.naturalWidth  / preview.width;
    state.scaleY = img.naturalHeight / preview.height;

    renderHighlights(pageNum);
  };
  img.src = `data:image/png;base64,${preview.image_b64}`;
}

function renderHighlights(pageNum) {
  highlightLayer.innerHTML = '';

  // ── FIX: use viewport-relative rects for precise alignment ──
  // The highlight layer covers the whole wrap (inset:0).
  // We need the canvas position relative to the layer origin.
  const layerRect  = highlightLayer.getBoundingClientRect();
  const canvasRect = pdfCanvas.getBoundingClientRect();
  const offX = canvasRect.left - layerRect.left;
  const offY = canvasRect.top  - layerRect.top;

  // Scale: displayed canvas CSS pixels ÷ native canvas pixels
  const dsx = canvasRect.width  / pdfCanvas.width;
  const dsy = canvasRect.height / pdfCanvas.height;

  // Get selected entity ids
  const selectedIds = new Set(
    [...document.querySelectorAll('.entity-checkbox:checked')].map(c => c.dataset.entityId)
  );

  const sess = getActiveSession();
  sess.entities.forEach(ent => {
    ent.spans.filter(s => s.page === pageNum).forEach(sp => {
      const [x0, y0, x1, y1] = sp.bbox;
      const px = x0 * state.scaleX * dsx + offX;
      const py = y0 * state.scaleY * dsy + offY;
      const pw = (x1 - x0) * state.scaleX * dsx;
      const ph = (y1 - y0) * state.scaleY * dsy;

      const rect = document.createElement('div');
      rect.className = 'hl-rect';
      rect.style.cssText = `
        left: ${px}px; top: ${py}px;
        width: ${pw}px; height: ${ph}px;
        background: ${ent.color};
        opacity: ${selectedIds.has(ent.id) ? 0.55 : 0.25};
        border: 2px solid ${ent.color};
      `;
      rect.title = `${ent.type}: ${ent.text}`;
      rect.addEventListener('click', () => {
        if (state.drawMode) return; // ignore in draw mode
        const cb = $(`cb-${ent.id}`);
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
      });
      highlightLayer.appendChild(rect);
    });
  });
}

// Re-render highlights on canvas resize
window.addEventListener('resize', () => {
  if (!$('panel-review').classList.contains('hidden')) {
    renderPage(state.currentPage);
  }
});

// ── Redact ────────────────────────────────────────────────────
let rdoneCurrentPage = 0;

async function doRedact() {
  saveSelectionsToSession(); // ensure current view's selections are saved to state

  // Check if anything is selected across any session
  let anySelected = false;
  state.sessions.forEach(sess => {
    if (sess.checkedEntityIds && sess.checkedEntityIds.size > 0) anySelected = true;
  });

  if (!anySelected) {
    showToast('Select at least one entity or draw a region to redact.', 'error'); return;
  }

  redactBtn.disabled = true;
  redactBtn.innerHTML = '⏳ Redacting…';

  try {
    state.redactedPreviews = [];
    rdoneCurrentPage = 0;
    
    let totalRedacted = 0;
    let totalPages = 0;
    let allTypes = new Set();
    
    // Create ZIP for multiple, but we just use individual downloads for now
    // Ideally we'd pack them or just provide multiple buttons. For simplicity, we'll just download the first or build a UI.
    const downloadLinks = [];

    for (let sess of state.sessions) {
      if (!sess.checkedEntityIds || sess.checkedEntityIds.size === 0) continue;
      
      const allCheckedIds = Array.from(sess.checkedEntityIds);
      const backendIds    = allCheckedIds.filter(id => !id.startsWith('draw-'));
      const manualRegions = [];
      
      sess.entities.forEach(ent => {
        if (allCheckedIds.includes(ent.id) && (ent.manual || ent.type === 'MANUAL_DRAW' || ent.type === 'MANUAL_SEARCH' || ent.type === 'AI_INSTRUCTION')) {
          ent.spans.forEach(sp => manualRegions.push({ page: sp.page, bbox: sp.bbox }));
        }
      });

      const res = await fetch(`${API}/api/redact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sess.sessionId,
          selected_entity_ids: backendIds,
          manual_regions: manualRegions,
        }),
      });
      if (!res.ok) throw new Error(`Failed to redact ${sess.filename}`);
      const data = await res.json();
      
      // We will just accumulate the first document's previews for the 'done' screen to keep UI simple
      if (state.redactedPreviews.length === 0) {
        state.redactedPreviews = data.redacted_previews || [];
      }
      
      totalRedacted += data.redacted_count;
      totalPages += sess.pageCount;
      sess.entities.filter(e => allCheckedIds.includes(e.id)).forEach(e => allTypes.add(e.type));
      
      downloadLinks.push({ url: data.download_url, name: `redacted_${sess.filename}` });
    }

    $('done-sub').textContent = `${totalRedacted} PII entr${totalRedacted === 1 ? 'y' : 'ies'} permanently removed across ${totalPages} page${totalPages > 1 ? 's' : ''}.`;
    $('done-stats').innerHTML = `
      <div class="done-stat"><span class="done-stat-val">${totalRedacted}</span><span class="done-stat-lbl">Entities Removed</span></div>
      <div class="done-stat"><span class="done-stat-val">${allTypes.size}</span><span class="done-stat-lbl">Types Redacted</span></div>
      <div class="done-stat"><span class="done-stat-val">${totalPages}</span><span class="done-stat-lbl">Pages</span></div>
    `;

    // If multiple links, replace downloadBtn with multiple buttons
    const doneCard = document.querySelector('.done-card');
    // Remove old multi-downloads if exist
    doneCard.querySelectorAll('.multi-dl').forEach(el => el.remove());
    
    if (downloadLinks.length === 1) {
      downloadBtn.href = `${API}${downloadLinks[0].url}`;
      downloadBtn.download = downloadLinks[0].name;
      downloadBtn.style.display = 'inline-flex';
    } else {
      downloadBtn.style.display = 'none';
      downloadLinks.forEach(dl => {
        const a = document.createElement('a');
        a.className = 'btn btn-primary btn-lg multi-dl';
        a.style.marginTop = '10px';
        a.href = `${API}${dl.url}`;
        a.download = dl.name;
        a.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="20" height="20"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Download ${dl.name}`;
        doneCard.insertBefore(a, startOverBtn);
      });
    }

    renderRdonePage(0);
    showPanel('panel-done');
    setStep(4);

  } catch (e) {
    showToast(`Redaction failed: ${e.message}`, 'error');
    redactBtn.disabled = false;
    redactBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" opacity="0.2"/><path d="M7 7L17 17M17 7L7 17" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg> Redact Selected`;
  }
}

function renderRdonePage(pageNum) {
  const previews = state.redactedPreviews || [];
  if (!previews.length) return;

  const p = previews[pageNum];
  const canvas = $('rdone-canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
  };
  img.src = `data:image/png;base64,${p.image_b64}`;

  $('rdone-page-counter').textContent = `Page ${pageNum + 1} / ${previews.length}`;
  $('rdone-prev').disabled = pageNum === 0;
  $('rdone-next').disabled = pageNum === previews.length - 1;
}

// Done panel page nav
$('rdone-prev').addEventListener('click', () => {
  if (rdoneCurrentPage > 0) renderRdonePage(--rdoneCurrentPage);
});
$('rdone-next').addEventListener('click', () => {
  const previews = state.redactedPreviews || [];
  if (rdoneCurrentPage < previews.length - 1) renderRdonePage(++rdoneCurrentPage);
});


// ── Start Over ────────────────────────────────────────────────
startOverBtn.addEventListener('click', () => {
  selectedFiles = [];
  state = { sessions:[], activeSessionIndex:0, currentPage:0, activeFilter:'ALL', scaleX:1, scaleY:1, drawMode: false };
  fileInput.value = '';
  uploadFilename.classList.add('hidden');
  analyzeBtn.disabled = true;

  // Reset draw mode UI
  const dmBtn = $('draw-mode-btn');
  if (dmBtn) dmBtn.classList.remove('active');
  $('pdf-canvas-wrap').classList.remove('draw-active');
  _drawStart = null;
  if (_drawOverlay) { _drawOverlay.remove(); _drawOverlay = null; }


  // Reset processing steps
  ['proc-upload','proc-ocr','proc-pii','proc-preview'].forEach(id => {
    $(id).className = 'proc-step';
    const dot = $(id).querySelector('.proc-dot');
    dot.style.background = '';
    dot.style.animation  = '';
  });

  showPanel('panel-upload');
  setStep(1);
});

// ── Utilities ─────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(1)} MB`;
}
function uuid4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

// ── Draw Mode (module-level — wired once for the page lifetime) ────────────
// Uses pdfCanvas for mousedown (always receives events).
// Overlay rect is fixed-positioned on document.body (immune to scroll/layout).
let _drawStart  = null;   // { screenX, screenY }
let _drawOverlay = null;  // the fixed rect shown while dragging

pdfCanvas.addEventListener('mousedown', e => {
  if (!state.drawMode) return;
  e.preventDefault();
  _drawStart = { x: e.clientX, y: e.clientY };

  _drawOverlay = document.createElement('div');
  _drawOverlay.className = 'draw-select-rect';
  _drawOverlay.style.cssText = `
    position: fixed;
    left: ${e.clientX}px; top: ${e.clientY}px;
    width: 0; height: 0;
    pointer-events: none; z-index: 9999;
  `;
  document.body.appendChild(_drawOverlay);
});

window.addEventListener('mousemove', e => {
  if (!state.drawMode || !_drawStart || !_drawOverlay) return;
  const x = Math.min(e.clientX, _drawStart.x);
  const y = Math.min(e.clientY, _drawStart.y);
  const w = Math.abs(e.clientX - _drawStart.x);
  const h = Math.abs(e.clientY - _drawStart.y);
  _drawOverlay.style.left   = x + 'px';
  _drawOverlay.style.top    = y + 'px';
  _drawOverlay.style.width  = w + 'px';
  _drawOverlay.style.height = h + 'px';
});

window.addEventListener('mouseup', e => {
  if (!state.drawMode || !_drawStart) return;

  // Clean up overlay
  if (_drawOverlay) { _drawOverlay.remove(); _drawOverlay = null; }

  // ── Convert screen coordinates → PDF units ─────────────────────────────
  const cr  = pdfCanvas.getBoundingClientRect();          // canvas in viewport
  const dsx = cr.width  / pdfCanvas.width;                // display scale X
  const dsy = cr.height / pdfCanvas.height;               // display scale Y

  // Screen rect corners (normalised)
  const sx0 = Math.min(_drawStart.x, e.clientX);
  const sy0 = Math.min(_drawStart.y, e.clientY);
  const sx1 = Math.max(_drawStart.x, e.clientX);
  const sy1 = Math.max(_drawStart.y, e.clientY);

  _drawStart = null;

  // canvas-display pixels → canvas-native pixels → PDF units
  const bx0 = (sx0 - cr.left) / dsx / state.scaleX;
  const by0 = (sy0 - cr.top)  / dsy / state.scaleY;
  const bx1 = (sx1 - cr.left) / dsx / state.scaleX;
  const by1 = (sy1 - cr.top)  / dsy / state.scaleY;

  if ((bx1 - bx0) < 3 || (by1 - by0) < 3) return;  // too small — ignore

  const preview = state.previews[state.currentPage];
  if (!preview) return;

  const manualEnt = {
    id:    'draw-' + uuid4(),
    type:  'MANUAL_DRAW',
    text:  `Region p.${state.currentPage + 1}`,
    score: 1.0,
    spans: [{
      bbox: [bx0, by0, bx1, by1],
      page: state.currentPage,
      page_width:  preview.width,
      page_height: preview.height,
    }],
    color: '#F59E0B',
    manual: true,
  };
  state.entities.push(manualEnt);
  appendEntityItem(manualEnt, true);
  syncRedactBtn();
  updateStats();
  renderHighlights(state.currentPage);
  showToast(`✓ Region marked on page ${state.currentPage + 1} — it will be redacted.`, 'success');
});

// ── Audit Log ─────────────────────────────────────────────────────────────────
async function openAuditLog() {
  document.getElementById('audit-modal').style.display = 'block';
  document.getElementById('audit-log-body').innerHTML = '<p style="color:#64748b;text-align:center;padding:40px;">Loading…</p>';
  try {
    const res = await fetch(`${API}/api/audit-log`);
    const entries = await res.json();
    renderAuditLog(entries);
  } catch (e) {
    document.getElementById('audit-log-body').innerHTML = `<p style="color:#f87171;text-align:center;padding:40px;">Failed to load audit log: ${e.message}</p>`;
  }
}

function closeAuditLog() {
  document.getElementById('audit-modal').style.display = 'none';
}

async function clearAuditLog() {
  if (!confirm('Clear all audit log entries? This cannot be undone.')) return;
  await fetch(`${API}/api/audit-log`, { method: 'DELETE' });
  document.getElementById('audit-log-body').innerHTML = '<p style="color:#64748b;text-align:center;padding:40px;">Audit log cleared.</p>';
}

function renderAuditLog(entries) {
  const body = document.getElementById('audit-log-body');
  if (!entries || entries.length === 0) {
    body.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px;">No sessions recorded yet.</p>';
    return;
  }

  const modeBadge = (m) => {
    const colors = {
      'Keywords Only':  ['#818cf8','rgba(99,102,241,0.15)'],
      'Model + Keywords': ['#34d399','rgba(52,211,153,0.12)'],
      'Model Only':     ['#94a3b8','rgba(148,163,184,0.1)'],
    };
    const [fg, bg] = colors[m] || ['#94a3b8','rgba(255,255,255,0.05)'];
    return `<span style="font-size:0.72rem;font-weight:600;padding:2px 9px;border-radius:20px;background:${bg};color:${fg};white-space:nowrap;">${m}</span>`;
  };

  const statusBadge = (s) => {
    const ok = s === 'redacted';
    return `<span style="font-size:0.72rem;font-weight:600;padding:2px 9px;border-radius:20px;background:${ok?'rgba(34,197,94,0.12)':'rgba(250,204,21,0.1)'};color:${ok?'#4ade80':'#fbbf24'};">${s}</span>`;
  };

  const pill = (txt, color) =>
    `<span style="display:inline-block;margin:2px 3px 2px 0;padding:1px 8px;border-radius:12px;font-size:0.71rem;background:rgba(255,255,255,0.05);color:${color||'#94a3b8'};border:1px solid rgba(255,255,255,0.08);">${txt}</span>`;

  const rows = entries.map(e => {
    const ts = new Date(e.timestamp).toLocaleString('en-GB', {
      day:'2-digit', month:'short', year:'numeric',
      hour:'2-digit', minute:'2-digit',
    });
    const shortId = e.session_id.split('-')[0].toUpperCase();
    const kwHtml  = e.keywords_given?.length
      ? e.keywords_given.map(k => pill(k, '#a5b4fc')).join('')
      : '<span style="color:#475569;font-size:0.75rem;">—</span>';
    const redHtml = e.redacted_items?.length
      ? e.redacted_items.map(r => pill(r.text, '#4ade80')).join('')
      : '<span style="color:#475569;font-size:0.75rem;">Not yet redacted</span>';

    return `
      <div style="padding:18px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:#6366f1;font-weight:600;">#${shortId}</span>
              ${modeBadge(e.mode)}
              ${statusBadge(e.status)}
              ${e.ocr_used ? '<span style="font-size:0.7rem;color:#f59e0b;background:rgba(245,158,11,0.1);padding:1px 7px;border-radius:10px;">OCR</span>' : ''}
            </div>
            <div style="font-size:0.85rem;font-weight:600;color:#e2e8f0;margin-bottom:2px;">📄 ${e.filename}</div>
            <div style="font-size:0.72rem;color:#475569;">${ts} · ${e.page_count} page${e.page_count !== 1 ? 's' : ''}</div>
          </div>
          <div style="font-size:0.72rem;color:#475569;text-align:right;white-space:nowrap;">
            <div style="color:#64748b;">${e.entities_detected?.length || 0} detected</div>
            <div style="color:#4ade80;">${e.redacted_items?.length || 0} redacted</div>
          </div>
        </div>
        <div style="margin-top:10px;">
          <div style="font-size:0.73rem;color:#475569;font-weight:600;letter-spacing:0.05em;margin-bottom:4px;">KEYWORDS GIVEN</div>
          <div>${kwHtml}</div>
        </div>
        <div style="margin-top:8px;">
          <div style="font-size:0.73rem;color:#475569;font-weight:600;letter-spacing:0.05em;margin-bottom:4px;">ACTUALLY MASKED</div>
          <div>${redHtml}</div>
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `<div style="font-size:0.8rem;color:#475569;margin-bottom:16px;">${entries.length} session${entries.length!==1?'s':''} recorded</div>${rows}`;
}

// Close modal on backdrop click
document.getElementById('audit-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('audit-modal')) closeAuditLog();
});

