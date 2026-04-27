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

// Cache of noble peripheral objects from the last scan, keyed by peripheral.id
const _bleCache = new Map();

let _btState = 'unknown';

// Last printer that was explicitly disconnected/forgotten (descriptor snapshot).
// macOS Core Bluetooth suppresses recently-disconnected peripherals from scan
// results for up to ~60 s, so we inject them from _bleCache as a fallback.
let _lastForgottenBLE = null;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Discover nearby printers via BLE and USB.
 * Returns a promise that resolves with an array of discovered devices.
 */
async function discover(timeoutMs = 8000) {
  const found = [];

  const [bleDevices, usbDevices, networkDevices] = await Promise.allSettled([
    _discoverBLE(timeoutMs),
    _discoverUSB(),
    _discoverNetwork(timeoutMs),
  ]);

  if (bleDevices.status === 'fulfilled') found.push(...bleDevices.value);
  if (usbDevices.status === 'fulfilled') found.push(...usbDevices.value);
  if (networkDevices.status === 'fulfilled') found.push(...networkDevices.value);

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
    } else if (printerDescriptor.type === 'y50') {
      _connection = await _connectY50(printerDescriptor);
    } else {
      throw new Error(`Unknown printer type: ${printerDescriptor.type}`);
    }

    _setState('connected', printerDescriptor);
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

      const isThermal = BLE_EXACT_NAMES.includes(name) || name.startsWith(Y50_PREFIX);
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

async function _discoverUSB() {
  let usb;
  try {
    usb = require('usb');
  } catch {
    return [];
  }

  // Accept any USB device that exposes a printer-class interface (bInterfaceClass 7).
  // This covers virtually all USB thermal printers regardless of vendor.
  const devices = usb.getDeviceList();
  const printers = [];

  for (const d of devices) {
    try {
      d.open();
      const hasPrinterIface = d.interfaces.some(i => i.descriptor.bInterfaceClass === 7);
      d.close();
      if (!hasPrinterIface) continue;
    } catch {
      // Device busy or permission denied — skip silently
      continue;
    }

    const vid = d.deviceDescriptor.idVendor.toString(16).padStart(4, '0');
    const pid = d.deviceDescriptor.idProduct.toString(16).padStart(4, '0');
    printers.push({
      type:      'usb',
      name:      `USB Printer (${vid}:${pid})`,
      usbId:     `${d.deviceDescriptor.idVendor}:${d.deviceDescriptor.idProduct}`,
      vendorId:  d.deviceDescriptor.idVendor,
      productId: d.deviceDescriptor.idProduct,
      _device:   d,
    });
  }

  return printers;
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
 * Find Y50 Bluetooth serial port (cross-platform).
 * - macOS: /dev/cu.Y50_xxxx-SPP
 * - Windows: COM port with "Y50" in device name
 */
async function _findY50SerialPort() {
  // Try serialport library first (cross-platform)
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    const y50Port = ports.find(p => 
      (p.path && p.path.toLowerCase().includes('y50')) ||
      (p.friendlyName && p.friendlyName.toLowerCase().includes('y50')) ||
      (p.pnpId && p.pnpId.toLowerCase().includes('y50'))
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
        .filter(f => /^cu\./i.test(f) && f.toLowerCase().includes('y50'))
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

async function _connectUSB(descriptor) {
  const usb = require('usb');

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

  const device = usb.findByIds(vendorId, productId);
  if (!device) {
    throw new Error(
      `USB device not found (${vendorId?.toString(16)}:${productId?.toString(16)}). ` +
      'Make sure the printer is plugged in and try scanning again.'
    );
  }
  device.open();

  // Immediately detect unplug and mark ourselves disconnected so auto-reconnect
  // kicks in without waiting for the next failed write.
  // The detach event lives on usb.usb (the underlying EventEmitter), not usb itself.
  const usbEmitter = usb.usb ?? usb;
  usbEmitter.on('detach', (detached) => {
    if (_connection === detached) {
      _connection = null;
      _setState('disconnected');
    }
  });

  return device;
}

async function _writeBytes(buffer) {
  if (!_connection) throw new Error('No connection');

  if (_state.printer.type === 'network') {
    await _writeNetwork(buffer);
  } else if (_state.printer.type === 'y50') {
    await _writeY50(buffer);
  } else if (_state.printer.type === 'ble') {
    await _writeBLE(buffer);
  } else {
    await _writeUSB(buffer);
  }
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
  return new Promise((resolve, reject) => {
    const device = _connection;
    const iface  = device.interface(0);
    try { iface.claim(); } catch {}

    const endpoint = iface.endpoints.find(e => e.direction === 'out');
    if (!endpoint) return reject(new Error('No OUT endpoint found on USB device'));

    endpoint.transfer(buffer, (err) => {
      if (err) {
        // USB write failed — mark disconnected so auto-reconnect fires
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
