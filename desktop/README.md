# JEVsnap for Linux and Windows

Electron + TypeScript. Tray app with a global hotkey, region selection overlay, bundled Tesseract OCR
(no downloads, works offline), and the same detection pipeline as the macOS app.

## Run from source

Requires Node 20+.

```bash
git clone https://github.com/brainstormity/JEVsnap.git
cd JEVsnap/desktop
npm ci
npm start            # builds and launches
npm test             # 90+ tests incl. real OCR on a fixture screenshot
npm run dist         # installers in release/: AppImage + deb (Linux), NSIS + portable exe (Windows)
```

Default hotkey: **Ctrl+Shift+6** (change it in Settings). Drag to select a region, Esc or right-click cancels.
Tray menu: capture region / full screen, reveal last, open folder, settings. On Windows, left-clicking the
tray icon captures a region.

## Settings

General (screenshots folder with `Redacted/` and `Not Redacted/`, clipboard, notifications,
hotkey recorder, launch at login), API (key, models, base URL, test connection), Detection (per-detector
toggles, QR codes, custom phrases/regexes, allowlist, padding), AI (text check policy and sensitivity,
optional Box visual check). Settings live in the app's user-data folder; the API key is encrypted with the OS
keystore (Windows DPAPI, Linux libsecret/KWallet). With no keystore the key is kept in memory only; or set
`TYPESAFE_API_KEY`.

Original captures stay in memory and are never saved. Once processing succeeds, only the processed PNG is
saved: `Redacted/` when regions were hidden, or `Not Redacted/` when no redactions were needed.

## Known limits and troubleshooting

- **OCR speed:** Tesseract runs on CPU: expect a few seconds per capture (more on a full 4K screen). It runs on a
  worker thread so the app stays responsive.
- **Wayland:** screen capture goes through the PipeWire portal (a permission prompt) and global hotkeys often do
  not work. X11 / XWayland is recommended; use the tray menu as a fallback.
- **GNOME has no tray by default:** install the AppIndicator extension, or just relaunch JEVsnap to open Settings.
- **AppImage on Ubuntu 24.04+:** AppArmor blocks Chromium's sandbox; run with `--no-sandbox` or use the `.deb`.
- **Windows:** the exe is unsigned, so SmartScreen warns on first run ("More info" then "Run anyway").
- No local face detection on this platform; use the optional visual check with a "face" target.
- Multi-monitor and mixed-DPI selection are implemented but only tested on a single virtual display.

## Layout

`src/core` platform-independent logic (detectors, Jev client, engine) · `src/pipeline` OCR, QR, PNG, worker
thread · `src/main` Electron main process · `src/renderer` settings and overlay pages · `test/` unit + integration.
