/* ════════════════════════════════════════════════════════════
   DocMasker — Application Logic
   ════════════════════════════════════════════════════════════ */

const API = '';   // Same-origin: FastAPI serves frontend

// ── State ────────────────────────────────────────────────────
let state = {
  sessionId: null,
  filename: null,
  entities: [],           // all entities from backend
  previews: [],           // [{page, width, height, image_b64}]
  pageCount: 0,
  currentPage: 0,
  ocrUsed: false,
  activeFilter: 'ALL',
  scaleX: 1, scaleY: 1,  // pdf-units → canvas-pixel scale
  drawMode: false,        // draw-to-redact mode
};

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
let selectedFile = null;

browseBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
uploadZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

uploadZone.addEventListener('dragover', e => {
  e.preventDefault(); uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf') {
    showToast('Please upload a PDF file.', 'error'); return;
  }
  selectedFile = file;
  uploadFilename.textContent = `📄  ${file.name}  (${formatBytes(file.size)})`;
  uploadFilename.classList.remove('hidden');
  analyzeBtn.disabled = false;
}

analyzeBtn.addEventListener('click', () => {
  if (!selectedFile) return;
  uploadAndAnalyze(selectedFile);
});

// ── Upload + Analyze ──────────────────────────────────────────
async function uploadAndAnalyze(file) {
  showPanel('panel-processing');
  setStep(2);

  setProgress(10, 'Uploading PDF…', 'Sending your document to the server', 'proc-upload', 'active');

  const form = new FormData();
  form.append('file', file);

  let data;
  try {
    const res = await fetch(`${API}/api/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    data = await res.json();
  } catch (e) {
    showPanel('panel-upload');
    setStep(1);
    showToast(`Upload failed: ${e.message}`, 'error');
    return;
  }

  markDone('proc-upload');
  setProgress(55, 'Analyzing PII…', 'Presidio is scanning for sensitive entities', 'proc-pii', 'active');
  if (data.ocr_used) markDone('proc-ocr');
  else markSkipped('proc-ocr');

  // Small UI delay so user sees transitions
  await sleep(600);

  markDone('proc-pii');
  setProgress(85, 'Building Preview…', 'Rendering annotated page images', 'proc-preview', 'active');
  await sleep(400);
  markDone('proc-preview');
  setProgress(100, 'Ready!', '', '', '');

  await sleep(300);

  // Populate state
  state.sessionId = data.session_id;
  state.filename   = data.filename;
  state.entities   = data.entities;
  state.previews   = data.previews;
  state.pageCount  = data.page_count;
  state.ocrUsed    = data.ocr_used;
  state.currentPage= 0;
  state.activeFilter = 'ALL';

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
  // OCR badge
  ocrBadge.classList.toggle('hidden', !state.ocrUsed);

  // Filter pills
  const types = [...new Set(state.entities.map(e => e.type))].sort();
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
  pageCounter.textContent = `Page 1 / ${state.pageCount}`;
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
      const res = await fetch(`${API}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: state.sessionId, query }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(err.detail);
      }
      const data = await res.json();
      if (!data.matches.length) {
        showToast(`"${query}" not found in document.`, '');
        return;
      }
      data.matches.forEach(match => {
        if (state.entities.find(e => e.type === 'MANUAL_SEARCH' && e.text === match.text)) return;
        state.entities.push(match);
        appendEntityItem(match, true);
      });
      if (!filterPills.querySelector('[data-type="MANUAL_SEARCH"]')) {
        const pill = document.createElement('button');
        pill.className = 'pill';
        pill.dataset.type = 'MANUAL_SEARCH';
        pill.textContent = 'Manual';
        pill.addEventListener('click', () => applyFilter('MANUAL_SEARCH'));
        filterPills.appendChild(pill);
      }
      syncRedactBtn(); updateStats(); renderPage(state.currentPage);
      showToast(`Found ${data.total} occurrence${data.total === 1 ? '' : 's'} of "${query}" — auto-selected.`, 'success');
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


function renderEntityList() {
  entityList.innerHTML = '';

  if (!state.entities.length) {
    entityList.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-muted);font-size:0.88rem;">
      No PII entities detected in this document.
    </div>`;
    return;
  }

  state.entities.forEach(ent => appendEntityItem(ent, false));
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
  const any = [...document.querySelectorAll('.entity-checkbox')].some(c => c.checked);
  redactBtn.disabled = !any;
}
function updateStats() {
  const all = state.entities.length;
  const sel = [...document.querySelectorAll('.entity-checkbox:checked')].length;
  const types = [...new Set(state.entities.map(e => e.type))].length;
  $('stat-total').textContent    = all;
  $('stat-selected').textContent = sel;
  $('stat-types').textContent    = types;
}

// ── Page Rendering ────────────────────────────────────────────
function changePage(delta) {
  const next = state.currentPage + delta;
  if (next < 0 || next >= state.pageCount) return;
  state.currentPage = next;
  pageCounter.textContent = `Page ${next + 1} / ${state.pageCount}`;
  renderPage(next);
}

function renderPage(pageNum) {
  const preview = state.previews[pageNum];
  if (!preview) return;

  const img = new Image();
  img.onload = () => {
    pdfCanvas.width  = img.naturalWidth;
    pdfCanvas.height = img.naturalHeight;
    const ctx = pdfCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

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

  state.entities.forEach(ent => {
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
  const checkedBoxes = [...document.querySelectorAll('.entity-checkbox:checked')];
  const allCheckedIds = checkedBoxes.map(c => c.dataset.entityId);

  // Split: backend entities (in session) vs client-only manual entities
  const backendIds    = allCheckedIds.filter(id => !id.startsWith('draw-'));
  const manualEntIds  = new Set(allCheckedIds.filter(id => id.startsWith('draw-')));

  // Collect spans from all checked manual/search entities as flat {page, bbox} list
  const manualRegions = [];
  state.entities.forEach(ent => {
    if (allCheckedIds.includes(ent.id) && (ent.manual || ent.type === 'MANUAL_DRAW' || ent.type === 'MANUAL_SEARCH')) {
      ent.spans.forEach(sp => manualRegions.push({ page: sp.page, bbox: sp.bbox }));
    }
  });

  if (!backendIds.length && !manualRegions.length) {
    showToast('Select at least one entity or draw a region to redact.', 'error'); return;
  }

  redactBtn.disabled = true;
  redactBtn.innerHTML = '⏳ Redacting…';

  try {
    const res = await fetch(`${API}/api/redact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: state.sessionId,
        selected_entity_ids: backendIds,
        manual_regions: manualRegions,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    const data = await res.json();

    // Store redacted previews in state
    state.redactedPreviews = data.redacted_previews || [];
    rdoneCurrentPage = 0;

    // Build done screen stats
    const types = [...new Set(
      state.entities.filter(e => allCheckedIds.includes(e.id)).map(e => e.type)
    )];
    $('done-sub').textContent = `${data.redacted_count} PII entr${data.redacted_count === 1 ? 'y' : 'ies'} permanently removed across ${state.pageCount} page${state.pageCount > 1 ? 's' : ''}.`;
    $('done-stats').innerHTML = `
      <div class="done-stat"><span class="done-stat-val">${data.redacted_count}</span><span class="done-stat-lbl">Entities Removed</span></div>
      <div class="done-stat"><span class="done-stat-val">${types.length}</span><span class="done-stat-lbl">Types Redacted</span></div>
      <div class="done-stat"><span class="done-stat-val">${state.pageCount}</span><span class="done-stat-lbl">Pages</span></div>
    `;

    downloadBtn.href = `${API}${data.download_url}`;
    downloadBtn.download = `redacted_${state.filename || 'document.pdf'}`;

    // Render first page of redacted preview
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
  selectedFile = null;
  state = { sessionId:null, filename:null, entities:[], previews:[], pageCount:0,
            currentPage:0, ocrUsed:false, activeFilter:'ALL', scaleX:1, scaleY:1,
            drawMode: false };
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
