/**
 * Config persistence for ScreenDeck.
 *
 * The user's "shareable screens" (sources), hotkeys and Output-window
 * preferences are stored as a single JSON document under the per-user app data
 * folder, so settings survive across runs. Writes are atomic (temp file +
 * rename) so a crash mid-save can never leave a half-written, unparseable file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const FILE_NAME = 'config.json';

/** Shape used when no config exists yet (first launch). */
function defaultConfig() {
  return {
    version: 1,
    sources: [],            // see DEFAULT_SOURCE in the renderer for the shape
    output: {
      alwaysOnTop: false,
      frameless: true,      // hide the OS title bar by default for a clean share
      width: 1280,
      height: 720,
    },
    transition: {
      type: 'fade',         // 'none' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
      duration: 400,        // milliseconds
      easing: 'ease-in-out',// 'linear' | 'ease-in-out'
    },
    deck: {
      alwaysOnTop: true,    // float the control deck above other windows
      x: null,              // remembered position (null = let the OS place it)
      y: null,
      width: 360,
      height: 360,
    },
    activeSourceId: null,
  };
}

function configPath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

/** Read config from disk, falling back to defaults on missing/corrupt file. */
function loadConfig() {
  const file = configPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    // Shallow-merge onto defaults so older/partial files gain new fields.
    return {
      ...defaultConfig(),
      ...parsed,
      output: { ...defaultConfig().output, ...parsed.output },
      transition: { ...defaultConfig().transition, ...parsed.transition },
      deck: { ...defaultConfig().deck, ...parsed.deck },
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[config] could not read config, using defaults:', err.message);
    }
    return defaultConfig();
  }
}

/** Atomically write config to disk. Returns the path written. */
function saveConfig(config) {
  const file = configPath();
  const tmp = file + '.tmp';
  const data = JSON.stringify(config, null, 2);
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file); // atomic on the same volume
  return file;
}

module.exports = { loadConfig, saveConfig, configPath, defaultConfig };
