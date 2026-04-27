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
  const job   = { jobId, type, data, status: 'pending', createdAt: new Date().toISOString() };
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

async function _processNext() {
  if (_running) return;
  const next = _jobs.find(j => j.status === 'pending');
  if (!next) return;

  _running    = true;
  next.status = 'printing';

  try {
    const buffer = _buildBuffer(next);
    // Race the print against a timeout so a hung BLE write never locks the queue
    await Promise.race([
      printer.send(buffer),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Print job timed out after 30 s')), JOB_TIMEOUT_MS)
      ),
    ]);
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
    const status = printer.getStatus();
    if (status.printer?.type === 'y50') {
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

  // Check if connected printer is a Y50 (requires bitmap/DCRASTER format)
  const status = printer.getStatus();
  const isY50 = status.printer?.type === 'y50';

  if (isY50) {
    switch (job.type) {
      case 'receipt': return y50Raster.receipt(job.data);
      case 'label':   return y50Raster.receipt(job.data); // same format for now
      case 'test':    return y50Raster.testPrint();
      default:        throw new Error(`Unknown job type: ${job.type}`);
    }
  } else {
    // Standard ESC/POS for other printers (USB thermal, MPT BLE, etc.)
    switch (job.type) {
      case 'receipt': return escpos.receipt(job.data);
      case 'label':   return escpos.label(job.data);
      case 'test':    return escpos.testPrint();
      default:        throw new Error(`Unknown job type: ${job.type}`);
    }
  }
}

module.exports = { init, enqueue, getJobs, getJob };
