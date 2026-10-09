param(
  [Parameter(Mandatory=$true)][string]$LockPath,
  [Parameter(Mandatory=$true)][string]$PipeName,
  [ValidateSet('classic', 'remove-directory')][string]$Mechanism = 'classic'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# No ACL, execution-policy, privilege, or system configuration changes.
# BOOLEAN fields are one byte; FILE_STANDARD_INFO has native 8-byte alignment.
# Win32 contracts: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle
# https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class AuthLockNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct StandardInfo {
    public long AllocationSize, EndOfFile;
    public uint NumberOfLinks;
    public byte DeletePending, Directory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  static extern bool SetFileInformationByHandle(IntPtr handle, int infoClass, ref byte info, uint size);
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  static extern bool GetFileInformationByHandleEx(IntPtr handle, int infoClass, out StandardInfo info, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern bool RemoveDirectoryW(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern bool CreateDirectoryW(string path, IntPtr security);
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern bool GetVolumePathNameW(string path, StringBuilder root, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern bool GetVolumeInformationW(string root, StringBuilder label, uint labelSize, out uint serial, out uint componentLength, out uint flags, StringBuilder format, uint formatSize);

  static void Require(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  public static IntPtr Open(string path, uint access) {
    // OPEN_EXISTING, FILE_SHARE_READ|WRITE|DELETE, FILE_FLAG_BACKUP_SEMANTICS.
    IntPtr handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW");
    return handle;
  }
  public static StandardInfo Query(IntPtr handle) {
    StandardInfo info;
    Require(GetFileInformationByHandleEx(handle, 1, out info, (uint)Marshal.SizeOf(typeof(StandardInfo))), "FileStandardInfo");
    return info;
  }
  public static void Mark(IntPtr handle, string path, string mechanism) {
    if (mechanism == "remove-directory") Require(RemoveDirectoryW(path), "RemoveDirectoryW");
    else {
      // Classic FileDispositionInfo (4), not FileDispositionInfoEx/POSIX delete.
      byte delete = 1;
      Require(SetFileInformationByHandle(handle, 4, ref delete, 1), "FileDispositionInfo");
    }
  }
  public static int MkdirError(string path) {
    return CreateDirectoryW(path, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error();
  }
  public static string[] Volume(string path) {
    var root = new StringBuilder(32768);
    Require(GetVolumePathNameW(path, root, (uint)root.Capacity), "GetVolumePathNameW");
    var format = new StringBuilder(256);
    uint serial, length, flags;
    Require(GetVolumeInformationW(root.ToString(), null, 0, out serial, out length, out flags, format, (uint)format.Capacity), "GetVolumeInformationW");
    return new string[] { root.ToString(), format.ToString() };
  }
  public static void Close(IntPtr handle) { Require(CloseHandle(handle), "CloseHandle"); }
}
'@

$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::InOut)
$handle = [IntPtr]::new(-1)
$reader = $null
$writer = $null
try {
  # Explicit IPC stream, independent of PowerShell's host/redirected Console.In.
  $pipe.Connect(10000)
  $utf8 = [Text.UTF8Encoding]::new($false)
  $reader = [IO.StreamReader]::new($pipe, $utf8)
  $writer = [IO.StreamWriter]::new($pipe, $utf8)
  $writer.AutoFlush = $true
  $access = if ($Mechanism -eq 'classic') { 0x00010080 } else { 0 } # DELETE | FILE_READ_ATTRIBUTES
  $volume = [AuthLockNative]::Volume($LockPath)
  $handle = [AuthLockNative]::Open($LockPath, $access)
  $handleId = $handle.ToInt64().ToString()
  $sequence = 0
  $armed = $false
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { throw 'Controller disconnected before RELEASE' }
    $request = $line | ConvertFrom-Json
    $sequence++
    if ($request.id -ne $sequence) { throw 'Out-of-order controller request' }
    $command = [string]$request.command
    if ($sequence -eq 1 -and $command -ne 'open') { throw 'OPEN required first' }
    $mkdirError = $null
    $closed = $false
    switch ($command) {
      'open' { if ($sequence -ne 1) { throw 'Duplicate OPEN' } }
      'arm' {
        if ($armed) { throw 'Duplicate ARM' }
        [AuthLockNative]::Mark($handle, $LockPath, $Mechanism)
        $armed = $true
      }
      'check' { if (-not $armed) { throw 'ARM required before CHECK' } }
      'release' {
        [AuthLockNative]::Close($handle)
        $handle = [IntPtr]::new(-1)
        $closed = $true
      }
      default { throw "Unknown controller command: $command" }
    }
    $info = $null
    if (-not $closed) {
      $native = [AuthLockNative]::Query($handle)
      $info = @{ deletePending = ($native.DeletePending -ne 0); directory = ($native.Directory -ne 0); numberOfLinks = $native.NumberOfLinks }
      # In the old-mechanism control, let Node try mkdir first: a successful
      # CreateDirectoryW would otherwise recreate the name before Node sees it.
      if ($armed -and ($Mechanism -eq 'classic' -or $command -eq 'check')) {
        $mkdirError = [AuthLockNative]::MkdirError($LockPath)
      }
    }
    $response = @{
      id = $request.id; command = $command; pid = $PID; path = $LockPath
      mechanism = $Mechanism; access = $access; share = 7; flags = 0x02000000
      handle = $handleId; volumeRoot = $volume[0]; fileSystem = $volume[1]
      closed = $closed; info = $info; mkdirError = $mkdirError
    }
    $writer.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
    if ($closed) { break }
  }
} finally {
  if ($handle -ne [IntPtr]::new(-1)) { [AuthLockNative]::Close($handle) }
  if ($null -ne $writer) { $writer.Dispose() }
  if ($null -ne $reader) { $reader.Dispose() }
  $pipe.Dispose()
}
