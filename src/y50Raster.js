/**
 * src/y50Raster.js
 * CPCL encoder for Y50 label printers.
 * Converts text receipts to bitmap-in-CPCL (EG command) format.
 */

'use strict';

// Y50 print parameters
const DPI = 200;                    // 8 dots/mm
const PAPER_WIDTH_MM = 50;          // 50mm paper width
const PRINT_WIDTH_PX = Math.floor(PAPER_WIDTH_MM * DPI / 25.4); // ~394 pixels
const BYTES_PER_ROW = Math.ceil(PRINT_WIDTH_PX / 8);            // ~50 bytes

// Simple bitmap font (5x7 pixel characters, scaled 2x for readability)
// This is a minimal implementation - we draw text as 1-bit pixels
const CHAR_WIDTH = 12;  // pixels per character (including spacing)
const CHAR_HEIGHT = 20; // pixels per character line
const LINE_HEIGHT = 24; // pixels per line (including spacing)

/**
 * Convert a character to a 5x7 bitmap pattern.
 * Returns array of 7 bytes, each representing a row.
 */
const FONT_5X7 = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  '"': [0x0a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00],
  '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
  '$': [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  '%': [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
  '&': [0x08, 0x14, 0x14, 0x08, 0x15, 0x12, 0x0d],
  "'": [0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '*': [0x00, 0x04, 0x15, 0x0e, 0x15, 0x04, 0x00],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ',': [0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x08],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04],
  '/': [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x00],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x0e, 0x10, 0x10, 0x1f],
  '3': [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ':': [0x00, 0x00, 0x04, 0x00, 0x04, 0x00, 0x00],
  ';': [0x00, 0x00, 0x04, 0x00, 0x04, 0x04, 0x08],
  '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '=': [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  '@': [0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0e],
  'A': [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'B': [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  'C': [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  'D': [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  'E': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  'F': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  'G': [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  'H': [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'I': [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  'J': [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  'M': [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  'O': [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'P': [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  'Q': [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  'R': [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  'S': [0x0e, 0x11, 0x10, 0x0e, 0x01, 0x11, 0x0e],
  'T': [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  'X': [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  'Y': [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  'Z': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '[': [0x0e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0e],
  '\\': [0x00, 0x10, 0x08, 0x04, 0x02, 0x01, 0x00],
  ']': [0x0e, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0e],
  '^': [0x04, 0x0a, 0x11, 0x00, 0x00, 0x00, 0x00],
  '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  '`': [0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
  'a': [0x00, 0x00, 0x0e, 0x01, 0x0f, 0x11, 0x0f],
  'b': [0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x1e],
  'c': [0x00, 0x00, 0x0f, 0x10, 0x10, 0x10, 0x0f],
  'd': [0x01, 0x01, 0x0f, 0x11, 0x11, 0x11, 0x0f],
  'e': [0x00, 0x00, 0x0e, 0x11, 0x1f, 0x10, 0x0e],
  'f': [0x06, 0x08, 0x1e, 0x08, 0x08, 0x08, 0x08],
  'g': [0x00, 0x00, 0x0f, 0x11, 0x0f, 0x01, 0x0e],
  'h': [0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x11],
  'i': [0x04, 0x00, 0x0c, 0x04, 0x04, 0x04, 0x0e],
  'j': [0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0c],
  'k': [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12],
  'l': [0x0c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  'm': [0x00, 0x00, 0x1a, 0x15, 0x15, 0x15, 0x15],
  'n': [0x00, 0x00, 0x1e, 0x11, 0x11, 0x11, 0x11],
  'o': [0x00, 0x00, 0x0e, 0x11, 0x11, 0x11, 0x0e],
  'p': [0x00, 0x00, 0x1e, 0x11, 0x1e, 0x10, 0x10],
  'q': [0x00, 0x00, 0x0f, 0x11, 0x0f, 0x01, 0x01],
  'r': [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10],
  's': [0x00, 0x00, 0x0f, 0x10, 0x0e, 0x01, 0x1e],
  't': [0x08, 0x08, 0x1e, 0x08, 0x08, 0x09, 0x06],
  'u': [0x00, 0x00, 0x11, 0x11, 0x11, 0x11, 0x0f],
  'v': [0x00, 0x00, 0x11, 0x11, 0x11, 0x0a, 0x04],
  'w': [0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0a],
  'x': [0x00, 0x00, 0x11, 0x0a, 0x04, 0x0a, 0x11],
  'y': [0x00, 0x00, 0x11, 0x11, 0x0f, 0x01, 0x0e],
  'z': [0x00, 0x00, 0x1f, 0x02, 0x04, 0x08, 0x1f],
  '{': [0x02, 0x04, 0x04, 0x08, 0x04, 0x04, 0x02],
  '|': [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  '}': [0x08, 0x04, 0x04, 0x02, 0x04, 0x04, 0x08],
  '~': [0x00, 0x08, 0x15, 0x02, 0x00, 0x00, 0x00],
};

// Naira symbol approximation (N with two strokes)
FONT_5X7['₦'] = [0x11, 0x19, 0x1f, 0x15, 0x1f, 0x13, 0x11];

/**
 * Create an empty 1-bit bitmap buffer.
 * Each byte represents 8 horizontal pixels.
 */
function createBitmap(width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  return {
    width,
    height,
    bytesPerRow,
    data: Buffer.alloc(bytesPerRow * height, 0xff), // white = 1
  };
}

/**
 * Set a pixel in the bitmap (0 = black, 1 = white).
 */
function setPixel(bitmap, x, y, black = true) {
  if (x < 0 || x >= bitmap.width || y < 0 || y >= bitmap.height) return;
  const byteIndex = y * bitmap.bytesPerRow + Math.floor(x / 8);
  const bitIndex = 7 - (x % 8);
  if (black) {
    bitmap.data[byteIndex] &= ~(1 << bitIndex); // set bit to 0 (black)
  } else {
    bitmap.data[byteIndex] |= (1 << bitIndex);  // set bit to 1 (white)
  }
}

/**
 * Draw a character at position (x, y) with 2x scaling.
 */
function drawChar(bitmap, ch, x, y, scale = 2) {
  const pattern = FONT_5X7[ch] || FONT_5X7['?'];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      const isSet = (pattern[row] >> (4 - col)) & 1;
      if (isSet) {
        // Draw scaled pixel
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            setPixel(bitmap, x + col * scale + sx, y + row * scale + sy, true);
          }
        }
      }
    }
  }
}

/**
 * Draw a text string at position (x, y).
 */
function drawText(bitmap, text, x, y, options = {}) {
  const { scale = 2, bold = false } = options;
  const charWidth = 5 * scale + scale; // character width + spacing
  
  for (let i = 0; i < text.length; i++) {
    drawChar(bitmap, text[i], x + i * charWidth, y, scale);
    if (bold) {
      // Draw again slightly offset for bold effect
      drawChar(bitmap, text[i], x + i * charWidth + 1, y, scale);
    }
  }
}

/**
 * Draw a horizontal line.
 */
function drawHLine(bitmap, x1, x2, y, thickness = 1) {
  for (let t = 0; t < thickness; t++) {
    for (let x = x1; x <= x2; x++) {
      setPixel(bitmap, x, y + t, true);
    }
  }
}

/**
 * Render a receipt to bitmap.
 * @param {Object} data Receipt data
 * @returns {Object} Bitmap object with width, height, bytesPerRow, data
 */
function renderReceipt(data) {
  // Calculate height based on content
  let lineCount = 0;
  lineCount += 2; // business name (double size)
  if (data.businessAddress) lineCount += 1;
  lineCount += 1; // blank
  lineCount += 2; // invoice + date
  lineCount += 1; // separator
  lineCount += (data.items || []).length;
  lineCount += 1; // separator
  lineCount += 1; // total
  if (data.note) lineCount += 2;
  lineCount += 3; // thank you + powered by + blank
  lineCount += 4; // extra margin

  const width = PRINT_WIDTH_PX;
  const height = lineCount * LINE_HEIGHT;
  const bitmap = createBitmap(width, height);

  let y = 8;
  const leftMargin = 4;
  const centerX = Math.floor(width / 2);

  // Business name (centered, bold, double size)
  const bizName = data.businessName || 'FigoBooks';
  const bizNameWidth = bizName.length * CHAR_WIDTH * 2;
  drawText(bitmap, bizName, centerX - Math.floor(bizNameWidth / 2), y, { scale: 4, bold: true });
  y += LINE_HEIGHT * 2;

  // Business address (centered)
  if (data.businessAddress) {
    const addrWidth = data.businessAddress.length * (CHAR_WIDTH / 2);
    drawText(bitmap, data.businessAddress, centerX - Math.floor(addrWidth / 2), y, { scale: 2 });
    y += LINE_HEIGHT;
  }
  y += LINE_HEIGHT / 2;

  // Invoice and date
  drawText(bitmap, `Invoice: ${data.invoiceNumber || 'N/A'}`, leftMargin, y, { scale: 2 });
  y += LINE_HEIGHT;
  drawText(bitmap, `Date: ${data.date || new Date().toLocaleDateString()}`, leftMargin, y, { scale: 2 });
  y += LINE_HEIGHT;

  // Separator
  drawHLine(bitmap, leftMargin, width - leftMargin, y, 2);
  y += LINE_HEIGHT;

  // Items
  for (const item of (data.items || [])) {
    const qty = String(item.qty || 1).padEnd(3);
    const name = String(item.name).substring(0, 18).padEnd(18);
    const price = `N${Number(item.price || 0).toLocaleString()}`;
    drawText(bitmap, `${qty}${name} ${price}`, leftMargin, y, { scale: 2 });
    y += LINE_HEIGHT;
  }

  // Separator
  drawHLine(bitmap, leftMargin, width - leftMargin, y, 2);
  y += LINE_HEIGHT;

  // Total
  const totalStr = `TOTAL: N${Number(data.total || 0).toLocaleString()}`;
  drawText(bitmap, totalStr, leftMargin, y, { scale: 2, bold: true });
  y += LINE_HEIGHT;

  // Note
  if (data.note) {
    y += LINE_HEIGHT / 2;
    const noteWidth = data.note.length * (CHAR_WIDTH / 2);
    drawText(bitmap, data.note, centerX - Math.floor(noteWidth / 2), y, { scale: 2 });
    y += LINE_HEIGHT;
  }

  y += LINE_HEIGHT / 2;

  // Footer
  const footer1 = 'Thank you!';
  const footer2 = 'Powered by FigoBooks';
  drawText(bitmap, footer1, centerX - (footer1.length * CHAR_WIDTH / 2), y, { scale: 2 });
  y += LINE_HEIGHT;
  drawText(bitmap, footer2, centerX - (footer2.length * CHAR_WIDTH / 2), y, { scale: 2 });

  return bitmap;
}

/**
 * Render test print pattern to bitmap.
 */
function renderTestPrint() {
  const width = PRINT_WIDTH_PX;
  const height = 288;  // fixed height
  const bitmap = createBitmap(width, height);

  // Draw a simple thick horizontal line near top
  for (let y = 20; y < 30; y++) {
    for (let x = 10; x < width - 10; x++) {
      setPixel(bitmap, x, y, true);
    }
  }

  // Draw "TEST" text
  drawText(bitmap, 'TEST', 50, 60, { scale: 2 });

  // Another line
  for (let y = 120; y < 130; y++) {
    for (let x = 10; x < width - 10; x++) {
      setPixel(bitmap, x, y, true);
    }
  }

  return bitmap;
}

/**
 * Encode bitmap to CPCL format using the EG (Embedded Graphic) command.
 * Y50P accepts CPCL via BLE GATT on char FF02 (service FF00).
 *
 * CPCL EG format:  bit=1 → black (ink),  bit=0 → white (background).
 * Our bitmap uses the opposite convention (bit=1 → white, bit=0 → black),
 * so each byte is XOR-inverted before hex-encoding.
 *
 * @param {Object} bitmap
 * @returns {Buffer} CPCL data ready to send to Y50P
 */
function encodeCPCL(bitmap) {
  const { width, height, bytesPerRow, data } = bitmap;

  // Build hex string with inversion: 0=black in our bitmap → 1 (ink) in CPCL
  const hexParts = [];
  for (let i = 0; i < data.length; i++) {
    hexParts.push((data[i] ^ 0xFF).toString(16).padStart(2, '0').toUpperCase());
  }
  const hexStr = hexParts.join('');

  return Buffer.from(
    `! 0 200 200 ${height} 1\r\n` +
    `PAGE-WIDTH ${width}\r\n` +
    `EG ${bytesPerRow} ${height} 0 0 ${hexStr}\r\n` +
    `PRINT\r\n`,
    'utf-8'
  );
}

/**
 * Generate DCRASTER test print data.
 * @returns {Buffer} Raw bytes to send to Y50 printer
 */
function testPrint() {
  const bitmap = renderTestPrint();
  return encodeCPCL(bitmap);
}

/**
 * Generate DCRASTER receipt data.
 * @param {Object} data Receipt data
 * @returns {Buffer} Raw bytes to send to Y50 printer
 */
function receipt(data) {
  const bitmap = renderReceipt(data);
  return encodeCPCL(bitmap);
}

/**
 * Generate TSPL from raw text lines.
 * @param {string[]} lines Array of text lines to print
 * @returns {Buffer} Raw bytes to send to Y50 printer
 */
function fromTextLines(lines) {
  const width = PRINT_WIDTH_PX;
  const height = (lines.length + 4) * LINE_HEIGHT;
  const bitmap = createBitmap(width, height);

  let y = 8;
  const leftMargin = 4;

  for (const line of lines) {
    drawText(bitmap, line, leftMargin, y, { scale: 2 });
    y += LINE_HEIGHT;
  }

  return encodeCPCL(bitmap);
}

/**
 * Build a DCRASTER buffer from raw RGBA image data (e.g. from a canvas).
 * @param {Object} opts
 * @param {Buffer|Uint8Array} opts.data  - RGBA pixel bytes (4 bytes per pixel)
 * @param {number}            opts.width - image width in pixels
 * @param {number}            opts.height - image height in pixels
 * @returns {Buffer} DCRASTER encoded data ready to send to the printer
 */
function fromImageData({ data, width, height }) {
  // Scale the image horizontally to fit the print width (PRINT_WIDTH_PX)
  const scaleX = PRINT_WIDTH_PX / width;
  const outW   = PRINT_WIDTH_PX;
  const outH   = Math.round(height * scaleX);
  const bitmap = createBitmap(outW, outH);

  for (let y = 0; y < outH; y++) {
    const srcY = Math.floor(y / scaleX);
    for (let x = 0; x < outW; x++) {
      const srcX   = Math.floor(x / scaleX);
      const idx    = (srcY * width + srcX) * 4;
      const r      = data[idx];
      const g      = data[idx + 1];
      const b      = data[idx + 2];
      // Luminance threshold: dark pixels → black dot on label
      const lum    = 0.299 * r + 0.587 * g + 0.114 * b;
      setPixel(bitmap, x, y, lum < 128);
    }
  }

  return encodeCPCL(bitmap);
}

module.exports = {
  testPrint,
  receipt,
  fromTextLines,
  fromImageData,
  renderReceipt,
  renderTestPrint,
  encodeCPCL,
  PRINT_WIDTH_PX,
  DPI,
};
