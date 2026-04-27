/**
 * src/tray.js
 * Optional macOS / Windows system tray icon.
 *
 * This file is NOT required for the daemon to function — the core API
 * runs fine without a tray. This is loaded only when `menubar` or
 * `systray2` is available (optional dependency).
 *
 * Tray icon assets used:
 *   assets/tray-icon-22.png       — light mode (macOS, @1x)
 *   assets/tray-icon-44.png       — light mode (macOS, @2x Retina)
 *   assets/tray-icon-22-white.png — dark mode  (macOS, @1x)
 *   assets/tray-icon-44-white.png — dark mode  (macOS, @2x Retina)
 *
 * Usage in main.js (optional):
 *   const tray = require('./src/tray');
 *   tray.init(PORT);
 *
 * NOTE: Full tray support requires either:
 *   - Running inside Electron (use nativeImage + Tray from 'electron')
 *   - The `systray2` npm package for a pure-Node menu bar icon
 *
 * The implementation below targets `systray2`. Install it optionally:
 *   npm install systray2
 */

'use strict';

const path    = require('path');
const printer = require('./printerManager');

let _tray    = null;
let _port    = 3838;
let _SysTray = null;

try {
  _SysTray = require('systray2').default;
} catch {
  // systray2 not installed — tray is silently unavailable
}

function init(port) {
  if (!_SysTray) return;

  _port = port;
  _build();
}

function _build() {
  const status  = printer.getStatus();
  const isReady = status.status === 'connected';
  const iconPath = _resolveIcon(isReady);

  _tray = new _SysTray({
    menu: {
      icon:    iconPath,
      title:   '',
      tooltip: 'FigoBooks Printer Driver',
      items: [
        {
          title:   isReady
            ? `✓  ${status.printer?.name || 'Printer'} — Ready`
            : '⚠  No printer connected',
          enabled: false,
        },
        { title: 'separator' },
        { title: '⚙  Open Setup Wizard',  enabled: true },
        { title: '🔄  Reconnect Printer',  enabled: true },
        { title: 'separator' },
        { title: '✕  Quit FigoBooks Driver', enabled: true },
      ],
    },
    debug:   false,
    copyDir: true,
  });

  _tray.onClick((action) => {
    const item = action.item?.title || '';
    if (item.includes('Setup Wizard')) {
      import('open').then(({ default: open }) => open(`http://127.0.0.1:${_port}/setup`));
    } else if (item.includes('Reconnect')) {
      const saved = require('./config').get('printer');
      if (saved) printer.connect(saved).catch(() => {});
      _refresh();
    } else if (item.includes('Quit')) {
      _tray.kill();
      process.exit(0);
    }
  });

  // Refresh icon when printer status changes
  printer.on('status', () => _refresh());
}

function _refresh() {
  if (!_tray) return;
  _tray.kill();
  _build();
}

/**
 * Pick the right tray icon based on printer state and system appearance.
 * Returns the absolute path to the PNG.
 */
function _resolveIcon(isReady) {
  // On macOS, prefer white icon (works as template image in both light+dark)
  // On Windows, use the blue branded icon
  const isMac = process.platform === 'darwin';
  const base  = isMac ? 'tray-icon-22-white.png' : 'tray-icon-22.png';
  return path.resolve(__dirname, '..', 'assets', base);
}

module.exports = { init };
