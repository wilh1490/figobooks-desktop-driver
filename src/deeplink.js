/**
 * src/deeplink.js
 * Registers and handles the figoprint:// custom URL scheme.
 * On macOS, opening figoprint://print?id=INV203 will trigger a print.
 *
 * Registration: the LaunchAgent plist registers the URL scheme via
 * the LSURLTypes key in the app's Info.plist-equivalent.
 * For a pure Node binary, we use a helper .app shim or the open protocol
 * trick — here we watch for SIGCONT with an env var as a simpler approach,
 * but the primary mechanism is the FIGOPRINT_URL env var set by the shim.
 */

'use strict';

const queue = require('./queue');

function register() {
  // When macOS opens a figoprint:// URL, it can launch the process with
  // the URL in the FIGOPRINT_URL environment variable (set by our shim app).
  // We also watch for it arriving via stdin for the pkg-bundled binary.
  const url = process.env.FIGOPRINT_URL;
  if (url) _handle(url);

  // Listen for runtime URL triggers sent via stdin (used by the shim).
  // Only attach if stdin is a pipe/file — not a TTY — to avoid blocking
  // the event loop when the process is run interactively or as a daemon.
  if (!process.stdin.isTTY) {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (data) => {
      const line = data.trim();
      if (line.startsWith('figoprint://')) _handle(line);
    });
  }
}

function _handle(urlString) {
  try {
    const url = new URL(urlString);
    const host = url.hostname; // e.g. "print", "open"

    switch (host) {
      case 'print': {
        const id   = url.searchParams.get('id')   || 'unknown';
        const type = url.searchParams.get('type') || 'receipt';
        queue.enqueue(type, { invoiceNumber: id });
        break;
      }
      case 'setup': {
        // Re-open setup wizard
        import('open').then(({ default: open }) => {
          open('http://127.0.0.1:3838/setup');
        });
        break;
      }
      case 'status': {
        import('open').then(({ default: open }) => {
          open('http://127.0.0.1:3838/status');
        });
        break;
      }
      default:
        break;
    }
  } catch {}
}

module.exports = { register };
