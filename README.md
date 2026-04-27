# FigoBooks Printer Driver

A lightweight background service that bridges the **FigoBooks web app** to Bluetooth and USB thermal printers via a local HTTP API on `http://127.0.0.1:3838`.

---

## How it works

```
FigoBooks Web App  ──→  POST http://127.0.0.1:3838/print  ──→  Thermal Printer
                        (running silently in background)
```

- Runs as a **macOS LaunchAgent** (auto-starts on login, no Dock icon)
- Exposes a simple REST API consumed by the FigoBooks web app
- Opens a **5-screen setup wizard** in your browser on first run
- Deep link support: `figoprint://print?id=INV203`

---

## Quick start (development)

```bash
# Install dependencies (also auto-generates icon assets)
npm install

# Run the driver
npm start
# → API ready at http://127.0.0.1:3838
# → Setup wizard opens automatically at http://127.0.0.1:3838/setup
```

> **Requires:** Node.js 18+ and Python 3 + Pillow (`pip install Pillow`) for icon generation.

---

## Install as background service

### macOS (LaunchAgent)

```bash
node platform/mac/install.js
# → Daemon running silently, starts on every login
# → Uninstall: node platform/mac/install.js uninstall
```

Or via npm:
```bash
npm run install-service:mac
npm run uninstall-service:mac
```

**Logs:** `~/.figobooks/logs/driver.log`

### Windows (Recommended user flow)

1. Download `figo-driver-win.exe`.
2. Double-click once.
3. The app self-installs to `%LOCALAPPDATA%\\FigoBooks Driver`, adds auto-start,
   and creates Start Menu + Desktop shortcuts.

To uninstall, use **Apps & features** (FigoBooks Printer Driver) or run:

```bash
figo-driver-win.exe --uninstall
```

### Windows (advanced service mode)

```bash
# Requires: npm install node-windows
npm run install-service:win
npm run uninstall-service:win
```

---

## Build a distributable installer

Produces a double-click installer — no Node.js runtime needed on the target machine.

```bash
# macOS — builds dist/FigoBooks-Driver.pkg
npm run build:pkg:mac

# Windows — builds dist/figo-driver-win.exe  (run on Windows or via GitHub Actions)
npm run build:win
```

> Requires Node.js 20+.

### Legacy: Node SEA binary only (no installer)

```bash
# macOS (arm64 or x64 — matches whatever arch you build on)
npm run build:mac
# → dist/figo-driver-macos

# Windows
npm run build:win
# → dist/figo-driver-win.exe
```

---

## API reference

All endpoints are served on `http://127.0.0.1:3838` and only accessible from localhost.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/status` | Driver + printer + Bluetooth status |
| `GET` | `/printers` | Discover nearby printers (BLE + USB, ~8 s) |
| `POST` | `/bind` | Save selected printer `{ name, type, address }` |
| `DELETE` | `/bind` | Forget saved printer |
| `POST` | `/print` | Enqueue a print job `{ type, data }` |
| `GET` | `/jobs` | List recent print jobs |
| `GET` | `/jobs/:id` | Single job status |
| `GET` | `/version` | Driver version |
| `GET` | `/setup` | Setup wizard UI |

### `GET /status` response

```json
{
  "driverInstalled": true,
  "printerConnected": true,
  "printerName": "XPrinter 80",
  "status": "connected",
  "error": null,
  "bluetooth": {
    "state": "poweredOn",
    "available": true
  }
}
```

### `POST /print` request

```json
{ "type": "receipt", "data": {
    "businessName": "Figo Store",
    "invoiceNumber": "INV-042",
    "date": "2026-03-06",
    "items": [
      { "name": "Rice (5kg)", "qty": 2, "price": 4500 }
    ],
    "total": 9000,
    "note": "Thank you!"
}}
```

Supported types: `receipt` · `label` · `test`

---

## Deep link (figoprint://)

Register `figoprint://` as a URL scheme so the web app or WhatsApp can trigger prints:

```
figoprint://print?id=INV042&type=receipt
figoprint://setup
figoprint://status
```

On macOS the driver registers this automatically via the LaunchAgent plist.

---

## Optional: menu bar icon

Install `systray2` to show a status icon in the macOS/Windows menu bar:

```bash
npm install systray2
```

The driver detects it and shows the FigoBooks icon automatically. Without it, the driver runs headless with no visual indicator (still fully functional).

---

## Project structure

```
figo-mac-driver/
├── main.js                       ← daemon entry point
├── package.json
├── src/
│   ├── config.js                 ← settings persisted to ~/.figobooks/
│   ├── server.js                 ← Express API on localhost:3838
│   ├── printerManager.js         ← BLE + USB discovery, Bluetooth state checks
│   ├── escpos.js                 ← ESC/POS receipt / label builder
│   ├── queue.js                  ← serial print queue (prevents overlaps)
│   ├── deeplink.js               ← figoprint:// handler
│   └── tray.js                   ← optional system tray icon
├── ui/
│   ├── index.html                ← 5-screen setup wizard
│   ├── style.css
│   └── setup.js
├── assets/
│   ├── gen_icons.py              ← generates all icon sizes from source PNGs
│   ├── logo-blue.png             ← source brand asset
│   ├── logo-white.png
│   ├── wordmark-blue.png
│   └── wordmark-white.png        ← generated icons ignored by .gitignore
└── platform/
    ├── mac/
    │   ├── install.js            ← LaunchAgent installer / uninstaller
    │   ├── build.js              ← Node SEA binary builder
    │   └── com.figobooks.driver.plist  ← LaunchAgent template
    └── win/
        ├── service.js            ← Windows Service installer
        └── build.js              ← Node SEA binary builder (Windows)
```

---

## Bluetooth & printer range

- The driver **checks Bluetooth is on** before scanning. If it is off, the setup wizard shows a clear "Turn on Bluetooth" message with instructions.
- Printers are required to be within **~10 m** (−80 dBm RSSI minimum). Devices beyond this threshold are filtered out automatically.
- Each discovered device shows a signal strength label: **Excellent / Good / Fair**.

---

## Regenerating icons

If brand assets change, regenerate all icon sizes:

```bash
python3 assets/gen_icons.py
```

This is also run automatically on `npm install`.
