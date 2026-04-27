/**
 * FigoBooks Printer Driver — main.js
 * Entry point: starts the HTTP API server and opens the setup wizard
 * on first run (no printer configured yet).
 */

'use strict';

const path    = require('path');
const http    = require('http');
const net     = require('net');
const config  = require('./src/config');
const server  = require('./src/server');
const printer = require('./src/printerManager');
const queue   = require('./src/queue');
const deeplink = require('./src/deeplink');
const tray    = require('./src/tray');
const winInstaller = require('./platform/win/installer');

const PREFERRED_PORT = 3838;
const PORT_RANGE     = 10; // try 3838–3847

/**
 * Check if a port is free on 127.0.0.1.
 * Resolves true if free, false if in use.
 */
function isPortFree(port) {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
}

/**
 * Check if the process already running on a given port is another
 * FigoBooks driver instance (responds to GET /version with our name).
 */
async function isFigoInstance(port) {
  return new Promise(resolve => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/version', timeout: 1500 },
      res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json.name === 'figo-mac-driver');
          } catch { resolve(false); }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Find a free port, starting from PREFERRED_PORT.
 * If the preferred port is occupied by another FigoBooks instance, exit
 * immediately (no reason to start a duplicate daemon).
 */
async function resolvePort() {
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + PORT_RANGE; p++) {
    const free = await isPortFree(p);
    if (free) {
      return p;
    }
    // Port in use — check if it's us
    if (p === PREFERRED_PORT) {
      const isSelf = await isFigoInstance(p);
      if (isSelf) {
        process.exit(0);
      }
    }
  }
  throw new Error(
    `No free port found in range ${PREFERRED_PORT}–${PREFERRED_PORT + PORT_RANGE - 1}. ` +
    'Stop other processes using those ports and try again.'
  );
}

async function main() {
  const installFlow = winInstaller.maybeHandleInstallFlow();
  if (installFlow.handled) {
    process.exit(installFlow.exitCode || 0);
    return;
  }

  queue.init();

  // Resolve which port to bind
  const PORT = await resolvePort();

  // Persist the active port so other tools (e.g. the installer) can read it
  config.set('port', PORT);

  // Try to reconnect to the last saved printer on startup
  const savedPrinter = config.get('printer');
  if (savedPrinter) {
    printer.connect(savedPrinter).catch(() => {});
  }

  // Auto-reconnect: retry every 15 s whenever the printer goes offline
  printer.startAutoReconnect(() => config.get('printer'));

  // Start the HTTP API server
  const app = server.createApp(PORT);
  const httpServer = http.createServer(app);

  httpServer.listen(PORT, '127.0.0.1', async () => {
    // Register the figoprint:// deep link handler
    deeplink.register();

    // Start optional tray icon (requires systray2 to be installed)
    tray.init(PORT);

    // If no printer is configured yet, open setup wizard in the browser
    if (!savedPrinter) {
      const { default: open } = await import('open');
      open(`http://127.0.0.1:${PORT}/setup`);
    }
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') process.exit(1);
    throw err;
  });

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);

  function shutdown() {
    printer.disconnect();
    httpServer.close(() => process.exit(0));
  }
}

main().catch(() => process.exit(1));
