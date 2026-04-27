/**
 * extension/injected.js
 * Runs in the MAIN world (injected via DOM by content.js).
 * Overrides window.print and intercepts Ctrl+P / Cmd+P.
 * Communicates back to the isolated-world content.js via postMessage.
 */
(function () {
  'use strict';

  // Guard: don't inject twice (e.g. in iframes that also run the content script)
  if (window.__figobooksHooked) return;
  window.__figobooksHooked = true;

  const _nativePrint = window.print.bind(window);

  // Override window.print
  window.print = function printViaFigoBooks() {
    // Ask isolated-world content.js to forward to background service worker
    window.postMessage({ type: 'FIGOBOOKS_PRINT_REQUEST' }, '*');

    // One-shot listener: if driver unavailable, fall back to native print
    function onResponse(event) {
      if (!event.data || event.data.type !== 'FIGOBOOKS_PRINT_RESPONSE') return;
      window.removeEventListener('message', onResponse);
      if (!event.data.ok) _nativePrint();
    }
    window.addEventListener('message', onResponse);

    // Safety timeout: if no response in 5 s, fall back
    setTimeout(() => {
      window.removeEventListener('message', onResponse);
    }, 5000);
  };

  // Intercept Ctrl+P / Cmd+P before the browser opens its print dialog
  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.print();
    }
  }, true /* capture phase */);
})();
