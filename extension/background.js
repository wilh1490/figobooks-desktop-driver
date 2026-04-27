/**
 * extension/background.js
 * Service worker — receives print requests from content.js,
 * captures the visible tab, scales to printer width, and POSTs to localhost:3838.
 */
'use strict';

const DRIVER_URL  = 'http://localhost:3838';
const PRINT_WIDTH = 394; // Y50 / MPT-II printer width in px

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'print_page') return false;

  handlePrint(sender)
    .then(result  => sendResponse(result))
    .catch(err    => sendResponse({ ok: false, error: err.message }));

  return true; // keep message channel open for async response
});

async function handlePrint(sender) {
  // 1. Check driver is online and has a connected printer
  const statusRes = await fetch(`${DRIVER_URL}/status`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!statusRes.ok) throw new Error(`Driver unreachable (HTTP ${statusRes.status})`);

  const status = await statusRes.json();
  if (!status.printerConnected) {
    // Return ok:false so injected.js falls back to native browser print
    return { ok: false, reason: 'no_printer' };
  }

  // 2. Capture the visible tab as PNG
  const dataUrl = await chrome.tabs.captureVisibleTab(
    sender.tab.windowId,
    { format: 'png' }
  );

  // 3. Decode PNG → bitmap → scale to printer width using OffscreenCanvas
  const blob   = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const scale       = PRINT_WIDTH / bitmap.width;
  const printHeight = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(PRINT_WIDTH, printHeight);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PRINT_WIDTH, printHeight);
  ctx.drawImage(bitmap, 0, 0, PRINT_WIDTH, printHeight);

  const imageData = ctx.getImageData(0, 0, PRINT_WIDTH, printHeight);
  const bytes     = imageData.data; // Uint8ClampedArray RGBA

  // 4. Encode RGBA to base64 (chunked to avoid call-stack overflow)
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const dataBase64 = btoa(binary);

  // 5. POST to driver
  const res = await fetch(`${DRIVER_URL}/print`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      type: 'image',
      data: { dataBase64, width: PRINT_WIDTH, height: printHeight },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`Driver error HTTP ${res.status}`);
  return { ok: true };
}
