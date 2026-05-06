/**
 * src/y50Raster.js
 * CPCL encoder for Y50 label printers.
 * Converts text receipts to bitmap-in-CPCL (EG command) format.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Y50 print parameters
const DPI = 200;                    // 8 dots/mm
const PAPER_WIDTH_MM = 50;          // 50mm paper width
const PRINT_WIDTH_PX = Math.floor(PAPER_WIDTH_MM * DPI / 25.4); // ~394 pixels
const BYTES_PER_ROW = Math.ceil(PRINT_WIDTH_PX / 8);            // ~50 bytes
const REAL_FONT_FAMILY = 'NotoSansReceipt';
const RECEIPT_FONT_SIZE_OFFSET_PT = 12;
let PImage = null;
let _fontLoaded = false;

try {
  PImage = require('pureimage');
} catch {
  PImage = null;
}

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

function drawLogoImage(bitmap, logoImage, y) {
  if (!logoImage?.dataBase64 || !logoImage.width || !logoImage.height) return 0;
  const src = Buffer.from(String(logoImage.dataBase64), 'base64');
  const srcW = Number(logoImage.width);
  const srcH = Number(logoImage.height);
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) return 0;
  if (src.length < srcW * srcH * 4) return 0;

  const threshold = Number.isFinite(Number(logoImage.threshold)) ? Number(logoImage.threshold) : 170;
  const scaleX = bitmap.width / srcW;
  const outH = Math.max(1, Math.round(srcH * scaleX));

  for (let outY = 0; outY < outH; outY++) {
    const srcY = Math.min(srcH - 1, Math.floor(outY / scaleX));
    for (let outX = 0; outX < bitmap.width; outX++) {
      const srcX = Math.min(srcW - 1, Math.floor(outX / scaleX));
      const idx = (srcY * srcW + srcX) * 4;
      const alpha = src[idx + 3];
      if (alpha < 32) continue;
      const lum = 0.299 * src[idx] + 0.587 * src[idx + 1] + 0.114 * src[idx + 2];
      setPixel(bitmap, outX, y + outY, lum < threshold);
    }
  }

  return outH;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return NaN;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function moneyText(value, fallback = '') {
  const n = toNumber(value);
  if (Number.isFinite(n)) return `N${n.toLocaleString()}`;
  return cleanText(value) || fallback;
}

function itemAmountText(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '-';
  return String(n);
}

function normalizeFooter(footer) {
  const lines = Array.isArray(footer)
    ? footer.filter(Boolean).map(cleanText).filter(Boolean)
    : [];
  if (!lines.length) lines.push('Thank you!');
  if (!lines.some((line) => /powered\s+by\s+figobooks/i.test(line))) {
    lines.push('Powered by FigoBooks');
  }
  return lines;
}

function drawCenteredText(bitmap, text, y, options = {}) {
  const scale = options.scale || 2;
  const value = cleanText(text);
  if (!value) return;
  const charWidth = 5 * scale + scale;
  const textWidth = value.length * charWidth;
  const x = Math.max(0, Math.floor((bitmap.width - textWidth) / 2));
  drawText(bitmap, value, x, y, options);
}

function drawKeyValue(bitmap, label, value, y, options = {}) {
  const leftMargin = options.leftMargin || 4;
  const scale = options.scale || 2;
  const maxChars = options.maxChars || 32;
  const textValue = `${label}: ${cleanText(value)}`.slice(0, maxChars);
  drawText(bitmap, textValue, leftMargin, y, { scale, bold: options.bold });
}

function drawAmountLine(bitmap, label, value, y, options = {}) {
  const leftMargin = options.leftMargin || 4;
  const scale = options.scale || 2;
  const maxChars = options.maxChars || 32;
  const amount = cleanText(value);
  const labelText = cleanText(label);
  const spaces = Math.max(1, maxChars - labelText.length - amount.length);
  drawText(bitmap, `${labelText}${' '.repeat(spaces)}${amount}`.slice(0, maxChars), leftMargin, y, {
    scale,
    bold: options.bold,
  });
}

function formatColumns(columns, widths) {
  return columns
    .map((value, index) => {
      const textValue = cleanText(value);
      const width = widths[index];
      if (index === columns.length - 1) return textValue.slice(0, width).padStart(width);
      return textValue.slice(0, width).padEnd(width);
    })
    .join(' ');
}

function wrapTextByChars(text, maxChars) {
  const value = cleanText(text);
  if (!value) return [];
  const words = value.split(' ');
  const lines = [];
  let line = '';

  for (const word of words) {
    if (word.length > maxChars) {
      if (line) {
        lines.push(line);
        line = '';
      }
      for (let i = 0; i < word.length; i += maxChars) {
        lines.push(word.slice(i, i + maxChars));
      }
      continue;
    }
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines;
}

function receiptFont(basePt) {
  return `${basePt + RECEIPT_FONT_SIZE_OFFSET_PT}pt ${REAL_FONT_FAMILY}`;
}

function ensureRealFont() {
  if (!PImage) {
    console.log('[y50Raster] PImage not available, cannot use real fonts');
    return false;
  }
  if (_fontLoaded) {
    console.log('[y50Raster] Font already loaded: ' + REAL_FONT_FAMILY);
    return true;
  }
  console.log('[y50Raster] Loading real font for receipt rendering...');
  const candidates = [
    path.join(__dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf'),
    'C:/Windows/Fonts/NotoSans-Regular.ttf',
    path.join(__dirname, '..', 'node_modules', '@fontsource', 'noto-sans', 'files', 'noto-sans-latin-400-normal.woff'),
    path.join(__dirname, '..', 'node_modules', '@fontsource', 'noto-sans', 'files', 'noto-sans-latin-700-normal.woff'),
    'C:/Windows/Fonts/segoeui.ttf',
    'C:/Windows/Fonts/arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  const fontPath = candidates.find((p) => {
    const exists = fs.existsSync(p);
    if (exists) console.log('[y50Raster] Found font file: ' + p);
    return exists;
  });
  if (!fontPath) {
    console.log('[y50Raster] No suitable font file found');
    return false;
  }
  try {
    console.log('[y50Raster] Registering font: ' + fontPath + ' as "' + REAL_FONT_FAMILY + '"');
    PImage.registerFont(fontPath, REAL_FONT_FAMILY).loadSync();
    _fontLoaded = true;
    console.log('[y50Raster] Font loaded successfully!');
    return true;
  } catch (err) {
    console.log('[y50Raster] Font loading failed:', err.message);
    return false;
  }
}

function setPixelRgba(img, x, y, r, g, b, a = 255) {
  if (x < 0 || x >= img.width || y < 0 || y >= img.height) return;
  const idx = (y * img.width + x) * 4;
  img.data[idx] = r;
  img.data[idx + 1] = g;
  img.data[idx + 2] = b;
  img.data[idx + 3] = a;
}

function drawLogoRgba(img, logoImage, y) {
  if (!logoImage?.dataBase64 || !logoImage.width || !logoImage.height) return 0;
  const src = Buffer.from(String(logoImage.dataBase64), 'base64');
  const srcW = Number(logoImage.width);
  const srcH = Number(logoImage.height);
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || src.length < srcW * srcH * 4) return 0;

  const scaleX = img.width / srcW;
  const outH = Math.max(1, Math.round(srcH * scaleX));
  for (let outY = 0; outY < outH; outY++) {
    const srcY = Math.min(srcH - 1, Math.floor(outY / scaleX));
    for (let outX = 0; outX < img.width; outX++) {
      const srcX = Math.min(srcW - 1, Math.floor(outX / scaleX));
      const srcIdx = (srcY * srcW + srcX) * 4;
      const alpha = src[srcIdx + 3] / 255;
      if (alpha <= 0) continue;
      const bg = 255 * (1 - alpha);
      setPixelRgba(
        img,
        outX,
        y + outY,
        Math.round(src[srcIdx] * alpha + bg),
        Math.round(src[srcIdx + 1] * alpha + bg),
        Math.round(src[srcIdx + 2] * alpha + bg),
        255
      );
    }
  }
  return outH;
}

function measureText(ctx, text) {
  const metrics = ctx.measureText(cleanText(text));
  return Number(metrics?.width || 0);
}

function fitText(ctx, text, maxWidth) {
  let value = cleanText(text);
  if (measureText(ctx, value) <= maxWidth) return value;
  while (value.length > 1 && measureText(ctx, `${value}..`) > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}..`;
}

function wrapTextReal(ctx, text, maxWidth) {
  const value = cleanText(text);
  if (!value) return [];
  const words = value.split(' ');
  const lines = [];
  let line = '';

  for (const word of words) {
    if (measureText(ctx, word) > maxWidth) {
      if (line) {
        lines.push(line);
        line = '';
      }
      let chunk = '';
      for (const char of word) {
        const next = chunk + char;
        if (chunk && measureText(ctx, next) > maxWidth) {
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
    if (measureText(ctx, next) <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines;
}

function drawCenteredWrappedReal(ctx, text, y, maxWidth, lineHeight, options = {}) {
  const lines = wrapTextReal(ctx, text, maxWidth);
  for (const line of lines) {
    drawCenteredReal(ctx, line, y, options);
    y += lineHeight;
  }
  return y;
}

function drawTextReal(ctx, text, x, y, options = {}) {
  const value = cleanText(text);
  if (!value) return;
  if (options.bold) {
    const strength = options.boldStrength || 0.6;
    ctx.fillText(value, x, y);
    ctx.fillText(value, x + strength, y);
    if (strength >= 1) ctx.fillText(value, x, y + 0.6);
    return;
  }
  ctx.fillText(value, x, y);
}

function drawCenteredReal(ctx, text, y, options = {}) {
  const value = cleanText(text);
  if (!value) return;
  const x = Math.max(0, Math.floor((PRINT_WIDTH_PX - measureText(ctx, value)) / 2));
  drawTextReal(ctx, value, x, y, options);
}

function drawRightReal(ctx, text, rightX, y, options = {}) {
  const value = cleanText(text);
  drawTextReal(ctx, value, rightX - measureText(ctx, value), y, options);
}

function rgbaToBitmap(data, width, height, threshold = 210) {
  const bitmap = createBitmap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      setPixel(bitmap, x, y, lum < threshold);
    }
  }
  return bitmap;
}

function renderReceiptWithRealFont(data) {
  if (!ensureRealFont()) return null;

  const width = PRINT_WIDTH_PX;
  const items = Array.isArray(data.items) ? data.items : [];
  const taxes = Array.isArray(data.taxes) ? data.taxes : [];
  const footer = normalizeFooter(data.footer);
  const receiptId = data.receiptId || data.invoiceNumber || data.ref || 'N/A';
  const receiptTime = data.time || data.date || new Date().toLocaleDateString();
  const status = cleanText(data.status);
  const staff = cleanText(data.staff);
  const soldTo = cleanText(data.soldTo || data.customer);
  const totalNum = toNumber(data.totalValue ?? data.total ?? data.amount);
  const computedTotal = items.reduce((sum, item) => {
    const itemTotal = toNumber(item.total ?? item.lineTotal);
    if (Number.isFinite(itemTotal)) return sum + itemTotal;
    const qty = toNumber(item.qty || 1);
    const unit = toNumber(item.price || item.unitPrice);
    return Number.isFinite(qty) && Number.isFinite(unit) ? sum + qty * unit : sum;
  }, 0);
  const receiptTotal = Number.isFinite(totalNum) ? totalNum : computedTotal;
  const hasLogoImage = Boolean(data.logoImage?.dataBase64 && data.logoImage.width && data.logoImage.height);
  const logoHeightPx = hasLogoImage
    ? Math.max(1, Math.round(Number(data.logoImage.height) * (width / Number(data.logoImage.width))))
    : 0;
  const itemWrapExtra = items.reduce((sum, item) => {
    const name = cleanText(item.name || item.label || 'Item');
    return sum + Math.max(0, Math.ceil(name.length / 16) - 1);
  }, 0);
  const addressWrapExtra = data.businessAddress ? Math.max(0, Math.ceil(cleanText(data.businessAddress).length / 26) - 1) : 0;

  const height = Math.max(
    1600,
    760 + logoHeightPx + (items.length * 52) + (itemWrapExtra * 42) + (addressWrapExtra * 42) + (taxes.length * 44) + (footer.length * 52) +
      (soldTo ? 44 : 0) + (staff ? 44 : 0) + (data.balance ? 44 : 0)
  );
  const img = PImage.make(width, height);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';

  let y = 12;
  const left = 14;
  const right = width - 14;

  if (hasLogoImage) {
    y += drawLogoRgba(img, data.logoImage, y);
    y += 8;
  }

  ctx.font = receiptFont(24);
  drawCenteredReal(ctx, data.businessName || 'FigoBooks', y + 48, { bold: true, boldStrength: 1.4 });
  y += 68;

  ctx.font = receiptFont(11);
  if (data.businessAddress) {
    y = drawCenteredWrappedReal(ctx, data.businessAddress, y + 34, width - 28, 34);
    y += 4;
  }
  if (data.businessPhone) {
    drawCenteredReal(ctx, data.businessPhone, y + 34);
    y += 38;
  }

  y += 6;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 34;

  ctx.font = receiptFont(12);
  drawTextReal(ctx, `Ref: ${fitText(ctx, receiptId, 260)}`, left, y);
  y += 38;
  drawTextReal(ctx, `Time: ${fitText(ctx, receiptTime, 250)}`, left, y);
  y += 38;
  if (soldTo) {
    drawTextReal(ctx, `Sold to: ${fitText(ctx, soldTo, 230)}`, left, y);
    y += 38;
  }
  if (staff) {
    drawTextReal(ctx, `Staff: ${fitText(ctx, staff, 245)}`, left, y);
    y += 38;
  }

  y += 4;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 34;

  ctx.font = receiptFont(11);
  drawTextReal(ctx, 'Qty', left, y, { bold: true, boldStrength: 1.2 });
  drawTextReal(ctx, 'Item', 52, y, { bold: true, boldStrength: 1.2 });
  drawRightReal(ctx, 'Price', 292, y, { bold: true, boldStrength: 1.2 });
  drawRightReal(ctx, 'Total', right, y, { bold: true, boldStrength: 1.2 });
  y += 38;

  ctx.font = receiptFont(11);
  for (const item of items) {
    const qty = cleanText(item.qty || 1);
    const nameLines = wrapTextReal(ctx, item.name || item.label || 'Item', 145);
    const unit = toNumber(item.price || item.unitPrice);
    const lineTotal = toNumber(item.total ?? item.lineTotal);
    drawTextReal(ctx, qty, left, y);
    drawTextReal(ctx, nameLines[0] || 'Item', 52, y);
    drawRightReal(ctx, itemAmountText(unit), 292, y);
    drawRightReal(ctx, itemAmountText(lineTotal), right, y);
    y += 34;
    for (const line of nameLines.slice(1)) {
      drawTextReal(ctx, line, 52, y);
      y += 34;
    }
    y += 10;
  }

  y += 4;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 36;

  ctx.font = receiptFont(12);
  if (data.subtotalValue) {
    drawTextReal(ctx, data.subtotalLabel || 'Subtotal', left, y);
    drawRightReal(ctx, moneyText(data.subtotalValue), right, y);
    y += 38;
  }
  for (const tax of taxes) {
    drawTextReal(ctx, fitText(ctx, tax.label || 'Tax', 230), left, y);
    drawRightReal(ctx, moneyText(tax.value), right, y);
    y += 38;
  }

  ctx.font = receiptFont(14);
  drawTextReal(ctx, data.totalLabel || 'Total', left, y, { bold: true, boldStrength: 1.2 });
  drawRightReal(ctx, `N${receiptTotal.toLocaleString()}`, right, y, { bold: true, boldStrength: 1.2 });
  y += 42;

  if (data.balance) {
    ctx.font = receiptFont(12);
    drawTextReal(ctx, 'Balance', left, y, { bold: true });
    drawRightReal(ctx, moneyText(data.balance), right, y, { bold: true });
    y += 40;
  }

  y += 4;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 40;

  if (status) {
    ctx.font = receiptFont(14);
    drawCenteredReal(ctx, `** ${status} **`, y, { bold: true, boldStrength: 1.2 });
    y += 44;
  }

  ctx.font = receiptFont(11);
  for (const line of footer) {
    drawCenteredReal(ctx, line, y);
    y += 38;
  }

  if (y + 80 > height) {
    console.log(`[y50Raster] Receipt render height nearly overflowed: used=${Math.ceil(y)} canvas=${height}`);
  }
  const usedHeight = Math.min(height, Math.ceil(y + 80));
  return rgbaToBitmap(img.data, width, usedHeight, 225);
}

/**
 * Render a receipt to bitmap.
 * @param {Object} data Receipt data
 * @returns {Object} Bitmap object with width, height, bytesPerRow, data
 */
function renderReceipt(data) {
  const receiptId = data.receiptId || data.invoiceNumber || data.ref || 'N/A';
  const receiptTime = data.time || data.date || new Date().toLocaleDateString();
  const status = cleanText(data.status);
  const staff = cleanText(data.staff);
  const soldTo = cleanText(data.soldTo || data.customer);
  const taxes = Array.isArray(data.taxes) ? data.taxes : [];
  const footer = normalizeFooter(data.footer);
  const computedTotalFromItems = (data.items || []).reduce((sum, item) => {
    const itemTotal = toNumber(item.total ?? item.lineTotal);
    if (Number.isFinite(itemTotal)) return sum + itemTotal;
    const qty = toNumber(item.qty || 1);
    const unit = toNumber(item.price || item.unitPrice);
    if (Number.isFinite(qty) && Number.isFinite(unit)) return sum + (qty * unit);
    return sum;
  }, 0);
  const totalNum = toNumber(data.totalValue ?? data.total ?? data.amount);
  const receiptTotal = Number.isFinite(totalNum) ? totalNum : computedTotalFromItems;
  const hasLogoImage = Boolean(data.logoImage?.dataBase64 && data.logoImage.width && data.logoImage.height);
  const logoHeightPx = hasLogoImage
    ? Math.max(1, Math.round(Number(data.logoImage.height) * (PRINT_WIDTH_PX / Number(data.logoImage.width))))
    : 0;
  const businessAddressLines = wrapTextByChars(data.businessAddress, 30);
  const itemNameLines = (data.items || []).map((item) => wrapTextByChars(item.name || item.label || 'Item', 11));

  // Calculate height based on content
  let lineCount = 0;
  lineCount += 2; // business name (double size)
  lineCount += businessAddressLines.length;
  if (data.businessPhone) lineCount += 1;
  lineCount += 1; // separator
  lineCount += 2; // ref + time
  if (soldTo) lineCount += 1;
  if (staff) lineCount += 1;
  lineCount += 1; // separator
  lineCount += 1; // item table header
  lineCount += itemNameLines.reduce((sum, lines) => sum + Math.max(1, lines.length), 0);
  lineCount += 2; // separator + spacing
  if (data.subtotalValue) lineCount += 1;
  lineCount += taxes.length;
  lineCount += 1; // total
  if (data.balance) lineCount += 1;
  lineCount += 1; // separator
  if (status) lineCount += 1;
  if (data.note) lineCount += 2;
  lineCount += footer.length;
  lineCount += 4; // extra margin

  const width = PRINT_WIDTH_PX;
  const height = lineCount * LINE_HEIGHT + logoHeightPx + (hasLogoImage ? 8 : 0);
  const bitmap = createBitmap(width, height);

  let y = 8;
  const leftMargin = 4;
  const centerX = Math.floor(width / 2);

  if (hasLogoImage) {
    y += drawLogoImage(bitmap, data.logoImage, y);
    y += 8;
  }

  // Business name (centered, bold, double size)
  const bizName = data.businessName || 'FigoBooks';
  const bizNameWidth = bizName.length * CHAR_WIDTH * 2;
  drawText(bitmap, bizName, centerX - Math.floor(bizNameWidth / 2), y, { scale: 4, bold: true });
  y += LINE_HEIGHT * 2;

  // Business address (centered)
  for (const line of businessAddressLines) {
    drawCenteredText(bitmap, line, y, { scale: 2 });
    y += LINE_HEIGHT;
  }
  if (data.businessPhone) {
    drawCenteredText(bitmap, data.businessPhone, y, { scale: 2 });
    y += LINE_HEIGHT;
  }

  drawHLine(bitmap, leftMargin, width - leftMargin, y, 2);
  y += LINE_HEIGHT;

  // Reference and time
  drawKeyValue(bitmap, 'Ref', receiptId, y);
  y += LINE_HEIGHT;
  drawKeyValue(bitmap, 'Time', receiptTime, y);
  y += LINE_HEIGHT;
  if (soldTo) {
    drawKeyValue(bitmap, 'Sold to', soldTo, y);
    y += LINE_HEIGHT;
  }
  if (staff) {
    drawKeyValue(bitmap, 'Staff', staff, y);
    y += LINE_HEIGHT;
  }

  // Separator
  drawHLine(bitmap, leftMargin, width - leftMargin, y, 2);
  y += LINE_HEIGHT;

  drawText(bitmap, formatColumns(['Qty', 'Item', 'Price', 'Total'], [3, 11, 7, 8]), leftMargin, y, { scale: 2, bold: true });
  y += LINE_HEIGHT;

  // Items
  for (let i = 0; i < (data.items || []).length; i++) {
    const item = data.items[i];
    const qty = cleanText(item.qty || 1);
    const nameLines = itemNameLines[i]?.length ? itemNameLines[i] : ['Item'];
    const lineTotalNum = toNumber(item.total ?? item.lineTotal);
    const unitPriceNum = toNumber(item.price || item.unitPrice);
    const priceText = itemAmountText(unitPriceNum);
    const totalText = Number.isFinite(lineTotalNum) ? itemAmountText(lineTotalNum) : itemAmountText(unitPriceNum);
    drawText(bitmap, formatColumns([qty, nameLines[0], priceText, totalText], [3, 11, 7, 8]), leftMargin, y, { scale: 2 });
    y += LINE_HEIGHT;
    for (const line of nameLines.slice(1)) {
      drawText(bitmap, formatColumns(['', line, '', ''], [3, 11, 7, 8]), leftMargin, y, { scale: 2 });
      y += LINE_HEIGHT;
    }
  }

  // Separator
  y += LINE_HEIGHT / 2;
  drawHLine(bitmap, leftMargin, width - leftMargin, y, 2);
  y += LINE_HEIGHT;

  if (data.subtotalValue) {
    drawAmountLine(bitmap, data.subtotalLabel || 'Subtotal', moneyText(data.subtotalValue), y);
    y += LINE_HEIGHT;
  }

  for (const tax of taxes) {
    drawAmountLine(bitmap, tax.label || 'Tax', moneyText(tax.value), y);
    y += LINE_HEIGHT;
  }

  // Total
  drawAmountLine(bitmap, data.totalLabel || 'Total', `N${receiptTotal.toLocaleString()}`, y, { bold: true });
  y += LINE_HEIGHT;

  if (data.balance) {
    drawAmountLine(bitmap, 'Balance', moneyText(data.balance), y, { bold: true });
    y += LINE_HEIGHT;
  }

  drawHLine(bitmap, leftMargin, width - leftMargin, y, 2);
  y += LINE_HEIGHT;

  if (status) {
    drawCenteredText(bitmap, `** ${status} **`, y, { scale: 2, bold: true });
    y += LINE_HEIGHT;
  }

  // Note
  if (data.note) {
    y += LINE_HEIGHT / 2;
    const noteWidth = data.note.length * (CHAR_WIDTH / 2);
    drawText(bitmap, data.note, centerX - Math.floor(noteWidth / 2), y, { scale: 2 });
    y += LINE_HEIGHT;
  }

  y += LINE_HEIGHT / 2;

  // Footer
  for (const line of footer) {
    drawCenteredText(bitmap, line, y, { scale: 2 });
    y += LINE_HEIGHT;
  }

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
 * Encode the same Y50 bitmap as ESC/POS GS v 0 raster.
 * Some Y50 USB firmware accepts only raster graphics over cable while BLE uses CPCL.
 */
function encodeEscposRaster(bitmap) {
  const { height, bytesPerRow, data } = bitmap;
  const raster = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    // Our bitmap stores white=1 and black=0; ESC/POS raster expects black=1.
    raster[i] = data[i] ^ 0xff;
  }

  return Buffer.concat([
    Buffer.from([
      0x1b, 0x40,
      0x1d, 0x76, 0x30, 0x00,
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
    ]),
    raster,
    Buffer.from([0x0a, 0x0a, 0x0a]),
  ]);
}

/**
 * Generate DCRASTER test print data.
 * @returns {Buffer} Raw bytes to send to Y50 printer
 */
function testPrint() {
  const bitmap = renderTestPrint();
  return encodeCPCL(bitmap);
}

function testPrintEscposRaster() {
  const bitmap = renderTestPrint();
  return encodeEscposRaster(bitmap);
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

function receiptEscposRaster(data) {
  console.log('[y50Raster] receiptEscposRaster called');
  const realFontBitmap = renderReceiptWithRealFont(data);
  if (realFontBitmap) {
    console.log('[y50Raster] Using real font renderer');
  } else {
    console.log('[y50Raster] Falling back to bitmap font renderer');
  }
  const bitmap = realFontBitmap || renderReceipt(data);
  return encodeEscposRaster(bitmap);
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
  testPrintEscposRaster,
  receipt,
  receiptEscposRaster,
  fromTextLines,
  fromImageData,
  renderReceipt,
  renderTestPrint,
  encodeCPCL,
  encodeEscposRaster,
  PRINT_WIDTH_PX,
  DPI,
};
