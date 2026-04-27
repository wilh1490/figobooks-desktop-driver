/**
 * src/escpos.js
 * Builds ESC/POS command buffers for common print operations.
 * Returns raw Buffer objects to be handed to printerManager.send().
 */

'use strict';

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

module.exports = { receipt, testPrint, label, imageRaster, text, separator, CMDS };
