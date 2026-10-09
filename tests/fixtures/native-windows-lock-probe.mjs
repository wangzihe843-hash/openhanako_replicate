// Native acceptance experiment, not attribution of the original CI EPERM.
// Only disposable directories, named pipes and public synthetic credentials.
import assert from 'node:assert/strict';
import console from 'node:console';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { assertHeldState, createRequestChannel, observeMkdir } from './native-windows-lock-protocol.mjs';

assert.equal(process.platform, 'win32', 'Native Windows is required; this probe must not be counted as a Mac pass.');
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Probe refuses network access'); };
const { AuthStorage } = await import('../../lib/pi-sdk/model-runtime.ts');
// Observe the exact graceful-fs instance used by Pi's proper-lockfile. Every
// attempt still calls its real mkdir, and forwards the identical callback error.
const require = createRequire(import.meta.url);
const piRequire = createRequire(require.resolve('@earendil-works/pi-coding-agent'));
const lockRequire = createRequire(piRequire.resolve('proper-lockfile'));
const lockFs = lockRequire('graceful-fs');
const baseline = process.argv.includes('--baseline');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-native-auth-lock-'));
const credential = { type: 'oauth', access: 'public-fixture-old', refresh: 'public-fixture-refresh', expires: 1 };
const rotated = { ...credential, access: 'public-fixture-rotated', expires: Date.now() + 3600000 };
const report = {
  passed: false, baseline, platform: process.platform, release: os.release(), node: process.version,
  syntheticCredentialsOnly: true, networkAttempts: 0, diagnostics: [], observations: [], errors: [],
};
const describeError = error => ({ code: error?.code ?? null, syscall: error?.syscall ?? null, path: error?.path ?? null });
const isLockError = (error, lockPath) => error?.code === 'EPERM' && error.syscall === 'mkdir' && error.path === lockPath;

async function withHolder(lockPath, mechanism, events, run) {
  fs.mkdirSync(lockPath);
  const pipeName = `hana-native-auth-${randomUUID()}`;
  let socket, child, channel, exited, watchdog, opened;
  let released = false;
  const failures = [];
  let connected;
  const connection = new Promise(resolve => { connected = resolve; });
  const server = net.createServer(stream => {
    if (socket) return stream.destroy();
    socket = stream;
    connected(stream);
  });
  async function request(command) {
    assert.equal(child.exitCode, null, 'Holder exited before request');
    assert.equal(child.signalCode, null, 'Holder was killed before request');
    const state = await channel.request(command);
    assert.equal(state.pid, child.pid);
    assert.equal(state.path, lockPath);
    assert.equal(state.mechanism, mechanism);
    assert.equal(state.access, mechanism === 'classic' ? 0x10080 : 0);
    assert.equal(state.share, 7);
    assert.equal(state.flags, 0x02000000);
    assert.equal(state.fileSystem, 'NTFS', 'This acceptance experiment requires an NTFS temporary volume');
    assert.ok(state.volumeRoot.length > 0);
    assert.match(state.handle, /^\d+$/);
    if (opened) {
      for (const key of ['handle', 'volumeRoot', 'fileSystem']) assert.equal(state[key], opened[key]);
    }
    if (command === 'release') {
      assert.equal(state.closed, true);
      assert.equal(state.info, null);
      released = true;
    } else {
      assert.equal(child.exitCode, null, 'Holder exited while claiming to hold the directory');
      assert.equal(child.signalCode, null);
      assert.equal(state.closed, false);
      assert.equal(state.info.directory, true);
    }
    return state;
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
    });
    const helper = fileURLToPath(new URL('./native-windows-lock-holder.ps1', import.meta.url));
    child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper,
      '-LockPath', lockPath, '-PipeName', pipeName, '-Mechanism', mechanism], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let spawnError = null;
    child.on('error', error => { spawnError = String(error); });
    child.stdout.on('data', data => process.stderr.write(data));
    child.stderr.on('data', data => process.stderr.write(data));
    exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, error: spawnError })));
    // A deadline only fails/kills a stuck helper. It never triggers success or release.
    watchdog = setTimeout(() => child.kill(), 20000);
    await Promise.race([connection, exited.then(result => { throw new Error(`Holder exited before connection: ${JSON.stringify(result)}`); })]);
    channel = createRequestChannel(socket, { onMessage(state) {
      events.push(state);
      console.error(JSON.stringify({ nativeHolder: state }));
    } });
    opened = await request('open');
    assert.equal(opened.info.deletePending, false);
    await run({ request, opened });
  } catch (error) { failures.push(error); }
  finally {
    if (channel && !released && child.exitCode === null && child.signalCode === null) {
      try { await request('release'); } catch (error) { failures.push(error); }
    }
    if (child && !released) child.kill();
    if (exited) {
      const exit = await exited;
      events.push({ command: 'exit', ...exit });
      try { assert.deepEqual(exit, { code: 0, signal: null, error: null }); } catch (error) { failures.push(error); }
    }
    clearTimeout(watchdog);
    channel?.close();
    socket?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => String(error.stack || error)).join('\n'));
}

function directMkdir(lockPath) {
  try { fs.mkdirSync(lockPath); return describeError(null); }
  catch (error) { return describeError(error); }
}

function assertRecreatable(lockPath) {
  fs.mkdirSync(lockPath);
  fs.rmdirSync(lockPath);
}

async function diagnoseRemoveDirectory() {
  const lockPath = path.join(root, 'remove-directory-control.lock');
  const diagnostic = { mechanism: 'remove-directory', events: [] };
  report.diagnostics.push(diagnostic);
  await withHolder(lockPath, 'remove-directory', diagnostic.events, async holder => {
    // Same access=0/share=7/RemoveDirectoryW as the old fixture, now with a
    // live handshake and actual handle state. No assumed EPERM in this control.
    await holder.request('arm');
    diagnostic.directMkdir = directMkdir(lockPath);
    await holder.request('check');
    await holder.request('release');
  });
  // A successful diagnostic mkdir may have created a replacement directory.
  if (fs.existsSync(lockPath)) fs.rmdirSync(lockPath);
  assertRecreatable(lockPath);
  diagnostic.recreated = true;
}

async function probe(persistent) {
  const dir = path.join(root, persistent ? 'persistent' : 'transient');
  fs.mkdirSync(dir);
  const authPath = path.join(dir, 'auth.json');
  const lockPath = authPath + '.lock';
  fs.writeFileSync(authPath, JSON.stringify({ fixture: credential }));
  const storage = AuthStorage.create(authPath);
  const observation = { persistent, lockPath, events: [] };
  report.observations.push(observation);
  await withHolder(lockPath, 'classic', observation.events, async holder => {
    assertHeldState(await holder.request('arm'));
    observation.preflight = directMkdir(lockPath);
    assert.ok(isLockError(observation.preflight, lockPath), 'The host must reproduce the real delete-pending mkdir EPERM');
    assertHeldState(await holder.request('check'));
    const observer = observeMkdir(lockFs, lockPath, persistent ? undefined : async error => {
      assert.ok(isLockError(error, lockPath));
      assertHeldState(await holder.request('check'));
      // Synchronize on an actual failed native attempt, not on a timer. Rotate
      // synthetic data and await CloseHandle before forwarding that SAME error.
      // Baseline must reject it; candidate must make another native mkdir/read.
      fs.writeFileSync(authPath, JSON.stringify({ fixture: rotated }));
      await holder.request('release');
    });
    observation.attempts = observer.attempts;
    try {
      if (persistent || baseline) {
        await assert.rejects(storage.get('fixture'), error => isLockError(error, lockPath));
      } else assert.deepEqual(await storage.get('fixture'), rotated);
      observer.check();
      const failure = { code: 'EPERM', syscall: 'mkdir', path: lockPath };
      assert.deepEqual(observer.attempts, persistent ? Array(6).fill(failure)
        : baseline ? [failure] : [failure, describeError(null)]);
      if (persistent) {
        assertHeldState(await holder.request('check'));
        await holder.request('release');
      }
      observation.nativeCode = 'EPERM';
      observation.result = persistent || baseline ? 'visible EPERM' : 'fresh credential after release';
    } finally {
      observer.restore();
      observation.originalMkdirRestored = true;
    }
  });
  assertRecreatable(lockPath);
  observation.recreated = true;
}

try {
  // Collect each independent experiment even when an earlier precondition
  // fails. Every failure remains fatal to this report and the CI job.
  for (const experiment of [diagnoseRemoveDirectory, () => probe(false), ...(baseline ? [] : [() => probe(true)])]) {
    try { await experiment(); }
    catch (error) { report.errors.push(String(error.stack || error)); }
  }
  assert.equal(networkAttempts, 0);
} catch (error) {
  report.errors.push(String(error.stack || error));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch (error) { report.errors.push(`Cleanup: ${error.stack || error}`); }
  report.networkAttempts = networkAttempts;
  report.passed = report.errors.length === 0;
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
