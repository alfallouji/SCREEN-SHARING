/**
 * Deck renderer — a compact, floating control surface. One large button per
 * shareable screen, each with a small live-ish preview, the title, and the
 * hotkey. Clicking a button activates that source in the Output window.
 *
 * Previews are periodically-refreshed desktopCapturer thumbnails (not N live
 * capture streams), which keeps the deck cheap and avoids extra capture noise.
 */

const api = window.screendeck;
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const pin = document.getElementById('dk-pin');

const REFRESH_MS = 2500;
const tiles = new Map(); // id -> { el, thumb, nm, hk, lastThumb }
let activeId = null;

function prettyHotkey(accel) {
  // Compact form for the small badge, e.g. "Ctrl+F1".
  return (accel || '').replace('CommandOrControl', 'Ctrl').replace('Super', 'Win');
}

function makeTile(id) {
  const el = document.createElement('button');
  el.className = 'tile';
  el.dataset.id = id;
  el.innerHTML =
    '<div class="thumb"></div>' +
    '<span class="hk"></span>' +
    '<div class="dot"></div>' +
    '<div class="meta"><span class="nm"></span></div>';
  el.addEventListener('click', () => {
    activeId = id;
    applyActive();
    api.activate(id);
  });
  return {
    el,
    thumb: el.querySelector('.thumb'),
    nm: el.querySelector('.nm'),
    hk: el.querySelector('.hk'),
    lastThumb: undefined,
  };
}

function updateTile(t, s) {
  t.nm.textContent = s.name || 'Untitled';
  t.nm.title = s.name || '';
  t.hk.textContent = prettyHotkey(s.hotkey);
  t.hk.style.display = s.hotkey ? '' : 'none';
  t.el.classList.toggle('unbound', !s.bound);

  if (s.bound && s.thumb) {
    // Only touch the DOM when the image actually changed (avoids flicker).
    if (t.lastThumb !== s.thumb) {
      t.thumb.style.backgroundImage = `url("${s.thumb}")`;
      t.thumb.innerHTML = '';
      t.lastThumb = s.thumb;
    }
  } else if (t.lastThumb !== 'PH') {
    t.thumb.style.backgroundImage = 'none';
    t.thumb.innerHTML = '<span class="ph">not found —<br>rebind in Control</span>';
    t.lastThumb = 'PH';
  }
}

function applyActive() {
  for (const [id, t] of tiles) t.el.classList.toggle('active', id === activeId);
}

function render(list) {
  empty.classList.toggle('hidden', list.length > 0);

  const seen = new Set();
  for (const s of list) {
    seen.add(s.id);
    if (s.active) activeId = s.id;
    let t = tiles.get(s.id);
    if (!t) { t = makeTile(s.id); tiles.set(s.id, t); }
    updateTile(t, s);
    grid.appendChild(t.el); // re-append keeps DOM order in sync with config order
  }
  for (const [id, t] of tiles) {
    if (!seen.has(id)) { t.el.remove(); tiles.delete(id); }
  }
  applyActive();
}

async function refresh() {
  try {
    render(await api.listDeckSources());
  } catch (err) {
    console.error('[deck] refresh failed:', err);
  }
}

async function syncPin() {
  pin.classList.toggle('on', await api.deckIsOnTop());
}

// --- Wiring ----------------------------------------------------------------
pin.addEventListener('click', async () => {
  const on = await api.deckToggleOnTop();
  pin.classList.toggle('on', on);
});

api.onActive(({ id }) => { activeId = id; applyActive(); });
api.onDeckRefresh(() => refresh());

// Periodic thumbnail refresh, paused while the window is hidden/minimized.
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);

refresh();
syncPin();
