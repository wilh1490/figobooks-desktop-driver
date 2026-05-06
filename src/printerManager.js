/**
 * src/printerManager.js
 * Discovers BLE, USB, and Network thermal printers, manages connection state,
 * and exposes a unified interface for sending raw bytes to the printer.
 */

'use strict';

const EventEmitter = require('events');
const net = require('net');
const dgram = require('dgram');
const emitter = new EventEmitter();

// Network printer port (raw ESC/POS)
const PRINTER_PORT = 9100;

// Current connection state
let _state = {
  status: 'disconnected',  // connected | disconnected | printing | error
  printer: null,           // { name, type, address/usbId }
  error: null,
};

// Active connection reference
let _connection = null;
let _genericSerialPortInstance = null;

// Cache of noble peripheral objects from the last scan, keyed by peripheral.id
const _bleCache = new Map();

let _btState = 'unknown';

// Last printer that was explicitly disconnected/forgotten (descriptor snapshot).
// macOS Core Bluetooth suppresses recently-disconnected peripherals from scan
// results for up to ~60 s, so we inject them from _bleCache as a fallback.
let _lastForgottenBLE = null;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Discover nearby printers via BLE, USB, network, and serial.
 * Returns a promise that resolves with an array of discovered devices.
 */
async function discover(timeoutMs = 8000) {
  const found = [];

  const [bleDevices, usbDevices, networkDevices, serialDevices] = await Promise.allSettled([
    _discoverBLE(timeoutMs),
    _discoverUSB(),
    _discoverNetwork(timeoutMs),
    _discoverSerial(),
  ]);

  if (bleDevices.status === 'fulfilled') found.push(...bleDevices.value);
  if (usbDevices.status === 'fulfilled') found.push(...usbDevices.value);
  if (networkDevices.status === 'fulfilled') found.push(...networkDevices.value);
  if (serialDevices.status === 'fulfilled') found.push(...serialDevices.value);

  // Currently-connected BLE printer stops advertising, so inject from cache.
  const currentPrinter = _state.printer;
  if (currentPrinter && (currentPrinter.type === 'ble' || currentPrinter.type === 'y50')) {
    const alreadyInList = found.some(d => d.address === currentPrinter.address);
    if (!alreadyInList) {
      const cached = _bleCache.get(currentPrinter.address);
      found.unshift({
        type:        currentPrinter.type,
        name:        currentPrinter.name,
        address:     currentPrinter.address,
        rssi:        cached?.rssi ?? null,
        signalLabel: cached ? _rssiLabel(cached.rssi ?? -60) : 'Connected',
        _peripheral: cached ?? null,
      });
    }
  }

  // Recently-forgotten BLE printer: macOS suppresses it from scan results for
  // up to ~60 s after disconnect.  Inject directly so it still appears.
  if (_lastForgottenBLE && (_lastForgottenBLE.type === 'ble' || _lastForgottenBLE.type === 'y50')) {
    const alreadyInList = found.some(d => d.address === _lastForgottenBLE.address);
    if (!alreadyInList && _lastForgottenBLE._peripheral) {
      found.push({
        type:        _lastForgottenBLE.type,
        name:        _lastForgottenBLE.name,
        address:     _lastForgottenBLE.address,
        rssi:        null,
        signalLabel: 'Recently used',
        _peripheral: _lastForgottenBLE._peripheral,
      });
    }
  }

  return found;
}

/**
 * Connect to a printer descriptor returned by discover().
 */
async function connect(printerDescriptor) {
  // Full teardown of any existing connection before establishing the new one.
  // This signals the old printer to go idle (LED blue → green) and properly
  // closes USB / BLE links — matching what DELETE /bind does.
  // It's safe to call disconnect() here because scanning has already happened
  // before connect() is called, so the target peripheral is already in
  // _bleCache and doesn't need to be re-discovered.
  await disconnect();

  // Bust the GATT cache for the new target in case a stale characteristic
  // survives from a prior session.
  if (printerDescriptor.address) _bleCharCache.delete(printerDescriptor.address);

  try {
    if (printerDescriptor.type === 'network') {
      _connection = await _connectNetwork(printerDescriptor);
    } else if (printerDescriptor.type === 'ble') {
      _connection = await _connectBLE(printerDescriptor);
    } else if (printerDescriptor.type === 'usb') {
      _connection = await _connectUSB(printerDescriptor);
    } else if (printerDescriptor.type === 'serial') {
      _connection = await _connectSerial(printerDescriptor);
    } else if (printerDescriptor.type === 'y50') {
      _connection = await _connectY50(printerDescriptor);
    } else {
      throw new Error(`Unknown printer type: ${printerDescriptor.type}`);
    }

    const transport = _connection?.type || printerDescriptor.type;
    _setState('connected', { ...printerDescriptor, transport });
    // Clear the forgotten-BLE record once we've successfully connected to
    // any printer — it's no longer needed as a discover() fallback.
    _lastForgottenBLE = null;
  } catch (err) {
    _setState('error', printerDescriptor, err.message);
    throw err;
  }
}

/**
 * Send raw bytes to the connected printer.
 */
async function send(buffer) {
  if (_state.status !== 'connected' && _state.status !== 'printing') {
    throw new Error('No printer connected');
  }
  _setState('printing', _state.printer);
  try {
    await _writeBytes(buffer);
    _setState('connected', _state.printer);
  } catch (err) {
    _setState('error', _state.printer, err.message);
    throw err;
  }
}

async function disconnect() {
  // Snapshot the printer descriptor before we wipe state.
  const dyingPrinter = _state.printer ? { ..._state.printer } : null;

  let blePeripheral = null;

  if (_connection?.type === 'network') {
    // Network printer - close TCP socket
    try { 
      _connection.socket?.removeAllListeners();
      _connection.socket?.destroy(); 
    } catch {}
  } else if (_connection?.type === 'y50') {
    blePeripheral = _connection.ble;
    try { if (_connection.ble) _connection.ble.removeAllListeners('disconnect'); } catch {}
    // Close serial connection (serialport lib or fd)
    if (_connection.serial === 'serialport' && _serialPortInstance) {
      try { _serialPortInstance.close(); } catch {}
      _serialPortInstance = null;
    } else if (_connection.serial != null && typeof _connection.serial === 'number') {
      try { const fs = require('fs'); fs.closeSync(_connection.serial); } catch {}
    }
    if (dyingPrinter?.address) _bleCharCache.delete(dyingPrinter.address);
  } else if (_connection?.type === 'serial') {
    if (_genericSerialPortInstance) {
      try { _genericSerialPortInstance.close(); } catch {}
      _genericSerialPortInstance = null;
    }
  } else {
    if (_connection) {
      try { _connection.removeAllListeners?.('disconnect'); } catch {}
      // For USB, close it; for BLE, we'll disconnect below with a proper await
      if (_connection.state !== undefined) {
        // It's a noble peripheral (BLE)
        blePeripheral = _connection;
      } else {
        // USB
        try { if (typeof _connection.close === 'function') _connection.close(); } catch {}
      }
    }
    if (dyingPrinter?.address) _bleCharCache.delete(dyingPrinter.address);
  }

  // Store peripheral for _lastForgottenBLE before we disconnect it
  if (dyingPrinter && (dyingPrinter.type === 'ble' || dyingPrinter.type === 'y50')) {
    _lastForgottenBLE = { ...dyingPrinter, _peripheral: blePeripheral };
  }

  // Actually disconnect BLE and wait for it to complete
  if (blePeripheral && blePeripheral.state === 'connected') {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(), 2000);
      blePeripheral.once('disconnect', () => { clearTimeout(timeout); resolve(); });
      try { blePeripheral.disconnect(); } catch { clearTimeout(timeout); resolve(); }
    });
  }

  _connection = null;
  _setState('disconnected');
}

function getStatus() {
  return { ..._state };
}

function on(event, listener) {
  emitter.on(event, listener);
}

/** Returns the current Bluetooth adapter state string */
function getBluetoothState() {
  return _btState;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function _setState(status, printer = null, error = null) {
  _state = { status, printer, error };
  emitter.emit('status', _state);
}

const BLE_EXACT_NAMES  = ['mpt-ii'];
const Y50_PREFIX       = 'y50';
const BLE_NAME_KEYWORDS = [
  'printer', 'thermal', 'pos', 'receipt', 'escpos',
  'xprinter', 'xp-', 'pt-', 'mpt', 'rpp', 'btp', '58', '80',
];

const MIN_RSSI = -80;

async function _discoverBLE(timeoutMs) {
  return new Promise((resolve, reject) => {
    let noble;
    try {
      noble = require('@abandonware/noble');
    } catch {
      return resolve([]);
    }

    const found = [];
    const seen  = new Set();
    let   scanStarted = false;

    // ── Check / wait for Bluetooth adapter to be ready ───────────────────────
    function onStateChange(state) {
      _btState = state;
      emitter.emit('btState', state);

      if (state === 'poweredOn') {
        if (!scanStarted) {
          scanStarted = true;
          noble.startScanning([], true);
        }
      } else if (state === 'poweredOff') {
        cleanup();
        const err = new Error('Bluetooth is turned off. Please enable Bluetooth and try again.');
        err.code = 'BT_OFF';
        reject(err);
      } else if (state === 'unauthorized') {
        cleanup();
        const err = new Error(
          'Bluetooth access denied. Please grant Bluetooth permission in ' +
          'System Settings → Privacy & Security → Bluetooth.'
        );
        err.code = 'BT_UNAUTHORIZED';
        reject(err);
      } else if (state === 'unsupported') {
        cleanup();
        const err = new Error('This device does not support Bluetooth.');
        err.code = 'BT_UNSUPPORTED';
        reject(err);
      }
      // 'resetting' — adapter is recovering; wait for next stateChange
    }

    // ── Collect nearby thermal printers, filter by keyword + RSSI ────────────
    function onDiscover(peripheral) {
      const name    = (peripheral.advertisement.localName || '').toLowerCase();
      const rssi    = typeof peripheral.rssi === 'number' ? peripheral.rssi : -999;
      const inRange = rssi >= MIN_RSSI;

      if (!inRange) return;

      const isThermal =
        BLE_EXACT_NAMES.includes(name) ||
        name.startsWith(Y50_PREFIX) ||
        BLE_NAME_KEYWORDS.some(k => name.includes(k));
      if (isThermal && !seen.has(peripheral.id)) {
        seen.add(peripheral.id);
        _bleCache.set(peripheral.id, peripheral);
        const rawName = peripheral.advertisement.localName || peripheral.id;
        const isY50   = rawName.toLowerCase().startsWith(Y50_PREFIX);

        if (isY50) {
          const key = 'y50-dedup';
          if (!seen.has(key)) {
            seen.add(key);
            found.push({
              type:        'y50',
              name:        rawName.toUpperCase(),		// use actual advertised name
              address:     peripheral.id,
              rssi,
              signalLabel: _rssiLabel(rssi),
              _peripheral: peripheral,
            });
          } else {
            const existing = found.find(e => e.type === 'y50');
            if (existing && rawName.toLowerCase().endsWith('_ble')) {
              existing.address    = peripheral.id;
              existing._peripheral = peripheral;
              _bleCache.set(peripheral.id, peripheral);
            }
          }
        } else {
          const displayName = rawName;
          found.push({
            type:        'ble',
            name:        displayName,
            address:     peripheral.id,
            rssi,
            signalLabel: _rssiLabel(rssi),
            _peripheral: peripheral,
          });
        }
      }
    }

    function cleanup() {
      noble.removeListener('stateChange', onStateChange);
      noble.removeListener('discover',    onDiscover);
      try { noble.stopScanning(); } catch {}
    }

    noble.on('stateChange', onStateChange);
    noble.on('discover',    onDiscover);

    // If noble already knows the state (adapter already initialised), trigger now
    if (noble.state && noble.state !== 'unknown') {
      onStateChange(noble.state);
    }

    // ── Stop scanning after timeout regardless ───────────────────────────────
    setTimeout(() => {
      cleanup();
      resolve(found);
    }, timeoutMs);
  });
}

/** Map RSSI dBm value to a human-readable signal label */
function _rssiLabel(rssi) {
  if (rssi >= -50) return 'Excellent';
  if (rssi >= -65) return 'Good';
  if (rssi >= -80) return 'Fair';
  return 'Weak';
}

async function _discoverWindowsUsbPrinters() {
  if (process.platform !== 'win32') return [];
  const { execFile } = require('child_process');

  return new Promise((resolve) => {
    execFile('wmic', ['printer', 'get', 'Name,PortName', '/format:csv'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const printers = [];
      const seen = new Set();

      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || /^Node,/i.test(trimmed)) continue;
        const parts = trimmed.split(',');
        const portName = parts.pop();
        const name = parts.slice(1).join(',') || parts[0] || '';
        const match = name.match(/([0-9a-f]{4}):([0-9a-f]{4})/i);
        if (!/^USB0*\d+$/i.test(String(portName || '')) && !match) continue;

        const vendorId = match ? parseInt(match[1], 16) : null;
        const productId = match ? parseInt(match[2], 16) : null;
        const key = `${name}:${portName}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const knownName = (vendorId && productId) ? _getKnownPrinterName(vendorId, productId) : null;
        printers.push({
          type: 'usb',
          name: knownName || name || `Windows USB Printer (${portName})`,
          address: vendorId != null && productId != null ? `${vendorId}:${productId}` : null,
          usbId: vendorId != null && productId != null ? `${vendorId}:${productId}` : null,
          vendorId,
          productId,
          portName,
        });
      }

      resolve(printers);
    });
  });
}

function _getKnownPrinterName(vendorId, productId) {
  // Map known printer models by VID:PID
  const knownModels = {
    '5958:0150': 'Y50',
    '09c5:0386': '380Pro',
    '09c5:0387': '380Pro',
    '09c5:0388': '380Pro',
  };
  
  const vid = vendorId.toString(16).padStart(4, '0').toLowerCase();
  const pid = productId.toString(16).padStart(4, '0').toLowerCase();
  const key = `${vid}:${pid}`;
  
  return knownModels[key] || null;
}

async function _discoverUSB() {
  let usb;
  try {
    usb = require('usb');
  } catch {
    return _discoverWindowsUsbPrinters();
  }

  // Accept devices that expose printer-class interfaces (class 7). On Windows,
  // some printers cannot be opened for probing due to driver ownership, so we
  // also inspect config descriptors without opening and keep likely candidates.
  const devices = usb.getDeviceList();
  const printers = [];

  for (const d of devices) {
    const vid = d.deviceDescriptor.idVendor.toString(16).padStart(4, '0');
    const pid = d.deviceDescriptor.idProduct.toString(16).padStart(4, '0');
    let hasPrinterIface = false;

    try {
      d.open();
      hasPrinterIface = d.interfaces.some(i => i.descriptor.bInterfaceClass === 7);
      d.close();
    } catch {
      // Device busy/permission denied; try passive descriptor inspection below.
    }

    if (!hasPrinterIface) {
      try {
        const cfg = d.configDescriptor;
        if (cfg?.interfaces?.length) {
          hasPrinterIface = cfg.interfaces.some(altList =>
            Array.isArray(altList) && altList.some(alt => alt.bInterfaceClass === 7)
          );
        }
      } catch {}
    }

    if (!hasPrinterIface) {
      // Last-resort heuristic: many low-cost thermal printers present as vendor-
      // specific class on Windows. Keep likely printer USB IDs to allow binding.
      const likelyPrinterVidPrefixes = ['04b8', '0519', '067b', '0fe6', '0483', '1fc9', '28e9', '1a86', '0416', '5958'];
      const vidLooksLikePrinter = likelyPrinterVidPrefixes.includes(vid);
      if (!vidLooksLikePrinter) continue;
    }

    const knownName = _getKnownPrinterName(d.deviceDescriptor.idVendor, d.deviceDescriptor.idProduct);
    printers.push({
      type:      'usb',
      name:      knownName || `USB Printer (${vid}:${pid})`,
      usbId:     `${d.deviceDescriptor.idVendor}:${d.deviceDescriptor.idProduct}`,
      vendorId:  d.deviceDescriptor.idVendor,
      productId: d.deviceDescriptor.idProduct,
      _device:   d,
    });
  }

  if (process.platform === 'win32') {
    const windowsPrinters = await _discoverWindowsUsbPrinters();
    for (const p of windowsPrinters) {
      if (!printers.some(existing =>
        (p.usbId && existing.usbId === p.usbId) ||
        (p.portName && existing.portName === p.portName)
      )) {
        printers.push(p);
      }
    }
  }

  return printers;
}

/**
 * Discover Bluetooth serial printers (Y50 / 380Pro) so they appear even when
 * USB/BLE discovery paths are unavailable.
 */
async function _discoverSerial() {
  const candidates = [];
  const seen = new Set();
  const searchTerms = ['y50', '380pro', '380'];

  // Try serialport library first (cross-platform)
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();

    for (const port of ports) {
      const serialPath = port.path || '';
      const text = `${port.path || ''} ${port.friendlyName || ''} ${port.manufacturer || ''} ${port.pnpId || ''}`.toLowerCase();
      if (/active management technology|amt|sol/.test(text)) continue;
      const matchesNamedPrinter = searchTerms.some(term => text.includes(term));
      const looksPrinterish =
        /bluetooth|printer|thermal|pos|escpos|receipt|usb|ch340|ftdi|prolific|cp210|serial/.test(text);
      const isComLike = /^com\d+$/i.test(serialPath);
      if (!serialPath || (!matchesNamedPrinter && !looksPrinterish && !isComLike)) continue;
      if (seen.has(serialPath.toLowerCase())) continue;
      seen.add(serialPath.toLowerCase());

      const label = port.friendlyName || port.manufacturer || (matchesNamedPrinter ? 'Y50 Serial Printer' : 'Serial Printer');
      candidates.push({
        type: matchesNamedPrinter ? 'y50' : 'serial',
        name: `${label} (${serialPath})`,
        address: serialPath,
        serialPath,
      });
    }
    return candidates;
  } catch {
    // serialport not installed, fall back to manual detection below
  }

  // Fallback: macOS manual scan
  if (process.platform === 'darwin') {
    const fs = require('fs');
    const path = require('path');
    try {
      const serialPorts = fs.readdirSync('/dev')
        .filter(f => /^cu\./i.test(f) && searchTerms.some(term => f.toLowerCase().includes(term)))
        .map(f => path.join('/dev', f));

      for (const serialPath of serialPorts) {
        candidates.push({
          type: 'y50',
          name: serialPath,
          address: serialPath,
          serialPath,
        });
      }
    } catch {
      // ignore scan failures
    }
  }

  return candidates;
}

// ─── Network Printer Discovery & Connection ─────────────────────────────────

/**
 * Get local network interfaces to determine subnet for scanning.
 */
function _getLocalSubnets() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const subnets = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip loopback and non-IPv4
      if (iface.internal || iface.family !== 'IPv4') continue;
      // Extract subnet (assume /24 for simplicity)
      const parts = iface.address.split('.');
      if (parts.length === 4) {
        subnets.push(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }
  }
  return subnets;
}

/**
 * Check if a specific IP has a printer on port 9100.
 */
function _probePort(ip, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    
    socket.connect(port, ip);
  });
}

/**
 * Discover network printers on local subnet(s).
 * Scans for devices listening on port 9100 (raw ESC/POS).
 */
async function _discoverNetwork(timeoutMs = 8000) {
  const subnets = _getLocalSubnets();
  if (subnets.length === 0) return [];
  
  const found = [];
  const scanPromises = [];
  
  // Scan common printer IP ranges (1-50 to keep it fast)
  for (const subnet of subnets) {
    for (let i = 1; i <= 50; i++) {
      const ip = `${subnet}.${i}`;
      scanPromises.push(
        _probePort(ip, PRINTER_PORT, Math.min(timeoutMs / 2, 1500))
          .then(isOpen => {
            if (isOpen) {
              found.push({
                type:    'network',
                name:    `Network Printer (${ip})`,
                address: ip,
                port:    PRINTER_PORT,
              });
            }
          })
      );
    }
  }
  
  // Also check common static printer IPs
  const commonIPs = ['192.168.1.100', '192.168.0.100', '192.168.1.200', '10.0.0.100'];
  for (const ip of commonIPs) {
    if (!subnets.some(s => ip.startsWith(s))) {
      scanPromises.push(
        _probePort(ip, PRINTER_PORT, 1000)
          .then(isOpen => {
            if (isOpen) {
              found.push({
                type:    'network',
                name:    `Network Printer (${ip})`,
                address: ip,
                port:    PRINTER_PORT,
              });
            }
          })
      );
    }
  }
  
  await Promise.all(scanPromises);
  return found;
}

/**
 * Connect to a network printer via TCP socket.
 */
async function _connectNetwork(descriptor) {
  const ip = descriptor.address;
  const port = descriptor.port || PRINTER_PORT;
  
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(10000);
    
    socket.on('connect', () => {
      socket.setTimeout(0); // Disable timeout after connect
      socket.on('close', () => _setState('disconnected'));
      socket.on('error', (err) => {
        console.error('[Network] Socket error:', err.message);
        _setState('disconnected');
      });
      resolve({ type: 'network', socket, ip, port });
    });
    
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Connection to ${ip}:${port} timed out`));
    });
    
    socket.on('error', (err) => {
      socket.destroy();
      reject(new Error(`Failed to connect to ${ip}:${port}: ${err.message}`));
    });
    
    socket.connect(port, ip);
  });
}

/**
 * Write data to network printer.
 */
async function _writeNetwork(buffer) {
  const socket = _connection?.socket;
  if (!socket || socket.destroyed) {
    throw new Error('Network socket not connected');
  }
  
  return new Promise((resolve, reject) => {
    socket.write(buffer, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ─── BLE Connection ─────────────────────────────────────────────────────────

async function _connectBLE(descriptor) {
  // Resolve peripheral: prefer live object on descriptor, then cache.
  // If neither is available (daemon restarted, cache stale), do a quick
  // 8-second re-scan to find the device again before giving up.
  let peripheral = descriptor._peripheral || _bleCache.get(descriptor.address);

  if (!peripheral) {
    const found = await _discoverBLE(8000);
    peripheral = _bleCache.get(descriptor.address);
    // Fallback: if address changed (macOS Core Bluetooth may reassign UUIDs),
    // match by Y50 type in the freshly scanned list.
    if (!peripheral && descriptor.type === 'y50') {
      const match = found.find(f => f.type === 'y50');
      if (match) peripheral = match._peripheral;
    }
    if (!peripheral) {
      throw new Error(
        `Bluetooth printer "${descriptor.name}" not found nearby. ` +
        'Make sure it is powered on and in range, then try again.'
      );
    }
  }

  // If Core Bluetooth already has this peripheral connected from a prior
  // session, peripheral.connect() callback may never fire — skip it.
  if (peripheral.state === 'connected') {
    peripheral.removeAllListeners('disconnect');
    peripheral.setMaxListeners(20);
    peripheral.once('disconnect', () => _setState('disconnected'));
    return peripheral;
  }

  return new Promise((resolve, reject) => {
    // Guard against peripheral.connect() hanging indefinitely on macOS.
    const timer = setTimeout(() => {
      reject(new Error('BLE connect() timed out after 15s — printer may need to be power-cycled'));
    }, 15000);

    // Remove stale listeners from prior connect/disconnect cycles.
    peripheral.removeAllListeners('connect');
    peripheral.removeAllListeners('disconnect');
    peripheral.setMaxListeners(20);

    peripheral.connect((err) => {
      clearTimeout(timer);
      if (err) return reject(err);
      peripheral.once('disconnect', () => _setState('disconnected'));
      resolve(peripheral);
    });
  });
}

// ── Y50 dual-path (Classic BT serial + BLE GATT) ─────────────────────────────

/**
 * Find Y50/380Pro Bluetooth serial port (cross-platform).
 * - macOS: /dev/cu.Y50_xxxx or /dev/cu.380Pro-xxxx
 * - Windows: COM port with "Y50"/"380" in device name
 */
async function _findY50SerialPort() {
  const searchTerms = ['y50', '380pro', '380'];

  // Try serialport library first (cross-platform)
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    const y50Port = ports.find(p =>
      searchTerms.some(term =>
        (p.path && p.path.toLowerCase().includes(term)) ||
        (p.friendlyName && p.friendlyName.toLowerCase().includes(term)) ||
        (p.pnpId && p.pnpId.toLowerCase().includes(term))
      )
    );
    if (y50Port) return y50Port.path;
  } catch {
    // serialport not installed, fall back to manual detection
  }

  // Fallback: macOS manual scan
  if (process.platform === 'darwin') {
    const fs = require('fs');
    const path = require('path');
    try {
      return fs.readdirSync('/dev')
        .filter(f => /^cu\./i.test(f) && searchTerms.some(term => f.toLowerCase().includes(term)))
        .map(f => path.join('/dev', f))[0] || null;
    } catch {
      return null;
    }
  }

  return null;
}

// Cache for SerialPort instance (used on Windows)
let _serialPortInstance = null;

/**
 * Connect to Y50: open BLE GATT (for fallback) and the Classic BT serial port
 * (primary, faster, no chunking needed).  Either may be absent — we succeed
 * as long as at least one path is available.
 */
async function _connectY50(descriptor) {
  const fs = require('fs');

  // ── Classic BT serial port ──────────────────────────────────────────────
  const serialPath = await _findY50SerialPort();
  let serialFd = null;

  if (serialPath) {
    // Try serialport library first (works on Windows)
    try {
      const { SerialPort } = require('serialport');
      _serialPortInstance = new SerialPort({ 
        path: serialPath, 
        baudRate: 115200,
        autoOpen: false 
      });
      await new Promise((resolve, reject) => {
        _serialPortInstance.open((err) => err ? reject(err) : resolve());
      });
      serialFd = 'serialport'; // marker to use serialport for writes
    } catch {
      // Fallback: direct fd (macOS/Linux only)
      if (process.platform !== 'win32') {
        try {
          const O_WRONLY   = fs.constants.O_WRONLY;
          const O_NOCTTY   = fs.constants.O_NOCTTY   || 0o400;
          const O_NONBLOCK = fs.constants.O_NONBLOCK || 0o4000;
          serialFd = fs.openSync(serialPath, O_WRONLY | O_NOCTTY | O_NONBLOCK);
        } catch {
          // serial port unavailable
        }
      }
    }
  }

  // ── BLE GATT ─────────────────────────────────────────────────────────────
  let blePeriph = null;
  try {
    blePeriph = await _connectBLE(descriptor);
  } catch (e) {
    if (serialFd == null) throw e;
  }

  return { type: 'y50', ble: blePeriph, serial: serialFd, serialPath };
}

/**
 * Write to Y50: prefer Classic BT serial (full stream, no MTU limit).
 * Falls back to BLE GATT if serial is not available.
 */
async function _writeY50(buffer) {
  const conn = _connection;

  if (conn.serial != null) {
    if (conn.serial === 'serialport' && _serialPortInstance) {
      // Use serialport library (cross-platform)
      await new Promise((resolve, reject) => {
        _serialPortInstance.write(buffer, (err) => {
          if (err) return reject(err);
          _serialPortInstance.drain(resolve);
        });
      });
    } else {
      // Classic BT serial — write raw bytes directly to the fd (macOS/Linux)
      const fs = require('fs');
      await new Promise((resolve, reject) => {
        fs.write(conn.serial, buffer, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  } else if (conn.ble) {
    await _writeBLE(buffer);
  } else {
    throw new Error('Y50: no connection available (serial and BLE both failed)');
  }
}

/**
 * On Windows, USB printers are claimed by usbprint.sys so libusb cannot open
 * them directly (LIBUSB_ERROR_NOT_SUPPORTED).  The usbmon.dll port monitor
 * exposes each USB printer as a raw device path (\\.\USB001, \\.\USB002, …)
 * that any process can open with O_WRONLY and write ESC/POS bytes to directly.
 * No driver replacement (Zadig) needed — this is how all Windows POS software works.
 *
 * Strategy: prefer the port name Windows registered for any thermal/receipt
 * printer via wmic; fall back to probing USB00x sequentially.
 */
async function _findWindowsUsbPrintPort() {
  const fs             = require('fs');
  const { execFile }   = require('child_process');

  // ── 1. Ask Windows which port each printer is on ──────────────────────────
  // wmic printer get Name,PortName lists all installed printers with their ports.
  const wmicResult = await new Promise((resolve) => {
    execFile('wmic', ['printer', 'get', 'Name,PortName', '/format:csv'],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => resolve(err ? '' : stdout));
  });

  console.log('[USB] wmic returned:', wmicResult.substring(0, 300));

  // Parse CSV output and collect USB0xx / USBPRN ports for thermal-ish printers.
  const thermalKeywords = /xprinter|thermal|pos|receipt|escpos|xp-|btp|rpp|380|58mm|80mm|rongta|hprt|sewoo/i;
  const usbPortPattern  = /^USB0*\d+$/i;
  const candidates      = [];

  for (const line of wmicResult.split(/\r?\n/)) {
    const cols = line.split(',');
    if (cols.length < 3) continue;
    // CSV columns: Node, Name, PortName  (or Name, PortName depending on version)
    const name = cols.slice(0, -1).join(' ');
    const port = cols[cols.length - 1].trim();
    if (!usbPortPattern.test(port)) continue;
    // Put thermal-looking printers first, others at the end as fallback.
    if (thermalKeywords.test(name)) {
      candidates.unshift(port);
    } else {
      candidates.push(port);
    }
  }

  console.log('[USB] Candidate USB ports from wmic:', candidates);

  // ── 2. Try each candidate port path ───────────────────────────────────────
  for (const portName of candidates) {
    const portPath = `\\\\.\\${portName}`;
    try {
      const fd = fs.openSync(portPath, fs.constants.O_WRONLY | fs.constants.O_NOCTTY);
      fs.closeSync(fd);
      return portPath;
    } catch { /* port busy or gone */ }
  }

  // ── 3. Blind probe USB001–USB009 as last resort ───────────────────────────
  for (let i = 1; i <= 9; i++) {
    const portPath = `\\\\.\\USB00${i}`;
    try {
      const fd = fs.openSync(portPath, fs.constants.O_WRONLY | fs.constants.O_NOCTTY);
      fs.closeSync(fd);
      console.log(`[USB] Successfully opened ${portPath} (blind probe)`);
      return portPath;
    } catch (err) {
      // Port doesn't exist or in use - try next
    }
  }

  // ── 4. Try alternative COM port naming for USB-serial printers ────────────
  // Some thermal printers enumerate as USB-to-serial (CDC ACM) and create COMx ports.
  // Skip COM3 (often Intel AMT) and other known non-printer serial devices.
  const skipPorts = ['COM3']; // Intel AMT
  for (let i = 1; i <= 20; i++) {
    const portName = `COM${i}`;
    if (skipPorts.includes(portName)) continue;
    const portPath = `\\\\.\\${portName}`;
    try {
      const fd = fs.openSync(portPath, fs.constants.O_WRONLY | fs.constants.O_NOCTTY);
      fs.closeSync(fd);
      console.log(`[USB] Successfully opened ${portPath} (USB-serial fallback)`);
      return portPath;
    } catch { }
  }

  console.log('[USB] No accessible USB print port found. Printer may not be installed in Windows.');
  return null;
}

async function _connectUSB(descriptor) {
  // vendorId / productId may have been stripped during JSON serialisation
  // (e.g. POST /bind only round-trips strings).  Parse from the usbId address
  // string ("decimal:decimal") as a fallback.
  let vendorId  = descriptor.vendorId  != null ? Number(descriptor.vendorId)  : null;
  let productId = descriptor.productId != null ? Number(descriptor.productId) : null;

  if ((vendorId == null || productId == null) && descriptor.address) {
    const [v, p] = descriptor.address.split(':');
    vendorId  = vendorId  ?? parseInt(v, 10);
    productId = productId ?? parseInt(p, 10);
  }

  let usb;
  try {
    usb = require('usb');
  } catch (usbRequireErr) {
    if (process.platform !== 'win32') throw usbRequireErr;
    console.log(`[USB] Native usb module unavailable, using Windows fallbacks: ${usbRequireErr.message || usbRequireErr}`);
    return _connectWindowsUsbFallback(vendorId, productId, descriptor);
  }

  const device = usb.findByIds(vendorId, productId);
  if (!device) {
    if (process.platform === 'win32') return _connectWindowsUsbFallback(vendorId, productId, descriptor);
    throw new Error(
      `USB device not found (${vendorId?.toString(16)}:${productId?.toString(16)}). ` +
      'Make sure the printer is plugged in and try scanning again.'
    );
  }

  // Try the standard libusb path first.
  try {
    device.open();

    // Immediately detect unplug and mark disconnected so auto-reconnect fires.
    const usbEmitter = usb.usb ?? usb;
    usbEmitter.on('detach', (detached) => {
      if (_connection === detached) {
        _connection = null;
        _setState('disconnected');
      }
    });

    return device;
  } catch (libusbErr) {
    console.log(`[USB] libusb device.open() failed: ${libusbErr.message || libusbErr}`);

    // On Windows, usbprint.sys claims printer-class interfaces and libusb
    // returns LIBUSB_ERROR_NOT_SUPPORTED/ACCESS. Try raw USB port access first
    // (same as Mac - direct byte writes), then fall back to Windows spooler.
    if (process.platform !== 'win32') throw libusbErr;

    // PRIORITY 1: Try raw USB port (works like Mac - direct writes)
    const winPort = await _findWindowsUsbPrintPort();
    if (winPort) {
      console.log(`[USB] Using raw Windows USB port ${winPort} (direct writes like Mac)`);
      return { type: 'winusb', portPath: winPort };
    }

    // PRIORITY 2: Bypass spooler via the USBPRINT device interface.
    try {
      const winUsbPrintRaw = require('./winUsbPrintRaw');
      const devicePath = await winUsbPrintRaw.findDevicePath(vendorId, productId);
      if (devicePath) {
        console.log(`[USB] Using Windows USBPRINT raw interface for ${vendorId}:${productId}`);
        return { type: 'usbprint', devicePath, vendorId, productId };
      }
    } catch (usbPrintErr) {
      console.log(`[USB] USBPRINT raw fallback failed: ${usbPrintErr.message || usbPrintErr}`);
    }

    // PRIORITY 3: Fall back to Windows Spooler if direct paths are not accessible
    try {
      const winSpool = require('./winSpoolRaw');
      const winPrinterSetup = require('./winPrinterSetup');

      let queue = await winSpool.findQueueForUsbPrinter(vendorId, productId);
      if (!queue) {
        const install = await winPrinterSetup.autoInstallUsbPrinter(vendorId, productId);
        if (install.success) {
          queue = { Name: install.printerName, PortName: install.port };
        }
      }

      if (queue?.Name) {
        console.log(`[USB] Using Windows spooler queue "${queue.Name}" as fallback`);
        return {
          type: 'winspool',
          printerName: queue.Name,
          portName: queue.PortName || null,
          vendorId,
          productId,
        };
      }
    } catch (spoolErr) {
      console.log(`[USB] Windows spooler fallback failed: ${spoolErr.message || spoolErr}`);
    }

    // No method worked
    const errStr = String(libusbErr.message || libusbErr).toLowerCase();
    if (errStr.includes('not supported') || errStr.includes('access')) {
      throw new Error(
        'Cannot access USB printer. Please install it in Windows first:\n' +
        '1. Open Settings → Devices → Printers & scanners\n' +
        '2. Click "Add a printer or scanner"\n' +
        '3. Let Windows detect and install the printer\n' +
        '4. Then try connecting again in FigoBooks'
      );
    }
    throw libusbErr;
  }
}

async function _connectWindowsUsbFallback(vendorId, productId, descriptor = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Windows USB fallback is only available on Windows');
  }

  try {
    const winUsbPrintRaw = require('./winUsbPrintRaw');
    const devicePath = vendorId != null && productId != null
      ? await winUsbPrintRaw.findDevicePath(vendorId, productId)
      : null;
    if (devicePath) {
      console.log(`[USB] Using Windows USBPRINT raw interface for ${vendorId}:${productId}`);
      return { type: 'usbprint', devicePath, vendorId, productId };
    }
  } catch (usbPrintErr) {
    console.log(`[USB] USBPRINT raw fallback failed: ${usbPrintErr.message || usbPrintErr}`);
  }

  try {
    const winSpool = require('./winSpoolRaw');
    const winPrinterSetup = require('./winPrinterSetup');

    let queue = null;
    if (vendorId != null && productId != null) {
      queue = await winSpool.findQueueForUsbPrinter(vendorId, productId);
    }
    if (!queue && descriptor.name) {
      queue = { Name: descriptor.name, PortName: descriptor.portName || null };
    }
    if (!queue && vendorId != null && productId != null) {
      const install = await winPrinterSetup.autoInstallUsbPrinter(vendorId, productId);
      if (install.success) queue = { Name: install.printerName, PortName: install.port };
    }

    if (queue?.Name) {
      console.log(`[USB] Using Windows spooler queue "${queue.Name}" as fallback`);
      return {
        type: 'winspool',
        printerName: queue.Name,
        portName: queue.PortName || descriptor.portName || null,
        vendorId,
        productId,
      };
    }
  } catch (spoolErr) {
    console.log(`[USB] Windows spooler fallback failed: ${spoolErr.message || spoolErr}`);
  }

  throw new Error(
    'Cannot access USB printer. Please install it in Windows first, then scan/connect again.'
  );
}

async function _connectSerial(descriptor) {
  const { SerialPort } = require('serialport');
  const serialPath = descriptor.address;
  if (!serialPath) throw new Error('Serial printer path is missing');

  // Y50 / Bluetooth SPP thermal links usually use 115200; some stacks use 9600.
  const name = String(descriptor.name || '');
  const isY50Serial = /y50/i.test(name) || /y50/i.test(serialPath);
  const isBTSerial  = /bluetooth/i.test(name);
  const envBaud = parseInt(process.env.FIGO_SERIAL_BAUD || '', 10);
  const baudRate = Number.isFinite(envBaud) && envBaud > 0
    ? envBaud
    : (isY50Serial || isBTSerial ? 115200 : 9600);

  const port = new SerialPort({
    path: serialPath,
    baudRate,
    autoOpen: false,
  });

  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });

  _genericSerialPortInstance = port;
  port.on('error', (err) => {
    console.error('[Serial] port error:', err?.message || err);
    if (_genericSerialPortInstance === port) {
      _genericSerialPortInstance = null;
      _connection = null;
      _setState('error', _state.printer, err?.message || 'Serial port error');
    }
  });
  port.on('close', () => {
    _genericSerialPortInstance = null;
    _setState('disconnected');
  });

  return { type: 'serial', serialPath };
}

async function _writeBytes(buffer) {
  if (!_connection) throw new Error('No connection');

  if (_state.printer.type === 'network') {
    await _writeNetwork(buffer);
  } else if (_state.printer.type === 'y50') {
    await _writeY50(buffer);
  } else if (_state.printer.type === 'serial') {
    await _writeSerial(buffer);
  } else if (_state.printer.type === 'ble') {
    await _writeBLE(buffer);
  } else {
    // Covers both libusb devices and winusb (raw Windows port) fallback.
    await _writeUSB(buffer);
  }
}

async function _writeSerial(buffer) {
  if (!_genericSerialPortInstance) {
    throw new Error('Serial printer not connected');
  }
  const port = _genericSerialPortInstance;
  const CHUNK = 256;
  // Large ESC/POS jobs over Bluetooth SPP often need chunked writes + pacing
  if (buffer.length <= CHUNK) {
    return new Promise((resolve, reject) => {
      port.write(buffer, (err) => {
        if (err) return reject(err);
        port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
      });
    });
  }
  for (let off = 0; off < buffer.length; off += CHUNK) {
    const slice = buffer.subarray(off, Math.min(off + CHUNK, buffer.length));
    await new Promise((resolve, reject) => {
      port.write(slice, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((r) => setTimeout(r, 8));
  }
  return new Promise((resolve, reject) => {
    port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
  });
}

function _nobleUuid(uuid) {
  const s = uuid.toLowerCase().replace(/-/g, '');
  // If it is the standard 128-bit BT base UUID pattern (0000xxxx00001000…)
  // noble shortens it to just the 4-char service/char id.
  const m = s.match(/^0000([0-9a-f]{4})00001000800000805f9b34fb$/);
  return m ? m[1] : s;
}

// Known print-data characteristic UUIDs (in order of preference)
const BLE_PRINT_CHAR_UUIDS = [
  '2af1',
  'ff02',
  '6e400002b5a3f393e0a9e50e24dcca9e',
  '49535343884143f4a8d4ecbe34729bb3',
  'bef8d6c99c214c9eb632bd58c1009f9f',
].map(_nobleUuid);

// Y50P uses CPCL over service FF00, char FF02 exclusively.
// Never use 2af1 (Fitness Machine char) for Y50 — it exists on the device
// but ignores all writes.
const Y50_PRINT_CHAR_UUID = _nobleUuid('ff02');

const BLE_CHUNK_DEFAULT = 20;
const BLE_CHUNK_DELAY_MS = 10; // delay between confirmed writes (with-response)

// Cache stores { char, withoutResponse, mtu } so we know which write mode and chunk size to use.
const _bleCharCache = new Map();

async function _writeBLE(buffer) {
  // For Y50 dual-path _connection is { type:'y50', ble, serial }; unwrap it.
  const peripheral = _connection?.type === 'y50' ? _connection.ble : _connection;
  const address    = _state.printer?.address;

  // Resolve (and cache) the print characteristic
  let cached = address ? _bleCharCache.get(address) : null;

  if (!cached) {
    const chars = await new Promise((res, rej) => {
      peripheral.discoverAllServicesAndCharacteristics((err, _svcs, c) => {
        if (err) return rej(err);
        res(c);
      });
    });

    let writable = null;
    const isY50 = _connection?.type === 'y50';

    if (isY50) {
      // Y50P: always use FF02 (service FF00) — the designated CPCL print char.
      // 2af1 (Fitness Machine char) also exists on Y50P but ignores all writes.
      writable = chars.find(c => _nobleUuid(c.uuid) === Y50_PRINT_CHAR_UUID &&
        (c.properties.includes('write') || c.properties.includes('writeWithoutResponse')));
    }

    if (!writable) {
      // Find characteristic by iterating through our preference list
      for (const preferredUuid of BLE_PRINT_CHAR_UUIDS) {
        writable = chars.find(c => _nobleUuid(c.uuid) === preferredUuid &&
          (c.properties.includes('write') || c.properties.includes('writeWithoutResponse')));
        if (writable) break;
      }
    }

    // Fall back to any writable characteristic
    if (!writable) {
      writable = chars.find(c =>
        c.properties.includes('write') ||
        c.properties.includes('writeWithoutResponse'));
    }

    if (!writable) throw new Error('No writable BLE characteristic found');

    // Subscribe to FF03 (Y50P print-status notify) or any notify char on other printers.
    // Without subscribing, some printers buffer-lock after a few writes.
    const notifyUuid = isY50 ? _nobleUuid('ff03') : null;
    const notifyChar = notifyUuid
      ? chars.find(c => _nobleUuid(c.uuid) === notifyUuid && c.properties.includes('notify'))
      : chars.find(c => c.properties.includes('notify') || c.properties.includes('indicate'));
    if (notifyChar) {
      await new Promise((resolve) => notifyChar.subscribe(() => resolve()));
    }

    // Prefer WriteWithoutResponse — data flows at full BLE speed, preventing
    // motor stutter from round-trip ACK delays between each 20-byte chunk.
    const withoutResponse = writable.properties.includes('writeWithoutResponse');

    // Negotiate a larger ATT MTU (BLE 4.2 supports up to 247 payload bytes).
    // More bytes per packet means the printer buffer stays full continuously.
    let mtu = BLE_CHUNK_DEFAULT;
    if (typeof peripheral.requestMtu === 'function') {
      try {
        mtu = await new Promise((res) => {
          peripheral.requestMtu(247, (err, negotiated) => res(err ? BLE_CHUNK_DEFAULT : negotiated - 3));
        });
      } catch { /* keep default */ }
    }

    cached = { char: writable, withoutResponse, mtu };
    if (address) _bleCharCache.set(address, cached);
  }

  const { char: writable, withoutResponse, mtu: BLE_CHUNK } = cached;

  return new Promise((resolve, reject) => {
    let offset = 0;
    let timedOut = false;
    const CHUNK_TIMEOUT_MS = 2000;

    function writeNext() {
      if (timedOut) return;
      if (offset >= buffer.length) return resolve();
      const chunk = buffer.slice(offset, offset + BLE_CHUNK);
      offset += BLE_CHUNK;

      if (withoutResponse) {
        // Fire-and-forget: no ACK round-trip. With a large MTU (up to 244 bytes),
        // far fewer packets are needed so the printer buffer stays full and the
        // motor runs smooth without stalling between rows.
        writable.write(chunk, true, () => {});
        setTimeout(writeNext, 7);
        return;
      }

      // Confirmed write path (fallback for characteristics that only support 'write')
      const chunkTimer = setTimeout(() => {
        timedOut = true;
        if (address) _bleCharCache.delete(address);
        _connection = null;
        _setState('disconnected');
        reject(new Error('BLE write timed out — printer may be out of range or off'));
      }, CHUNK_TIMEOUT_MS);

      writable.write(chunk, false, (err) => {
        clearTimeout(chunkTimer);
        if (timedOut) return;
        if (err) return reject(err);
        setTimeout(writeNext, BLE_CHUNK_DELAY_MS);
      });
    }

    writeNext();
  });
}

async function _writeUSB(buffer) {
  const conn = _connection;

  if (conn?.type === 'winspool') {
    const winSpool = require('./winSpoolRaw');
    await winSpool.writeRaw(conn.printerName, buffer);
    return;
  }

  if (conn?.type === 'usbprint') {
    const winUsbPrintRaw = require('./winUsbPrintRaw');
    await winUsbPrintRaw.writeRaw(conn.devicePath, buffer);
    return;
  }

  // Windows raw port path (usbprint.sys fallback) — just write bytes directly.
  if (conn?.type === 'winusb') {
    const fs = require('fs');
    return new Promise((resolve, reject) => {
      fs.open(conn.portPath, fs.constants.O_WRONLY | fs.constants.O_NOCTTY, (openErr, fd) => {
        if (openErr) {
          _connection = null;
          _setState('disconnected');
          return reject(new Error(`Cannot open Windows USB port ${conn.portPath}: ${openErr.message}`));
        }
        fs.write(fd, buffer, (writeErr) => {
          fs.close(fd, () => {});
          if (writeErr) {
            _connection = null;
            _setState('disconnected');
            return reject(writeErr);
          }
          resolve();
        });
      });
    });
  }

  // Standard libusb path.
  return new Promise((resolve, reject) => {
    const device = conn;
    const iface  = device.interface(0);
    try { iface.claim(); } catch {}

    const endpoint = iface.endpoints.find(e => e.direction === 'out');
    if (!endpoint) return reject(new Error('No OUT endpoint found on USB device'));

    endpoint.transfer(buffer, (err) => {
      if (err) {
        _connection = null;
        _setState('disconnected');
        return reject(err);
      }
      resolve();
    });
  });
}

// ─── Auto-reconnect ─────────────────────────────────────────────────────────

let _reconnectTimer  = null;
const RECONNECT_INTERVAL = 3_000; // retry every 3 s (fast enough for USB plug-in)

/**
 * Start the auto-reconnect loop.
 * `getSavedPrinter` is a function that returns the saved printer descriptor
 * from config (or null). Called each attempt so it stays in sync with config.
 */
function startAutoReconnect(getSavedPrinter) {
  if (_reconnectTimer) return; // already running
  _reconnectTimer = setInterval(async () => {
    // Only retry when disconnected or in error state
    if (_state.status !== 'disconnected' && _state.status !== 'error') return;
    const saved = getSavedPrinter();
    if (!saved) return; // no saved printer — nothing to reconnect to
    try {
      await connect(saved);
    } catch { /* will retry next interval */ }
  }, RECONNECT_INTERVAL);
  // Don't keep the process alive just for reconnect retries
  _reconnectTimer.unref();
}

module.exports = { discover, connect, disconnect, send, getStatus, getBluetoothState, on, startAutoReconnect };
