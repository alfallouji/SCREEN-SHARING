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
 * Re-resolve a saved source's live desktopCapturer id. IDs are not stable
 * across runs, so we match on the remembered window title / display id.
 * Returns the live id, or null if the target can't be found right now.
 */
async function resolveLiveId(source, targets) {
  // Fast path: the id we used last is still present this session.
  if (source.lastSourceId && targets.some((t) => t.id === source.lastSourceId)) {
    return source.lastSourceId;
  }
  const m = source.match || {};
  if (source.capture === 'screen') {
    const byId = targets.find((t) => t.type === 'screen' && String(t.displayId) === String(m.displayId));
    if (byId) return byId.id;
    // Fall back to the first screen so a display source still shows something.
    const anyScreen = targets.find((t) => t.type === 'screen');
    return anyScreen ? anyScreen.id : null;
  }
  // Window: match by remembered title (case-insensitive substring, both ways).
  if (m.windowTitle) {
    const needle = m.windowTitle.toLowerCase();
    const hit = targets.find((t) => {
      const name = (t.name || '').toLowerCase();
      return t.type === 'window' && (name.includes(needle) || needle.includes(name));
    });
    if (hit) return hit.id;
  }
  return null;
}

/** Activate a source by its config id: resolve it live, then push to Output. */
async function activateSource(sourceId) {
  const source = (config.sources || []).find((s) => s.id === sourceId);
  if (!source) return { ok: false, reason: 'no such source' };

  const targets = await listCaptureTargets();
  const liveId = await resolveLiveId(source, targets);

  config.activeSourceId = sourceId;

  if (!liveId) {
    sendActive({ id: sourceId, bound: false });
    if (outputWin) outputWin.webContents.send('output:unbound', { name: source.name });
    return { ok: false, reason: 'target not found — needs rebinding' };
  }

  // Remember the resolved id for the fast path within this session.
  source.lastSourceId = liveId;

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
  ipcMain.handle('sources:list', () => listCaptureTargets({ withProcess: true }));

  ipcMain.handle('config:get', () => config);

  ipcMain.handle('config:save', (_evt, next) => {
    config = { ...config, ...next };
    saveConfig(config);
    reloadHotkeys();
    if (deckWin && !deckWin.isDestroyed()) deckWin.webContents.send('deck:refresh');
    return { ok: true, path: configPath() };
  });

  ipcMain.handle('source:activate', (_evt, sourceId) => activateSource(sourceId));

  // Deck: a source list joined with each source's resolved live thumbnail.
  ipcMain.handle('deck:sources', async () => {
    const targets = await listCaptureTargets();
    const out = [];
    for (const s of config.sources || []) {
      const liveId = await resolveLiveId(s, targets);
      const t = liveId ? targets.find((x) => x.id === liveId) : null;
      out.push({
        id: s.id,
        name: s.name,
        hotkey: s.hotkey || '',
        thumb: t ? t.thumbnailDataURL : null,
        bound: !!t,
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

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
