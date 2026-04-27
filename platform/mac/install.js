/**
 * platform/mac/install.js
 * Installs the FigoBooks driver as a macOS LaunchAgent so it auto-starts on login.
 * Run with: sudo node platform/mac/install.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const LABEL         = 'com.figobooks.driver';
const PLIST_DIR     = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH    = path.join(PLIST_DIR, `${LABEL}.plist`);
const BINARY_PATH   = process.execPath;
const SCRIPT_PATH   = path.resolve(__dirname, '..', '..', 'main.js');
const LOG_DIR       = path.join(os.homedir(), '.figobooks', 'logs');
const PLIST_TMPL    = path.join(__dirname, `${LABEL}.plist`);

function install() {
  if (!fs.existsSync(LOG_DIR))  fs.mkdirSync(LOG_DIR,  { recursive: true });
  if (!fs.existsSync(PLIST_DIR)) fs.mkdirSync(PLIST_DIR, { recursive: true });

  // Determine the program invocation: bundled binary vs node + script
  const isPkg = BINARY_PATH.includes('figo-driver');
  const argLine = isPkg
    ? `  <string>${BINARY_PATH}</string>`
    : `  <string>${BINARY_PATH}</string>\n    <string>${SCRIPT_PATH}</string>`;

  // Fill placeholders in the static plist template
  let plist = fs.readFileSync(PLIST_TMPL, 'utf8');
  plist = plist
    .replace(
      /\s*<string>\/usr\/local\/bin\/node<\/string>\s*\n\s*<string>SCRIPT_PATH_PLACEHOLDER<\/string>/,
      `\n    ${argLine}`
    )
    .replace(/LOG_DIR_PLACEHOLDER/g,  LOG_DIR)
    .replace(/HOME_PLACEHOLDER/g,     os.homedir());

  fs.writeFileSync(PLIST_PATH, plist, 'utf8');
  console.log(`[Install] LaunchAgent plist written to:\n  ${PLIST_PATH}`);

  // Load the agent immediately
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
    execSync(`launchctl load -w "${PLIST_PATH}"`);
    console.log('[Install] LaunchAgent loaded — driver is now running in the background.');
    console.log('[Install] Setup wizard: http://127.0.0.1:3838/setup');
  } catch (err) {
    console.error('[Install] launchctl failed:', err.message);
    console.log('[Install] You can load it manually:\n  launchctl load -w', PLIST_PATH);
  }
}

function uninstall() {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
    console.log('[Uninstall] LaunchAgent unloaded.');
  } catch {}
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
    console.log('[Uninstall] Plist removed.');
  }
  console.log('[Uninstall] FigoBooks driver removed from login items.');
}

// ── Browser Extension Auto-Install ──────────────────────────────────────────

const CRX_SOURCE = path.join(__dirname, '..', '..', 'dist', 'figobooks-extension.crx');
const ID_FILE    = path.join(__dirname, '..', '..', 'dist', 'extension-id.txt');
// Resolve the REAL user's home even when the script is run via sudo
const _realUser    = process.env.SUDO_USER || os.userInfo().username;
const _realHome    = process.env.SUDO_USER
  ? path.join('/Users', process.env.SUDO_USER)
  : os.homedir();
const EXT_DEST_DIR = path.join(_realHome, '.figobooks', 'extension');

function installBrowserExtension() {
  if (!fs.existsSync(ID_FILE) || !fs.existsSync(CRX_SOURCE)) {
    console.log('[Install] Extension not built — run: npm run build:extension');
    console.log('[Install] Skipping browser extension install.');
    return;
  }

  const extensionId = fs.readFileSync(ID_FILE, 'utf8').trim();

  // Deploy CRX and update.xml to ~/.figobooks/extension/
  if (!fs.existsSync(EXT_DEST_DIR)) fs.mkdirSync(EXT_DEST_DIR, { recursive: true });

  const crxDest = path.join(EXT_DEST_DIR, 'figobooks-extension.crx');
  fs.copyFileSync(CRX_SOURCE, crxDest);
  // update.xml is served dynamically by the driver over HTTP — no static file needed

  // Install a macOS Configuration Profile — Chrome 124+ requires this instead of
  // plain plist files in /Library/Managed Preferences/.
  const UPDATE_URL = 'http://127.0.0.1:3838/extension/update.xml';
  const profilePath = '/Library/Managed Preferences/figobooks-extension.mobileconfig';
  const profileContent = `<?xml version="1.0" encoding="UTF-8"?>
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
        <string>${extensionId};${UPDATE_URL}</string>
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
        <string>${extensionId};${UPDATE_URL}</string>
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
        <string>${extensionId};${UPDATE_URL}</string>
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
</plist>`;

  try {
    fs.writeFileSync(profilePath, profileContent, 'utf8');
    console.log(`[Install] Configuration profile → ${profilePath}`);
    execSync(`profiles -I -F "${profilePath}"`, { stdio: 'inherit' });
    console.log(`[Install] Extension ID: ${extensionId}`);
    console.log('[Install] FigoBooks Printer extension will auto-install on next Chrome / Edge / Brave launch.');
  } catch (err) {
    console.warn(`[Install] Could not install configuration profile: ${err.message}`);
    console.warn('[Install] Run installer with sudo for browser auto-install.');
  }

  // External Extensions mechanism — works on consumer (non-enterprise) macOS.
  // Chrome/Edge/Brave each check {AppSupport}/{Browser}/External Extensions/{id}.json at startup.
  // Use external_update_url so Chrome fetches from our local driver (must be running).
  const extJson = JSON.stringify({ external_update_url: UPDATE_URL }, null, 2);
  const extDirs = [
    '/Library/Application Support/Google/Chrome/External Extensions',
    '/Library/Application Support/Microsoft Edge/External Extensions',
    '/Library/Application Support/BraveSoftware/Brave-Browser/External Extensions',
  ];
  for (const dir of extDirs) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${extensionId}.json`), extJson, 'utf8');
      console.log(`[Install] External extension → ${dir}/${extensionId}.json`);
    } catch (err) {
      console.warn(`[Install] Could not write external extension JSON to ${dir}: ${err.message}`);
    }
  }
}

function uninstallBrowserExtension() {
  const profilePath = '/Library/Managed Preferences/figobooks-extension.mobileconfig';
  try {
    execSync(`profiles -R -F "${profilePath}"`, { stdio: 'inherit' });
    console.log('[Uninstall] Configuration profile removed.');
  } catch {
    // Profile may not be installed — not an error
  }
  if (fs.existsSync(profilePath)) {
    try { fs.unlinkSync(profilePath); } catch { /* ignore */ }
  }
  // Remove External Extensions JSON files
  const extDirs = [
    '/Library/Application Support/Google/Chrome/External Extensions',
    '/Library/Application Support/Microsoft Edge/External Extensions',
    '/Library/Application Support/BraveSoftware/Brave-Browser/External Extensions',
  ];
  for (const dir of extDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('figobooks')) {
          fs.unlinkSync(filePath);
          console.log(`[Uninstall] Removed ${filePath}`);
        }
      } catch { /* ignore */ }
    }
  }

  if (fs.existsSync(EXT_DEST_DIR)) {
    fs.rmSync(EXT_DEST_DIR, { recursive: true, force: true });
    console.log('[Uninstall] Extension files removed.');
  }
}

const cmd = process.argv[2];
if (cmd === 'uninstall') {
  uninstall();
  uninstallBrowserExtension();
} else {
  install();
  installBrowserExtension();
}
