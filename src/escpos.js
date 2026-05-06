/**
 * src/escpos.js
 * Builds ESC/POS command buffers for common print operations.
 * Returns raw Buffer objects to be handed to printerManager.send().
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ESC/POS command constants
const ESC  = 0x1b;
const GS   = 0x1d;
const LF   = 0x0a;
const NUL  = 0x00;

const CMDS = {
  INIT:           Buffer.from([ESC, 0x40]),
  ALIGN_LEFT:     Buffer.from([ESC, 0x61, 0x00]),
  ALIGN_CENTER:   Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_RIGHT:    Buffer.from([ESC, 0x61, 0x02]),
  BOLD_ON:        Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF:       Buffer.from([ESC, 0x45, 0x00]),
  DOUBLE_SIZE_ON: Buffer.from([GS,  0x21, 0x11]),
  DOUBLE_SIZE_OFF:Buffer.from([GS,  0x21, 0x00]),
  UNDERLINE_ON:   Buffer.from([ESC, 0x2d, 0x01]),
  UNDERLINE_OFF:  Buffer.from([ESC, 0x2d, 0x00]),
  FEED_1:         Buffer.from([LF]),
  FEED_3:         Buffer.from([LF, LF, LF]),
  CUT:            Buffer.from([GS, 0x56, 0x42, 0x00]), // partial cut
};

const DEFAULT_80MM_WIDTH_PX = 576;
const DEFAULT_IMAGE_THRESHOLD = 170;
const RASTER_FONT_FAMILY = 'EscposRasterSans';
const RASTER_FONT_SIZE_OFFSET_PT = 10;
let PImage = null;
let _rasterFontLoaded = false;

try {
  PImage = require('pureimage');
} catch {
  PImage = null;
}

/**
 * Encode a string as Latin-1 bytes (safe for most thermal printers).
 */
function text(str) {
  return Buffer.from(str + '\n', 'latin1');
}

/**
 * Build a separator line of dashes.
 */
function separator(char = '-', width = 42) {
  return text(char.repeat(width));
}

function truncate(str, width) {
  const s = String(str || '');
  return s.length <= width ? s : s.slice(0, width);
}

function padRight(str, width) {
  return truncate(str, width).padEnd(width);
}

function padLeft(str, width) {
  return truncate(str, width).padStart(width);
}

function itemLine(qty, name, price, total) {
  const qtyCol = 4;
  const itemCol = 15;
  const priceCol = 10;
  const totalCol = 10;
  return `${padRight(qty, qtyCol)} ${padRight(name, itemCol)} ${padLeft(price, priceCol)} ${padLeft(total, totalCol)}`;
}

function summaryLine(label, value) {
  const labelCol = 29;
  const valueCol = 12;
  return `${padRight(label, labelCol)} ${padLeft(value, valueCol)}`;
}

function formatMoney(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `₦${value.toLocaleString()}`;
  const s = String(value).trim();
  if (!s) return '';
  const normalized = s.replace(/[\s,]/g, '').replace(/₦/g, '');
  const n = Number(normalized);
  if (Number.isFinite(n)) return `₦${n.toLocaleString()}`;
  return s;
}

function parseMoneyNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return NaN;
  const s = String(value).trim();
  if (!s) return NaN;
  const cleaned = s.replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function plainAmount(value) {
  const n = parseMoneyNumber(value);
  if (!Number.isFinite(n)) return '-';
  return String(n);
}

function ensureRasterFont() {
  if (!PImage) return false;
  if (_rasterFontLoaded) return true;
  const candidates = [
    path.join(__dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf'),
    'C:/Windows/Fonts/segoeui.ttf',
    'C:/Windows/Fonts/arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  const fontPath = candidates.find((p) => fs.existsSync(p));
  if (!fontPath) return false;
  try {
    PImage.registerFont(fontPath, RASTER_FONT_FAMILY).loadSync();
    _rasterFontLoaded = true;
    return true;
  } catch {
    return false;
  }
}

function rasterFont(pt) {
  return `${pt + RASTER_FONT_SIZE_OFFSET_PT}pt ${RASTER_FONT_FAMILY}`;
}

function measure(ctx, textValue) {
  return Number(ctx.measureText(cleanText(textValue))?.width || 0);
}

function wrapRasterText(ctx, textValue, maxWidth) {
  const value = cleanText(textValue);
  if (!value) return [];
  const words = value.split(' ');
  const lines = [];
  let line = '';

  for (const word of words) {
    if (measure(ctx, word) > maxWidth) {
      if (line) {
        lines.push(line);
        line = '';
      }
      let chunk = '';
      for (const char of word) {
        const next = chunk + char;
        if (chunk && measure(ctx, next) > maxWidth) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk = next;
        }
      }
      if (chunk) lines.push(chunk);
      continue;
    }

    const next = line ? `${line} ${word}` : word;
    if (measure(ctx, next) <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawRasterText(ctx, textValue, x, y, options = {}) {
  const value = cleanText(textValue);
  if (!value) return;
  if (options.bold) {
    ctx.fillText(value, x, y);
    ctx.fillText(value, x + (options.boldStrength || 1), y);
    return;
  }
  ctx.fillText(value, x, y);
}

function drawCenteredRasterText(ctx, width, textValue, y, options = {}) {
  const value = cleanText(textValue);
  if (!value) return;
  drawRasterText(ctx, value, Math.max(0, Math.floor((width - measure(ctx, value)) / 2)), y, options);
}

function drawRightRasterText(ctx, textValue, rightX, y, options = {}) {
  const value = cleanText(textValue);
  drawRasterText(ctx, value, rightX - measure(ctx, value), y, options);
}

function drawRasterLogo(img, logoImage, y) {
  if (!logoImage?.dataBase64 || !logoImage.width || !logoImage.height) return 0;
  const src = Buffer.from(String(logoImage.dataBase64), 'base64');
  const srcW = Number(logoImage.width);
  const srcH = Number(logoImage.height);
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0 || src.length < srcW * srcH * 4) return 0;
  const scaleX = img.width / srcW;
  const outH = Math.max(1, Math.round(srcH * scaleX));

  for (let outY = 0; outY < outH; outY++) {
    const srcY = Math.min(srcH - 1, Math.floor(outY / scaleX));
    for (let outX = 0; outX < img.width; outX++) {
      const srcX = Math.min(srcW - 1, Math.floor(outX / scaleX));
      const srcIdx = (srcY * srcW + srcX) * 4;
      const dstIdx = ((y + outY) * img.width + outX) * 4;
      const alpha = src[srcIdx + 3] / 255;
      if (alpha <= 0) continue;
      const bg = 255 * (1 - alpha);
      img.data[dstIdx] = Math.round(src[srcIdx] * alpha + bg);
      img.data[dstIdx + 1] = Math.round(src[srcIdx + 1] * alpha + bg);
      img.data[dstIdx + 2] = Math.round(src[srcIdx + 2] * alpha + bg);
      img.data[dstIdx + 3] = 255;
    }
  }
  return outH;
}

function normalizeFooter(footer) {
  const lines = Array.isArray(footer) ? footer.filter(Boolean).map(cleanText).filter(Boolean) : [];
  if (!lines.length) lines.push('Thank you!');
  if (!lines.some((line) => /powered\s+by\s+figobooks/i.test(line))) lines.push('Powered by FigoBooks');
  return lines;
}

/**
 * Build a receipt print buffer.
 * @param {Object} data
 * @param {string} data.businessName
 * @param {string} data.businessAddress
 * @param {string} data.invoiceNumber
 * @param {string} data.date
 * @param {Array<{name,qty,price}>} data.items
 * @param {number} data.total
 * @param {string} [data.note]
 */
function receipt(data) {
  const ref = String(data.receiptId || data.invoiceNumber || 'N/A');
  const time = String(data.time || data.date || new Date().toLocaleDateString());
  const status = String(data.status || '').trim();
  const staff = String(data.staff || '').trim();
  const soldTo = String(data.soldTo || data.customer || '').trim();
  const balance = String(data.balance || '').trim();
  const items = Array.isArray(data.items) ? data.items : [];
  const taxes = Array.isArray(data.taxes) ? data.taxes : [];
  const subtotalLabel = String(data.subtotalLabel || 'Subtotal');
  const subtotalValue = String(data.subtotalValue || '');
  const totalLabel = String(data.totalLabel || 'Total');
  const totalValue = data.totalValue != null ? data.totalValue : data.total;
  const footer = Array.isArray(data.footer) ? data.footer.filter(Boolean).map(String) : [];

  const parts = [
    CMDS.INIT,
    CMDS.ALIGN_CENTER,
    CMDS.BOLD_ON,
    CMDS.DOUBLE_SIZE_ON,
    text(data.businessName || 'FigoBooks'),
    CMDS.DOUBLE_SIZE_OFF,
    CMDS.BOLD_OFF,
  ];

  if (data.businessAddress) parts.push(text(data.businessAddress));
  if (data.businessPhone) parts.push(text(data.businessPhone));
  parts.push(CMDS.FEED_1);

  parts.push(
    CMDS.ALIGN_LEFT,
    separator(),
    text(`Ref:   ${ref}`),
    text(`Time:  ${time}`),
  );

  if (soldTo) parts.push(text(`Customer: ${soldTo}`));
  if (status) parts.push(text(`Status: ${status}`));
  if (staff) parts.push(text(`Staff:  ${staff}`));

  parts.push(
    separator(),
    text(itemLine('Qty', 'Item', 'Price', 'Total')),
    separator(),
  );

  // Line items
  for (const item of items) {
    const qty = String(item.qty || '');
    const name = String(item.name || '');
    const qtyNum = Number(qty);
    const explicitTotal = item.total ?? item.lineTotal;

    let total = formatMoney(explicitTotal) || '';
    let price = formatMoney(item.price ?? item.unitPrice) || '';

    // Backward compatibility: older payloads only sent one amount in `price`,
    // which represented line total. Derive unit price when qty is known.
    if (!total && price) total = price;
    const totalNum = parseMoneyNumber(total);
    if ((!price || price === total) && Number.isFinite(totalNum) && Number.isFinite(qtyNum) && qtyNum > 0) {
      price = formatMoney(totalNum / qtyNum) || price;
    }

    parts.push(text(itemLine(qty, name, price || '-', total || '-')));
  }

  parts.push(separator());

  if (subtotalValue) {
    parts.push(text(summaryLine(subtotalLabel, formatMoney(subtotalValue) || subtotalValue)));
  }

  for (const t of taxes) {
    const label = String(t?.label || '').trim();
    const value = String(t?.value || '').trim();
    if (label || value) {
      parts.push(text(summaryLine(label || 'Tax', formatMoney(value) || value)));
    }
  }

  parts.push(
    CMDS.BOLD_ON,
    text(summaryLine(totalLabel, formatMoney(totalValue) || String(totalValue || ''))),
    CMDS.BOLD_OFF,
    separator(),
  );

  if (balance) {
    parts.push(
      CMDS.FEED_1,
      CMDS.ALIGN_LEFT,
      CMDS.BOLD_ON,
      text(`Balance owed: ${balance}`),
      CMDS.BOLD_OFF,
      separator(),
    );
  }

  if (data.note) {
    parts.push(CMDS.FEED_1, CMDS.ALIGN_CENTER, text(data.note));
  }

  if (footer.length > 0) {
    parts.push(CMDS.ALIGN_CENTER);
    for (const line of footer) parts.push(text(line));
  }

  parts.push(
    CMDS.FEED_1,
    CMDS.ALIGN_CENTER,
    ...(footer.length > 0 ? [] : [text('Thank you for your business!'), text('Powered by FigoBooks')]),
    CMDS.FEED_3,
    CMDS.CUT,
  );

  return Buffer.concat(parts);
}

/**
 * Single-line + CRLF, ASCII only (avoids Latin-1/Unicode on cheap thermal firmware).
 */
function lineAscii(s) {
  return Buffer.from(String(s).replace(/\r?\n/g, ' ') + '\r\n', 'ascii');
}

/**
 * Minimal test for Bluetooth SPP / serial devices: no ₦, no double-size,
 * no partial-cut (GS V) — many 58mm / label-class units ignore the buffer or
 * lock up on unsupported opcodes, which looks like "blank paper but feed".
 */
function testPrintSerial() {
  const esc = 0x1b;
  const gs  = 0x1d;
  return Buffer.concat([
    Buffer.from([esc, 0x40]), // init
    Buffer.from([esc, 0x61, 0x01]), // center
    lineAscii('FIGO / FigoBooks'),
    lineAscii('TEST OK'),
    lineAscii('--------------------'),
    Buffer.from([esc, 0x61, 0x00]), // left
    lineAscii('Item A   qty 1   1000'),
    lineAscii('Item B   qty 2   500'),
    lineAscii('Total: 2000'),
    lineAscii(''),
    Buffer.from([esc, 0x64, 0x0a]), // feed 10 lines (enough to eject on 58mm)
    Buffer.from([0x0a, 0x0a]),
    // No GS V cut here: some firmware ignores the whole buffer if cut is unsupported.
    ...(process.env.FIGO_TEST_CUT === '1'
      ? [Buffer.from([gs, 0x56, 0x00])]
      : []),
  ]);
}

/**
 * Build a simple test print buffer.
 */
function testPrint() {
  return receipt({
    businessName:    'FigoBooks Test Print',
    businessAddress: '--- Driver Setup ---',
    invoiceNumber:   'TEST-001',
    date:            new Date().toLocaleString(),
    items: [
      { name: 'Test Item A', qty: 1, price: 1000 },
      { name: 'Test Item B', qty: 2, price: 500  },
    ],
    total: 2000,
    note:  'Printer is working correctly!',
  });
}

function receiptRaster(data, options = {}) {
  if (!ensureRasterFont()) return receipt(data);

  const width = Number.isFinite(Number(options.printWidthPx))
    ? Math.max(128, Math.round(Number(options.printWidthPx)))
    : DEFAULT_80MM_WIDTH_PX;
  const items = Array.isArray(data.items) ? data.items : [];
  const taxes = Array.isArray(data.taxes) ? data.taxes : [];
  const footer = normalizeFooter(data.footer);
  const status = cleanText(data.status);
  const soldTo = cleanText(data.soldTo || data.customer);
  const staff = cleanText(data.staff);
  const receiptId = data.receiptId || data.invoiceNumber || data.ref || 'N/A';
  const receiptTime = data.time || data.date || new Date().toLocaleDateString();
  const logoHeight = data.logoImage?.height && data.logoImage?.width
    ? Math.round(Number(data.logoImage.height) * (width / Number(data.logoImage.width)))
    : 0;
  const itemExtraLines = items.reduce((sum, item) => {
    const name = cleanText(item.name || item.label || 'Item');
    return sum + Math.max(0, Math.ceil(name.length / 26) - 1);
  }, 0);
  const addressExtraLines = data.businessAddress ? Math.max(0, Math.ceil(cleanText(data.businessAddress).length / 42) - 1) : 0;
  const height = Math.max(
    760,
    430 + logoHeight + (items.length * 34) + (itemExtraLines * 28) + (addressExtraLines * 28) +
      (taxes.length * 30) + (footer.length * 32) + (soldTo ? 30 : 0) + (staff ? 30 : 0) +
      (data.balance ? 32 : 0) + 80
  );

  const img = PImage.make(width, height);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;

  const left = 16;
  const right = width - 16;
  let y = 14;

  if (data.logoImage) {
    y += drawRasterLogo(img, data.logoImage, y);
    y += 8;
  }

  ctx.font = rasterFont(24);
  drawCenteredRasterText(ctx, width, data.businessName || 'FigoBooks', y + 32, { bold: true, boldStrength: 1.4 });
  y += 48;

  ctx.font = rasterFont(13);
  if (data.businessAddress) {
    for (const line of wrapRasterText(ctx, data.businessAddress, width - 32)) {
      drawCenteredRasterText(ctx, width, line, y + 22);
      y += 26;
    }
  }
  if (data.businessPhone) {
    drawCenteredRasterText(ctx, width, data.businessPhone, y + 22);
    y += 26;
  }

  y += 8;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 28;

  ctx.font = rasterFont(13);
  drawRasterText(ctx, `Ref: ${receiptId}`, left, y);
  y += 28;
  drawRasterText(ctx, `Time: ${receiptTime}`, left, y);
  y += 28;
  if (soldTo) {
    drawRasterText(ctx, `Sold to: ${soldTo}`, left, y);
    y += 28;
  }
  if (staff) {
    drawRasterText(ctx, `Staff: ${staff}`, left, y);
    y += 28;
  }

  y += 4;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 28;

  const qtyX = left;
  const itemX = left + 46;
  const priceRightX = width - 132;
  const totalRightX = right;
  const itemMaxWidth = Math.max(120, priceRightX - itemX - 16);

  ctx.font = rasterFont(13);
  drawRasterText(ctx, 'Qty', qtyX, y, { bold: true });
  drawRasterText(ctx, 'Item', itemX, y, { bold: true });
  drawRightRasterText(ctx, 'Price', priceRightX, y, { bold: true });
  drawRightRasterText(ctx, 'Total', totalRightX, y, { bold: true });
  y += 28;

  ctx.font = rasterFont(13);
  for (const item of items) {
    const qty = cleanText(item.qty || 1);
    const nameLines = wrapRasterText(ctx, item.name || item.label || 'Item', itemMaxWidth);
    const unit = item.price ?? item.unitPrice;
    const lineTotal = item.total ?? item.lineTotal ?? unit;
    drawRasterText(ctx, qty, qtyX, y);
    drawRasterText(ctx, nameLines[0] || 'Item', itemX, y);
    drawRightRasterText(ctx, plainAmount(unit), priceRightX, y);
    drawRightRasterText(ctx, plainAmount(lineTotal), totalRightX, y);
    y += 26;
    for (const line of nameLines.slice(1)) {
      drawRasterText(ctx, line, itemX, y);
      y += 26;
    }
  }

  y += 8;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 30;

  ctx.font = rasterFont(14);
  if (data.subtotalValue) {
    drawRasterText(ctx, data.subtotalLabel || 'Subtotal', left, y);
    drawRightRasterText(ctx, formatMoney(data.subtotalValue) || data.subtotalValue, right, y);
    y += 30;
  }
  for (const tax of taxes) {
    drawRasterText(ctx, tax.label || 'Tax', left, y);
    drawRightRasterText(ctx, formatMoney(tax.value) || tax.value, right, y);
    y += 30;
  }

  drawRasterText(ctx, data.totalLabel || 'Total', left, y, { bold: true, boldStrength: 1.2 });
  drawRightRasterText(ctx, formatMoney(data.totalValue ?? data.total) || String(data.totalValue ?? data.total ?? ''), right, y, { bold: true, boldStrength: 1.2 });
  y += 34;

  if (data.balance) {
    drawRasterText(ctx, 'Balance', left, y, { bold: true });
    drawRightRasterText(ctx, formatMoney(data.balance) || data.balance, right, y, { bold: true });
    y += 32;
  }

  y += 6;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 34;

  if (status) {
    ctx.font = rasterFont(15);
    drawCenteredRasterText(ctx, width, `** ${status} **`, y, { bold: true, boldStrength: 1.2 });
    y += 34;
  }

  ctx.font = rasterFont(13);
  for (const line of footer) {
    drawCenteredRasterText(ctx, width, line, y);
    y += 30;
  }

  return imageRaster({
    data: img.data,
    width,
    height: Math.min(height, Math.ceil(y + 100)),
    printWidthPx: width,
    threshold: options.threshold ?? 220,
  });
}

function testPrintRaster(options = {}) {
  return receiptRaster({
    businessName: 'FigoBooks Test Print',
    businessAddress: '--- Driver Setup ---',
    receiptId: 'TEST-001',
    time: new Date().toLocaleString(),
    status: 'TEST OK',
    items: [
      { name: 'Test Item A', qty: 1, price: 1000, total: 1000 },
      { name: 'Test Item B', qty: 2, price: 500, total: 1000 },
    ],
    totalValue: 2000,
    footer: ['Printer is working correctly!', 'Powered by FigoBooks'],
  }, options);
}

/**
 * Build a label buffer.
 * @param {Object} data
 * @param {string}  data.name
 * @param {number}  [data.price]
 * @param {number}  [data.costPrice]
 * @param {number}  [data.stock]
 * @param {string}  [data.barcode]
 * @param {Object}  [data.fields]  - boolean flags for which fields to print
 */
function label(data) {
  const fields = data.fields || { name: true, price: true, barcode: true };
  const parts  = [CMDS.INIT, CMDS.ALIGN_CENTER];

  if (fields.name && data.name) {
    parts.push(
      CMDS.BOLD_ON,
      CMDS.DOUBLE_SIZE_ON,
      text(data.name),
      CMDS.DOUBLE_SIZE_OFF,
      CMDS.BOLD_OFF,
    );
  }

  if (fields.price && data.price != null) {
    parts.push(
      CMDS.BOLD_ON,
      text(`\u20a6${Number(data.price).toLocaleString()}`),
      CMDS.BOLD_OFF,
    );
  }

  if (fields.costPrice && data.costPrice > 0) {
    parts.push(text(`Cost: \u20a6${Number(data.costPrice).toLocaleString()}`));
  }

  if (fields.stock && data.stock != null) {
    parts.push(text(`Qty: ${data.stock}`));
  }

  // ESC/POS CODE128 barcode: GS k  type=8 (CODE128), n bytes, data, NUL
  if (fields.barcode && data.barcode) {
    const barcodeVal = String(data.barcode);
    parts.push(
      Buffer.from([LF]),
      // Set barcode height: GS h n
      Buffer.from([GS, 0x68, 0x40]),
      // Set barcode HRI position below: GS H 2
      Buffer.from([GS, 0x48, 0x02]),
      // Print CODE128: GS k 8 n d1..dn
      Buffer.from([GS, 0x6b, 0x08, barcodeVal.length]),
      Buffer.from(barcodeVal, 'ascii'),
      Buffer.from([NUL]),
    );
  }

  parts.push(CMDS.FEED_3, CMDS.CUT);
  return Buffer.concat(parts);
}

/**
 * Convert RGBA canvas data to ESC/POS GS v 0 raster image buffer.
 * @param {Object} opts
 * @param {Buffer|Uint8Array} opts.data   - RGBA pixel bytes (4 bytes per pixel)
 * @param {number}           opts.width  - canvas width in pixels
 * @param {number}           opts.height - canvas height in pixels
 * @param {number}           [opts.printWidthPx=576] - printer dot width
 * @param {number}           [opts.threshold=170] - grayscale threshold (higher = darker)
 * @returns {Buffer}
 */
function imageRaster({ data, width, height, printWidthPx = DEFAULT_80MM_WIDTH_PX, threshold = DEFAULT_IMAGE_THRESHOLD }) {
  const safeWidth = Number.isFinite(printWidthPx) ? Math.max(128, Math.round(printWidthPx)) : DEFAULT_80MM_WIDTH_PX;
  const safeThreshold = Number.isFinite(threshold)
    ? Math.max(32, Math.min(245, Math.round(threshold)))
    : DEFAULT_IMAGE_THRESHOLD;
  const scaleX   = safeWidth / width;
  const outW     = safeWidth;
  const outH     = Math.round(height * scaleX);
  const bytesPerRow = Math.ceil(outW / 8);

  // Build 1-bit packed bitmap (MSB = leftmost pixel, 0 = black)
  const bitmap = Buffer.alloc(bytesPerRow * outH, 0x00);
  for (let y = 0; y < outH; y++) {
    const srcY = Math.floor(y / scaleX);
    for (let x = 0; x < outW; x++) {
      const srcX = Math.floor(x / scaleX);
      const idx  = (srcY * width + srcX) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < safeThreshold) {
        // dark pixel → set bit (black dot)
        bitmap[y * bytesPerRow + Math.floor(x / 8)] |= (0x80 >> (x % 8));
      }
    }
  }

  // GS v 0: xL xH yL yH  then bitmap rows
  const header = Buffer.from([
    GS, 0x76, 0x30, 0x00,
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
    outH & 0xff,        (outH >> 8) & 0xff,
  ]);

  return Buffer.concat([CMDS.INIT, header, bitmap, CMDS.FEED_3]);
}

module.exports = { receipt, receiptRaster, testPrint, testPrintRaster, testPrintSerial, label, imageRaster, text, separator, CMDS };
