// Native acceptance probe; the CI driver runs isolated baseline/candidate copies.
// No permission/ACL changes, network, real credentials, or system configuration.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { spawn } from 'node:child_process';

assert.equal(process.platform, 'win32', 'Native Windows is required; this probe must not be counted as a Mac pass.');
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Probe refuses network access'); };
const { AuthStorage } = await import('../../lib/pi-sdk/model-runtime.ts');
const baseline = process.argv.includes('--baseline');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-native-auth-lock-'));
const credential = { type: 'oauth', access: 'public-fixture-old', refresh: 'public-fixture-refresh', expires: 1 };
const rotated = { ...credential, access: 'public-fixture-rotated', expires: Date.now() + 3600000 };
const observations = [];

function holdDeletedDirectory(lockPath) {
  fs.mkdirSync(lockPath);
  const quotedPath = "'" + lockPath.replaceAll("'", "''") + "'";
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AuthLockProbeNative {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool RemoveDirectoryW(string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$lockPath = ${quotedPath}
$handle = [AuthLockProbeNative]::CreateFileW($lockPath, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::new(-1)) { throw "CreateFileW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
  if (-not [AuthLockProbeNative]::RemoveDirectoryW($lockPath)) { throw "RemoveDirectoryW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {
  [void][AuthLockProbeNative]::CloseHandle($handle)
}
`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', data => { output += data; if (output.includes('READY')) resolve(); });
    exited.then(result => { if (!output.includes('READY')) reject(new Error(JSON.stringify({ result, stderr }))); }, reject);
  });
  const watchdog = setTimeout(() => child.kill(), 20000);
  watchdog.unref();
  return {
    ready,
    release() { if (!child.stdin.destroyed) child.stdin.end('\n'); },
    async close() {
      if (!child.stdin.destroyed) child.stdin.end('\n');
      const result = await exited;
      clearTimeout(watchdog);
      assert.deepEqual(result, { code: 0, signal: null }, stderr);
    },
  };
}

async function probe(persistent) {
  const dir = path.join(root, persistent ? 'persistent' : 'transient');
  fs.mkdirSync(dir);
  const authPath = path.join(dir, 'auth.json');
  const lockPath = authPath + '.lock';
  fs.writeFileSync(authPath, JSON.stringify({ fixture: credential }));
  const storage = AuthStorage.create(authPath);
  const holder = holdDeletedDirectory(lockPath);
  let releaseTimer;
  try {
    await holder.ready;
    let nativeError;
    try { fs.mkdirSync(lockPath); } catch (error) { nativeError = error; }
    assert.equal(nativeError?.code, 'EPERM', 'The host must actually reproduce the native delete-pending mkdir failure.');
    assert.equal(nativeError.syscall, 'mkdir');
    const read = storage.get('fixture');
    if (!persistent) {
      releaseTimer = setTimeout(() => {
        // Synthetic rotation: the real OAuth/concurrency assertions remain in Vitest.
        fs.writeFileSync(authPath, JSON.stringify({ fixture: rotated }));
        holder.release();
      }, 120);
    }
    if (persistent || baseline) {
      await assert.rejects(read, error => error.code === 'EPERM' && error.syscall === 'mkdir' && error.path === lockPath);
    } else {
      assert.deepEqual(await read, rotated);
    }
    observations.push({ persistent, nativeCode: nativeError.code, result: persistent || baseline ? 'visible EPERM' : 'fresh credential after release' });
  } finally {
    clearTimeout(releaseTimer);
    await holder.close();
  }
}

try {
  await probe(false);
  if (!baseline) await probe(true);
  assert.equal(networkAttempts, 0);
  console.log(JSON.stringify({ passed: true, baseline, platform: process.platform, release: os.release(), node: process.version, syntheticCredentialsOnly: true, networkAttempts, observations }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
