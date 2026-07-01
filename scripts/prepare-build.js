/**
 * Pre-populates electron-builder's winCodeSign cache on Windows.
 *
 * The winCodeSign archive contains macOS .dylib **symlinks**; extracting them on
 * Windows needs the "create symbolic link" privilege (admin or Developer Mode),
 * which many machines don't have — so `electron-builder` fails with
 * "Cannot create symbolic link: A required privilege is not held by the client."
 *
 * Those dylibs are only used for *macOS* signing and are irrelevant to a Windows
 * build, so here we fetch the same archive and extract it WITHOUT the `darwin`
 * folder into the exact cache dir electron-builder looks for. It then finds a
 * ready cache and skips its own (failing) extraction.
 *
 * No-op on macOS/Linux (symlinks extract fine there). Run automatically by the
 * `dist*`/`pack` npm scripts.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') process.exit(0);

const VERSION = 'winCodeSign-2.6.0';
const URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${VERSION}/${VERSION}.7z`;

const cacheRoot = process.env.ELECTRON_BUILDER_CACHE
  || path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');
const dest = path.join(cacheRoot, 'winCodeSign', VERSION);
const marker = path.join(dest, 'windows-10'); // present only on a complete extraction

if (fs.existsSync(marker)) {
  console.log('[prepare-build] winCodeSign cache already present — skipping.');
  process.exit(0);
}

(async () => {
  // Clear any partial/failed extraction so we start clean.
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const tmp = path.join(cacheRoot, 'winCodeSign', 'wcs-download.7z');
  console.log('[prepare-build] downloading', URL);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

  const path7za = require('7zip-bin').path7za;
  console.log('[prepare-build] extracting (excluding darwin symlinks)…');
  const r = spawnSync(path7za, ['x', tmp, `-o${dest}`, '-xr!darwin', '-y'], { stdio: 'inherit' });
  fs.rmSync(tmp, { force: true });
  if (r.status !== 0) throw new Error('7za extraction failed');

  console.log('[prepare-build] winCodeSign cache ready.');
})().catch((err) => {
  console.error('[prepare-build]', err.message);
  process.exit(1);
});
