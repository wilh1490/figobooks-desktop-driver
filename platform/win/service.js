/**
 * platform/win/service.js
 * Installs / uninstalls the FigoBooks driver as a Windows Service.
 * Requires: npm install node-windows
 * Usage:
 *   node platform/win/service.js install
 *   node platform/win/service.js uninstall
 */

'use strict';

const path = require('path');
const SCRIPT_PATH = path.resolve(__dirname, '..', '..', 'main.js');

let Service;
try {
  Service = require('node-windows').Service;
} catch {
  console.error('[Windows Service] node-windows is not installed.');
  console.error('Run: npm install node-windows');
  process.exit(1);
}

const svc = new Service({
  name:        'FigoBooks Printer Driver',
  description: 'Local printer bridge for the FigoBooks web app.',
  script:      SCRIPT_PATH,
  env: [{
    name:  'NODE_ENV',
    value: 'production',
  }],
});

svc.on('install', () => {
  svc.start();
  console.log('[Windows Service] Installed and started.');
  console.log('[Windows Service] Setup wizard: http://127.0.0.1:3838/setup');
});

svc.on('uninstall', () => {
  console.log('[Windows Service] Uninstalled successfully.');
});

svc.on('error', (err) => {
  console.error('[Windows Service] Error:', err);
});

const cmd = process.argv[2];
if (cmd === 'uninstall') {
  svc.uninstall();
} else if (cmd === 'install') {
  svc.install();
} else {
  console.log('Usage: node platform/win/service.js [install|uninstall]');
}
