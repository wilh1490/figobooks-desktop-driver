/**
 * platform/win/build.js
 *
 * Produces a self-contained Windows binary using Node.js SEA.
 * Requires Node.js 20+ on Windows.
 *
 * Output: dist\figo-driver-win.exe
 *
 * Usage: npm run build:win
 */

'use strict';

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const ROOT    = path.resolve(__dirname, '..', '..');
const DIST    = path.join(ROOT, 'dist');
const BINARY  = path.join(DIST, 'figo-driver-win.exe');
const SEA_CFG = path.join(ROOT, 'sea-config.json');
const SEA_BLOB= path.join(ROOT, 'sea-prep.blob');
const LOCAL_POSTJECT = path.join(ROOT, 'node_modules', '.bin', 'postject.cmd');

function run(cmd) {
  console.log(`  > ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: true });
}

console.log('\n[Build] FigoBooks Driver — Windows binary (Node SEA)\n');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);

const seaCfg = {
  main:   'main.js',
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
  useSnapshot:  false,
  useCodeCache: true,
};
fs.writeFileSync(SEA_CFG, JSON.stringify(seaCfg, null, 2));
console.log('[Build] Written sea-config.json');

run(`node --experimental-sea-config "${SEA_CFG}"`);
console.log('[Build] SEA blob generated');

// Copy node.exe
run(`copy "${process.execPath}" "${BINARY}"`);
console.log('[Build] node.exe copied');

// Remove existing signature if signtool is available
try {
  run(`signtool remove /s "${BINARY}"`);
} catch { /* signtool optional */ }

// Inject blob
const injectCmd = fs.existsSync(LOCAL_POSTJECT)
  ? `"${LOCAL_POSTJECT}" "${BINARY}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite`
  : `npx postject "${BINARY}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite`;
run(injectCmd);
console.log('[Build] SEA blob injected');

fs.unlinkSync(SEA_BLOB);
fs.unlinkSync(SEA_CFG);

console.log(`\n[Build] Done! Binary: ${BINARY}`);
console.log('[Build] Size:', Math.round(fs.statSync(BINARY).size / 1024 / 1024) + ' MB');
console.log('\nInstall as Windows Service:');
console.log('  node platform\\win\\service.js install\n');
