/**
 * platform/mac/build-pkg.js
 *
 * Builds a self-contained macOS .pkg installer that:
 *   - Installs the full app + node_modules to /usr/local/lib/figo-driver/
 *   - Bundles the current Node.js binary so no runtime is needed on target Mac
 *   - Creates a launcher script at /usr/local/bin/figo-driver
 *   - Installs a LaunchAgent that auto-starts the driver on login
 *
 * Usage: npm run build:pkg:mac
 * Output: dist/FigoBooks-Driver.pkg
 */

'use strict';

const { execSync }   = require('child_process');
const fs             = require('fs');
const path           = require('path');
const os             = require('os');

const ROOT    = path.resolve(__dirname, '..', '..');
const DIST    = path.join(ROOT, 'dist');
const STAGING = path.join(ROOT, 'pkg-staging');
const SCRIPTS = path.join(ROOT, 'pkg-scripts');
const PKG_OUT = path.join(DIST, 'FigoBooks-Driver.pkg');

// Files / folders from the project to include
const INCLUDE = ['main.js', 'src', 'ui', 'assets', 'package.json'];

// ── 0. Pre-build the extension CRX if not already built ─────────────────────
console.log('\n[Build PKG] FigoBooks Driver — macOS .pkg installer\n');
const CRX_PATH = path.join(DIST, 'figobooks-extension.crx');
const EXT_ID_PATH = path.join(DIST, 'extension-id.txt');
if (!fs.existsSync(CRX_PATH) || !fs.existsSync(EXT_ID_PATH)) {
  console.log('[Build PKG] Extension CRX not found — building it first...');
  run(`node "${path.join(__dirname, 'build-extension.js')}"`, { cwd: ROOT });
} else {
  console.log('[Build PKG] Extension CRX already built, skipping.');
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

// ── 1. Clean staging ────────────────────────────────────────────────────────
console.log('\n[Build PKG] FigoBooks Driver — macOS .pkg installer\n');
if (fs.existsSync(STAGING)) fs.rmSync(STAGING, { recursive: true });
if (fs.existsSync(SCRIPTS)) fs.rmSync(SCRIPTS, { recursive: true });
if (!fs.existsSync(DIST))   fs.mkdirSync(DIST);

// ── 2. Create staging directory tree ────────────────────────────────────────
// App goes to: /usr/local/lib/figo-driver/
const APP_DEST    = path.join(STAGING, 'usr', 'local', 'lib', 'figo-driver');
// Launcher script: /usr/local/bin/figo-driver
const BIN_DEST    = path.join(STAGING, 'usr', 'local', 'bin');

fs.mkdirSync(APP_DEST, { recursive: true });
fs.mkdirSync(BIN_DEST, { recursive: true });
fs.mkdirSync(SCRIPTS,  { recursive: true });

// ── 3. Copy app source files ─────────────────────────────────────────────────
console.log('[Build PKG] Copying app source files...');
for (const name of INCLUDE) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) continue;
  const st = fs.statSync(src);
  if (st.isDirectory()) copyDir(src, path.join(APP_DEST, name));
  else fs.copyFileSync(src, path.join(APP_DEST, name));
}

// Bundle the pre-built extension files inside the app folder
const extBundleDir = path.join(APP_DEST, 'extension');
fs.mkdirSync(extBundleDir, { recursive: true });
fs.copyFileSync(CRX_PATH,   path.join(extBundleDir, 'figobooks-extension.crx'));
fs.copyFileSync(EXT_ID_PATH, path.join(extBundleDir, 'extension-id.txt'));
console.log('[Build PKG] Bundled browser extension CRX.');

// ── 4. Copy production node_modules ──────────────────────────────────────────
console.log('[Build PKG] Copying node_modules (production)...');
// Install production-only deps into the staging app folder
run(`npm install --omit=dev --prefix "${APP_DEST}"`, { cwd: ROOT });
// npm install --prefix creates its own package.json copy; make sure node_modules landed
const nmDest = path.join(APP_DEST, 'node_modules');
if (!fs.existsSync(nmDest)) {
  // fallback: straight copy
  copyDir(path.join(ROOT, 'node_modules'), nmDest);
}

// ── 5. Bundle the Node.js binary ─────────────────────────────────────────────
console.log('[Build PKG] Bundling Node.js runtime...');
const nodeSrc  = process.execPath;        // e.g. /usr/local/bin/node
const nodeDest = path.join(APP_DEST, 'node');
fs.copyFileSync(nodeSrc, nodeDest);
fs.chmodSync(nodeDest, 0o755);

// ── 6. Create the launcher shell script ──────────────────────────────────────
console.log('[Build PKG] Writing launcher script...');
const launcher = `#!/bin/sh
exec /usr/local/lib/figo-driver/node /usr/local/lib/figo-driver/main.js "$@"
`;
const launcherPath = path.join(BIN_DEST, 'figo-driver');
fs.writeFileSync(launcherPath, launcher, { mode: 0o755 });

// ── 7. Write postinstall script ───────────────────────────────────────────────
console.log('[Build PKG] Writing postinstall script...');
const postinstall = `#!/bin/bash
# NOTE: No 'set -e' — we explicitly handle failures so macOS doesn't show
# "Installation failed, contact the software manufacturer"

INSTALL_USER=$(stat -f "%Su" /dev/console 2>/dev/null || echo "$USER")
USER_HOME=$(eval echo "~$INSTALL_USER")
LABEL="com.figobooks.driver"
PLIST_DIR="$USER_HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$USER_HOME/.figobooks/logs"

# Fix permissions on installed app
chown -R "$INSTALL_USER" /usr/local/lib/figo-driver /usr/local/bin/figo-driver 2>/dev/null || true

mkdir -p "$PLIST_DIR" "$LOG_DIR" || true
chown -R "$INSTALL_USER" "$USER_HOME/.figobooks" 2>/dev/null || true

cat > "$PLIST_PATH" << 'PLISTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.figobooks.driver</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/figo-driver</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
PLISTEOF

# Inject the log paths (can't use variables inside 'PLISTEOF' heredoc)
sed -i '' "s|</dict>|  <key>StandardOutPath</key>\\n  <string>$LOG_DIR/driver.log</string>\\n  <key>StandardErrorPath</key>\\n  <string>$LOG_DIR/driver.log</string>\\n</dict>|" "$PLIST_PATH" 2>/dev/null || true

chown "$INSTALL_USER" "$PLIST_PATH" 2>/dev/null || true

USER_UID=$(id -u "$INSTALL_USER" 2>/dev/null || echo "501")
launchctl asuser "$USER_UID" launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl asuser "$USER_UID" launchctl load -w "$PLIST_PATH" 2>/dev/null || true

# ── Deploy browser extension (Chrome / Edge / Brave auto-install) ──────────
EXT_SRC="/usr/local/lib/figo-driver/extension"
EXT_DEST="$USER_HOME/.figobooks/extension"
EXT_ID_FILE="$EXT_SRC/extension-id.txt"

if [ -f "$EXT_ID_FILE" ]; then
  mkdir -p "$EXT_DEST" 2>/dev/null || true
  cp "$EXT_SRC/figobooks-extension.crx" "$EXT_DEST/figobooks-extension.crx" 2>/dev/null || true
  chown -R "$INSTALL_USER" "$EXT_DEST" 2>/dev/null || true

  EXT_ID=$(cat "$EXT_ID_FILE")
  UPDATE_URL="http://127.0.0.1:3838/extension/update.xml"

  # Install a macOS Configuration Profile — this is the only method Chrome 124+
  # reliably reads on macOS (plain plist in Managed Preferences is ignored).
  # profiles -I requires root and works on macOS 10.15+.
  PROFILE_PATH="/Library/Managed Preferences/figobooks-extension.mobileconfig"

  cat > "$PROFILE_PATH" << MCEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.google.Chrome</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.figobooks.driver.chrome-ext</string>
      <key>PayloadUUID</key>
      <string>A1B2C3D4-E5F6-7890-ABCD-EF1234567890</string>
      <key>PayloadDisplayName</key>
      <string>FigoBooks Printer Extension</string>
      <key>ExtensionInstallForcelist</key>
      <array>
        <string>$EXT_ID;$UPDATE_URL</string>
      </array>
    </dict>
    <dict>
      <key>PayloadType</key>
      <string>com.microsoft.Edge</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.figobooks.driver.edge-ext</string>
      <key>PayloadUUID</key>
      <string>B2C3D4E5-F6A7-8901-BCDE-F12345678901</string>
      <key>PayloadDisplayName</key>
      <string>FigoBooks Printer Extension (Edge)</string>
      <key>ExtensionInstallForcelist</key>
      <array>
        <string>$EXT_ID;$UPDATE_URL</string>
      </array>
    </dict>
    <dict>
      <key>PayloadType</key>
      <string>com.brave.Browser</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.figobooks.driver.brave-ext</string>
      <key>PayloadUUID</key>
      <string>C3D4E5F6-A7B8-9012-CDEF-123456789012</string>
      <key>PayloadDisplayName</key>
      <string>FigoBooks Printer Extension (Brave)</string>
      <key>ExtensionInstallForcelist</key>
      <array>
        <string>$EXT_ID;$UPDATE_URL</string>
      </array>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>FigoBooks Printer Extension Policy</string>
  <key>PayloadIdentifier</key>
  <string>com.figobooks.driver.policy</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>D4E5F6A7-B8C9-0123-DEF0-234567890123</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
MCEOF

  # Install the profile silently (requires root — we are root in postinstall)
  profiles -I -F "$PROFILE_PATH" 2>/dev/null || true

  # External Extensions — works on consumer (non-enterprise) macOS.
  # Chrome/Edge/Brave read {AppSupport}/{Browser}/External Extensions/{id}.json at startup.
  # Use external_update_url so Chrome fetches from our local driver (must be running).
  for EXT_DIR in "/Library/Application Support/Google/Chrome/External Extensions" "/Library/Application Support/Microsoft Edge/External Extensions" "/Library/Application Support/BraveSoftware/Brave-Browser/External Extensions"; do
    mkdir -p "$EXT_DIR" 2>/dev/null || true
    cat > "$EXT_DIR/$EXT_ID.json" << EXTEOF
{"external_update_url":"$UPDATE_URL"}
EXTEOF
    chmod 644 "$EXT_DIR/$EXT_ID.json" 2>/dev/null || true
  done
fi

# Wait for the driver to be ready then open setup wizard in user's GUI session
(
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    if curl -sf http://127.0.0.1:3838/status > /dev/null 2>&1; then
      launchctl asuser "$USER_UID" open "http://127.0.0.1:3838/setup" 2>/dev/null || true
      break
    fi
  done
) &

echo "FigoBooks Driver installed successfully."
echo "Setup wizard: http://127.0.0.1:3838/setup"
exit 0
`;
fs.writeFileSync(path.join(SCRIPTS, 'postinstall'), postinstall, { mode: 0o755 });

// ── 8. Run pkgbuild ───────────────────────────────────────────────────────────
console.log('[Build PKG] Running pkgbuild...');
run(`pkgbuild \
  --root "${STAGING}" \
  --scripts "${SCRIPTS}" \
  --identifier com.figobooks.driver \
  --version 1.0.0 \
  --install-location / \
  "${PKG_OUT}"`);

// ── 9. Cleanup ────────────────────────────────────────────────────────────────
fs.rmSync(STAGING, { recursive: true });
fs.rmSync(SCRIPTS, { recursive: true });

const sizeMB = Math.round(fs.statSync(PKG_OUT).size / 1024 / 1024);
console.log(`\n[Build PKG] Done! → dist/FigoBooks-Driver.pkg (${sizeMB} MB)`);
console.log('[Build PKG] Share this file with users — double-click to install.\n');
