/**
 * Control renderer. The dashboard for defining "shareable screens" (sources):
 * name, hotkey, capture target (window or display), and an optional region.
 * Changes auto-save to disk via the main process, which also (re)registers the
 * global hotkeys.
 */

const api = window.screendeck;

// --- State -----------------------------------------------------------------
let config = { sources: [], output: {}, activeSourceId: null };
let targets = [];            // live capturable screens/windows (last refresh)
let selectedId = null;       // source being edited
let activeId = null;         // source currently shown in Output
let previewStream = null;    // crop-preview MediaStream (stop on teardown)
let showAllTargets = false;  // override the focused/same-app rebind filter
let dragId = null;           // id of the source list item being dragged

// --- Element refs ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const sourceList = $('source-list');
const emptyHint = $('empty-hint');
const editor = $('editor');
const editorEmpty = $('editor-empty');
const fName = $('f-name');
const fHotkey = $('f-hotkey');
const targetGrid = $('target-grid');
const cropEmpty = $('crop-empty');
const cropWrap = $('crop-wrap');
const cropVideo = $('crop-video');
const cropOverlay = $('crop-overlay');
const cropLabel = $('crop-label');
const hotkeyWarning = $('hotkey-warning');
const tType = $('t-type');
const tDuration = $('t-duration');
const tDurationVal = $('t-duration-val');
const tEasing = $('t-easing');

// --- Helpers ---------------------------------------------------------------
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.round(Math.random() * 1e6));
const getSource = (id) => config.sources.find((s) => s.id === id);

function targetSummary(s) {
  const where = s.capture === 'screen' ? 'Display' : (s.match?.windowTitle || 'Window');
  const region = s.crop ? ' · region' : '';
  return where + region;
}

async function persist() {
  await api.saveConfig({
    sources: config.sources,
    output: config.output,
    transition: config.transition,
    activeSourceId: config.activeSourceId,
  });
}

// --- Source list -----------------------------------------------------------
function renderList() {
  sourceList.innerHTML = '';
  emptyHint.classList.toggle('hidden', config.sources.length > 0);

  for (const s of config.sources) {
    const li = document.createElement('li');
    li.className = 'source-item';
    li.draggable = true;
    li.dataset.id = s.id;
    if (s.id === selectedId) li.classList.add('selected');
    if (s.id === activeId) li.classList.add('active');

    const main = document.createElement('div');
    main.className = 'si-main';
    const bound = isBound(s);
    main.innerHTML =
      `<div class="si-name">${escapeHtml(s.name || 'Untitled')}</div>` +
      `<div class="si-target">${escapeHtml(targetSummary(s))}` +
      (bound ? '' : ' · <span class="si-unbound">needs rebinding</span>') +
      `</div>`;

    li.appendChild(main);
    if (s.hotkey) {
      const hk = document.createElement('span');
      hk.className = 'si-hotkey';
      hk.textContent = prettyHotkey(s.hotkey);
      li.appendChild(hk);
    }

    const del = document.createElement('button');
    del.className = 'si-del';
    del.title = 'Delete this shareable screen';
    del.textContent = '✕';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteSource(s.id); });
    li.appendChild(del);

    li.addEventListener('click', () => selectSource(s.id));
    wireDrag(li);
    sourceList.appendChild(li);
  }
}

// --- Drag-to-reorder the source list --------------------------------------
function wireDrag(li) {
  li.addEventListener('dragstart', (e) => {
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  li.addEventListener('dragend', () => {
    dragId = null;
    sourceList.querySelectorAll('.source-item').forEach((n) =>
      n.classList.remove('dragging', 'drop-target'));
  });
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (li.dataset.id !== dragId) li.classList.add('drop-target');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    li.classList.remove('drop-target');
    reorderSources(dragId, li.dataset.id);
  });
}

async function reorderSources(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const arr = config.sources;
  const from = arr.findIndex((s) => s.id === fromId);
  const to = arr.findIndex((s) => s.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  await persist();
  renderList();
}

/** A source is "bound" if its remembered target appears in the live list. */
function isBound(s) {
  if (!targets.length) return true; // unknown yet — don't alarm before first refresh
  if (s.capture === 'screen') {
    return targets.some((t) => t.type === 'screen' && String(t.displayId) === String(s.match?.displayId));
  }
  const needle = (s.match?.windowTitle || '').toLowerCase();
  if (!needle) return false;
  return targets.some((t) => t.type === 'window' &&
    ((t.name || '').toLowerCase().includes(needle) || needle.includes((t.name || '').toLowerCase())));
}

// --- Editing ---------------------------------------------------------------
function selectSource(id) {
  selectedId = id;
  showAllTargets = false; // start each source in its focused view
  teardownPreview();
  const s = getSource(id);
  editor.classList.remove('hidden');
  editorEmpty.classList.add('hidden');
  fName.value = s.name || '';
  fHotkey.value = s.hotkey ? prettyHotkey(s.hotkey) : '';
  fHotkey.dataset.accelerator = s.hotkey || '';
  renderTargetGrid();
  renderCrop(s);
  renderList();
}

/** Platform-sensible default hotkey candidates, in priority order. macOS
 *  reserves ⌘ and the F-keys heavily, so use Control+Option+<digit> there. */
function defaultHotkeyCandidates() {
  if (api.platform === 'darwin') {
    return Array.from({ length: 10 }, (_, i) => `Control+Alt+${(i + 1) % 10}`);
  }
  return Array.from({ length: 12 }, (_, i) => `CommandOrControl+F${i + 1}`);
}

function addSource() {
  // Suggest the next free default hotkey for this platform.
  const used = new Set(config.sources.map((s) => s.hotkey));
  const hotkey = defaultHotkeyCandidates().find((c) => !used.has(c)) || '';
  const s = {
    id: uuid(),
    name: 'New screen',
    hotkey,
    capture: 'window',
    match: {},
    lastSourceId: null,
    crop: null,
  };
  config.sources.push(s);
  persist();
  selectSource(s.id);
}

async function deleteSource(id) {
  const targetId = id || selectedId;
  if (!targetId) return;
  config.sources = config.sources.filter((s) => s.id !== targetId);
  if (activeId === targetId) activeId = null;
  // Only collapse the editor if the source being edited is the one removed.
  if (selectedId === targetId) {
    selectedId = null;
    teardownPreview();
    editor.classList.add('hidden');
    editorEmpty.classList.remove('hidden');
  }
  await persist();
  renderList();
}

// --- Target grid -----------------------------------------------------------
async function refreshTargets() {
  targets = await api.listSources();
  // Backfill processName for window sources created before app-aware re-binding
  // existed, so the focused rebind view can work for them once seen bound.
  let changed = false;
  for (const s of config.sources) {
    if (s.capture !== 'window' || s.match?.processName) continue;
    const needle = (s.match?.windowTitle || '').toLowerCase();
    if (!needle) continue;
    const hit = targets.find((t) => t.type === 'window' && t.processName &&
      ((t.name || '').toLowerCase().includes(needle) || needle.includes((t.name || '').toLowerCase())));
    if (hit) { s.match.processName = hit.processName; changed = true; }
  }
  if (changed) await persist();
  renderTargetGrid();
  renderList(); // bound/unbound badges may change
}

function renderTargetGrid() {
  targetGrid.innerHTML = '';
  const s = getSource(selectedId);
  if (!s) return;

  const addHeader = (label, count) => {
    const h = document.createElement('div');
    h.className = 'target-group';
    h.textContent = `${label} (${count})`;
    targetGrid.appendChild(h);
  };
  const addTile = (t) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    if (isSelectedTarget(s, t)) tile.classList.add('selected');
    const subtitle = t.type === 'window' && t.processName ? t.processName : t.type;
    tile.innerHTML =
      `<img alt="" src="${t.thumbnailDataURL || ''}" />` +
      `<div class="cap"><div class="nm">${escapeHtml(t.name)}</div>` +
      `<div class="ty">${escapeHtml(subtitle)}</div></div>`;
    tile.addEventListener('click', () => chooseTarget(t));
    targetGrid.appendChild(tile);
  };

  const screens = targets.filter((t) => t.type === 'screen');
  let windows = targets.filter((t) => t.type === 'window');

  // Rebind assist: when a window source can't re-bind to its remembered target,
  // narrow the window list to other windows of the same app so the user can
  // re-pick one — unless they've asked to see everything.
  const procName = (s.capture === 'window' && s.match?.processName) || '';
  const rebinding = !!procName && !isBound(s) && !showAllTargets;
  if (rebinding) {
    const pn = procName.toLowerCase();
    windows = windows.filter((w) => (w.processName || '').toLowerCase() === pn);
    addRebindBanner(procName, windows.length);
  }

  if (screens.length) { addHeader('Displays', screens.length); screens.forEach(addTile); }
  if (windows.length) {
    addHeader(rebinding ? `${procName} windows` : 'Windows', windows.length);
    windows.forEach(addTile);
  } else if (rebinding) {
    const none = document.createElement('div');
    none.className = 'target-empty';
    none.textContent = `No ${procName} windows open right now. Open one and click Refresh, or show all windows.`;
    targetGrid.appendChild(none);
  }
}

/** Banner shown above the grid while re-binding a window to its app's windows. */
function addRebindBanner(procName, count) {
  const banner = document.createElement('div');
  banner.className = 'rebind-banner';
  const text = document.createElement('span');
  text.innerHTML = `Re-bind to a <strong>${escapeHtml(procName)}</strong> window — your region is kept.`;
  const toggle = document.createElement('button');
  toggle.className = 'ghost tiny';
  toggle.textContent = 'Show all windows';
  toggle.addEventListener('click', () => { showAllTargets = true; renderTargetGrid(); });
  banner.appendChild(text);
  banner.appendChild(toggle);
  targetGrid.appendChild(banner);
}

function isSelectedTarget(s, t) {
  if (s.capture !== t.type) return false;
  if (t.type === 'screen') return String(t.displayId) === String(s.match?.displayId);
  return s.lastSourceId === t.id ||
    (s.match?.windowTitle && s.match.windowTitle === t.name);
}

async function chooseTarget(t) {
  const s = getSource(selectedId);
  // Re-binding to another window of the *same app* (e.g. picking a different
  // Chrome window after the old one closed) keeps the region; switching to a
  // genuinely different target discards it, since the old region wouldn't apply.
  const sameApp = t.type === 'window' && !!s.match?.processName && t.processName &&
    t.processName.toLowerCase() === s.match.processName.toLowerCase();

  s.capture = t.type;
  s.lastSourceId = t.id;
  s.match = t.type === 'screen'
    ? { displayId: t.displayId }
    : { windowTitle: t.name, processName: t.processName || null };
  // If the name is still the default, adopt the target's name for convenience.
  if (!s.name || s.name === 'New screen') {
    s.name = t.type === 'screen' ? (t.name || 'Display') : t.name;
    fName.value = s.name;
  }
  if (!sameApp) s.crop = null; // a brand-new target invalidates any old region
  showAllTargets = false;      // collapse back to the focused view next time
  await persist();
  renderTargetGrid();
  renderCrop(s);
  renderList();
}

// --- Crop preview + region selection --------------------------------------
function teardownPreview() {
  if (previewStream) {
    previewStream.getTracks().forEach((tr) => tr.stop());
    previewStream = null;
  }
  cropVideo.srcObject = null;
}

async function renderCrop(s) {
  teardownPreview();
  cropLabel.textContent = s.crop ? formatCrop(s.crop) : 'Whole target';
  const liveId = s.lastSourceId && targets.some((t) => t.id === s.lastSourceId) ? s.lastSourceId : null;

  if (!liveId) {
    cropWrap.classList.add('hidden');
    cropEmpty.classList.remove('hidden');
    cropEmpty.textContent = s.match?.windowTitle || s.capture === 'screen'
      ? 'Target not in the current list — click Refresh, then reselect it above to draw a region.'
      : 'Pick a target above to draw a region, or share the whole thing.';
    return;
  }

  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: liveId, maxFrameRate: 15 } },
    });
  } catch (err) {
    cropWrap.classList.add('hidden');
    cropEmpty.classList.remove('hidden');
    cropEmpty.textContent = 'Could not preview this target.';
    return;
  }
  cropEmpty.classList.add('hidden');
  cropWrap.classList.remove('hidden');
  cropVideo.srcObject = previewStream;
  await cropVideo.play().catch(() => {});
  drawExistingRect(s);
}

function drawExistingRect(s) {
  cropOverlay.querySelectorAll('.crop-rect').forEach((n) => n.remove());
  if (!s.crop) return;
  const r = document.createElement('div');
  r.className = 'crop-rect';
  r.style.left = s.crop.x * 100 + '%';
  r.style.top = s.crop.y * 100 + '%';
  r.style.width = s.crop.w * 100 + '%';
  r.style.height = s.crop.h * 100 + '%';
  cropOverlay.appendChild(r);
}

// Drag-to-select a region on the preview. Coords normalized to the video box.
let dragStart = null;
cropOverlay.addEventListener('mousedown', (e) => {
  const s = getSource(selectedId);
  if (!s) return;
  const box = cropOverlay.getBoundingClientRect();
  dragStart = { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  cropOverlay.querySelectorAll('.crop-rect').forEach((n) => n.remove());
});
cropOverlay.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  const box = cropOverlay.getBoundingClientRect();
  const cur = { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  paintRect(dragStart, cur);
});
window.addEventListener('mouseup', async (e) => {
  if (!dragStart) return;
  const box = cropOverlay.getBoundingClientRect();
  const cur = { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  const rect = normRect(dragStart, cur);
  dragStart = null;
  if (rect.w < 0.02 || rect.h < 0.02) return; // ignore stray clicks
  const s = getSource(selectedId);
  s.crop = rect;
  cropLabel.textContent = formatCrop(rect);
  await persist();
  renderList();
  // If this source is live in Output, refresh it with the new crop.
  if (activeId === s.id) api.activate(s.id);
});

function paintRect(a, b) {
  let r = cropOverlay.querySelector('.crop-rect');
  if (!r) { r = document.createElement('div'); r.className = 'crop-rect'; cropOverlay.appendChild(r); }
  const n = normRect(a, b);
  r.style.left = n.x * 100 + '%';
  r.style.top = n.y * 100 + '%';
  r.style.width = n.w * 100 + '%';
  r.style.height = n.h * 100 + '%';
}

function normRect(a, b) {
  const x = Math.max(0, Math.min(a.x, b.x));
  const y = Math.max(0, Math.min(a.y, b.y));
  const w = Math.min(1, Math.max(a.x, b.x)) - x;
  const h = Math.min(1, Math.max(a.y, b.y)) - y;
  return { x, y, w, h };
}

function formatCrop(c) {
  return `Region ${Math.round(c.w * 100)}%×${Math.round(c.h * 100)}% @ ${Math.round(c.x * 100)},${Math.round(c.y * 100)}`;
}

async function useWhole() {
  const s = getSource(selectedId);
  if (!s) return;
  s.crop = null;
  cropLabel.textContent = 'Whole target';
  cropOverlay.querySelectorAll('.crop-rect').forEach((n) => n.remove());
  await persist();
  renderList();
  if (activeId === s.id) api.activate(s.id);
}

// --- Hotkey capture --------------------------------------------------------
const MODS = (e) => {
  const m = [];
  if (e.ctrlKey) m.push('CommandOrControl');
  if (e.altKey) m.push('Alt');
  if (e.shiftKey) m.push('Shift');
  if (e.metaKey) m.push('Super');
  return m;
};

function keyToAccel(e) {
  const k = e.key;
  if (/^F\d{1,2}$/.test(k)) return k;             // F1..F12
  if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase();
  if (/^[0-9]$/.test(k)) return k;
  const named = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  return named[k] || null;
}

function prettyHotkey(accel) {
  return (accel || '').replace('CommandOrControl', 'Ctrl').replace('Super', 'Win').replaceAll('+', ' + ');
}

fHotkey.addEventListener('keydown', async (e) => {
  e.preventDefault();
  const key = keyToAccel(e);
  if (!key) return; // wait for a non-modifier key
  const mods = MODS(e);
  if (!mods.length && !/^F\d/.test(key)) return; // require a modifier (except F-keys)
  const accel = [...mods, key].join('+');
  const s = getSource(selectedId);
  // Hotkeys must be unique — a duplicate accelerator can't be registered twice
  // by the OS. If another screen already owns this binding, take it from them.
  const stolenFrom = config.sources.filter((o) => o.id !== s.id && o.hotkey === accel);
  for (const o of stolenFrom) o.hotkey = '';
  s.hotkey = accel;
  fHotkey.value = prettyHotkey(accel);
  fHotkey.dataset.accelerator = accel;
  await persist();
  renderList();
  fHotkey.blur();
  if (stolenFrom.length) {
    const names = stolenFrom.map((o) => o.name || 'Untitled').join(', ');
    showHotkeyWarning(`${prettyHotkey(accel)} was reassigned here from: ${names}.`);
  }
});

$('f-hotkey-clear').addEventListener('click', async () => {
  const s = getSource(selectedId);
  if (!s) return;
  s.hotkey = '';
  fHotkey.value = '';
  fHotkey.dataset.accelerator = '';
  await persist();
  renderList();
});

fName.addEventListener('input', async () => {
  const s = getSource(selectedId);
  if (!s) return;
  s.name = fName.value;
  await persist();
  renderList();
});

// --- Output controls + import/export --------------------------------------
function syncOutputButtons() {
  $('btn-ontop').textContent = 'Output: on top ' + (config.output.alwaysOnTop ? '✓' : '✗');
  $('btn-frame').textContent = 'Output: frame ' + (config.output.frameless ? '✗' : '✓');
}

$('btn-add').addEventListener('click', addSource);
$('btn-delete').addEventListener('click', () => deleteSource());
$('btn-refresh').addEventListener('click', async () => {
  const btn = $('btn-refresh');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('spinning');
  btn.textContent = '↻ Refreshing…';
  await refreshTargets();
  btn.classList.remove('spinning');
  btn.textContent = `✓ ${targets.length} found`;
  setTimeout(() => { btn.textContent = '↻ Refresh list'; btn.disabled = false; }, 1300);
});
$('btn-whole').addEventListener('click', useWhole);
$('btn-activate').addEventListener('click', () => { if (selectedId) api.activate(selectedId); });

$('btn-ontop').addEventListener('click', async () => {
  config.output.alwaysOnTop = await api.toggleOnTop();
  syncOutputButtons();
});
$('btn-frame').addEventListener('click', async () => {
  config.output.frameless = await api.toggleFrame();
  syncOutputButtons();
});
$('btn-focus').addEventListener('click', () => api.focusOutput());
$('btn-deck').addEventListener('click', () => api.openDeck());

// --- Transition controls ---------------------------------------------------
function syncTransitionControls() {
  const t = config.transition || {};
  tType.value = t.type || 'fade';
  tDuration.value = String(t.duration ?? 400);
  tDurationVal.textContent = (t.duration ?? 400) + ' ms';
  tEasing.value = t.easing || 'ease-in-out';
}

async function updateTransition() {
  config.transition = {
    type: tType.value,
    duration: Number(tDuration.value),
    easing: tEasing.value,
  };
  tDurationVal.textContent = config.transition.duration + ' ms';
  await persist();
}

tType.addEventListener('change', updateTransition);
tEasing.addEventListener('change', updateTransition);
tDuration.addEventListener('input', () => { tDurationVal.textContent = tDuration.value + ' ms'; });
tDuration.addEventListener('change', updateTransition);

// Replay the live (or selected) source so the chosen transition plays.
$('t-test').addEventListener('click', () => {
  const id = activeId || selectedId;
  if (id) api.activate(id);
});

$('btn-export').addEventListener('click', () => api.exportConfig());
$('btn-import').addEventListener('click', async () => {
  const res = await api.importConfig();
  if (res.ok) { config = res.config; selectedId = null; activeId = config.activeSourceId; editor.classList.add('hidden'); editorEmpty.classList.remove('hidden'); syncOutputButtons(); syncTransitionControls(); await refreshTargets(); renderList(); }
});

// --- Events from main ------------------------------------------------------
api.onActive(({ id, bound }) => {
  activeId = id;
  renderList();
  if (!bound) showHotkeyWarning('The active screen’s target wasn’t found. Refresh and reselect its window/display.');
});

api.onHotkeysStatus(({ failed }) => {
  if (failed && failed.length) {
    const list = failed.map((f) => prettyHotkey(f.hotkey)).join(', ');
    showHotkeyWarning('These hotkeys could not be registered (already in use by another app): ' + list);
  } else {
    hotkeyWarning.classList.add('hidden');
  }
});

function showHotkeyWarning(msg) {
  hotkeyWarning.textContent = msg;
  hotkeyWarning.classList.remove('hidden');
}

// macOS only: warn (with a shortcut to the settings pane) until the user grants
// Screen Recording permission, without which all captures come back black.
const permWarning = $('perm-warning');
async function checkScreenPermission() {
  if (api.platform !== 'darwin') return;
  const status = await api.screenPermission();
  if (status === 'granted') { permWarning.classList.add('hidden'); return; }
  permWarning.innerHTML =
    'macOS needs <strong>Screen Recording</strong> permission to capture screens & windows. ' +
    'Enable ScreenDeck under System Settings → Privacy &amp; Security → Screen Recording, then relaunch. ' +
    '<button id="perm-open" class="ghost tiny">Open settings</button>';
  permWarning.classList.remove('hidden');
  const btn = document.getElementById('perm-open');
  if (btn) btn.addEventListener('click', () => api.openScreenSettings());
}

// --- Misc ------------------------------------------------------------------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Boot ------------------------------------------------------------------
(async function init() {
  config = await api.getConfig();
  if (!config.output) config.output = {};
  if (!config.transition) config.transition = {};
  activeId = config.activeSourceId || null;
  syncOutputButtons();
  syncTransitionControls();
  checkScreenPermission();
  await refreshTargets();
  renderList();
})();
