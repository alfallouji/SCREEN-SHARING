/**
 * Resolve which executable owns a captured window.
 *
 * Electron's desktopCapturer gives us a window's title and an id of the form
 * `window:<HWND>:<webContentsId>` — on Windows the middle field is the native
 * HWND. From that HWND we can find the owning process (and thus its .exe), which
 * lets the Control UI offer a "show only other windows of the same app" view
 * when a remembered window can't be re-bound by title.
 *
 * The mapping is done by shelling out to PowerShell once (HWND -> PID via a tiny
 * P/Invoke, PID -> path via Get-Process). Results are cached per session keyed
 * by HWND, so repeated refreshes only query windows we haven't seen yet — and a
 * refresh where every window is already known spawns no process at all.
 *
 * Windows-only: on macOS/Linux this resolves to empty info and the UI simply
 * falls back to showing every window (the prior behaviour).
 */

const { execFile } = require('node:child_process');

const cache = new Map(); // hwnd (string) -> { name, path }

/** Build the PowerShell program that maps the given HWNDs to process paths. */
function buildScript(csv) {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class SDWin {',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '}',
    '"@',
    // PID -> executable path, in one pass (Path can be empty for protected procs).
    '$paths=@{}',
    'Get-Process | ForEach-Object { if($_.Path){ $paths[[int]$_.Id]=$_.Path } }',
    `$res = foreach($h in '${csv}'.Split(',')){`,
    '  $procId=0',
    '  [void][SDWin]::GetWindowThreadProcessId([IntPtr][int64]$h,[ref]$procId)',
    '  $p=$paths[[int]$procId]',
    '  $nm=""',
    '  if($p){ $nm=Split-Path $p -Leaf }',
    '  [pscustomobject]@{ hwnd=$h; name=$nm; path=$p }',
    '}',
    '$res | ConvertTo-Json -Compress',
  ].join('\n');
}

/** Query PowerShell for a batch of HWNDs. Resolves to Map<hwndStr,{name,path}>. */
function queryPowerShell(hwnds) {
  return new Promise((resolve) => {
    const safe = hwnds.filter((h) => /^\d+$/.test(h));
    if (!safe.length) { resolve(new Map()); return; }
    // -EncodedCommand (UTF-16LE base64) sidesteps all shell quoting concerns.
    const encoded = Buffer.from(buildScript(safe.join(',')), 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 9000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const map = new Map();
        if (err || !stdout) { resolve(map); return; }
        try {
          let arr = JSON.parse(stdout.trim());
          if (!Array.isArray(arr)) arr = [arr];
          for (const it of arr) {
            if (it && it.hwnd != null) map.set(String(it.hwnd), { name: it.name || '', path: it.path || '' });
          }
        } catch { /* malformed output -> empty map, caller degrades gracefully */ }
        resolve(map);
      }
    );
  });
}

/**
 * Resolve process info for a list of HWNDs (numbers or numeric strings).
 * Returns Map<hwndStr, { name, path }>. Cached entries are reused; only
 * unseen HWNDs trigger a PowerShell call.
 */
async function resolveWindowProcesses(hwnds) {
  const result = new Map();
  if (process.platform !== 'win32') return result;

  const missing = [];
  for (const h of hwnds) {
    const k = String(h);
    if (cache.has(k)) result.set(k, cache.get(k));
    else missing.push(k);
  }
  if (!missing.length) return result;

  const fresh = await queryPowerShell(missing);
  for (const [k, v] of fresh) { cache.set(k, v); result.set(k, v); }
  // Keep the session cache from growing without bound as windows come and go.
  if (cache.size > 800) cache.clear();
  return result;
}

module.exports = { resolveWindowProcesses };
