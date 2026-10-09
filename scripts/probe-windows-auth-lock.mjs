import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHeldState } from '../tests/fixtures/native-windows-lock-protocol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_COMMIT = '81ec09c47cb7c3899bba3042c5cc9c4479ed60dc';
export const BASELINE_BLOB = 'fcbd9e5ddd668b9b7bf35af97bc56fbe7c820ee1';
export const BASELINE_SHA256 = 'f8e184038e4b6ad5e06fd97f3aae2510c5137898f65ab0b22533a755816441d0';
const ADAPTER = 'lib/pi-sdk/model-runtime.ts';
const PROBE = 'tests/fixtures/native-windows-lock-probe.mjs';
export const NATIVE_PROBE_FILES = [PROBE, 'tests/fixtures/native-windows-lock-protocol.mjs',
  'tests/fixtures/native-windows-lock-holder.ps1'];
const WATCHED = [ADAPTER, ...NATIVE_PROBE_FILES, 'package.json', 'package-lock.json'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function validateHolderEvents(events, mechanism, lockPath) {
  const commands = mechanism === 'classic'
    ? ['open', 'arm', 'check', 'check', 'release', 'exit']
    : ['open', 'arm', 'check', 'release', 'exit'];
  assert.deepEqual(events.map(event => event.command), commands);
  const opened = events[0];
  assert.ok(Number.isInteger(opened.pid) && opened.pid > 0);
  assert.match(opened.handle, /^\d+$/);
  assert.equal(opened.fileSystem, 'NTFS');
  assert.ok(typeof opened.volumeRoot === 'string' && opened.volumeRoot.length > 0);
  assert.equal(opened.path, lockPath);
  assert.equal(opened.info.deletePending, false);
  for (const [index, state] of events.slice(0, -1).entries()) {
    assert.equal(state.id, index + 1);
    for (const key of ['pid', 'path', 'handle', 'fileSystem', 'volumeRoot']) assert.equal(state[key], opened[key]);
    assert.equal(state.mechanism, mechanism);
    assert.equal(state.access, mechanism === 'classic' ? 0x10080 : 0);
    assert.equal(state.share, 7);
    assert.equal(state.flags, 0x02000000);
    assert.equal(state.closed, state.command === 'release');
    if (state.closed) {
      assert.equal(state.info, null);
      assert.equal(state.mkdirError, null);
    } else {
      assert.equal(state.info.directory, true);
      assert.equal(typeof state.info.deletePending, 'boolean');
      assert.ok(Number.isInteger(state.info.numberOfLinks) && state.info.numberOfLinks >= 0);
      if (mechanism === 'classic' && state.command !== 'open') assertHeldState(state);
    }
  }
  assert.deepEqual(events.at(-1), { command: 'exit', code: 0, signal: null, error: null });
}

// An exit code or bare EPERM label alone is not native evidence. Require the
// live handle state, request/release transcript and actual native mkdir attempts.
export function validateNativeReport(report, baseline) {
  assert.equal(report.passed, true);
  assert.equal(report.baseline, baseline);
  assert.equal(report.platform, 'win32');
  assert.equal(report.node, 'v24.15.0');
  assert.equal(typeof report.release, 'string');
  assert.ok(report.release.length > 0);
  assert.equal(report.syntheticCredentialsOnly, true);
  assert.equal(report.networkAttempts, 0);
  assert.deepEqual(report.errors, []);
  assert.equal(report.diagnostics.length, 1);
  const diagnostic = report.diagnostics[0];
  assert.equal(diagnostic.mechanism, 'remove-directory');
  assert.equal(diagnostic.recreated, true);
  validateHolderEvents(diagnostic.events, 'remove-directory', diagnostic.events[0].path);
  assert.ok(Object.hasOwn(diagnostic.directMkdir, 'code'));
  assert.equal(report.observations.length, baseline ? 1 : 2);
  for (const [index, observation] of report.observations.entries()) {
    const persistent = index === 1;
    assert.equal(observation.persistent, persistent);
    assert.equal(observation.nativeCode, 'EPERM');
    assert.equal(observation.result, persistent || baseline ? 'visible EPERM' : 'fresh credential after release');
    assert.equal(typeof observation.lockPath, 'string');
    assert.ok(observation.lockPath.endsWith('auth.json.lock'));
    const failure = { code: 'EPERM', syscall: 'mkdir', path: observation.lockPath };
    assert.deepEqual(observation.preflight, failure);
    assert.deepEqual(observation.attempts, persistent ? Array(6).fill(failure)
      : baseline ? [failure] : [failure, { code: null, syscall: null, path: null }]);
    assert.equal(observation.originalMkdirRestored, true);
    assert.equal(observation.recreated, true);
    validateHolderEvents(observation.events, 'classic', observation.lockPath);
  }
}

function recordCommand(outputDir, name, command, args, options, run) {
  let result;
  try {
    result = run(command, args, {
      encoding: 'utf8', windowsHide: true, timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024, ...options,
    });
  } catch (error) {
    result = { error };
  }
  fs.writeFileSync(path.join(outputDir, `${name}.stdout.txt`), result.stdout ?? '');
  fs.writeFileSync(path.join(outputDir, `${name}.stderr.txt`), result.stderr ?? '');
  const exit = {
    command, args, code: result.status ?? null, signal: result.signal ?? null,
    error: result.error ? String(result.error.stack || result.error) : null,
  };
  writeJson(path.join(outputDir, `${name}.exit.json`), exit);
  return { ...exit, stdout: result.stdout ?? '' };
}

function requireSuccess(result) {
  assert.equal(result.error, null, result.error ?? 'Process failed');
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, `Command failed: ${result.command} ${result.args.join(' ')}`);
  return result.stdout;
}

export function readBaseline(rootDir, outputDir, run = spawnSync) {
  const git = (name, args) => requireSuccess(recordCommand(outputDir, name, 'git', args, { cwd: rootDir }, run));
  // The ordinary checkout is shallow. Fetch exactly this object, never a branch
  // or tag, then verify both identity and raw blob bytes before executing them.
  git('baseline-fetch', ['fetch', '--no-tags', '--depth=1', 'origin', BASELINE_COMMIT]);
  assert.equal(git('baseline-commit', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim(), BASELINE_COMMIT);
  assert.equal(git('baseline-blob', ['rev-parse', `${BASELINE_COMMIT}:${ADAPTER}`]).trim(), BASELINE_BLOB);
  const source = git('baseline-source', ['show', `${BASELINE_COMMIT}:${ADAPTER}`]);
  assert.equal(sha256(source), BASELINE_SHA256, 'Baseline adapter SHA256 mismatch');
  return source;
}

export function runNativeAuthLockCi({
  rootDir = ROOT, outputDir = path.join(rootDir, 'output/windows-auth-lock-native'),
  platform = process.platform, nodeVersion = process.version, run = spawnSync,
} = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const summary = {
    passed: false, platform, node: nodeVersion, baselineCommit: BASELINE_COMMIT,
    baselineBlob: BASELINE_BLOB, baselineSha256: BASELINE_SHA256,
    sourceBefore: {}, sourceAfter: {}, cases: {}, errors: [],
  };
  for (const name of ['baseline', 'candidate']) {
    summary.cases[name] = { passed: false, notRun: true };
    writeJson(path.join(outputDir, `${name}.json`), summary.cases[name]);
    writeJson(path.join(outputDir, `${name}.exit.json`), { code: null, signal: null, notRun: true });
    for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(outputDir, `${name}.${stream}.txt`), '');
  }
  let isolationRoot;
  try {
    assert.equal(platform, 'win32', 'Native Windows is required; no skip/pass on other hosts.');
    assert.equal(nodeVersion, 'v24.15.0', 'The native probe requires Node 24.15.0.');
    const snapshot = Object.fromEntries(WATCHED.map(file => [file, fs.readFileSync(path.join(rootDir, file))]));
    summary.sourceBefore = Object.fromEntries(WATCHED.map(file => [file, sha256(snapshot[file])]));
    summary.candidateCommit = requireSuccess(recordCommand(outputDir, 'candidate-commit', 'git',
      ['rev-parse', 'HEAD'], { cwd: rootDir }, run)).trim();
    assert.ok(fs.statSync(path.join(rootDir, 'node_modules')).isDirectory(), 'Run npm ci first');
    isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-auth-lock-ci-'));
    let baselineSource;
    try {
      baselineSource = readBaseline(rootDir, outputDir, run);
    } catch (error) {
      summary.cases.baseline.error = String(error.stack || error);
      writeJson(path.join(outputDir, 'baseline.json'), summary.cases.baseline);
    }
    // A failed baseline must still leave candidate diagnostics. Each case gets
    // a separate process/module cache and only its own copied adapter is used.
    for (const [name, source] of [['baseline', baselineSource], ['candidate', snapshot[ADAPTER]]]) {
      if (source === undefined) continue;
      const result = { passed: false, adapterSha256: sha256(source) };
      try {
        const caseDir = path.join(isolationRoot, name);
        fs.mkdirSync(path.join(caseDir, 'lib/pi-sdk'), { recursive: true });
        fs.mkdirSync(path.join(caseDir, 'tests/fixtures'), { recursive: true });
        fs.mkdirSync(path.join(caseDir, 'temp'));
        fs.writeFileSync(path.join(caseDir, 'package.json'), '{"type":"module"}\n');
        fs.writeFileSync(path.join(caseDir, ADAPTER), source);
        for (const file of NATIVE_PROBE_FILES) fs.writeFileSync(path.join(caseDir, file), snapshot[file]);
        // A junction needs no symlink privilege on Windows. Never write through
        // this dependency link or replace any file in the checked-out source.
        fs.symlinkSync(path.resolve(rootDir, 'node_modules'), path.join(caseDir, 'node_modules'), 'junction');
        const child = recordCommand(outputDir, name, process.execPath,
          [path.join(caseDir, PROBE), ...(name === 'baseline' ? ['--baseline'] : [])], {
            cwd: caseDir, env: {
              ...process.env, TEMP: path.join(caseDir, 'temp'), TMP: path.join(caseDir, 'temp'),
              PI_CODING_AGENT_DIR: path.join(caseDir, 'pi-home'),
            },
          }, run);
        result.exitCode = child.code;
        // Retain structured partial diagnostics even when a precondition fails.
        if (child.stdout.trim()) result.report = JSON.parse(child.stdout);
        requireSuccess(child);
        validateNativeReport(result.report, name === 'baseline');
        result.passed = true;
      } catch (error) {
        result.error = String(error.stack || error);
      }
      summary.cases[name] = result;
      writeJson(path.join(outputDir, `${name}.json`), result);
    }
  } catch (error) {
    summary.errors.push(String(error.stack || error));
  } finally {
    if (isolationRoot) {
      try {
        // Unlink explicitly before recursive cleanup: shared npm ci contents
        // and the production worktree are never cleanup targets.
        for (const name of ['baseline', 'candidate']) {
          const link = path.join(isolationRoot, name, 'node_modules');
          if (fs.existsSync(link)) fs.unlinkSync(link);
        }
        fs.rmSync(isolationRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        summary.errors.push(`Isolation cleanup: ${error.stack || error}`);
      }
    }
    try {
      summary.sourceAfter = Object.fromEntries(Object.keys(summary.sourceBefore)
        .map(file => [file, sha256(fs.readFileSync(path.join(rootDir, file)))]));
      assert.deepEqual(summary.sourceAfter, summary.sourceBefore, 'Checked-out source changed during the probe');
    } catch (error) {
      summary.errors.push(String(error.stack || error));
    }
    summary.passed = summary.errors.length === 0 && Object.values(summary.cases).every(result => result.passed);
    writeJson(path.join(outputDir, 'summary.json'), summary);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = runNativeAuthLockCi();
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.passed ? 0 : 1;
}
