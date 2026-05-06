/**
 * src/queue.js
 * Simple in-memory print queue.
 * Jobs are processed one at a time to prevent overlapping prints.
 */

'use strict';

const printer   = require('./printerManager');
const escpos    = require('./escpos');
const y50Raster = require('./y50Raster');

const DEFAULT_80MM_PRINT_WIDTH_PX = 576;
const DEFAULT_IMAGE_THRESHOLD = 170;

const _jobs    = [];
let   _running = false;

function init() {}

/**
 * Add a job to the queue.
 * @param {string} type - 'receipt' | 'label' | 'test'
 * @param {Object} data - payload matching the escpos builder
 * @returns {string} jobId
 */
function enqueue(type, data) {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const copies = _normalizeCopies(data?.copies);
  const job   = { jobId, type, data, copies, status: 'pending', createdAt: new Date().toISOString() };
  _jobs.push(job);
  _processNext();
  return jobId;
}

function getJobs() {
  return [..._jobs];
}

function getJob(jobId) {
  return _jobs.find(j => j.jobId === jobId) || null;
}

const JOB_TIMEOUT_MS = 30_000; // max 30 s per job before we give up
const COPY_DELAY_MS = 2_000;

function _normalizeCopies(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : 1;
}

function _delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CPCL/DCRASTER (y50Raster) is for Y50 BLE GATT and some direct-USB paths.
 * Bluetooth SPP ("Standard Serial over Bluetooth", COMx) speaks ESC/POS — sending
 * CPCL there feeds blank paper.
 */
function _printerUsesY50Raster() {
  const p = printer.getStatus().printer;
  if (!p) return false;
  if (p.type === 'serial') return false;
  if (p.type === 'y50') return true;
  if (/y50/i.test(String(p.name || ''))) return true;
  if (p.type === 'usb' && p.vendorId != null) {
    const vid = Number(p.vendorId);
    // Y50 USB cable path appears as VID 0x5958 (decimal 22872) on Windows.
    if (vid === 0x5958 || vid === 5958) return true;
  }
  return false;
}

function _printerUsesY50UsbEscposRaster() {
  const p = printer.getStatus().printer;
  if (!p || process.platform !== 'win32') return false;
  if (p.type !== 'usb' || p.transport !== 'usbprint') return false;
  const vid = Number(p.vendorId);
  return vid === 0x5958 || vid === 5958;
}

function _printerUsesWindowsUsbRaster() {
  const p = printer.getStatus().printer;
  if (!p || process.platform !== 'win32') return false;
  return p.type === 'usb' && !_printerUsesY50Raster();
}

function _encoderLabel(job) {
  if (job.type === 'image') {
    if (_printerUsesY50UsbEscposRaster()) return 'Y50-USB-ESCPOS-Raster(image)';
    if (_printerUsesWindowsUsbRaster()) return 'Windows-USB-ESCPOS-Raster(image)';
    return _printerUsesY50Raster() ? 'Y50-CPCL(image)' : 'ESCPOS-GSv0(image)';
  }
  if (_printerUsesY50UsbEscposRaster()) return 'Y50-USB-ESCPOS-Raster';
  if (_printerUsesWindowsUsbRaster()) return 'Windows-USB-ESCPOS-Raster';
  return _printerUsesY50Raster() ? 'Y50-CPCL' : 'ESCPOS';
}

async function _processNext() {
  if (_running) return;
  const next = _jobs.find(j => j.status === 'pending');
  if (!next) return;

  _running    = true;
  next.status = 'printing';

  try {
    const buffer = _buildBuffer(next);
    const s = printer.getStatus();
    console.log(
      `[FigoPrint] job=${next.type} copies=${next.copies} bytes=${buffer.length} encoder=${_encoderLabel(next)} ` +
        `name=${s.printer?.name || 'none'} type=${s.printer?.type || 'none'}`
    );
    for (let copy = 1; copy <= next.copies; copy++) {
      // Race each physical copy against a timeout so a hung write never locks the queue.
      await Promise.race([
        printer.send(buffer),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Print copy ${copy} timed out after 30 s`)), JOB_TIMEOUT_MS)
        ),
      ]);
      if (copy < next.copies) await _delay(COPY_DELAY_MS);
    }
    next.status     = 'done';
    next.finishedAt = new Date().toISOString();
  } catch (err) {
    next.status = 'error';
    next.error  = err.message;
  } finally {
    _running = false;
    // Keep only last 50 jobs in memory
    if (_jobs.length > 50) _jobs.splice(0, _jobs.length - 50);
    _processNext();
  }
}

function _buildBuffer(job) {
  // 'image' type: pre-rendered RGBA canvas data from the web app.
  // Decoded here and sent directly to the raster encoder for Y50,
  // or printed as a raster image for ESC/POS printers.
  if (job.type === 'image') {
    const { dataBase64, width, height } = job.data;
    const raw  = Buffer.from(dataBase64, 'base64');
    const rgba = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (_printerUsesY50UsbEscposRaster()) {
      return escpos.imageRaster({
        data: rgba,
        width,
        height,
        printWidthPx: y50Raster.PRINT_WIDTH_PX,
        threshold: DEFAULT_IMAGE_THRESHOLD,
      });
    }
    if (_printerUsesY50Raster()) {
      return y50Raster.fromImageData({ data: rgba, width, height });
    }
    const requestedWidth = Number(job.data?.printWidthPx);
    const printWidthPx = Number.isFinite(requestedWidth) && requestedWidth >= 128
      ? Math.round(requestedWidth)
      : DEFAULT_80MM_PRINT_WIDTH_PX;
    const requestedThreshold = Number(job.data?.threshold);
    const threshold = Number.isFinite(requestedThreshold)
      ? Math.round(requestedThreshold)
      : DEFAULT_IMAGE_THRESHOLD;
    return escpos.imageRaster({ data: rgba, width, height, printWidthPx, threshold });
  }

  // Y50 family (and mis-bound usb/serial to same device) use CPCL raster, not ESC/POS
  if (_printerUsesY50UsbEscposRaster()) {
    switch (job.type) {
      case 'receipt': return y50Raster.receiptEscposRaster(job.data);
      case 'label':   return y50Raster.receiptEscposRaster(job.data);
      case 'test':    return y50Raster.testPrintEscposRaster();
      default:        throw new Error(`Unknown job type: ${job.type}`);
    }
  }

  if (_printerUsesY50Raster()) {
    switch (job.type) {
      case 'receipt': return y50Raster.receipt(job.data);
      case 'label':   return y50Raster.receipt(job.data); // same format for now
      case 'test':    return y50Raster.testPrint();
      default:        throw new Error(`Unknown job type: ${job.type}`);
    }
  } else if (_printerUsesWindowsUsbRaster()) {
    switch (job.type) {
      case 'receipt': return escpos.receiptRaster(job.data, { printWidthPx: DEFAULT_80MM_PRINT_WIDTH_PX });
      case 'label':   return escpos.receiptRaster(job.data, { printWidthPx: DEFAULT_80MM_PRINT_WIDTH_PX });
      case 'test':    return escpos.testPrintRaster({ printWidthPx: DEFAULT_80MM_PRINT_WIDTH_PX });
      default:        throw new Error(`Unknown job type: ${job.type}`);
    }
  } else {
    // Standard ESC/POS for other printers (USB thermal, MPT BLE, etc.)
    const p = printer.getStatus().printer;
    switch (job.type) {
      case 'receipt': return escpos.receipt(job.data);
      case 'label':   return escpos.label(job.data);
      case 'test':
        return p?.type === 'serial' ? escpos.testPrintSerial() : escpos.testPrint();
      default:        throw new Error(`Unknown job type: ${job.type}`);
    }
  }
}

module.exports = { init, enqueue, getJobs, getJob };
