// Temporary diagnostic controller. Built-ins only; no network, build, release or credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = 'af4c8303f859c0f2577003b6b89b8e950689f89d';
const branch = 'diagnostic/windows-kimi-context-20261015';
const allow = ['.github/workflows/build.yml', 'tests/kimi-context-ui.windows-diag.test.tsx',
  'tests/helpers/kimi-context-windows-trace.ts', 'scripts/diagnose-windows-kimi-context.mjs'].sort();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const requireThat = (ok, reason) => { if (!ok) throw new Error(reason); };
function scope() {
  requireThat(process.platform === 'win32', 'native_windows_required');
  requireThat(process.version === 'v24.15.0', 'pinned_node_required');
  requireThat(process.env.GITHUB_REF === `refs/heads/${branch}`, 'diagnostic_ref_required');
  requireThat(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'manual_event_required');
  const sha = git('rev-parse', 'HEAD');
  requireThat(sha === process.env.GITHUB_SHA, 'checkout_sha_mismatch');
  requireThat(git('show', '-s', '--format=%P', 'HEAD') === baseline, 'single_diagnostic_commit_required');
  requireThat(JSON.stringify(git('diff', '--name-only', baseline, 'HEAD').split('\n').sort()) === JSON.stringify(allow), 'diff_scope_mismatch');
  requireThat(!git('status', '--porcelain', '--untracked-files=all'), 'dirty_checkout');
  for (const file of ['tests/kimi-context-ui.test.tsx', 'package.json', 'package-lock.json', 'vitest.config.js', '.github/workflows/ci.yml'])
    requireThat(git('rev-parse', `HEAD:${file}`) === git('rev-parse', `${baseline}:${file}`), 'protected_blob_changed');
  return sha;
}
const base = process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'kimi-context-diagnostic');
function directories() {
  requireThat(!!base, 'runner_temp_required');
  for (const sub of ['raw', 'safe']) fs.mkdirSync(path.join(base, sub), { recursive: true });
}
const json = (name, value) => fs.writeFileSync(path.join(base, 'safe', name), JSON.stringify(value, null, 2) + '\n');
const digest = file => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const targetName = "keeps saved display, editing and runtime on the same budget branch at 'ai'/'anthropic-messages'/'openai-completions'";
const tasks = [
  ...[0, 1, 2].map(index => ({ cohort: 'A', index, keys: ['T'], cap: 60_000 })),
  ...[0, 1, 2].map(index => ({ cohort: 'B', index: index + 3, keys: ['T'], cap: 60_000 })),
  { cohort: 'C', index: 6, keys: ['T', 'T', 'T'], cap: 90_000 },
  { cohort: 'D', index: 7, keys: ['P', 'T', 'S', 'P', 'T', 'S'], cap: 120_000 },
];
const fieldNames = new Set((`cohort process_index fixture_id test_index case_key budget_index action manager_id runtime_id request_id span_id parent_span_id
event monotonic_ms elapsed_ms outcome http_status sdk_error_count sdk_aborted sdk_errors error_class error_code syscall
pending_put_count pending_runtime_refresh_count pending_span_count config_read_id config_error availability_seq kimi_generation xai_generation
refresh_generation publication_generation signal_aborted published refresh_origin provider_id write_revision end_write_revision read_id file_role
lock_attempts_observed wait_timeout_ms test_timeout_ms provider_reset toast_type toast_visible response_ok response_has_error response_has_code
on_refresh_count panel_present deadline_ms event_loop_max_ms event_loop_mean_ms event_loop_utilization pending_kind started_ms response_error_category
config_present config_api config_context config_contextWindow config_name runtime_present runtime_api runtime_context runtime_contextWindow runtime_name
manager_present manager_api manager_context manager_contextWindow manager_name request_has_context request_context request_has_contextWindow request_contextWindow request_name`).split(/\s+/));
const labels = new Set((`A B C D P T S absent other explicit registration unregistration renamed success error
anthropic-messages openai-completions kimi-coding xai-oauth auth.json models.json models-store.json providers.json provider-catalog.json fixture-other
rename context-1048576 context-262144 EPERM EACCES EBUSY ELOCKED ENOENT ENOTEMPTY ABORT_ERR ETIMEDOUT EINVAL
Error TypeError AssertionError AbortError DOMException ModelsError CredentialSynchronizationError mkdir open read write unlink rmdir stat not_found permission lock`).split(/\s+/));
const eventNames = new Set((`instrumentation.ready instrumentation.failure beforeEach.done test.begin test.body.pass test.body.fail budget.begin budget.pass budget.fail
budget.state manager.created PUT.body PUT.body.unreadable onRefresh.enter onRefresh.exit save.click.begin save.click.return waitFor.begin waitFor.poll waitFor.pass waitFor.fail
toast.change cleanup.begin cleanup.end fetch-guard.begin fetch-guard.pass restoreMocks.end fixture.remove.begin fixture.remove.end eventLoop.sample pending.span tail.begin tail.end`).split(/\s+/));
const kinds = ['PUT', 'manager.init', 'manager.reloadAndSync', 'manager.syncAndRefresh', 'manager._removeApiKeyProviderAuthEntries',
  'manager._applyRuntimeApiKeyOverrides', 'manager.refreshAvailable', 'manager._syncSdkProviderRegistrations', 'registry.saveProvider', 'registry.updateModelEntry',
  'runtime.refresh', 'runtime.registerProvider', 'runtime.unregisterProvider', 'runtime.queueAvailabilityRefresh', 'runtime.updateModelSnapshot', 'runtime.rebuildProviders',
  'models.refresh', 'models.supersedeProviderRefresh', 'models.beginProviderRefresh', 'models.publishProviderModels', 'config.load',
  'auth.withLockAsync', 'auth.acquireLockAsync', 'auth.withLock', 'auth.acquireLockSyncWithRetry', 'auth.lock.attempt', 'auth.lockSync.attempt', 'io.rename'];
for (const kind of kinds) for (const suffix of ['begin', 'end', 'error']) eventNames.add(`${kind}.${suffix}`);
function scalar(key, value) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value !== 'string') throw new Error('unsafe_trace_type');
  if (key === 'event') { requireThat(eventNames.has(value), 'unknown_trace_event'); return value; }
  if (key === 'pending_kind') { requireThat(kinds.includes(value), 'unknown_span_kind'); return value; }
  requireThat(labels.has(value) || /^(fixture|manager|runtime|put|span|read)-\d+$/.test(value), 'unsafe_trace_string');
  return value;
}
function safeTrace(raw, destination) {
  const tally = {}, events = [];
  for (const line of fs.readFileSync(raw, 'utf8').split('\n').filter(Boolean)) {
    const input = JSON.parse(line), out = {};
    for (const [key, value] of Object.entries(input)) {
      requireThat(fieldNames.has(key), 'unknown_trace_field');
      if (key === 'sdk_errors') {
        requireThat(Array.isArray(value), 'invalid_sdk_errors');
        out[key] = value.map(error => Object.fromEntries(Object.entries(error).map(([k, v]) => {
          requireThat(['provider_id', 'error_class', 'error_code', 'syscall'].includes(k), 'unsafe_sdk_error_field');
          return [k, scalar(k, v)];
        })));
      } else out[key] = scalar(key, value);
    }
    requireThat(eventNames.has(out.event), 'trace_event_required');
    tally[out.event] = (tally[out.event] ?? 0) + 1; events.push(JSON.stringify(out));
  }
  fs.writeFileSync(destination, events.join('\n') + '\n');
  for (const event of ['instrumentation.ready', 'test.begin', 'PUT.begin', 'PUT.end', 'runtime.refresh.begin', 'models.refresh.begin',
    'config.load.begin', 'auth.acquireLockAsync.begin', 'auth.lock.attempt.begin', 'io.rename.begin', 'cleanup.begin', 'fixture.remove.end', 'tail.end'])
    requireThat(tally[event] > 0, 'required_hook_not_observed');
  requireThat(!tally['instrumentation.failure'], 'instrumentation_failed');
  return tally;
}
function childEnv(task, traceFile) {
  const env = {};
  const keys = new Set(['path', 'temp', 'tmp', 'systemroot', 'windir', 'comspec', 'pathext', 'processor_architecture',
    'number_of_processors', 'os', 'userprofile', 'homedrive', 'homepath', 'localappdata', 'appdata']);
  for (const [key, value] of Object.entries(process.env)) if (keys.has(key.toLowerCase())) env[key] = value;
  return { ...env, CI: 'true', NO_COLOR: '1', KIMI_DIAG_COHORT: task.cohort,
    KIMI_DIAG_PROCESS_INDEX: String(task.index), KIMI_DIAG_TRACE: traceFile };
}
async function execute(task, limitMs) {
  const stem = `${task.index}-${task.cohort}`;
  const rawResult = path.join(base, 'raw', `${stem}.json`), rawTrace = path.join(base, 'raw', `${stem}.jsonl`);
  const original = task.cohort === 'A';
  const expectedNames = original ? [targetName] : task.keys.map((key, index) => `diagnostic ${index} ${key}`);
  const file = original ? 'tests/kimi-context-ui.test.tsx' : 'tests/kimi-context-ui.windows-diag.test.tsx';
  const args = ['node_modules/vitest/vitest.mjs', 'run', file, '--testNamePattern', original ? `^${targetName}$` : '^diagnostic ',
    '--retry=0', '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', `--outputFile=${rawResult}`];
  const start = performance.now();
  const stdout = fs.openSync(path.join(base, 'raw', `${stem}.stdout.txt`), 'w');
  const stderr = fs.openSync(path.join(base, 'raw', `${stem}.stderr.txt`), 'w');
  let timedOut = false, spawnError = false, killFailure = false;
  const exit = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv(task, rawTrace), shell: false, windowsHide: true,
      stdio: ['ignore', stdout, stderr] });
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill only this spawned PID's tree, never other Node/runner processes.
      const killed = spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 2500 });
      killFailure = killed.status !== 0;
      if (killFailure) child.kill();
    }, limitMs);
    child.on('error', () => { spawnError = true; clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); resolve(code); });
  });
  fs.closeSync(stdout); fs.closeSync(stderr);
  const result = { cohort: task.cohort, process_index: task.index, planned_cases: task.keys, elapsed_ms: performance.now() - start,
    cap_ms: task.cap, effective_cap_ms: limitMs, exit_code: exit, timed_out: timedOut, spawn_error: spawnError,
    kill_failure: killFailure, selected: [], outcome: 'failed', validation_error: null, trace_tally: null };
  try {
    const report = JSON.parse(fs.readFileSync(rawResult, 'utf8'));
    const selected = report.testResults.flatMap(suite => suite.assertionResults).filter(test => !['pending', 'skipped', 'todo'].includes(test.status));
    requireThat(selected.length === expectedNames.length, 'selected_case_count_mismatch');
    requireThat(selected.every((test, index) => test.fullName.trim() === expectedNames[index]), 'selected_case_name_mismatch');
    result.selected = selected.map((test, index) => ({ test_index: index, case_key: task.keys[index], status: test.status,
      duration_ms: test.duration, failure_kind: test.status === 'passed' ? null
        : test.failureMessages?.some(message => /toHaveBeenCalledTimes|called 1 times|called 2 times|called 3 times/.test(message)) ? 'refresh_assertion'
        : test.failureMessages?.some(message => /timed out/i.test(message)) ? 'test_timeout' : 'assertion_or_hook' }));
    if (!original) result.trace_tally = safeTrace(rawTrace, path.join(base, 'safe', `${stem}.trace.jsonl`));
    result.outcome = !timedOut && !spawnError && !killFailure && exit === 0 && report.success === true
      && result.selected.every(test => test.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {
    const permitted = ['selected_case_count_mismatch', 'selected_case_name_mismatch', 'required_hook_not_observed', 'instrumentation_failed',
      'unsafe_trace_type', 'unknown_trace_event', 'unknown_span_kind', 'unsafe_trace_string', 'unknown_trace_field', 'invalid_sdk_errors',
      'unsafe_sdk_error_field', 'trace_event_required'];
    result.validation_error = permitted.includes(error.message) ? error.message : 'missing_or_invalid_diagnostic_output';
    // On deadline, retain the safe prefix and pending spans when possible.
    if (!original && fs.existsSync(rawTrace)) {
      try { result.trace_tally = safeTrace(rawTrace, path.join(base, 'safe', `${stem}.trace.jsonl`)); }
      catch { /* Missing end boundaries remain an explicit instrumentation/incomplete failure. */ }
    }
  }
  json(`${stem}.result.json`, result);
  console.log(JSON.stringify({ cohort: result.cohort, process_index: task.index, outcome: result.outcome,
    selected_count: result.selected.length, elapsed_ms: result.elapsed_ms, timed_out: timedOut, validation_error: result.validation_error }));
  return result;
}
async function main() {
  const sha = scope(); directories();
  json('scope.json', { sha, baseline, branch, allowed_files: allow, manual_only: true, contents_permission: 'read' });
  if (process.argv[2] === '--check-scope') return;
  requireThat(process.argv[2] === '--run', 'unsupported_mode');
  const sources = ['tests/kimi-context-ui.test.tsx', 'tests/fixtures/kimi-context-cases.ts', 'vitest.config.js', 'package-lock.json',
    'node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js', 'node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js',
    'node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js', 'node_modules/@earendil-works/pi-ai/dist/models.js',
    'node_modules/@testing-library/dom/dist/config.js', 'node_modules/@testing-library/react/dist/pure.js'];
  const packages = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'vitest', '@testing-library/dom', '@testing-library/react'];
  json('environment.json', { sha, os: os.type(), release: os.release(), arch: os.arch(), node: process.version,
    npm: execFileSync(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), '--version'], { encoding: 'utf8' }).trim(),
    image_os: process.env.ImageOS, image_version: process.env.ImageVersion, runner_os: process.env.RUNNER_OS,
    packages: Object.fromEntries(packages.map(name => [name, JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'))).version])),
    sha256: Object.fromEntries(sources.map(file => [file, digest(file)])),
    total_budget_ms: 480000, max_processes: 8, max_case_instances: 15, max_synthetic_puts: 360,
    wait_timeout_ms: 1000, test_timeout_ms: 10000, file_parallelism: false, max_workers: 1, retries: 0,
    reference_wrapper_free: true, tail_ms_per_instrumented_process: 2000 });
  const start = performance.now(), results = [];
  for (const task of tasks) {
    const remaining = 480000 - (performance.now() - start) - 5000;
    if (remaining <= 0) break;
    results.push(await execute(task, Math.min(task.cap, remaining)));
    json('summary.json', { sha, baseline, elapsed_ms: performance.now() - start, complete: results.length === tasks.length,
      failed_latched: results.some(result => result.outcome !== 'passed'), results });
  }
  const complete = results.length === tasks.length;
  const failed = results.some(result => result.outcome !== 'passed');
  json('summary.json', { sha, baseline, elapsed_ms: performance.now() - start, complete, failed_latched: failed,
    outcome: complete && !failed ? 'bounded_sample_not_reproduced' : complete ? 'diagnostic_failure' : 'bounded_diagnosis_incomplete', results });
  if (failed || !complete) process.exitCode = 1;
}
main().catch(() => { console.error('Diagnostic controller failed; inspect safe scope/results only.'); process.exitCode = 1; });
