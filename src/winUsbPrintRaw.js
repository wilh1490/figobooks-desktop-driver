/**
 * src/winUsbPrintRaw.js
 * Writes raw printer bytes through Windows' USBPRINT device interface.
 *
 * This bypasses the Windows print queue/spooler while still using the inbox
 * usbprint.sys driver that owns printer-class USB devices on Windows.
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

function hex4(value) {
  return Number(value).toString(16).padStart(4, '0').toLowerCase();
}

function buildScript() {
  return `
param(
  [Parameter(Mandatory=$true)][string]$Vid,
  [Parameter(Mandatory=$true)][string]$ProductId,
  [Parameter(Mandatory=$false)][string]$DataFile
)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class UsbPrintRaw {
  private const int DIGCF_PRESENT = 0x00000002;
  private const int DIGCF_DEVICEINTERFACE = 0x00000010;
  private const uint GENERIC_WRITE = 0x40000000;
  private const uint FILE_SHARE_READ = 0x00000001;
  private const uint FILE_SHARE_WRITE = 0x00000002;
  private const uint OPEN_EXISTING = 3;
  private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
  private static readonly Guid GUID_DEVINTERFACE_USBPRINT =
    new Guid("28d78fad-5a12-11d1-ae5b-0000f803a8c2");

  [StructLayout(LayoutKind.Sequential)]
  private struct SP_DEVICE_INTERFACE_DATA {
    public int cbSize;
    public Guid InterfaceClassGuid;
    public int Flags;
    public IntPtr Reserved;
  }

  [DllImport("setupapi.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern IntPtr SetupDiGetClassDevs(
    ref Guid ClassGuid,
    IntPtr Enumerator,
    IntPtr hwndParent,
    int Flags);

  [DllImport("setupapi.dll", SetLastError=true)]
  private static extern bool SetupDiEnumDeviceInterfaces(
    IntPtr DeviceInfoSet,
    IntPtr DeviceInfoData,
    ref Guid InterfaceClassGuid,
    int MemberIndex,
    ref SP_DEVICE_INTERFACE_DATA DeviceInterfaceData);

  [DllImport("setupapi.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern bool SetupDiGetDeviceInterfaceDetail(
    IntPtr DeviceInfoSet,
    ref SP_DEVICE_INTERFACE_DATA DeviceInterfaceData,
    IntPtr DeviceInterfaceDetailData,
    int DeviceInterfaceDetailDataSize,
    out int RequiredSize,
    IntPtr DeviceInfoData);

  [DllImport("setupapi.dll", SetLastError=true)]
  private static extern bool SetupDiDestroyDeviceInfoList(IntPtr DeviceInfoSet);

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern IntPtr CreateFile(
    string lpFileName,
    uint dwDesiredAccess,
    uint dwShareMode,
    IntPtr lpSecurityAttributes,
    uint dwCreationDisposition,
    uint dwFlagsAndAttributes,
    IntPtr hTemplateFile);

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool WriteFile(
    IntPtr hFile,
    byte[] lpBuffer,
    int nNumberOfBytesToWrite,
    out int lpNumberOfBytesWritten,
    IntPtr lpOverlapped);

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CloseHandle(IntPtr hObject);

  public static string[] ListPaths() {
    var paths = new List<string>();
    var usbPrintGuid = GUID_DEVINTERFACE_USBPRINT;
    IntPtr info = SetupDiGetClassDevs(
      ref usbPrintGuid,
      IntPtr.Zero,
      IntPtr.Zero,
      DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (info == INVALID_HANDLE_VALUE) return paths.ToArray();

    try {
      for (int index = 0; ; index++) {
        var data = new SP_DEVICE_INTERFACE_DATA();
        data.cbSize = Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA));
        if (!SetupDiEnumDeviceInterfaces(info, IntPtr.Zero, ref usbPrintGuid, index, ref data)) {
          break;
        }

        int requiredSize = 0;
        SetupDiGetDeviceInterfaceDetail(info, ref data, IntPtr.Zero, 0, out requiredSize, IntPtr.Zero);
        if (requiredSize <= 0) continue;

        IntPtr detail = Marshal.AllocHGlobal(requiredSize);
        try {
          Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
          if (!SetupDiGetDeviceInterfaceDetail(info, ref data, detail, requiredSize, out requiredSize, IntPtr.Zero)) {
            continue;
          }
          string devicePath = Marshal.PtrToStringUni(IntPtr.Add(detail, 4));
          if (!String.IsNullOrWhiteSpace(devicePath)) paths.Add(devicePath);
        } finally {
          Marshal.FreeHGlobal(detail);
        }
      }
    } finally {
      SetupDiDestroyDeviceInfoList(info);
    }

    return paths.ToArray();
  }

  public static void WriteRaw(string devicePath, byte[] bytes) {
    IntPtr handle = CreateFile(
      devicePath,
      GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      IntPtr.Zero,
      OPEN_EXISTING,
      0,
      IntPtr.Zero);
    if (handle == INVALID_HANDLE_VALUE) {
      throw new Exception("CreateFile failed (Win32=" + Marshal.GetLastWin32Error() + ") for " + devicePath);
    }

    try {
      const int chunkSize = 1024;
      int offset = 0;
      while (offset < bytes.Length) {
        int count = Math.Min(chunkSize, bytes.Length - offset);
        byte[] chunk = new byte[count];
        Buffer.BlockCopy(bytes, offset, chunk, 0, count);

        int written = 0;
        if (!WriteFile(handle, chunk, chunk.Length, out written, IntPtr.Zero)) {
          throw new Exception("WriteFile failed (Win32=" + Marshal.GetLastWin32Error() + ")");
        }
        if (written != chunk.Length) {
          throw new Exception("WriteFile wrote " + written + " of " + chunk.Length + " bytes");
        }

        offset += written;
        if (offset < bytes.Length) Thread.Sleep(2);
      }
    } finally {
      CloseHandle(handle);
    }
  }
}
"@

$paths = [UsbPrintRaw]::ListPaths()
$match = $paths | Where-Object {
  $_.ToLowerInvariant().Contains("vid_$($Vid.ToLowerInvariant())") -and
  $_.ToLowerInvariant().Contains("pid_$($ProductId.ToLowerInvariant())")
} | Select-Object -First 1

if (-not $match) {
  Write-Output (@{ ok = $false; paths = $paths; error = "USBPRINT interface not found" } | ConvertTo-Json -Compress)
  exit 0
}

if ($DataFile) {
  $bytes = [System.IO.File]::ReadAllBytes($DataFile)
  [UsbPrintRaw]::WriteRaw($match, $bytes)
}

Write-Output (@{ ok = $true; devicePath = $match; paths = $paths } | ConvertTo-Json -Compress)
`.trim();
}

async function findDevicePath(vendorId, productId) {
  if (process.platform !== 'win32') return null;

  const scriptPath = path.join(os.tmpdir(), `figo-usbprint-find-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(scriptPath, buildScript(), 'utf8');

  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Vid', hex4(vendorId), '-ProductId', hex4(productId)],
      { windowsHide: true, timeout: 10000 }
    );
    const result = JSON.parse(stdout.trim());
    return result.ok ? result.devicePath : null;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

async function writeRaw(devicePath, buffer) {
  if (process.platform !== 'win32') {
    throw new Error('USBPRINT raw writing is only available on Windows');
  }
  if (!devicePath) throw new Error('USBPRINT device path is missing');

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataPath = path.join(os.tmpdir(), `figo-usbprint-${stamp}.bin`);
  const scriptPath = path.join(os.tmpdir(), `figo-usbprint-${stamp}.ps1`);

  fs.writeFileSync(dataPath, buffer);
  fs.writeFileSync(scriptPath, buildScript(), 'utf8');

  try {
    const lower = devicePath.toLowerCase();
    const vidMatch = lower.match(/vid_([0-9a-f]{4})/);
    const pidMatch = lower.match(/pid_([0-9a-f]{4})/);
    if (!vidMatch || !pidMatch) throw new Error(`Invalid USBPRINT path: ${devicePath}`);

    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Vid',
        vidMatch[1],
        '-ProductId',
        pidMatch[1],
        '-DataFile',
        dataPath,
      ],
      { windowsHide: true, timeout: 30000 }
    );
    const result = JSON.parse(stdout.trim());
    if (!result.ok) throw new Error(result.error || 'USBPRINT raw write failed');
  } finally {
    try { fs.unlinkSync(dataPath); } catch {}
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

module.exports = { findDevicePath, writeRaw };
