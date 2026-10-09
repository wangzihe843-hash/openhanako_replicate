import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASELINE_BLOB, BASELINE_COMMIT, NATIVE_PROBE_FILES, readBaseline, runNativeAuthLockCi, validateNativeReport,
} from '../scripts/probe-windows-auth-lock.mjs';
import { checkNativeAuthLockEvidence, REQUIRED_EVIDENCE } from '../scripts/check-windows-auth-lock-evidence.mjs';

// These are driver contracts, not substitutes for native Windows observations.
const roots: string[] = [];
function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-native-ci-contract-'));
  roots.push(rootDir);
  for (const dir of ['lib/pi-sdk', 'tests/fixtures', 'node_modules', 'evidence']) {
    fs.mkdirSync(path.join(rootDir, dir), { recursive: true });
  }
  for (const file of ['lib/pi-sdk/model-runtime.ts', ...NATIVE_PROBE_FILES,
    'package.json', 'package-lock.json', 'node_modules/untouched']) {
    fs.writeFileSync(path.join(rootDir, file), 'contract fixture\n');
  }
  return { rootDir, outputDir: path.join(rootDir, 'evidence') };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function holderEvents(mechanism: string, lockPath: string) {
  const commands = mechanism === 'classic'
    ? ['open', 'arm', 'check', 'check', 'release'] : ['open', 'arm', 'check', 'release'];
  return [...commands.map((command, index) => ({
    command, id: index + 1, pid: 1234, path: lockPath, handle: '64', mechanism,
    access: mechanism === 'classic' ? 0x10080 : 0, share: 7, flags: 0x02000000,
    fileSystem: 'NTFS', volumeRoot: 'C:/', closed: command === 'release',
    info: command === 'release' ? null : { directory: true, deletePending: command !== 'open', numberOfLinks: 1 },
    mkdirError: command === 'open' || command === 'release' || (command === 'arm' && mechanism !== 'classic') ? null : 5,
  })), { command: 'exit', code: 0, signal: null, error: null }];
}

function report(baseline = false) {
  return {
    passed: true, baseline, platform: 'win32', node: 'v24.15.0', release: 'contract-only',
    syntheticCredentialsOnly: true, networkAttempts: 0, errors: [],
    diagnostics: [{ mechanism: 'remove-directory', events: holderEvents('remove-directory', 'C:/control.lock'),
      directMkdir: { code: 'EPERM', syscall: 'mkdir', path: 'C:/control.lock' }, recreated: true }],
    observations: (baseline ? [false] : [false, true]).map(persistent => {
      const lockPath = `C:/${persistent ? 'persistent' : 'transient'}/auth.json.lock`;
      const failure = { code: 'EPERM', syscall: 'mkdir', path: lockPath };
      return { persistent, lockPath, nativeCode: 'EPERM', preflight: failure,
        result: persistent || baseline ? 'visible EPERM' : 'fresh credential after release',
        events: holderEvents('classic', lockPath), originalMkdirRestored: true, recreated: true,
        attempts: persistent ? Array(6).fill(failure) : baseline ? [failure] : [failure, { code: null, syscall: null, path: null }],
      };
    }),
  };
}

function state(r: ReturnType<typeof report>, index: number) {
  const event = r.observations[0].events[index];
  if (!('info' in event)) throw new Error('Expected a holder state, not an exit');
  return event;
}

function evidenceFixture() {
  const options = fixture();
  const cases = Object.fromEntries(['baseline', 'candidate'].map(name => [name,
    { passed: true, exitCode: 0, report: report(name === 'baseline') }]));
  const writeJson = (file: string, value: unknown) => fs.writeFileSync(path.join(options.outputDir, file), JSON.stringify(value));
  writeJson('summary.json', { passed: true, cases });
  for (const name of ['baseline', 'candidate']) {
    writeJson(`${name}.json`, cases[name]);
    writeJson(`${name}.exit.json`, { code: 0, signal: null, error: null });
    writeJson(`${name}.stdout.txt`, cases[name].report);
    fs.writeFileSync(path.join(options.outputDir, `${name}.stderr.txt`), '');
  }
  return options;
}

describe('native probe evidence collection after install/probe failures', () => {
  it.each(['skipped', ''])('reports not-run for %j even with stale passing files and never manufactures evidence', (outcome) => {
    const options = evidenceFixture();
    const before = fs.readFileSync(path.join(options.outputDir, 'summary.json'), 'utf8');
    expect(checkNativeAuthLockEvidence({ ...options, outcome })).toEqual({ status: 'not-run', passed: false, errors: [] });
    expect(fs.readFileSync(path.join(options.outputDir, 'summary.json'), 'utf8')).toBe(before);
    fs.rmSync(options.outputDir, { recursive: true });
    expect(checkNativeAuthLockEvidence({ ...options, outcome })).toEqual({ status: 'not-run', passed: false, errors: [] });
    expect(fs.existsSync(options.outputDir)).toBe(false);
  });

  it.each(['success', 'failure', 'cancelled'])('distinguishes the %s probe result from complete evidence collection', (outcome) => {
    expect(checkNativeAuthLockEvidence({ ...evidenceFixture(), outcome })).toEqual({
      status: outcome, passed: outcome === 'success', errors: [],
    });
  });

  it.each(REQUIRED_EVIDENCE)('fails if an executed probe loses %s, even while the directory is nonempty', (file) => {
    const options = evidenceFixture();
    fs.unlinkSync(path.join(options.outputDir, file));
    for (const outcome of ['success', 'failure', 'cancelled']) {
      const result = checkNativeAuthLockEvidence({ ...options, outcome });
      expect(result.status).toBe('evidence-error');
      expect(result.passed).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(file);
    }
  });

  it.each(REQUIRED_EVIDENCE.filter(file => file.endsWith('.json')))('fails closed on corrupt %s', (file) => {
    const options = evidenceFixture();
    fs.writeFileSync(path.join(options.outputDir, file), '{broken JSON');
    expect(checkNativeAuthLockEvidence({ ...options, outcome: 'failure' }).status).toBe('evidence-error');
  });

  it.each([
    ['summary.json', { passed: false }],
    ['candidate.json', { passed: true, report: report(true) }],
    ['baseline.exit.json', { code: 7, signal: null, error: null }],
    ['candidate.stdout.txt', { ...report(), observations: [] }],
  ])('refuses a successful outcome with inconsistent %s', (file, value) => {
    const options = evidenceFixture();
    fs.writeFileSync(path.join(options.outputDir, file), JSON.stringify(value));
    expect(checkNativeAuthLockEvidence({ ...options, outcome: 'success' }).status).toBe('evidence-error');
  });

  it('refuses unknown outcomes instead of turning them into not-run', () => {
    expect(checkNativeAuthLockEvidence({ ...fixture(), outcome: 'unexpected' }).status).toBe('evidence-error');
  });

  it.each([
    ['skipped', false, 0, 'not-run'],
    ['success', true, 0, 'success'],
    ['success', false, 1, 'evidence-error'],
    ['failure', false, 1, 'evidence-error'],
    ['cancelled', false, 1, 'evidence-error'],
  ])('CLI records %s with files=%s and propagates collection exit %s', (outcome, files, exit, status) => {
    const options = evidenceFixture();
    const outputDir = path.join(options.rootDir, 'output/windows-auth-lock-native');
    if (files) fs.cpSync(options.outputDir, outputDir, { recursive: true });
    const summary = path.join(options.rootDir, 'step-summary.md');
    const child = spawnSync(process.execPath,
      [fileURLToPath(new URL('../scripts/check-windows-auth-lock-evidence.mjs', import.meta.url))], {
        cwd: options.rootDir, encoding: 'utf8',
        env: { ...process.env, NATIVE_AUTH_LOCK_OUTCOME: outcome, GITHUB_STEP_SUMMARY: summary },
      });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(exit);
    expect(JSON.parse(child.stdout)).toMatchObject({ status, passed: status === 'success' });
    expect(fs.readFileSync(summary, 'utf8')).toContain(status);
    expect(fs.existsSync(outputDir)).toBe(files);
  });
});

describe('native auth CI evidence contracts (no Win32 emulation)', () => {
  it('accepts only the complete baseline/candidate evidence shapes', () => {
    expect(() => validateNativeReport(report(true), true)).not.toThrow();
    expect(() => validateNativeReport(report(), false)).not.toThrow();
    expect(() => validateNativeReport(report(true), false)).toThrow();
  });

  it.each([
    { passed: false }, { baseline: true }, { platform: 'darwin' }, { node: 'v24.21.0' },
    { release: '' }, { syntheticCredentialsOnly: false }, { networkAttempts: 1 },
    { observations: [] }, { observations: report().observations.slice(0, 1) },
    { observations: [{ persistent: false, nativeCode: 'EACCES', result: 'skipped' }] },
  ])('rejects incomplete or non-native evidence: %j', (change) => {
    expect(() => validateNativeReport({ ...report(), ...change }, false)).toThrow();
  });

  it.each([
    ['missing native state', (r: ReturnType<typeof report>) => { state(r, 1).info = null; }],
    ['not delete-pending', (r: ReturnType<typeof report>) => { state(r, 1).info!.deletePending = false; }],
    ['wrong native mkdir error', (r: ReturnType<typeof report>) => { state(r, 2).mkdirError = 183; }],
    ['wrong share flags', (r: ReturnType<typeof report>) => { state(r, 0).share = 3; }],
    ['wrong access', (r: ReturnType<typeof report>) => { state(r, 0).access = 0; }],
    ['stale response', (r: ReturnType<typeof report>) => { state(r, 2).id = 1; }],
    ['different process', (r: ReturnType<typeof report>) => { state(r, 2).pid = 9876; }],
    ['different handle', (r: ReturnType<typeof report>) => { state(r, 2).handle = '999'; }],
    ['early close', (r: ReturnType<typeof report>) => { state(r, 2).closed = true; }],
    ['missing release', (r: ReturnType<typeof report>) => { r.observations[0].events.splice(4, 1); }],
    ['missing exit', (r: ReturnType<typeof report>) => { r.observations[0].events.pop(); }],
    ['no real retry', (r: ReturnType<typeof report>) => { r.observations[0].attempts.pop(); }],
    ['lost persistent attempts', (r: ReturnType<typeof report>) => { r.observations[1].attempts.pop(); }],
    ['failed post-release mkdir', (r: ReturnType<typeof report>) => { r.observations[0].recreated = false; }],
    ['observer not restored', (r: ReturnType<typeof report>) => { r.observations[0].originalMkdirRestored = false; }],
    ['missing diagnostic control', (r: ReturnType<typeof report>) => { r.diagnostics = []; }],
  ])('rejects a passing label with %s', (_name, mutate) => {
    const r = report();
    mutate(r);
    expect(() => validateNativeReport(r, false)).toThrow();
  });

  it.each([
    { platform: 'darwin', nodeVersion: 'v24.15.0' },
    { platform: 'win32', nodeVersion: 'v24.21.0' },
  ])('fails preflight with durable evidence and no child execution: %j', (runtime) => {
    const options = fixture();
    const result = runNativeAuthLockCi({ ...options, ...runtime, run() { throw new Error('must not execute'); } });
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    for (const name of ['baseline', 'candidate']) {
      expect(JSON.parse(fs.readFileSync(path.join(options.outputDir, `${name}.exit.json`), 'utf8')))
        .toEqual({ code: null, signal: null, notRun: true });
      expect(JSON.parse(fs.readFileSync(path.join(options.outputDir, `${name}.json`), 'utf8')).passed).toBe(false);
    }
    expect(JSON.parse(fs.readFileSync(path.join(options.outputDir, 'summary.json'), 'utf8'))).toEqual(result);
  });

  it.each(['commit', 'blob', 'source'])('pins the fetch and refuses a wrong baseline %s', (failure) => {
    const options = fixture();
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => {
      expect(command).toBe('git');
      calls.push(args);
      let stdout = '';
      if (args[0] === 'rev-parse') stdout = args.includes('--verify')
        ? (failure === 'commit' ? 'wrong-commit' : BASELINE_COMMIT)
        : (failure === 'blob' ? 'wrong-blob' : BASELINE_BLOB);
      if (args[0] === 'show') stdout = 'wrong bytes despite a matching blob id';
      return { status: 0, signal: null, stdout, stderr: '' };
    };
    expect(() => readBaseline(options.rootDir, options.outputDir, run)).toThrow();
    expect(calls[0]).toEqual(['fetch', '--no-tags', '--depth=1', 'origin', BASELINE_COMMIT]);
    if (failure === 'source') expect(calls.at(-1))
      .toEqual(['show', `${BASELINE_COMMIT}:lib/pi-sdk/model-runtime.ts`]);
  });

  it.each([
    { status: 0, stdout: JSON.stringify(report()), passed: true },
    { status: 7, stdout: JSON.stringify(report()), passed: false },
    { status: 1, stdout: JSON.stringify({ ...report(), passed: false, errors: ['native precondition failed'] }), passed: false },
    { status: 0, stdout: 'not JSON', passed: false },
    { status: null, stdout: '', error: new Error('spawn failed'), passed: false },
  ])('keeps candidate output after baseline fetch failure, isolates and cleans copies: %j', (child) => {
    const options = fixture();
    let caseDir = '';
    const run = (command: string, args: string[], spawnOptions: { cwd: string; timeout: number }) => {
      if (command === 'git') return args[0] === 'fetch'
        ? { status: 9, stdout: '', stderr: 'baseline fetch failed' }
        : { status: 0, stdout: 'candidate-commit\n', stderr: '' };
      expect(command).toBe(process.execPath);
      expect(args).toEqual([path.join(spawnOptions.cwd, 'tests/fixtures/native-windows-lock-probe.mjs')]);
      expect(spawnOptions.timeout).toBe(90_000);
      caseDir = spawnOptions.cwd;
      expect(caseDir).not.toBe(options.rootDir);
      expect(fs.readFileSync(path.join(caseDir, 'lib/pi-sdk/model-runtime.ts'), 'utf8')).toBe('contract fixture\n');
      for (const file of NATIVE_PROBE_FILES) expect(fs.readFileSync(path.join(caseDir, file), 'utf8')).toBe('contract fixture\n');
      fs.writeFileSync(path.join(caseDir, 'lib/pi-sdk/model-runtime.ts'), 'changed only in isolated copy');
      expect(fs.readFileSync(path.join(caseDir, 'node_modules/untouched'), 'utf8')).toBe('contract fixture\n');
      return { ...child, signal: null, stderr: 'child diagnostic' };
    };
    const result = runNativeAuthLockCi({ ...options, platform: 'win32', nodeVersion: 'v24.15.0', run });
    expect(result.passed).toBe(false); // Baseline failure cannot be hidden by candidate success.
    expect(result.cases.baseline.passed).toBe(false);
    expect(result.cases.candidate.passed).toBe(child.passed);
    if (child.status === 1) expect(result.cases.candidate.report.errors).toEqual(['native precondition failed']);
    expect(result.sourceAfter).toEqual(result.sourceBefore);
    expect(Object.keys(result.sourceBefore)).toHaveLength(6);
    expect(fs.existsSync(path.dirname(caseDir))).toBe(false);
    expect(fs.readFileSync(path.join(options.rootDir, 'node_modules/untouched'), 'utf8')).toBe('contract fixture\n');
    expect(fs.readFileSync(path.join(options.outputDir, 'candidate.stdout.txt'), 'utf8')).toBe(child.stdout);
    expect(fs.readFileSync(path.join(options.outputDir, 'candidate.stderr.txt'), 'utf8')).toBe('child diagnostic');
    expect(JSON.parse(fs.readFileSync(path.join(options.outputDir, 'candidate.exit.json'), 'utf8')).code).toBe(child.status);
    expect(JSON.parse(fs.readFileSync(path.join(options.outputDir, 'baseline-fetch.exit.json'), 'utf8')).code).toBe(9);
  });
});
