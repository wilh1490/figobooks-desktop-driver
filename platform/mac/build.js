/**
 * platform/mac/build.js
 *
 * Produces a self-contained macOS binary using Node.js Single Executable Application (SEA).
 * Requires Node.js 20+. No external build tools needed.
 *
 * Output: dist/figo-driver-macos  (runs on both arm64 and x64 — whichever arch built it)
 *
 * Usage: npm run build:mac
 */

'use strict';

const { execSync }  = require('child_process');
const fs            = require('fs');
const path          = require('path');

const ROOT    = path.resolve(__dirname, '..', '..');
const DIST    = path.join(ROOT, 'dist');
const BINARY  = path.join(DIST, 'figo-driver-macos');
const SEA_CFG = path.join(ROOT, 'sea-config.json');
const SEA_BLOB= path.join(ROOT, 'sea-prep.blob');

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

console.log('\n[Build] FigoBooks Driver — macOS binary (Node SEA)\n');

// 1. Ensure dist/ exists
if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);

// 2. Write SEA config
const seaCfg = {
  main:                  'main.js',
  output:                SEA_BLOB,
  disableExperimentalSEAWarning: true,
  useSnapshot:           false,
  useCodeCache:          true,
  assets: {
    // Bundle the UI and assets so the binary is fully self-contained
    'ui/index.html': path.join(ROOT, 'ui', 'index.html'),
    'ui/style.css':  path.join(ROOT, 'ui', 'style.css'),
    'ui/setup.js':   path.join(ROOT, 'ui', 'setup.js'),
  },
};
fs.writeFileSync(SEA_CFG, JSON.stringify(seaCfg, null, 2));
console.log('[Build] Written sea-config.json');

// 3. Generate blob
run(`node --experimental-sea-config "${SEA_CFG}"`, { cwd: ROOT });
console.log('[Build] SEA blob generated');

// 4. Copy the node binary as base
run(`cp "$(which node)" "${BINARY}"`);
run(`codesign --remove-signature "${BINARY}"`, { cwd: ROOT });
console.log('[Build] Node binary copied & signature stripped');

// 5. Inject the blob
run(`npx postject "${BINARY}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`);
console.log('[Build] SEA blob injected');

// 6. Re-sign (ad-hoc, for local use; replace with --sign for distribution)
run(`codesign --sign - "${BINARY}"`);
console.log('[Build] Binary re-signed (ad-hoc)');

// 7. Clean up intermediary files
fs.unlinkSync(SEA_BLOB);
fs.unlinkSync(SEA_CFG);

console.log(`\n[Build] Done! Binary: ${BINARY}`);
console.log('[Build] Size:', Math.round(fs.statSync(BINARY).size / 1024 / 1024) + ' MB');
console.log('\nInstall as LaunchAgent:');
console.log(`  ${BINARY} --install\n`);
