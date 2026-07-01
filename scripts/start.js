/**
 * Quiet launcher for ScreenDeck.
 *
 * Windows Graphics Capture emits benign, self-recovering native errors to
 * stderr when capturing background/occluded windows (e.g.
 *   ERROR:wgc_capture_session.cc ... ProcessFrame failed, using existing frame
 *   ERROR:wgc_capturer_win.cc ... Failed to start capture
 *   WARNING:dxgi_duplicator_controller.cc ... ).
 * These are hardcoded Chromium LOG() calls that the --disable-logging /
 * --log-level switches don't fully gate, so this launcher spawns Electron and
 * strips those known-noise lines from its stderr. Everything else (including
 * real app errors and our own console output) passes through untouched.
 *
 * Run the unfiltered app with `npm run start:verbose`.
 */

const { spawn } = require('node:child_process');
const electron = require('electron'); // resolves to the Electron binary path

// Lines matching any of these are dropped. Keep this list tight so genuine
// errors are never hidden.
const NOISE = [
  /wgc_capture_session\.cc/,
  /wgc_capturer_win\.cc/,
  /dxgi_adapter_duplicator\.cc/,
  /dxgi_duplicator_controller\.cc/,
  /ProcessFrame failed/,
  /Failed to start capture/,
  /Cannot initialize any DxgiOutputDuplicator/,
];

const isNoise = (line) => NOISE.some((re) => re.test(line));

// Don't let an inherited ELECTRON_RUN_AS_NODE turn the child into plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], { env, stdio: ['inherit', 'inherit', 'pipe'] });

let buf = '';
child.stderr.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split(/\r?\n/);
  buf = lines.pop(); // retain any trailing partial line for the next chunk
  for (const line of lines) {
    if (line && !isNoise(line)) process.stderr.write(line + '\n');
  }
});

child.on('exit', (code) => {
  if (buf && !isNoise(buf)) process.stderr.write(buf + '\n');
  process.exit(code ?? 0);
});

// Forward Ctrl+C so the app shuts down cleanly.
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
