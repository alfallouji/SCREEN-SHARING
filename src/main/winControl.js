/**
 * See, move, resize and raise *foreign* windows on Windows.
 *
 * Two jobs, both impossible through Electron (which only knows about the windows
 * it owns), so both go through Win32 via PowerShell P/Invoke — the same trick
 * winProcess.js uses for HWND -> process lookups:
 *
 *   1. Placement. When a shareable screen is activated we bring the real window
 *      to the front of the primary display, centred, at the size it had when the
 *      source's region was drawn. That keeps the region lined up with the
 *      content and puts the thing you're talking about in front of you.
 *   2. Finding minimized windows. desktopCapturer never lists a minimized
 *      window, so a source whose window is merely minimized is indistinguishable
 *      from one whose window has been closed. Enumerating them ourselves lets
 *      activation un-minimize and capture it instead of asking for a re-bind.
 *
 * Unlike winProcess.js this runs on *every* source switch, including rapid
 * hotkey presses, so a fresh `powershell.exe` per call is too slow — `Add-Type`
 * compiles C# at startup and costs most of a second. Instead one helper process
 * is kept alive and driven over stdin with one line per request:
 *
 *     <id> INFO  <hwnd>              -> "<id> OK x,y,w,h,clientW,clientH"
 *     <id> PLACE <hwnd> <w> <h>      -> "<id> OK 1" | "<id> OK 0"
 *     <id> SHOW  <hwnd>              -> "<id> OK 1" | "<id> OK 0"
 *     <id> MINS                      -> "<id> OK <base64 hwnd/title records>"
 *
 * Arguments are always single tokens (window titles travel base64-encoded) so
 * the line protocol can never be broken by a window called "a b c". The helper
 * is spawned lazily on first use and respawned if it ever dies, so a crashed
 * helper degrades to "the picture still switches, the window just doesn't move".
 *
 * A note on DPI: powershell.exe's DPI awareness is whatever Windows gives it,
 * which may mean Win32 hands it virtualized rather than physical coordinates on
 * a scaled display. We therefore never mix in coordinates from Electron's
 * `screen` module — the remembered window size, the primary monitor's work area
 * and the centring maths all come from Win32 inside the helper, so they are all
 * in the same coordinate space whatever that space turns out to be.
 *
 * Windows-only: everywhere else every call resolves to null/false/[] and the
 * caller simply skips the snap.
 */

const { spawn } = require('node:child_process');

const REQUEST_TIMEOUT_MS = 6000;

// Record/field separators for the MINS payload. Control characters cannot occur
// in a window title, so the payload needs no escaping.
const REC_SEP = '\u001e';
const FIELD_SEP = '\u001f';

/** P/Invoke surface + the operations, kept in C# so the PowerShell side never
 *  has to marshal a struct or escape a string. */
const CSHARP = [
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public static class SDPlace {',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }',
  '  delegate bool EnumProc(IntPtr h, IntPtr p);',
  '  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);',
  '  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);',
  '  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);',
  '  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
  '',
  '  // Outer rect + client size of a window, as "x,y,w,h,clientW,clientH".',
  '  public static string Info(IntPtr h) {',
  '    RECT r; RECT c = new RECT();',
  '    if (!IsWindow(h) || !GetWindowRect(h, out r)) return "";',
  '    GetClientRect(h, out c); // always origin-based, so Right/Bottom are the size',
  '    return string.Format("{0},{1},{2},{3},{4},{5}", r.Left, r.Top,',
  '      r.Right - r.Left, r.Bottom - r.Top, c.Right - c.Left, c.Bottom - c.Top);',
  '  }',
  '',
  '  // Every minimized top-level window with a title, as base64 of',
  '  // "<hwnd><US><title><RS>..." — control characters cannot occur in a title,',
  '  // so the payload needs no escaping and stays a single protocol token.',
  '  public static string Minimized() {',
  '    StringBuilder sb = new StringBuilder();',
  '    EnumProc cb = delegate(IntPtr h, IntPtr p) {',
  '      if (IsWindowVisible(h) && IsIconic(h)) {',
  '        StringBuilder t = new StringBuilder(512);',
  '        GetWindowTextW(h, t, 512);',
  '        if (t.Length > 0) sb.Append(h.ToInt64()).Append((char)31).Append(t.ToString()).Append((char)30);',
  '      }',
  '      return true;',
  '    };',
  '    EnumWindows(cb, IntPtr.Zero);',
  '    GC.KeepAlive(cb); // the delegate must outlive the native enumeration',
  '    return Convert.ToBase64String(Encoding.UTF8.GetBytes(sb.ToString()));',
  '  }',
  '',
  '  // Work area of the primary monitor (the display holding the origin).',
  '  static RECT PrimaryWorkArea() {',
  '    POINT origin; origin.X = 0; origin.Y = 0;',
  '    MONITORINFO mi = new MONITORINFO();',
  '    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));',
  '    GetMonitorInfo(MonitorFromPoint(origin, 1 /* MONITOR_DEFAULTTOPRIMARY */), ref mi);',
  '    return mi.rcWork;',
  '  }',
  '',
  '  // A process that is not already in the foreground may not call',
  '  // SetForegroundWindow. Briefly sharing the current foreground thread\'s',
  '  // input queue is the long-standing way to be granted that right.',
  '  static void Raise(IntPtr h) {',
  '    IntPtr fg = GetForegroundWindow();',
  '    uint pid;',
  '    uint fgTid = GetWindowThreadProcessId(fg, out pid);',
  '    uint myTid = GetCurrentThreadId();',
  '    bool attached = fgTid != 0 && fgTid != myTid && AttachThreadInput(myTid, fgTid, true);',
  '    try {',
  '      BringWindowToTop(h);',
  '      SetForegroundWindow(h);',
  '    } finally {',
  '      if (attached) AttachThreadInput(myTid, fgTid, false);',
  '    }',
  '  }',
  '',
  '  // Un-minimize and raise, leaving position and size untouched. Used to make',
  '  // a minimized window capturable again without moving it.',
  '  public static bool Show(IntPtr h) {',
  '    if (!IsWindow(h)) return false;',
  '    if (IsIconic(h)) ShowWindow(h, 9 /* SW_RESTORE */);',
  '    Raise(h);',
  '    return true;',
  '  }',
  '',
  '  // Un-minimize/un-maximize, resize to w x h (0 = keep current), centre on',
  '  // the primary monitor, and raise to the foreground.',
  '  public static bool Place(IntPtr h, int w, int hh) {',
  '    if (!IsWindow(h)) return false;',
  '    // A minimized or maximized window ignores SetWindowPos geometry, so drop',
  '    // it back to a normal window first (this is also what brings it back).',
  '    if (IsIconic(h) || IsZoomed(h)) ShowWindow(h, 9 /* SW_RESTORE */);',
  '    RECT cur;',
  '    if (!GetWindowRect(h, out cur)) return false;',
  '    if (w <= 0) w = cur.Right - cur.Left;',
  '    if (hh <= 0) hh = cur.Bottom - cur.Top;',
  '    RECT work = PrimaryWorkArea();',
  '    int areaW = work.Right - work.Left;',
  '    int areaH = work.Bottom - work.Top;',
  '    if (areaW <= 0 || areaH <= 0) return false;',
  '    if (w > areaW) w = areaW;',
  '    if (hh > areaH) hh = areaH;',
  '    int x = work.Left + (areaW - w) / 2;',
  '    int y = work.Top + (areaH - hh) / 2;',
  '    SetWindowPos(h, IntPtr.Zero /* HWND_TOP */, x, y, w, hh, 0x0040 /* SWP_SHOWWINDOW */);',
  '    Raise(h);',
  '    return true;',
  '  }',
  '}',
].join('\n');

/** The helper program: compile the P/Invoke class once, then serve stdin lines. */
const HELPER_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  'Add-Type @"',
  CSHARP,
  '"@',
  'while($true){',
  '  $line=[Console]::In.ReadLine()',
  '  if($null -eq $line){ break }',
  '  $line=$line.Trim()',
  "  if($line -eq ''){ continue }",
  "  if($line -eq 'QUIT'){ break }",
  "  $p=$line.Split(' ')",
  '  $id=$p[0]',
  '  $out="$id ERR"',
  '  try{',
  "    if($p[1] -eq 'INFO'){",
  '      $out="$id OK " + [SDPlace]::Info([IntPtr][int64]$p[2])',
  "    } elseif($p[1] -eq 'PLACE'){",
  '      $ok=[SDPlace]::Place([IntPtr][int64]$p[2],[int]$p[3],[int]$p[4])',
  '      if($ok){ $out="$id OK 1" } else { $out="$id OK 0" }',
  "    } elseif($p[1] -eq 'SHOW'){",
  '      $ok=[SDPlace]::Show([IntPtr][int64]$p[2])',
  '      if($ok){ $out="$id OK 1" } else { $out="$id OK 0" }',
  "    } elseif($p[1] -eq 'MINS'){",
  '      $out="$id OK " + [SDPlace]::Minimized()',
  '    }',
  '  } catch { $out="$id ERR" }',
  '  [Console]::Out.WriteLine($out)',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

let proc = null;          // live helper, or null before first use / after a death
let seq = 0;              // request id counter
let stdoutBuf = '';       // partial line carry-over
const pending = new Map(); // id -> { resolve, timer }

/** Fail every in-flight request (helper died or is being shut down). */
function flushPending() {
  for (const { resolve, timer } of pending.values()) {
    clearTimeout(timer);
    resolve(null);
  }
  pending.clear();
}

function handleLine(line) {
  const parts = line.trim().split(' ');
  const entry = pending.get(parts[0]);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(parts[0]);
  // An OK with no payload is a legitimate empty result (no minimized windows),
  // so keep '' distinct from the null that an ERR produces.
  entry.resolve(parts[1] === 'OK' ? (parts[2] === undefined ? '' : parts[2]) : null);
}

/** Spawn the helper if it isn't running. Returns it, or null if we can't. */
function ensureProc() {
  if (proc) return proc;
  if (process.platform !== 'win32') return null;

  const encoded = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64');
  let child;
  try {
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
  } catch {
    return null;
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.trim()) handleLine(line);
    }
  });
  const die = () => {
    if (proc === child) proc = null;
    stdoutBuf = '';
    flushPending();
  };
  child.on('exit', die);
  child.on('error', die);
  child.stdin.on('error', () => {}); // writing to a dead helper must not throw

  proc = child;
  return proc;
}

/** Send one request line and resolve with its payload (null on any failure). */
function request(line) {
  const child = ensureProc();
  if (!child) return Promise.resolve(null);
  const id = 'r' + ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try {
      child.stdin.write(`${id} ${line}\n`);
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve(null);
    }
  });
}

const isHwnd = (h) => /^\d+$/.test(String(h));

/**
 * Current geometry of a window, or null if it can't be read.
 * Returns { x, y, width, height, clientWidth, clientHeight } in Win32 coords.
 */
async function getWindowRect(hwnd) {
  if (!isHwnd(hwnd)) return null;
  const payload = await request(`INFO ${hwnd}`);
  if (!payload) return null;
  const n = payload.split(',').map((v) => Number(v));
  if (n.length < 6 || n.some((v) => !Number.isFinite(v))) return null;
  const [x, y, width, height, clientWidth, clientHeight] = n;
  if (width <= 0 || height <= 0) return null;
  // Minimized windows park at roughly (-32000, -32000); their rect is useless.
  if (x < -30000 || y < -30000) return null;
  return { x, y, width, height, clientWidth, clientHeight };
}

/**
 * Centre `hwnd` on the primary display and bring it to the front. `size`
 * ({ width, height }) resizes it; omit it to keep the window's current size.
 * Resolves true when the helper reported success.
 */
async function placeWindow(hwnd, size) {
  if (!isHwnd(hwnd)) return false;
  const w = Math.max(0, Math.round(Number(size && size.width) || 0));
  const h = Math.max(0, Math.round(Number(size && size.height) || 0));
  return (await request(`PLACE ${hwnd} ${w} ${h}`)) === '1';
}

/** Un-minimize `hwnd` and raise it, leaving its position and size alone. */
async function restoreWindow(hwnd) {
  if (!isHwnd(hwnd)) return false;
  return (await request(`SHOW ${hwnd}`)) === '1';
}

/**
 * Every currently minimized window, as [{ hwnd, name }]. These are exactly the
 * windows desktopCapturer refuses to list, which is why a minimized source
 * would otherwise look like one whose window has been closed.
 */
async function listMinimizedWindows() {
  const payload = await request('MINS');
  if (!payload) return []; // null = helper error, '' = nothing minimized
  let decoded;
  try {
    decoded = Buffer.from(payload, 'base64').toString('utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const record of decoded.split(REC_SEP)) {
    if (!record) continue;
    const sep = record.indexOf(FIELD_SEP);
    if (sep <= 0) continue;
    const hwnd = record.slice(0, sep);
    const name = record.slice(sep + 1);
    if (isHwnd(hwnd) && name) out.push({ hwnd, name });
  }
  return out;
}

/** Stop the helper (called on app quit). */
function shutdown() {
  const child = proc;
  proc = null;
  flushPending();
  if (!child) return;
  try {
    child.stdin.write('QUIT\n');
    child.stdin.end();
  } catch { /* already gone */ }
  child.kill();
}

module.exports = { getWindowRect, placeWindow, restoreWindow, listMinimizedWindows, shutdown };
