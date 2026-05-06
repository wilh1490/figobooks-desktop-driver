/**
 * src/server.js
 * Express HTTP API served on http://127.0.0.1:{port}
 *
 * Endpoints:
 *   GET  /status          — driver + printer + port status
 *   GET  /printers        — list discovered printers
 *   POST /bind            — save selected printer
 *   POST /print           — enqueue a print job
 *   GET  /jobs            — list recent print jobs
 *   GET  /jobs/:id        — single job status
 *   GET  /version         — driver version + name (used for duplicate-instance detection)
 *   DELETE /bind          — forget saved printer
 *   GET  /setup           — serves the setup wizard HTML (port injected via <meta>)
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const config  = require('./config');
const printer = require('./printerManager');
const queue   = require('./queue');
const winPrinterSetup = process.platform === 'win32' ? require('./winPrinterSetup') : null;
const { version, name } = require('../package.json');

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  if (/^chrome-extension:\/\//.test(origin)) return true;
  if (/^https:\/\/([a-z0-9-]+\.)*figobooks\.[a-z.]+$/i.test(origin)) return true;
  return false;
}

function createApp(port) {
  const app = express();

  // Allow localhost, the FigoBooks browser extension, and FigoBooks web apps.
  app.use(cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      console.log(`[CORS] blocked origin: ${origin || '(none)'}`);
      cb(new Error('CORS: origin not allowed'));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  }));

  app.use(express.json({ limit: '15mb' }));

  // ── Serve setup wizard UI ──────────────────────────────────────────────────
  // When bundled, __dirname points to snapshot, so look relative to process.execPath
  const isBundled = process.execPath.endsWith('.exe') && !process.execPath.includes('node.exe');
  const appRoot = isBundled ? path.dirname(process.execPath) : path.join(__dirname, '..');
  const uiPath = path.join(appRoot, 'ui');
  const assetsPath = path.join(appRoot, 'assets');
  
  app.use('/ui', express.static(uiPath));
  app.use('/assets', express.static(assetsPath));

  // ── Serve browser extension for Chrome/Edge/Brave force-install ───────────
  const EXT_DIR = path.join(os.homedir(), '.figobooks', 'extension');
  const EXT_ID_FILE = path.join(__dirname, '..', 'dist', 'extension-id.txt');

  app.get('/extension/update.xml', (_req, res) => {
    if (!fs.existsSync(EXT_DIR)) return res.status(404).send('Extension not installed');
    const extId = fs.existsSync(EXT_ID_FILE) ? fs.readFileSync(EXT_ID_FILE, 'utf8').trim() : '';
    const crxUrl = `http://127.0.0.1:${port}/extension/figobooks-extension.crx`;
    res.type('application/xml').send([
      `<?xml version='1.0' encoding='UTF-8'?>`,
      `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>`,
      `  <app appid='${extId}'>`,
      `    <updatecheck codebase='${crxUrl}' version='1.0.0' />`,
      `  </app>`,
      `</gupdate>`,
    ].join('\n'));
  });

  app.get('/extension/figobooks-extension.crx', (_req, res) => {
    const crxPath = path.join(EXT_DIR, 'figobooks-extension.crx');
    if (!fs.existsSync(crxPath)) return res.status(404).send('CRX not found');
    res.setHeader('Content-Type', 'application/x-chrome-extension');
    res.sendFile(crxPath);
  });

  app.get('/setup', (_req, res) => {
    // Inject the active port into the HTML via a <meta> tag so setup.js
    // never needs to hardcode 3838.
    const html = fs.readFileSync(path.join(uiPath, 'index.html'), 'utf8');
    const injected = html.replace(
      '<meta name="figo-port"',
      `<meta name="figo-port" content="${port}"`
    );
    res.type('html').send(injected);
  });

  // GET /close-setup — navigating here triggers window.close() in the browser.
  // window.close() is blocked by browsers unless the script itself initiates it,
  // so we serve a tiny self-closing page that does exactly that.
  app.get('/close-setup', (_req, res) => {
    res.type('html').send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body>' +
      '<script>window.close();window.location.replace("about:blank");<\/script>' +
      '</body></html>'
    );
  });

  // ── API routes ─────────────────────────────────────────────────────────────

  // GET /version  — name field used by duplicate-instance detection in main.js
  app.get('/version', (_req, res) => {
    res.json({ version, name, port });
  });

  // GET /status
  app.get('/status', (_req, res) => {
    const s   = printer.getStatus();
    const bt  = printer.getBluetoothState();
    const saved = config.get('printer');
    res.json({
      driverInstalled:   true,
      printerConnected:  s.status === 'connected' || s.status === 'printing',
      printerName:       s.printer?.name || null,
      printerType:       s.printer?.type || saved?.type || null,
      savedPrinterName:  saved?.name || null,
      status:            s.status,
      error:             s.error || null,
      port,
      bluetooth: {
        state:     bt,
        available: bt === 'poweredOn',
      },
    });
  });

  // GET /printers  — discover printers (takes up to 8 seconds)
  app.get('/printers', async (_req, res) => {
    try {
      const devices = await printer.discover(8000);
      res.json({
        bluetooth: {
          state:     printer.getBluetoothState(),
          available: printer.getBluetoothState() === 'poweredOn',
        },
        printers: devices.map(d => ({
          name:        d.name,
          type:        d.type,
          address:     d.address || d.usbId || null,
          rssi:        d.rssi        || null,
          signalLabel: d.signalLabel || null,
          // USB-only — needed by _connectUSB to call usb.findByIds()
          vendorId:    d.vendorId  || null,
          productId:   d.productId || null,
        })),
      });
    } catch (err) {
      // Return a structured error so the UI can show the right message
      const btCode = err.code || null;
      res.status(btCode ? 409 : 500).json({
        error:     err.message,
        errorCode: btCode,
        bluetooth: {
          state:     printer.getBluetoothState(),
          available: false,
        },
      });
    }
  });

  // POST /bind  { name, type, address, vendorId?, productId? }
  app.post('/bind', async (req, res) => {
    const { name, type, address, vendorId, productId } = req.body;
    if (!name || !type) {
      return res.status(400).json({ error: 'name and type are required' });
    }
    const descriptor = { name, type, address, vendorId, productId };
    try {
      await printer.connect(descriptor);
      config.set('printer', descriptor);
      res.json({ ok: true, printer: descriptor });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /install-windows-printer  { vendorId, productId }
  // Auto-installs a USB printer in Windows (requires admin rights)
  app.post('/install-windows-printer', async (req, res) => {
    if (process.platform !== 'win32') {
      return res.status(400).json({ error: 'This endpoint only works on Windows' });
    }
    
    const { vendorId, productId } = req.body;
    if (!vendorId || !productId) {
      return res.status(400).json({ error: 'vendorId and productId are required' });
    }
    
    // Check admin rights first
    const adminCheck = winPrinterSetup.checkAdminRights();
    if (!adminCheck.hasAdmin) {
      return res.status(403).json({ 
        error: adminCheck.message,
        needsAdmin: true,
      });
    }
    
    try {
      const result = await winPrinterSetup.autoInstallUsbPrinter(
        Number(vendorId),
        Number(productId)
      );
      
      if (result.success) {
        res.json({ 
          ok: true, 
          printerName: result.printerName, 
          port: result.port,
          message: `Printer installed successfully on ${result.port}. Please scan again to connect.`,
        });
      } else {
        res.status(500).json({ error: result.error });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /bind
  app.delete('/bind', async (_req, res) => {
    await printer.disconnect();
    config.remove('printer');
    res.json({ ok: true });
  });

  // POST /print  { type: 'receipt'|'label'|'test', data: {} }
  app.post('/print', (req, res) => {
    const { type, data } = req.body;
    if (!type) return res.status(400).json({ error: 'type is required' });
    try {
      const jobId = queue.enqueue(type, data || {});
      res.json({ ok: true, jobId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /jobs
  app.get('/jobs', (_req, res) => {
    res.json({ jobs: queue.getJobs() });
  });

  // GET /jobs/:id
  app.get('/jobs/:id', (req, res) => {
    const job = queue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  // 404 fallback
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

module.exports = { createApp };
