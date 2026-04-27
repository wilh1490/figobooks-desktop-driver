/**
 * platform/mac/build-extension.js
 *
 * Packs the extension/ folder as a CRX3 archive using only Node.js built-ins.
 * No npm packages required — CRX3 format is implemented from scratch.
 *
 * Output:
 *   dist/figobooks-extension.crx   — installable CRX3 archive
 *   dist/extension-id.txt          — 32-char Chromium extension ID (used by install.js)
 *   dist/extension-key.pem         — RSA-2048 private key (generated once, keep secret)
 *
 * Usage:  node platform/mac/build-extension.js
 *         npm run build:extension
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { execSync } = require('child_process');

const ROOT    = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, 'extension');
const DIST    = path.join(ROOT, 'dist');
const KEY_PATH = path.join(DIST, 'extension-key.pem');
const CRX_OUT  = path.join(DIST, 'figobooks-extension.crx');
const ID_OUT   = path.join(DIST, 'extension-id.txt');

console.log('\n[Extension] Building FigoBooks Printer extension (CRX3)\n');

// ── 1. Ensure dist/ exists ──────────────────────────────────────────────────
if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// ── 2. Load or generate private key ────────────────────────────────────────
let privateKey;
if (fs.existsSync(KEY_PATH)) {
  privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
  console.log('[Extension] Loaded existing key.pem');
} else {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = kp.privateKey;
  fs.writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8');
  console.log('[Extension] Generated new RSA-2048 key → dist/extension-key.pem');
}

// ── 3. Derive public key material ──────────────────────────────────────────
const publicKey  = crypto.createPublicKey(privateKey);
const pubKeyDER  = publicKey.export({ type: 'spki', format: 'der' });
const pubKeyB64  = pubKeyDER.toString('base64');

// Extension ID = nibble-encode( SHA-256(pubKeyDER)[0:16] )
// Each nibble → 'a'–'p'  (0=a … 15=p), high nibble first
const pubKeyHash  = crypto.createHash('sha256').update(pubKeyDER).digest();
const extensionId = Array.from(pubKeyHash.slice(0, 16))
  .map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 0xf)))
  .join('');

console.log(`[Extension] Extension ID: ${extensionId}`);

// ── 4. Copy extension source into a temp build dir ─────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figobooks-ext-'));

// Copy all source files except key.pem
for (const f of fs.readdirSync(EXT_DIR)) {
  if (f === 'key.pem') continue;
  fs.copyFileSync(path.join(EXT_DIR, f), path.join(tmpDir, f));
}

// Inject "key" into manifest.json so unpacked installs/devtools show the correct ID
const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
manifest.key = pubKeyB64;
fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// Copy icons from assets/ (16, 48≈64, 128)
const iconMap = { 'icon-16.png': 'icon-16.png', 'icon-48.png': 'icon-64.png', 'icon-128.png': 'icon-128.png' };
for (const [dest, src] of Object.entries(iconMap)) {
  const srcPath = path.join(ROOT, 'assets', src);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, path.join(tmpDir, dest));
  } else {
    console.warn(`[Extension] Warning: asset not found: ${srcPath}`);
  }
}

// ── 5. Create ZIP archive of the temp dir ──────────────────────────────────
const zipPath = path.join(DIST, '_ext-temp.zip');
execSync(`cd "${tmpDir}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });
const zipData = fs.readFileSync(zipPath);
fs.unlinkSync(zipPath);

// Clean up temp dir
fs.rmSync(tmpDir, { recursive: true, force: true });

// ── 6. Build CRX3 ──────────────────────────────────────────────────────────
//
// CRX3 wire format:
//   magic[4]         "Cr24"
//   version[4]       3 (LE)
//   header_size[4]   size of CrxFileHeader protobuf (LE)
//   header[N]        serialised CrxFileHeader
//   zip[...]         zip payload
//
// CrxFileHeader (protobuf):
//   sha256_with_rsa[2]:   AsymmetricKeyProof   { public_key[1], signature[2] }
//   signed_header_data[10]: bytes              = serialised SignedData
//
// SignedData (protobuf):
//   crx_id[1]: bytes = first 16 bytes of SHA-256(pubKeyDER)
//
// Signed message = "CRX3 SignedData\x00" || uint32LE(len(shd)) || shd || zip

// ── protobuf helpers ────────────────────────────────────────────────────────
function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

// Encode a bytes/embedded-message field (wire type 2)
function protoBytes(fieldNum, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(buf.length), buf]);
}

// ── build SignedData proto ──────────────────────────────────────────────────
const crxId           = pubKeyHash.slice(0, 16);
const signedHeaderData = protoBytes(1, crxId);  // SignedData { crx_id: bytes[1] }

// ── compute signature ───────────────────────────────────────────────────────
const prefix  = Buffer.from('CRX3 SignedData\x00');
const shdLen  = Buffer.alloc(4);
shdLen.writeUInt32LE(signedHeaderData.length, 0);
const toSign  = Buffer.concat([prefix, shdLen, signedHeaderData, zipData]);
const signer  = crypto.createSign('SHA256');
signer.update(toSign);
const signature = signer.sign(privateKey);

// ── assemble CrxFileHeader proto ───────────────────────────────────────────
const proof      = Buffer.concat([protoBytes(1, pubKeyDER), protoBytes(2, signature)]);
const fileHeader = Buffer.concat([protoBytes(2, proof), protoBytes(10, signedHeaderData)]);

// ── assemble final CRX3 binary ─────────────────────────────────────────────
const magic     = Buffer.from('Cr24');
const version   = Buffer.alloc(4); version.writeUInt32LE(3, 0);
const headerLen = Buffer.alloc(4); headerLen.writeUInt32LE(fileHeader.length, 0);
const crx       = Buffer.concat([magic, version, headerLen, fileHeader, zipData]);

fs.writeFileSync(CRX_OUT,  crx);
fs.writeFileSync(ID_OUT, extensionId, 'utf8');

console.log(`[Extension] CRX3 written → ${CRX_OUT}`);
console.log(`[Extension] Extension ID  → ${ID_OUT}`);
console.log(`[Extension] Size: ${Math.round(crx.length / 1024)} KB\n`);
console.log('Next step: node platform/mac/install.js\n');
