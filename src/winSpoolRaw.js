/**
 * src/winSpoolRaw.js
 * Sends already-rendered ESC/POS or CPCL bytes to Windows printer queues using
 * the Winspool RAW API. This avoids libusb on Windows, where usbprint.sys owns
 * USB printer-class devices exclusively.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function listPrinters() {
  if (process.platform !== 'win32') return [];

  const { stdout } = await execFileAsync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Get-Printer | Select-Object Name,PortName,DriverName | ConvertTo-Json -Compress',
    ],
    { windowsHide: true, timeout: 8000 }
  );

  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function expectedQueueName(vendorId, productId) {
  const vid = Number(vendorId).toString(16).padStart(4, '0').toUpperCase();
  const pid = Number(productId).toString(16).padStart(4, '0').toUpperCase();
  return `Thermal Printer ${vid}:${pid}`;
}

async function findQueueForUsbPrinter(vendorId, productId) {
  const printers = await listPrinters();
  const expected = expectedQueueName(vendorId, productId).toLowerCase();
  const exact = printers.find(p => String(p.Name || '').toLowerCase() === expected);
  if (exact) return exact;

  return null;
}

async function writeRaw(printerName, buffer) {
  if (process.platform !== 'win32') {
    throw new Error('Winspool RAW printing is only available on Windows');
  }
  if (!printerName) throw new Error('Windows printer queue name is missing');

  const tmp = os.tmpdir();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataPath = path.join(tmp, `figo-print-${stamp}.bin`);
  const scriptPath = path.join(tmp, `figo-print-${stamp}.ps1`);

  const script = `
param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$DataFile
)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOC_INFO_1 {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }

  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, ref DOC_INFO_1 pDocInfo);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
}
"@

$bytes = [System.IO.File]::ReadAllBytes($DataFile)
$handle = [IntPtr]::Zero
if (-not [RawPrinter]::OpenPrinter($PrinterName, [ref]$handle, [IntPtr]::Zero)) {
  throw "OpenPrinter failed for '$PrinterName' (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

try {
  $doc = New-Object RawPrinter+DOC_INFO_1
  $doc.pDocName = "FigoBooks Raw Print"
  $doc.pOutputFile = $null
  $doc.pDatatype = "RAW"

  if ([RawPrinter]::StartDocPrinter($handle, 1, [ref]$doc) -eq 0) {
    throw "StartDocPrinter failed (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
  if (-not [RawPrinter]::StartPagePrinter($handle)) {
    throw "StartPagePrinter failed (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }

  [int]$written = 0
  if (-not [RawPrinter]::WritePrinter($handle, $bytes, $bytes.Length, [ref]$written)) {
    throw "WritePrinter failed (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
  if ($written -ne $bytes.Length) {
    throw "WritePrinter wrote $written of $($bytes.Length) bytes"
  }

  [RawPrinter]::EndPagePrinter($handle) | Out-Null
  [RawPrinter]::EndDocPrinter($handle) | Out-Null
  Write-Output "OK"
}
finally {
  if ($handle -ne [IntPtr]::Zero) {
    [RawPrinter]::ClosePrinter($handle) | Out-Null
  }
}
`.trim();

  fs.writeFileSync(dataPath, buffer);
  fs.writeFileSync(scriptPath, script, 'utf8');

  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PrinterName', printerName, '-DataFile', dataPath],
      { windowsHide: true, timeout: 30000 }
    );
    if (!stdout.includes('OK')) {
      throw new Error(stderr || stdout || 'Windows spooler did not confirm RAW print');
    }
  } finally {
    try { fs.unlinkSync(dataPath); } catch {}
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

module.exports = { expectedQueueName, findQueueForUsbPrinter, listPrinters, writeRaw };
