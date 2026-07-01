/**
 * Preload bridge. Exposes a small, explicit API to both renderers via
 * contextBridge so the renderer processes can run with contextIsolation on and
 * nodeIntegration off — they never see Node, ipcRenderer, or the OS directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screendeck', {
  // --- environment ---
  platform: process.platform, // 'win32' | 'darwin' | 'linux'

  // --- queries / commands (renderer -> main) ---
  listSources: () => ipcRenderer.invoke('sources:list'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  activate: (sourceId) => ipcRenderer.invoke('source:activate', sourceId),
  toggleOnTop: () => ipcRenderer.invoke('output:toggleOnTop'),
  toggleFrame: () => ipcRenderer.invoke('output:toggleFrame'),
  focusOutput: () => ipcRenderer.invoke('output:focus'),
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),

  // --- deck window ---
  listDeckSources: () => ipcRenderer.invoke('deck:sources'),
  openDeck: () => ipcRenderer.invoke('deck:open'),
  deckToggleOnTop: () => ipcRenderer.invoke('deck:toggleOnTop'),
  deckIsOnTop: () => ipcRenderer.invoke('deck:isOnTop'),

  // --- macOS screen-capture permission ---
  screenPermission: () => ipcRenderer.invoke('perm:screen'),
  openScreenSettings: () => ipcRenderer.invoke('perm:openScreenSettings'),

  // --- events (main -> renderer) ---
  onShow: (cb) => ipcRenderer.on('output:show', (_e, payload) => cb(payload)),
  onUnbound: (cb) => ipcRenderer.on('output:unbound', (_e, payload) => cb(payload)),
  onActive: (cb) => ipcRenderer.on('control:active', (_e, payload) => cb(payload)),
  onHotkeysStatus: (cb) => ipcRenderer.on('hotkeys:status', (_e, payload) => cb(payload)),
  onDeckRefresh: (cb) => ipcRenderer.on('deck:refresh', () => cb()),
});
