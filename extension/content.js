/**
 * extension/content.js
 * Runs in the ISOLATED world (default for content scripts).
 *
 * Two responsibilities:
 *  1. Inject injected.js into the MAIN world so window.print can be overridden.
 *  2. Bridge postMessages from the main world to the background service worker.
 */
'use strict';

// --- 1. Inject the main-world script via a <script> tag ----------------------
// This is the only reliable MV3 way to override the page's own window.print
// across all Chromium versions without needing "world": "MAIN" support.
const s = document.createElement('script');
s.src = chrome.runtime.getURL('injected.js');
s.onload = () => s.remove();
(document.head || document.documentElement).appendChild(s);

// --- 2. Relay print requests from main world → background -------------------
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== 'FIGOBOOKS_PRINT_REQUEST') return;

  chrome.runtime.sendMessage({ action: 'print_page' }, (response) => {
    const ok = !chrome.runtime.lastError && !!response?.ok;
    window.postMessage({ type: 'FIGOBOOKS_PRINT_RESPONSE', ok }, '*');
  });
});
