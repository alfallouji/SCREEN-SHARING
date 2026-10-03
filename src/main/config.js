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
      border: {             // outline drawn around the shared picture
        enabled: true,
        width: 4,           // CSS pixels; 0 is the same as disabled
        color: '#ffffff',
      },
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
    // Windows only: on activation, also centre the captured window on the
    // primary display at the size remembered when the source was bound.
    snapOnActivate: true,
    activeSourceId: null,
  };
}

function configPath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

/** Read config from disk, falling back to defaults on missing/corrupt file. */
function loadConfig() {
  const file = configPath();
  const base = defaultConfig();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    // Shallow-merge onto defaults so older/partial files gain new fields.
    return {
      ...base,
      ...parsed,
      output: {
        ...base.output,
        ...parsed.output,
        // One level deeper, so a file written before borders existed still gets
        // the default outline rather than an empty object.
        border: { ...base.output.border, ...(parsed.output && parsed.output.border) },
      },
      transition: { ...base.transition, ...parsed.transition },
      deck: { ...base.deck, ...parsed.deck },
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[config] could not read config, using defaults:', err.message);
    }
    return base;
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
