/**
 * platform/win/installer.js
 *
 * Self-install/uninstall flow for the Windows SEA executable.
 * This allows a non-technical user to download and run once:
 * - copies exe to %LOCALAPPDATA%\FigoBooks Driver
 * - adds auto-start (HKCU Run)
 * - adds Start Menu and Desktop shortcuts
 * - adds uninstall entry under HKCU Uninstall
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP_NAME = 'FigoBooks Printer Driver';
const COMPANY = 'FigoBooks';
const EXE_NAME = 'figo-driver-win.exe';
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FigoBooksDriver';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'FigoBooksDriver';

function isWindows() {
  return process.platform === 'win32';
}

function isWindowsExeBuild() {
  return process.execPath.toLowerCase().endsWith('.exe');
}

function getPaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const desktop = path.join(os.homedir(), 'Desktop');

  const installDir = path.join(localAppData, 'FigoBooks Driver');
  const installedExe = path.join(installDir, EXE_NAME);

  const startMenuDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', COMPANY);
  const startMenuShortcut = path.join(startMenuDir, `${APP_NAME}.lnk`);
  const uninstallShortcut = path.join(startMenuDir, `Uninstall ${APP_NAME}.lnk`);
  const desktopShortcut = path.join(desktop, `${APP_NAME}.lnk`);

  return {
    installDir,
    installedExe,
    startMenuDir,
    startMenuShortcut,
    uninstallShortcut,
    desktopShortcut,
  };
}

function normalizeWinPath(p) {
  return path.resolve(p).toLowerCase();
}

function isInstalledLocation() {
  const { installedExe } = getPaths();
  return normalizeWinPath(process.execPath) === normalizeWinPath(installedExe);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  return result.status === 0;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createShortcut(linkPath, targetPath, argumentsValue = '') {
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$shortcut = $ws.CreateShortcut(${psQuote(linkPath)})`,
    `$shortcut.TargetPath = ${psQuote(targetPath)}`,
    `$shortcut.Arguments = ${psQuote(argumentsValue)}`,
    `$shortcut.WorkingDirectory = ${psQuote(path.dirname(targetPath))}`,
    `$shortcut.IconLocation = ${psQuote(targetPath)}`,
    '$shortcut.Save()',
  ].join('; ');

  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function addAutoStart(installedExe) {
  const runCommand = `"${installedExe}" --background`;
  run('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', runCommand, '/f']);
}

function removeAutoStart() {
  run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
}

function addUninstallEntry(installedExe) {
  const uninstallCmd = `"${installedExe}" --uninstall`;

  run('reg', ['add', UNINSTALL_KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', APP_NAME, '/f']);
  run('reg', ['add', UNINSTALL_KEY, '/v', 'Publisher', '/t', 'REG_SZ', '/d', COMPANY, '/f']);
  run('reg', ['add', UNINSTALL_KEY, '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', '1.0.0', '/f']);
  run('reg', ['add', UNINSTALL_KEY, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', path.dirname(installedExe), '/f']);
  run('reg', ['add', UNINSTALL_KEY, '/v', 'UninstallString', '/t', 'REG_SZ', '/d', uninstallCmd, '/f']);
  run('reg', ['add', UNINSTALL_KEY, '/v', 'NoModify', '/t', 'REG_DWORD', '/d', '1', '/f']);
  run('reg', ['add', UNINSTALL_KEY, '/v', 'NoRepair', '/t', 'REG_DWORD', '/d', '1', '/f']);
}

function removeUninstallEntry() {
  run('reg', ['delete', UNINSTALL_KEY, '/f']);
}

function removeFileSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  } catch {}
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function scheduleSelfDelete(exePath, installDir) {
  const cleanupCmd = `ping 127.0.0.1 -n 3 > nul && del /f /q "${exePath}" && rmdir "${installDir}"`;
  spawn('cmd.exe', ['/c', cleanupCmd], { detached: true, stdio: 'ignore' }).unref();
}

function startInstalledExe(installedExe) {
  const child = spawn(installedExe, ['--background'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function installFromCurrentExe() {
  if (!isWindows() || !isWindowsExeBuild()) return false;

  const {
    installDir,
    installedExe,
    startMenuDir,
    startMenuShortcut,
    uninstallShortcut,
    desktopShortcut,
  } = getPaths();

  try {
    ensureDir(installDir);
    ensureDir(startMenuDir);

    if (normalizeWinPath(process.execPath) !== normalizeWinPath(installedExe)) {
      fs.copyFileSync(process.execPath, installedExe);
    }

    createShortcut(startMenuShortcut, installedExe);
    createShortcut(uninstallShortcut, installedExe, '--uninstall');
    createShortcut(desktopShortcut, installedExe);

    addAutoStart(installedExe);
    addUninstallEntry(installedExe);

    startInstalledExe(installedExe);
    return true;
  } catch {
    return false;
  }
}

function uninstallCurrentInstall() {
  if (!isWindows()) return false;

  const {
    installDir,
    installedExe,
    startMenuShortcut,
    uninstallShortcut,
    desktopShortcut,
  } = getPaths();

  removeAutoStart();
  removeUninstallEntry();
  removeFileSafe(startMenuShortcut);
  removeFileSafe(uninstallShortcut);
  removeFileSafe(desktopShortcut);

  if (isInstalledLocation()) {
    scheduleSelfDelete(installedExe, installDir);
    return true;
  }

  removeFileSafe(installedExe);
  try {
    if (fs.existsSync(installDir)) fs.rmSync(installDir, { recursive: true, force: true });
  } catch {}
  return true;
}

function maybeHandleInstallFlow() {
  if (!isWindows()) return { handled: false };

  const args = new Set(process.argv.slice(1).map(v => String(v).toLowerCase()));

  if (args.has('--uninstall')) {
    uninstallCurrentInstall();
    return { handled: true, exitCode: 0 };
  }

  if (args.has('--install')) {
    installFromCurrentExe();
    return { handled: true, exitCode: 0 };
  }

  if (args.has('--background')) {
    return { handled: false };
  }

  // Only auto-install for the packaged Windows exe. Dev runs via node main.js are untouched.
  if (isWindowsExeBuild() && !isInstalledLocation() && path.basename(process.execPath).toLowerCase() === EXE_NAME) {
    installFromCurrentExe();
    return { handled: true, exitCode: 0 };
  }

  return { handled: false };
}

module.exports = {
  maybeHandleInstallFlow,
};
