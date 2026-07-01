# ScreenDeck

A driver-free **screen-share source switcher** for **Windows & macOS**. Pre-define
several "shareable screens" — each bound to a window, a region of a window, or a
region of a display — and flip between them with global hotkeys **without touching
your meeting's share picker**.

## How it works

You share **one** window in your meeting: the **ScreenDeck Output** window.
ScreenDeck paints whichever shareable screen is *active* into that window, and
hotkeys (Ctrl+F1, Ctrl+F2, …) swap the active one instantly. To your audience,
the shared window simply changes content — no "stop share / pick new window"
dance.

```
PowerPoint ─┐
Browser ────┤→  ScreenDeck (captures + crops)  →  Output window  →  shared in Zoom/Teams/Meet
VS Code ────┘        ▲ Ctrl+F1 / F2 / F3 switch which one is shown
```

## Run it

Requires [Node.js](https://nodejs.org) (18+).

```bash
cd j:\code\sonar\screen-sharing
npm install      # downloads Electron (~once)
npm start
```

Three windows open: **Control** (configure here), **Output** (share this one),
and **Deck** (a small floating switcher).

## Build an installer

Produces redistributable apps via [electron-builder](https://www.electron.build).
Output lands in `dist/`.

```bash
npm run dist        # build for the current OS
npm run dist:win    # Windows: NSIS installer  ->  dist/ScreenDeck Setup <ver>.exe
npm run dist:mac    # macOS:  .dmg + .zip   (must be run ON a Mac)
npm run pack        # unpacked app (no installer) — quick to test
```

Notes:
- A Windows `.exe` is built **on Windows**; a macOS `.dmg` must be built **on a
  Mac** (Apple's toolchain can't be cross-built from Windows).
- The Windows scripts first run [scripts/prepare-build.js](scripts/prepare-build.js),
  which pre-populates electron-builder's `winCodeSign` cache **without** the macOS
  symlinks it bundles. Those symlinks otherwise fail to extract on Windows unless
  you have admin rights or Developer Mode ("Cannot create symbolic link: A
  required privilege is not held"). With this, `npm run dist:win` works on a plain
  user account. (Alternatively, enable *Settings → Privacy & Security → For
  developers → Developer Mode* and build normally.)
- Builds are **unsigned** by default. On macOS, Gatekeeper will require a
  right-click → **Open** the first time. For a smooth, no-prompt experience,
  code-sign/notarize the Mac build.
- Drop `build/icon.ico` (Windows) and `build/icon.icns` (macOS) to brand the app;
  without them the default Electron icon is used.

## macOS setup

1. The first time you capture, macOS will block it until you grant **Screen
   Recording** permission: *System Settings → Privacy & Security → Screen
   Recording* → enable **ScreenDeck**, then **relaunch the app**. Control shows a
   banner with an **Open settings** shortcut until this is done.
2. Default hotkeys on macOS are **Control+Option+1/2/3…** (⌘ and the F-keys are
   reserved by macOS). Rebind any in Control; conflicts are reported there.
3. Minimized windows can't be captured on macOS (occluded-but-open ones are
   fine).

## The Deck (quick switcher)

A compact, always-on-top window with one large button per shareable screen —
each showing a **preview**, the **title**, and its **hotkey**. Click a button to
switch the Output to that screen (an alternative to the global hotkeys). It's
**frameless**: drag the top strip to move it, drag any edge to resize, and the
button grid reflows responsively to whatever size you choose. The 📌 pin toggles
always-on-top; its position/size are remembered. Reopen it any time with
**Open Deck** in Control.

## Set up your shareable screens

1. In **Control**, click **+ Add**.
2. Give it a **Name** (e.g. "PowerPoint").
3. Click the **Hotkey** field and press your combo (e.g. `Ctrl + F1`).
4. Under **Capture target**, click the window or display you want. Use
   **↻ Refresh list** if a window isn't showing yet.
5. (Optional) **Region** — drag a rectangle over the preview to share just part
   of the window/display, or click **Use whole target**.
6. Repeat for Browser (Ctrl+F2), VS Code (Ctrl+F3), etc.

## Use it in a call

1. In Zoom/Teams/Meet choose **Share → Window** and pick
   **"ScreenDeck — SHARE THIS WINDOW"**.
2. Press your hotkeys any time (even while another app is focused) to switch
   what your audience sees.
3. The Output window has **no title bar by default** for a clean share. Drag
   the thin strip at its top edge to move it (a faint "drag to move" hint shows
   on hover, never in the shared picture); resize from the window edges. Toggle
   **Output: frame ✓/✗** in Control to show/hide the OS title bar;
   **Output: on top ✓** keeps it above other windows.

## Settings

Saved automatically to `config.json` in your per-user app-data folder
(`%APPDATA%\screendeck\config.json` on Windows,
`~/Library/Application Support/screendeck/config.json` on macOS). Use
**Save… / Load…** to back up or move your setup. Windows are re-bound on the
next launch by matching the remembered window title / display, so your hotkeys
keep working across sessions.

## Notes & limits

- On Windows, capture uses Windows Graphics Capture; on macOS, ScreenCaptureKit.
  Background/occluded windows capture fine on both. A few **DRM/protected**
  windows may capture as black (an OS limitation).
- If a window's title changes a lot (some apps append the document name), the
  re-bind match may miss; just **Refresh** and reselect it.
- No audio capture and no virtual-camera device yet. Those can be added later.
