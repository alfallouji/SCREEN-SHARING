/**
 * ScreenDeck — main process.
 *
 * Owns two windows:
 *   - Control: the dashboard where you define "shareable screens" (sources),
 *     assign targets/crops/hotkeys, and save/load settings.
 *   - Output : the single window you share ONCE in your meeting. It paints the
 *     currently-active source full-bleed; hotkeys swap which source is active.
 *
 * The renderers never touch Node/OS APIs directly — everything goes through the
 * preload bridge and the IPC handlers registered here.
 */

const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen, dialog, Menu, systemPreferences, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, saveConfig, configPath } = require('./config');
const { resolveWindowProcesses } = require('./winProcess');
const {
  getWindowRect, placeWindow, restoreWindow, listMinimizedWindows,
  shutdown: shutdownWinControl,
} = require('./winControl');

let controlWin = null;
let outputWin = null;
let deckWin = null;
let config = null;

const PRELOAD = path.join(__dirname, '..', 'preload.js');

// Silence Chromium's noisy native logging. Capturing background/occluded
// windows makes Windows Graphics Capture spam stderr with benign, self-
// recovering errors like:
//   ERROR:wgc_capture_session.cc ... ProcessFrame failed, using existing frame
//   WARNING:dxgi_duplicator_controller.cc ... Failed to initialize
// These come from the GPU/browser process (not our JS) and capture keeps
// working, so we suppress them here. Our own console.* output is unaffected.
// (Set ELECTRON_ENABLE_LOGGING=1 to re-enable Chromium logs when debugging.)
if (!process.env.ELECTRON_ENABLE_LOGGING) {
  app.commandLine.appendSwitch('disable-logging');
  app.commandLine.appendSwitch('log-level', '3'); // 3 = FATAL only; filters ERROR/WARNING in any child still logging
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'ScreenDeck — Control',
    backgroundColor: '#14161c',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlWin.removeMenu();
  controlWin.loadFile(path.join(__dirname, '..', 'renderer', 'control', 'index.html'));
  controlWin.on('closed', () => {
    controlWin = null;
    // Closing the control window quits the app (the others are useless alone).
    if (outputWin && !outputWin.isDestroyed()) outputWin.close();
    if (deckWin && !deckWin.isDestroyed()) deckWin.close();
  });
}

/** The floating "stream deck": a small, movable, resizable control surface with
 *  one big button per shareable screen. */
function createDeckWindow() {
  const d = config.deck || {};
  deckWin = new BrowserWindow({
    width: d.width || 360,
    height: d.height || 360,
    x: typeof d.x === 'number' ? d.x : undefined,
    y: typeof d.y === 'number' ? d.y : undefined,
    minWidth: 180,
    minHeight: 160,
    title: 'ScreenDeck — Deck',
    backgroundColor: '#0e1118',
    frame: false,            // clean, compact; moved via an in-window drag strip
    resizable: true,
    movable: true,
    alwaysOnTop: !!d.alwaysOnTop,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  deckWin.removeMenu();
  deckWin.loadFile(path.join(__dirname, '..', 'renderer', 'deck', 'index.html'));
  // Remember where the user parked the deck and how big they made it.
  deckWin.on('close', () => {
    if (deckWin && !deckWin.isDestroyed()) {
      const b = deckWin.getBounds();
      config.deck = { ...config.deck, x: b.x, y: b.y, width: b.width, height: b.height };
      saveConfig(config);
    }
  });
  deckWin.on('closed', () => { deckWin = null; });
}

/** Push the Output window's styling (its border) to the Output renderer. */
function sendOutputStyle() {
  if (outputWin && !outputWin.isDestroyed()) {
    outputWin.webContents.send('output:style', { border: config.output.border });
  }
}

/** Broadcast which source is active to every window that highlights it. */
function sendActive(payload) {
  for (const w of [controlWin, deckWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('control:active', payload);
  }
}

/**
 * Application menu. macOS needs a real menu for the standard app shortcuts
 * (⌘Q to quit) and an Edit menu so copy/paste works in the text fields.
 * Windows/Linux get no menu bar (the UI is all in-window).
 */
function setupAppMenu() {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

/**
 * macOS screen-capture permission status. On Windows/Linux capture is always
 * allowed, so we report 'granted' there. On macOS the OS gates screen capture
 * behind a Screen Recording permission that can't be requested programmatically
 * — the user must enable it in System Settings and relaunch.
 */
function screenPermissionStatus() {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen'); // granted|denied|restricted|not-determined
}

function createOutputWindow() {
  const out = config.output || {};
  outputWin = new BrowserWindow({
    width: out.width || 1280,
    height: out.height || 720,
    title: 'ScreenDeck — SHARE THIS WINDOW',
    backgroundColor: '#000000',
    frame: !out.frameless,
    alwaysOnTop: !!out.alwaysOnTop,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  outputWin.removeMenu();
  outputWin.loadFile(path.join(__dirname, '..', 'renderer', 'output', 'index.html'));
  outputWin.on('closed', () => { outputWin = null; });
}

/** Recreate the Output window (used when toggling the frame, which can't change
 *  on a live BrowserWindow) and restore the active source. */
function recreateOutputWindow() {
  if (outputWin && !outputWin.isDestroyed()) {
    const [w, h] = outputWin.getSize();
    config.output.width = w;
    config.output.height = h;
    outputWin.removeAllListeners('closed');
    outputWin.close();
  }
  createOutputWindow();
  outputWin.webContents.once('did-finish-load', () => {
    if (config.activeSourceId) activateSource(config.activeSourceId);
  });
}

// ---------------------------------------------------------------------------
// Source enumeration + activation
// ---------------------------------------------------------------------------

/**
 * List live capturable screens and windows for the Control picker.
 *
 * When `opts.withProcess` is set (the Control picker; not the cheap, frequent
 * Deck refresh), each window is annotated with the owning process's executable
 * name (`processName`) so the UI can group windows by app for re-binding.
 */
async function listCaptureTargets(opts = {}) {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false,
  });
  const displays = screen.getAllDisplays();
  const out = sources.map((s) => {
    const isScreen = s.id.startsWith('screen');
    let displayId = s.display_id || null;
    // Map a screen source to its Display bounds (for region math / labels).
    const disp = isScreen && displayId
      ? displays.find((d) => String(d.id) === String(displayId))
      : null;
    // On Windows the id is `window:<HWND>:<webContentsId>` — pull out the HWND.
    const hwndMatch = isScreen ? null : /^window:(\d+):/.exec(s.id);
    return {
      id: s.id,
      name: s.name,
      type: isScreen ? 'screen' : 'window',
      thumbnailDataURL: s.thumbnail ? s.thumbnail.toDataURL() : null,
      displayId,
      bounds: disp ? disp.bounds : null,
      hwnd: hwndMatch ? hwndMatch[1] : null,
      processName: null,
      exePath: null,
    };
  });

  if (opts.withProcess) {
    const windows = out.filter((t) => t.type === 'window' && t.hwnd);
    const procs = await resolveWindowProcesses(windows.map((t) => t.hwnd));
    for (const t of windows) {
      const info = procs.get(String(t.hwnd));
      if (info) { t.processName = info.name; t.exePath = info.path; }
    }
  }
  return out;
}

/**
 * Re-resolve a saved source against a live target list. IDs are not stable
 * across runs, so we match on the remembered window title / display id.
 * Returns the matching target, or null if it can't be found right now.
 */
function resolveLiveTarget(source, targets) {
  // Fast path: the id we used last is still present this session.
  if (source.lastSourceId) {
    const last = targets.find((t) => t.id === source.lastSourceId);
    if (last) return last;
  }
  const m = source.match || {};
  if (source.capture === 'screen') {
    return targets.find((t) => t.type === 'screen' && String(t.displayId) === String(m.displayId))
      // Fall back to the first screen so a display source still shows something.
      || targets.find((t) => t.type === 'screen')
      || null;
  }
  // Window: match by remembered title (case-insensitive substring, both ways).
  if (m.windowTitle) {
    const needle = m.windowTitle.toLowerCase();
    return targets.find((t) => {
      const name = (t.name || '').toLowerCase();
      // An empty title would match every needle, so insist on a real one.
      return t.type === 'window' && name && (name.includes(needle) || needle.includes(name));
    }) || null;
  }
  return null;
}

/**
 * Dress raw minimized windows up as capture targets, so the same matcher works
 * on them. They carry no capture id — restoring comes first.
 *
 * `withProcess` fills in the owning executable to match what the capture list
 * provides, which only the Control picker needs. It can cost a PowerShell call
 * for windows not yet in the session cache, so the frequently-polled deck and
 * activation paths leave it off.
 */
async function shapeMinimized(windows, opts = {}) {
  const procs = opts.withProcess
    ? await resolveWindowProcesses(windows.map((w) => w.hwnd))
    : new Map();
  return windows.map((w) => {
    const info = procs.get(String(w.hwnd));
    return {
      id: null,
      name: w.name,
      type: 'window',
      hwnd: w.hwnd,
      minimized: true,
      thumbnailDataURL: null,
      displayId: null,
      bounds: null,
      processName: info ? info.name : null,
      exePath: info ? info.path : null,
    };
  });
}

/**
 * Build a matcher for sources whose window is minimized.
 *
 * desktopCapturer never lists a minimized window, so without this a source
 * whose window is merely minimized is indistinguishable from one whose window
 * has been closed — and the user gets told to re-bind a source that is fine.
 *
 * The Win32 enumeration is deferred until something actually fails to resolve,
 * and then done once per caller, so the common all-bound case costs nothing.
 */
function minimizedMatcher() {
  let shaped = null;
  return async (source) => {
    if (process.platform !== 'win32' || source.capture !== 'window') return null;
    if (!shaped) shaped = await shapeMinimized(await listMinimizedWindows());
    if (!shaped.length) return null;
    // Prefer the remembered HWND: a window keeps it for its whole life, and
    // unlike the title it doesn't change when the user switches browser tab.
    const hwnd = hwndFromSourceId(source.lastSourceId);
    const byHwnd = hwnd && shaped.find((t) => t.hwnd === hwnd);
    if (byHwnd) return byHwnd;
    // Otherwise fall back to the title, exactly as the capture list is matched.
    // (The remembered capture id can never match a minimized entry.)
    return resolveLiveTarget({ ...source, lastSourceId: null }, shaped);
  };
}

/** HWND out of a desktopCapturer window id (`window:<HWND>:<webContentsId>`). */
function hwndFromSourceId(sourceId) {
  const m = /^window:(\d+):/.exec(sourceId || '');
  return m ? m[1] : null;
}

/**
 * Bring the captured window to the user: restore it if minimized, resize it to
 * the size remembered when the source was bound (so a drawn region still lines
 * up), centre it on the primary display and raise it to the front.
 *
 * Best-effort and deliberately *not* awaited: the Output picture should switch
 * on the same frame as the hotkey, and the capture adapts on its own if the
 * resize lands a moment later. A failure here never blocks the switch.
 */
function snapSourceWindow(source, liveId) {
  if (process.platform !== 'win32') return;
  if (!config.snapOnActivate) return;
  if (source.capture !== 'window') return; // a display can't be moved
  const hwnd = hwndFromSourceId(liveId);
  if (!hwnd) return;
  // No remembered size (source bound before sizes were recorded) -> centre only.
  placeWindow(hwnd, source.match && source.match.windowSize).catch(() => {});
}

/** Activate a source by its config id: resolve it live, then push to Output. */
async function activateSource(sourceId) {
  const source = (config.sources || []).find((s) => s.id === sourceId);
  if (!source) return { ok: false, reason: 'no such source' };

  let targets = await listCaptureTargets();
  let target = resolveLiveTarget(source, targets);

  // Absent from the capture list? The window may just be minimized. Un-minimize
  // it — which is what activating the source is asking for anyway — and look
  // again, rather than reporting a source that is perfectly fine as unbound.
  if (!target) {
    const hidden = await minimizedMatcher()(source);
    if (hidden) {
      await restoreWindow(hidden.hwnd);
      // Give the compositor a moment; a window that has only just been restored
      // can still be missing from the next enumeration.
      await new Promise((resolve) => setTimeout(resolve, 200));
      targets = await listCaptureTargets();
      target = resolveLiveTarget(source, targets);
    }
  }

  const liveId = target ? target.id : null;

  config.activeSourceId = sourceId;

  if (!liveId) {
    sendActive({ id: sourceId, bound: false });
    if (outputWin) outputWin.webContents.send('output:unbound', { name: source.name });
    return { ok: false, reason: 'target not found — needs rebinding' };
  }

  // Remember the resolved id for the fast path within this session.
  source.lastSourceId = liveId;

  snapSourceWindow(source, liveId);

  if (outputWin && !outputWin.isDestroyed()) {
    outputWin.webContents.send('output:show', {
      sourceId: liveId,
      crop: source.crop || null,
      name: source.name,
      transition: config.transition || null,
    });
  }
  sendActive({ id: sourceId, bound: true });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Global hotkeys
// ---------------------------------------------------------------------------

/** Re-register every source hotkey from config. Returns per-source failures. */
function reloadHotkeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const source of config.sources || []) {
    if (!source.hotkey) continue;
    try {
      const ok = globalShortcut.register(source.hotkey, () => activateSource(source.id));
      if (!ok) failed.push({ id: source.id, hotkey: source.hotkey });
    } catch (err) {
      failed.push({ id: source.id, hotkey: source.hotkey, error: err.message });
    }
  }
  if (controlWin) controlWin.webContents.send('hotkeys:status', { failed });
  return failed;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('sources:list', async () => {
    const targets = await listCaptureTargets({ withProcess: true });
    // Include minimized windows so Control doesn't flag a perfectly good source
    // as "needs rebinding" just because its window is minimized. They have no
    // capture id, so the picker leaves them out of the selectable tiles.
    if (process.platform === 'win32') {
      targets.push(...await shapeMinimized(await listMinimizedWindows(), { withProcess: true }));
    }
    return targets;
  });

  ipcMain.handle('config:get', () => config);

  ipcMain.handle('config:save', (_evt, next) => {
    config = { ...config, ...next };
    saveConfig(config);
    reloadHotkeys();
    sendOutputStyle();
    if (deckWin && !deckWin.isDestroyed()) deckWin.webContents.send('deck:refresh');
    return { ok: true, path: configPath() };
  });

  ipcMain.handle('source:activate', (_evt, sourceId) => activateSource(sourceId));

  // Control calls this when binding a window target, to remember the size that
  // activating the source should later restore it to.
  ipcMain.handle('window:rect', (_evt, hwnd) => getWindowRect(hwnd));

  // Deck: a source list joined with each source's resolved live thumbnail.
  ipcMain.handle('deck:sources', async () => {
    const targets = await listCaptureTargets();
    const findHidden = minimizedMatcher(); // only enumerates if something misses
    const out = [];
    for (const s of config.sources || []) {
      const t = resolveLiveTarget(s, targets) || await findHidden(s);
      out.push({
        id: s.id,
        name: s.name,
        hotkey: s.hotkey || '',
        thumb: t ? t.thumbnailDataURL : null,
        bound: !!t,
        // Still bound, just not capturable until it is restored — which
        // clicking the tile does.
        minimized: !!(t && t.minimized),
        active: config.activeSourceId === s.id,
      });
    }
    return out;
  });

  ipcMain.handle('deck:open', () => {
    if (deckWin && !deckWin.isDestroyed()) { deckWin.show(); deckWin.focus(); }
    else createDeckWindow();
    return true;
  });

  ipcMain.handle('deck:toggleOnTop', () => {
    config.deck.alwaysOnTop = !config.deck.alwaysOnTop;
    if (deckWin) deckWin.setAlwaysOnTop(config.deck.alwaysOnTop);
    saveConfig(config);
    return config.deck.alwaysOnTop;
  });

  ipcMain.handle('deck:isOnTop', () => !!(config.deck && config.deck.alwaysOnTop));

  // macOS screen-capture permission: report status + open the right settings pane.
  ipcMain.handle('perm:screen', () => screenPermissionStatus());
  ipcMain.handle('perm:openScreenSettings', () => {
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
    return true;
  });

  ipcMain.handle('output:toggleOnTop', () => {
    config.output.alwaysOnTop = !config.output.alwaysOnTop;
    if (outputWin) outputWin.setAlwaysOnTop(config.output.alwaysOnTop);
    saveConfig(config);
    return config.output.alwaysOnTop;
  });

  ipcMain.handle('output:toggleFrame', () => {
    config.output.frameless = !config.output.frameless;
    saveConfig(config);
    recreateOutputWindow();
    return config.output.frameless;
  });

  ipcMain.handle('output:focus', () => {
    if (outputWin && !outputWin.isDestroyed()) outputWin.show();
    return true;
  });

  ipcMain.handle('config:export', async () => {
    const res = await dialog.showSaveDialog(controlWin, {
      title: 'Save ScreenDeck settings',
      defaultPath: 'screendeck-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    fs.writeFileSync(res.filePath, JSON.stringify(config, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle('config:import', async () => {
    const res = await dialog.showOpenDialog(controlWin, {
      title: 'Load ScreenDeck settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    try {
      const parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      config = { ...config, ...parsed, sources: Array.isArray(parsed.sources) ? parsed.sources : [] };
      saveConfig(config);
      reloadHotkeys();
      return { ok: true, config };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  config = loadConfig();
  setupAppMenu();
  registerIpc();
  createControlWindow();
  createOutputWindow();
  createDeckWindow();
  reloadHotkeys();

  // Restore the last active source once the Output window has loaded.
  outputWin.webContents.once('did-finish-load', () => {
    if (config.activeSourceId) activateSource(config.activeSourceId);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow();
      createOutputWindow();
      createDeckWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  shutdownWinControl();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
