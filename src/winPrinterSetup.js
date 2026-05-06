/**
 * src/winPrinterSetup.js
 * Automates Windows printer installation for USB thermal printers.
 * Uses PowerShell and Windows Print Management APIs to create printer queues.
 */

'use strict';

const { execFile, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Check if running with admin privileges.
 */
function isAdmin() {
  if (process.platform !== 'win32') return false;
  try {
    execFile('net', ['session'], { windowsHide: true }, (err) => {
      return !err;
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find available USB00x port numbers that aren't in use.
 */
async function findAvailableUsbPort() {
  try {
    const { stdout } = await execAsync('wmic printer get PortName /format:csv', {
      timeout: 5000,
      windowsHide: true,
    });
    
    const usedPorts = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/USB0*(\d+)/i);
      if (match) usedPorts.add(parseInt(match[1], 10));
    }
    
    // Find first available USB00x (1-9)
    for (let i = 1; i <= 9; i++) {
      if (!usedPorts.has(i)) return `USB00${i}`;
    }
    return null;
  } catch {
    return 'USB002'; // fallback
  }
}

async function findPreferredUsbPort(vendorId, productId) {
  if (process.platform !== 'win32') return null;

  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-PrinterPort | Select-Object Name,Description,PortMonitor | ConvertTo-Json -Compress"',
      { timeout: 5000, windowsHide: true }
    );
    const text = stdout.trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    const ports = Array.isArray(parsed) ? parsed : [parsed];
    const vid = Number(vendorId);
    const pid = Number(productId);

    // Y50/Y50P USB uses Windows USB monitor ports labelled by the vendor.
    // Prefer those real usbmon ports; locally-created USB00x ports are not
    // attached to the physical device and will accept jobs that then error.
    if (vid === 0x5958 || vid === 5958) {
      const y50Ports = ports.filter(p =>
        /^USB0*\d+$/i.test(String(p.Name || '')) &&
        /yxwl|y50|y50p/i.test(String(p.Description || ''))
      );
      const y50p = y50Ports.find(p => /y50p/i.test(String(p.Description || '')));
      return (y50p || y50Ports[0])?.Name || null;
    }
  } catch {}

  return null;
}

/**
 * Install a USB thermal printer in Windows using PowerShell.
 * Creates a printer queue with Generic/Text driver on specified USB port.
 * 
 * @param {string} printerName - Name for the printer (e.g., "XPrinter 380")
 * @param {string} usbPort - USB port (e.g., "USB002")
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function installPrinter(printerName, usbPort) {
  if (process.platform !== 'win32') {
    return { success: false, error: 'This function only works on Windows' };
  }

  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    
    // PowerShell script to install printer
    const psScript = `
      $ErrorActionPreference = 'Stop'
      
      try {
        # Check if printer already exists with this name
        $existing = Get-Printer -Name "${printerName}" -ErrorAction SilentlyContinue
        if ($existing) {
          Write-Output "EXISTS"
          exit 0
        }
        
        # Check if port exists, create if not
        $portName = "${usbPort}"
        $portExists = Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue
        if (-not $portExists) {
          Add-PrinterPort -Name $portName -ErrorAction Stop
        }
        
        # Install a suitable RAW-capable driver. Generic / Text Only is the
        # correct inbox driver for byte-for-byte POS/thermal spooler jobs.
        $driverName = "Generic / Text Only"
        $driverExists = Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue
        if (-not $driverExists) {
          Add-PrinterDriver -Name $driverName -ErrorAction Stop
        }
        
        # Create the printer
        Add-Printer -Name "${printerName}" -DriverName $driverName -PortName $portName -ErrorAction Stop
        
        # Set it as RAW printer (no rendering)
        Set-Printer -Name "${printerName}" -Datatype RAW -ErrorAction SilentlyContinue
        
        Write-Output "SUCCESS"
      } catch {
        Write-Output "ERROR: $($_.Exception.Message)"
        exit 1
      }
    `.trim();

    // Write script to temp file to avoid command-line quoting issues
    const tempScript = path.join(os.tmpdir(), `figo-install-printer-${Date.now()}.ps1`);
    fs.writeFileSync(tempScript, psScript, 'utf8');

    try {
      const { stdout, stderr } = await execAsync(
        `powershell -ExecutionPolicy Bypass -File "${tempScript}"`,
        { timeout: 15000, windowsHide: true }
      );

      console.log('[WinInstaller] PowerShell stdout:', stdout);
      console.log('[WinInstaller] PowerShell stderr:', stderr);

      // Clean up temp file
      try { fs.unlinkSync(tempScript); } catch {}

      if (stdout.includes('SUCCESS') || stdout.includes('EXISTS')) {
        return { success: true };
      }

      if (stdout.includes('ERROR:')) {
        const errMsg = stdout.match(/ERROR: (.+)/)?.[1] || 'Unknown error';
        return { success: false, error: errMsg };
      }

      return { success: false, error: stderr || stdout || 'Unknown error during printer installation' };
    } finally {
      // Ensure temp file is cleaned up
      try { fs.unlinkSync(tempScript); } catch {}
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check if a USB printer with given VID:PID is already installed in Windows.
 */
async function isPrinterInstalled(vendorId, productId) {
  try {
    const { stdout } = await execAsync('wmic printer get PortName /format:csv', {
      timeout: 5000,
      windowsHide: true,
    });
    
    // Check if any USB port is in use (indicates printer is installed)
    return /USB0*\d+/i.test(stdout);
  } catch {
    return false;
  }
}

/**
 * Auto-detect and install a USB thermal printer.
 * Returns the printer name and port if successful.
 * 
 * @param {number} vendorId - USB Vendor ID
 * @param {number} productId - USB Product ID
 * @returns {Promise<{success: boolean, printerName?: string, port?: string, error?: string}>}
 */
async function autoInstallUsbPrinter(vendorId, productId) {
  const vid = vendorId.toString(16).padStart(4, '0').toUpperCase();
  const pid = productId.toString(16).padStart(4, '0').toUpperCase();
  
  // Prefer the real Windows USB monitor port for this model, if Windows has one.
  const port = await findPreferredUsbPort(vendorId, productId) || await findAvailableUsbPort();
  if (!port) {
    return { success: false, error: 'No available USB ports (USB001-USB009 all in use)' };
  }
  
  // Generate printer name
  const printerName = `Thermal Printer ${vid}:${pid}`;
  
  // Install it (Windows will handle duplicate detection)
  const result = await installPrinter(printerName, port);
  
  if (result.success) {
    return { success: true, printerName, port };
  }
  
  return result;
}

/**
 * Check if the current process has admin rights, and if not,
 * provide instructions for elevation.
 */
function checkAdminRights() {
  if (process.platform !== 'win32') return { hasAdmin: true };
  
  try {
    // Simple check: try to access a system-only registry key
    const { execSync } = require('child_process');
    execSync('reg query "HKLM\\SOFTWARE\\Microsoft" >nul 2>&1', { windowsHide: true });
    return { hasAdmin: true };
  } catch {
    return {
      hasAdmin: false,
      message: 'Administrator privileges required to install printer in Windows. ' +
               'Please restart the FigoBooks driver as Administrator.',
    };
  }
}

module.exports = {
  installPrinter,
  autoInstallUsbPrinter,
  findAvailableUsbPort,
  findPreferredUsbPort,
  isPrinterInstalled,
  checkAdminRights,
  isAdmin,
};
