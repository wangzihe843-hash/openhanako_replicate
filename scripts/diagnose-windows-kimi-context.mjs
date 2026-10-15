// Temporary diagnostic controller. Built-ins only; no network, build, release or credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL, URL as NodeURL } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = 'af4c8303f859c0f2577003b6b89b8e950689f89d';
const diagnosticBase = 'ea45b890e3f8c15a7a1e864cbfbd6f08a110bc53';
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
  requireThat(git('show', '-s', '--format=%P', 'HEAD') === diagnosticBase, 'single_repair_commit_required');
  requireThat(git('show', '-s', '--format=%P', diagnosticBase) === baseline, 'diagnostic_ancestry_mismatch');
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
event monotonic_ms elapsed_ms outcome http_status sdk_error_count sdk_aborted sdk_errors error_class error_code syscall installation_stage
pending_put_count pending_runtime_refresh_count pending_span_count config_read_id config_error availability_seq kimi_generation xai_generation
refresh_generation publication_generation signal_aborted published refresh_origin provider_id write_revision end_write_revision read_id file_role
lock_attempts_observed wait_timeout_ms test_timeout_ms provider_reset toast_type toast_visible response_ok response_has_error response_has_code
on_refresh_count panel_present deadline_ms event_loop_max_ms event_loop_mean_ms event_loop_utilization pending_kind started_ms response_error_category
config_present config_api config_context config_contextWindow config_name runtime_present runtime_api runtime_context runtime_contextWindow runtime_name
manager_present manager_api manager_context manager_contextWindow manager_name request_has_context request_context request_has_contextWindow request_contextWindow request_name`).split(/\s+/));
const labels = new Set((`A B C D P T S absent other explicit registration unregistration renamed success error
anthropic-messages openai-completions kimi-coding xai-oauth auth.json models.json models-store.json providers.json provider-catalog.json fixture-other
rename context-1048576 context-262144 EPERM EACCES EBUSY ELOCKED ENOENT ENOTEMPTY ABORT_ERR ETIMEDOUT EINVAL
Error TypeError SyntaxError ReferenceError RangeError AssertionError AbortError DOMException ModelsError CredentialSynchronizationError
ERR_INVALID_ARG_VALUE ERR_INVALID_URL MODULE_NOT_FOUND ERR_MODULE_NOT_FOUND guard lockfile_resolve hook_install restore
mkdir open read write unlink rmdir stat not_found permission lock`).split(/\s+/));
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
const requiredEvents = ['instrumentation.ready', 'test.begin', 'PUT.begin', 'PUT.end', 'runtime.refresh.begin', 'models.refresh.begin',
  'config.load.begin', 'auth.acquireLockAsync.begin', 'auth.lock.attempt.begin', 'io.rename.begin', 'cleanup.begin', 'fixture.remove.end', 'tail.end'];
const traceErrors = new Set(['unsafe_trace_type', 'unknown_trace_event', 'unknown_span_kind', 'unsafe_trace_string', 'unknown_trace_field',
  'invalid_sdk_errors', 'unsafe_sdk_error_field', 'trace_event_required', 'invalid_trace_record', 'invalid_trace_json']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
// Never expose parser messages, arbitrary keys, messages, paths, or partially validated lines.
function sanitizeTrace(text) {
  const tally = {}, events = [];
  let sanitationError = null, errorLine = null;
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      let input;
      try { input = JSON.parse(line); } catch { throw new Error('invalid_trace_json'); }
      requireThat(record(input), 'invalid_trace_record');
      const out = {};
      for (const [key, value] of Object.entries(input)) {
        requireThat(fieldNames.has(key), 'unknown_trace_field');
        if (key === 'sdk_errors') {
          requireThat(Array.isArray(value), 'invalid_sdk_errors');
          out[key] = value.map(error => {
            requireThat(record(error), 'invalid_sdk_errors');
            return Object.fromEntries(Object.entries(error).map(([k, v]) => {
              requireThat(['provider_id', 'error_class', 'error_code', 'syscall'].includes(k), 'unsafe_sdk_error_field');
              return [k, scalar(k, v)];
            }));
          });
        } else out[key] = scalar(key, value);
      }
      requireThat(eventNames.has(out.event), 'trace_event_required');
      tally[out.event] = (tally[out.event] ?? 0) + 1; events.push(JSON.stringify(out));
    } catch (error) {
      sanitationError = traceErrors.has(error.message) ? error.message : 'invalid_trace_record';
      errorLine = index + 1;
      break;
    }
  }
  const missing = requiredEvents.filter(event => !tally[event]);
  return { events, tally, sanitation_error: sanitationError, error_line: errorLine, missing_required_events: missing,
    validation_error: sanitationError ?? (tally['instrumentation.failure'] ? 'instrumentation_failed' : missing.length ? 'required_hook_not_observed' : null) };
}
function safeTrace(raw, destination) {
  let content;
  try { content = fs.readFileSync(raw, 'utf8'); }
  catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'read_error', validation_error: 'trace_unavailable', tally: null }; }
  const { events, ...summary } = sanitizeTrace(content);
  const result = { ...summary, state: summary.sanitation_error ? 'invalid' : summary.validation_error ? 'incomplete' : 'ok',
    safe_event_count: events.length, write_error: false };
  try { if (events.length) fs.writeFileSync(destination, events.join('\n') + '\n'); }
  catch { result.write_error = true; result.validation_error = 'safe_trace_write_error'; result.state = 'write_error'; }
  return result;
}
// These are categories, never redacted versions of raw error text. Unknown text stays 'other'.
function diagnosticErrors(value) {
  const messages = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
  const text = messages.join('\n');
  const rules = [
    ['require_filename', /^(?=.*(?:createRequire|filename))(?=.*(?:ERR_INVALID_ARG_VALUE|file URL|absolute path))/s],
    ['invalid_url', /ERR_INVALID_URL/], ['module_resolution', /(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|Failed to resolve import)/],
    ['syntax', /SyntaxError|Parse failure|Transform failed/], ['native_guard', /Native Windows diagnostic only/],
    ['missing_hook', /Missing required diagnostic hook/], ['invalid_cohort', /Invalid diagnostic cohort/],
    ['instrumentation', /Diagnostic instrumentation failed/], ['test_timeout', /timed out/i],
    ['refresh_assertion', /toHaveBeenCalledTimes|called [123] times/],
  ];
  const categories = rules.filter(([, rule]) => rule.test(text)).map(([category]) => category);
  return { message_present: !!text, categories: categories.length ? categories : text ? ['other'] : [],
    error_codes: ['ERR_INVALID_ARG_VALUE', 'ERR_INVALID_URL', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ENOENT', 'EPERM', 'EACCES', 'ELOCKED']
      .filter(code => new RegExp(`\\b${code}\\b`).test(text)),
    error_classes: ['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'AssertionError', 'AbortError', 'DOMException',
      'ModelsError', 'CredentialSynchronizationError'].filter(name => new RegExp(`\\b${name}\\b`).test(text)) };
}
function safeLog(file) {
  try { const content = fs.readFileSync(file, 'utf8'); return { state: 'ok', bytes: Buffer.byteLength(content), ...diagnosticErrors(content) }; }
  catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'read_error', bytes: null, ...diagnosticErrors(null) }; }
}
const statuses = new Set(['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled']);
const status = value => statuses.has(value) ? value : 'other';
const expectedNames = task => task.cohort === 'A' ? [targetName] : task.keys.map((key, index) => `diagnostic ${index} ${key}`);
function summarizeReport(report, task) {
  const result = { state: 'ok', success: report?.success === true, reported_total_tests: finite(report?.numTotalTests),
    reported_passed_tests: finite(report?.numPassedTests), reported_failed_tests: finite(report?.numFailedTests),
    reported_pending_tests: finite(report?.numPendingTests), suites: [], selected_count: null, selected: [], validation_error: null };
  if (!record(report) || !Array.isArray(report.testResults)) return { ...result, state: 'invalid', validation_error: 'invalid_report_schema' };
  // Preserve suite startup/collection evidence BEFORE applying cardinality/name checks.
  result.suites = report.testResults.map((suite, index) => ({ suite_index: index, status: status(suite?.status),
    assertion_count: Array.isArray(suite?.assertionResults) ? suite.assertionResults.length : null, ...diagnosticErrors(suite?.message) }));
  if (!report.testResults.every(suite => record(suite) && Array.isArray(suite.assertionResults) && suite.assertionResults.every(record)))
    return { ...result, state: 'invalid', validation_error: 'invalid_report_schema' };
  const assertions = report.testResults.flatMap(suite => suite.assertionResults);
  const selected = assertions.filter(test => !['pending', 'skipped', 'todo', 'disabled'].includes(test.status));
  const names = expectedNames(task);
  // Keep the original reporter whitespace normalization. 'list --json' below
  // separately checks exact collected names; reporter statuses alone do not prove execution.
  const testName = test => typeof test.fullName === 'string' ? test.fullName.trim() : null;
  result.collected_count = assertions.length;
  result.matching_name_count = assertions.filter(test => names.includes(testName(test))).length;
  result.selected_count = selected.length;
  result.selected = selected.map((test, index) => ({ test_index: index,
    case_key: names.includes(testName(test)) ? task.keys[names.indexOf(testName(test))] : 'other',
    expected_name_match: testName(test) === names[index], status: status(test.status), duration_ms: finite(test.duration),
    ...diagnosticErrors(test.failureMessages) }));
  result.validation_error = selected.length !== names.length ? 'selected_case_count_mismatch'
    : result.selected.some(test => !test.expected_name_match) ? 'selected_case_name_mismatch'
    : result.selected.some(test => !['passed', 'failed'].includes(test.status)) ? 'invalid_test_status' : null;
  return result;
}
function safeReport(file, task) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'read_error', selected_count: null, selected: [], suites: [], validation_error: 'report_unavailable' }; }
  try { return summarizeReport(JSON.parse(content), task); }
  catch { return { state: 'invalid', selected_count: null, selected: [], suites: [], validation_error: 'invalid_report_json' }; }
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
  const file = original ? 'tests/kimi-context-ui.test.tsx' : 'tests/kimi-context-ui.windows-diag.test.tsx';
  const args = ['node_modules/vitest/vitest.mjs', 'run', file, '--testNamePattern', original ? `^${targetName}$` : '^diagnostic ',
    '--retry=0', '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', `--outputFile=${rawResult}`];
  const start = performance.now();
  const stdoutFile = path.join(base, 'raw', `${stem}.stdout.txt`), stderrFile = path.join(base, 'raw', `${stem}.stderr.txt`);
  const stdout = fs.openSync(stdoutFile, 'w'), stderr = fs.openSync(stderrFile, 'w');
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
  const elapsed = performance.now() - start;
  const result = { cohort: task.cohort, process_index: task.index, planned_cases: task.keys, elapsed_ms: elapsed,
    cap_ms: task.cap, effective_cap_ms: limitMs, exit_code: exit, timed_out: timedOut, spawn_error: spawnError,
    kill_failure: killFailure, deadline_exceeded: timedOut || elapsed > limitMs, outcome: 'failed' };
  result.reporter = safeReport(rawResult, task);
  result.selected_count = result.reporter.selected_count;
  result.selected = result.reporter.selected;
  result.logs = { stdout: safeLog(stdoutFile), stderr: safeLog(stderrFile) };
  // Trace processing is independent of reporter validity/counts; neither failure hides the other.
  result.trace = original ? { state: 'not_applicable', tally: null, validation_error: null }
    : safeTrace(rawTrace, path.join(base, 'safe', `${stem}.trace.jsonl`));
  result.trace_tally = result.trace.tally;
  result.validation_error = result.reporter.validation_error ?? result.trace.validation_error;
  result.execution_complete = result.reporter.validation_error === null
    && (original || result.trace_tally?.['test.begin'] === task.keys.length);
  result.outcome = !result.deadline_exceeded && !spawnError && !killFailure && exit === 0 && result.reporter.success
    && Object.values(result.logs).every(log => log.state === 'ok')
    && !result.validation_error && result.execution_complete && result.selected.every(test => test.status === 'passed') ? 'passed' : 'failed';
  json(`${stem}.result.json`, result);
  console.log(JSON.stringify({ cohort: result.cohort, process_index: task.index, outcome: result.outcome,
    selected_count: result.selected_count, elapsed_ms: result.elapsed_ms, timed_out: timedOut, validation_error: result.validation_error,
    trace_state: result.trace.state, suite_statuses: result.reporter.suites.map(suite => suite.status) }));
  return result;
}
async function main() {
  const sha = scope(); directories();
  json('scope.json', { sha, baseline, diagnostic_base: diagnosticBase, branch, allowed_files: allow, manual_only: true, contents_permission: 'read' });
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
    json('summary.json', { sha, baseline, elapsed_ms: performance.now() - start, ...completion(results),
      failed_latched: results.some(result => result.outcome !== 'passed'), results });
  }
  const { complete, processes_complete } = completion(results);
  const failed = results.some(result => result.outcome !== 'passed');
  const deadlineExceeded = performance.now() - start > 480000;
  json('summary.json', { sha, baseline, elapsed_ms: performance.now() - start, complete: complete && !deadlineExceeded,
    processes_complete, deadline_exceeded: deadlineExceeded, failed_latched: failed || deadlineExceeded,
    outcome: complete && !failed && !deadlineExceeded ? 'bounded_sample_not_reproduced'
      : complete && !deadlineExceeded ? 'diagnostic_failure' : 'bounded_diagnosis_incomplete', results });
  if (failed || !complete || deadlineExceeded) process.exitCode = 1;
}
function completion(results) {
  const processes_complete = results.length === tasks.length;
  return { processes_complete, complete: processes_complete && results.every(result => result.execution_complete
    && ['ok', 'not_applicable'].includes(result.trace.state)) };
}
// Local, collection-only preflight. It never executes the 15 diagnostic cases,
// spoofs a native platform/version, installs hooks, or installs dependencies.
async function preflight() {
  const { default: assert } = await import('node:assert/strict');
  const { createRequire } = await import('node:module');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-diag-preflight-'));
  const result = { outcome: 'failed', stage: 'versions', platform: process.platform, node: process.version,
    native_initialization_verified: false, test_bodies_executed: 0, directory };
  const write = () => fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify(result, null, 2) + '\n');
  try {
    result.versions = Object.fromEntries(['vitest', 'vite', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'].map(name =>
      [name, JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version]));
    assert.deepEqual(result.versions, { vitest: '4.1.11', vite: '7.3.5', '@earendil-works/pi-coding-agent': '1.2.0', '@earendil-works/pi-ai': '1.2.0' });
    result.stage = 'sanitizers';
    const secret = 'DO_NOT_EXPORT_token_or_path';
    const valid = requiredEvents.map(event => JSON.stringify({ event })).join('\n');
    assert.equal(sanitizeTrace(valid).validation_error, null);
    const bad = [
      ['null', 'invalid_trace_record'], ['[]', 'invalid_trace_record'], ['42', 'invalid_trace_record'], ['{"event":', 'invalid_trace_json'],
      [JSON.stringify({ event: 'test.begin', message: secret }), 'unknown_trace_field'],
      [JSON.stringify({ event: secret }), 'unknown_trace_event'],
      [JSON.stringify({ event: 'test.begin', error_code: secret }), 'unsafe_trace_string'],
      [JSON.stringify({ event: 'test.begin', sdk_errors: null }), 'invalid_sdk_errors'],
      [JSON.stringify({ event: 'test.begin', sdk_errors: [null] }), 'invalid_sdk_errors'],
      [JSON.stringify({ event: 'test.begin', sdk_errors: [{ message: secret }] }), 'unsafe_sdk_error_field'],
      [JSON.stringify({ event: 'test.begin', sdk_errors: [{ error_code: secret }] }), 'unsafe_trace_string'],
      ['{"event":"test.begin","__proto__":{"message":"' + secret + '"}}', 'unknown_trace_field'],
      ['{"event":"test.begin","monotonic_ms":1e400}', 'unsafe_trace_type'],
    ];
    for (const [text, error] of bad) {
      const sanitized = sanitizeTrace('{"event":"test.begin"}\n' + text);
      assert.equal(sanitized.sanitation_error, error);
      assert.equal(sanitized.error_line, 2);
      assert.equal(sanitized.events.length, 1);
      assert.ok(!JSON.stringify(sanitized).includes(secret));
    }
    const task = tasks[3];
    const startup = summarizeReport({ success: false, testResults: [{ status: 'failed', assertionResults: [],
      message: `TypeError [ERR_INVALID_ARG_VALUE]: filename must be a file URL ${secret}` }] }, task);
    assert.equal(startup.selected_count, 0);
    assert.equal(startup.validation_error, 'selected_case_count_mismatch');
    assert.deepEqual(startup.suites[0].categories, ['require_filename']);
    assert.equal(startup.suites[0].status, 'failed');
    assert.ok(!JSON.stringify(startup).includes(secret));
    const test = { fullName: 'diagnostic 0 T', status: 'passed', duration: 1 };
    const mismatch = summarizeReport({ success: true, testResults: [{ status: 'passed', assertionResults: [test, test] }] }, task);
    assert.equal(mismatch.selected_count, 2);
    assert.equal(mismatch.selected.length, 2);
    assert.equal(mismatch.validation_error, 'selected_case_count_mismatch');
    const hookFailure = summarizeReport({ success: false, testResults: [{ status: 'failed', message: 'Native Windows diagnostic only',
      assertionResults: [{ ...test, status: 'skipped' }] }] }, task);
    assert.equal(hookFailure.matching_name_count, 1);
    assert.equal(hookFailure.selected_count, 0);
    assert.deepEqual(hookFailure.suites[0].categories, ['native_guard']);
    assert.equal(summarizeReport({ success: true, testResults: [{ status: 'passed',
      assertionResults: [{ ...test, fullName: ' diagnostic 0 T ' }] }] }, task).validation_error, null);
    const unexpected = summarizeReport({ success: false, testResults: [{ status: secret, assertionResults: [{ fullName: secret,
      status: secret, duration: secret, failureMessages: [secret, { message: secret }] }] }] }, task);
    assert.equal(unexpected.validation_error, 'selected_case_name_mismatch');
    assert.equal(unexpected.selected[0].case_key, 'other');
    assert.ok(!JSON.stringify(unexpected).includes(secret));
    assert.equal(summarizeReport({ testResults: [{ status: 'failed', message: secret }] }, task).selected_count, null);
    const missing = path.join(directory, 'absent');
    assert.equal(safeReport(missing, task).selected_count, null);
    assert.equal(safeTrace(missing, missing + '.safe').state, 'missing');
    assert.equal(safeLog(missing).state, 'missing');
    assert.equal(safeTrace(directory, missing).state, 'read_error');
    const raw = path.join(directory, 'synthetic-input.jsonl'), safe = path.join(directory, 'synthetic-safe.jsonl');
    fs.writeFileSync(raw, valid + '\n{"event":"test.begin","message":"' + secret + '"}');
    assert.equal(safeTrace(raw, safe).state, 'invalid');
    assert.ok(!fs.readFileSync(safe, 'utf8').includes(secret));
    assert.equal(safeTrace(raw, directory).write_error, true);
    fs.writeFileSync(raw, '{');
    assert.equal(safeReport(raw, task).validation_error, 'invalid_report_json');
    assert.ok(!JSON.stringify(diagnosticErrors(`ERR_INVALID_ARG_VALUE ${secret}`)).includes(secret));
    assert.equal(completion(tasks.map(() => ({ execution_complete: false, trace: { state: 'missing' } }))).complete, false);
    result.sanitizers = { passed: true, malformed_trace_cases: bad.length, safe_prefix_preserved: true,
      startup_summary_preserved: true, missing_count_is_null: true, sentinel_absent: true };
    result.stage = 'client_transform';
    const helper = path.join(root, 'tests/helpers/kimi-context-windows-trace.ts');
    const source = fs.readFileSync(helper, 'utf8');
    assert.ok(source.includes('new NodeURL('));
    const { createVitest } = await import(pathToFileURL(path.join(root, 'node_modules/vitest/dist/node.js')).href);
    const ctx = await createVitest('test', { root, config: path.join(root, 'vitest.config.js'), watch: false },
      { cacheDir: path.join(directory, 'vite-cache'), server: { middlewareMode: true, hmr: false, watch: null },
        plugins: [{ name: 'diagnostic-url-negative-control', enforce: 'pre', load(id) {
          if (id === helper + '?diagnostic-negative') return source.replace('new NodeURL(', 'new URL(');
        } }] });
    try {
      const current = (await ctx.vite.environments.client.transformRequest(helper)).code;
      const prior = (await ctx.vite.environments.client.transformRequest(helper + '?diagnostic-negative')).code;
      const expression = code => code.match(/createRequire\((new (?:NodeURL|URL)\([^\n]+\))\)/)?.[1];
      const fixedExpression = expression(current), oldExpression = expression(prior);
      const moduleURL = /(?:import\.meta|__vite_ssr_import_meta__)\.url/;
      assert.ok(moduleURL.test(fixedExpression));
      assert.ok(!fixedExpression.includes('self.location'));
      assert.ok(oldExpression?.includes('self.location'));
      const fixedURL = Function('NodeURL', 'moduleURL', `return ${fixedExpression.replace(moduleURL, 'moduleURL')}`)(NodeURL, pathToFileURL(helper).href);
      const oldURL = Function('URL', 'self', `return ${oldExpression}`)(NodeURL, { location: 'http://localhost:3000/' });
      assert.equal(oldURL.protocol, 'http:');
      assert.throws(() => createRequire(oldURL), { code: 'ERR_INVALID_ARG_VALUE' });
      const sdkAnchor = path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js');
      assert.equal(fixedURL.href, pathToFileURL(sdkAnchor).href);
      assert.equal(createRequire(fixedURL).resolve('proper-lockfile'), createRequire(sdkAnchor).resolve('proper-lockfile'));
      assert.equal(createRequire(fixedURL)('proper-lockfile'), createRequire(sdkAnchor)('proper-lockfile'));
      result.client_transform = { passed: true, negative_control: 'ERR_INVALID_ARG_VALUE', fixed_protocol: fixedURL.protocol,
        sdk_anchor_unchanged: true, same_lockfile_instance: true };
    } finally { await ctx.close(); }
    result.stage = 'collection';
    result.collection = [];
    for (const task of [tasks[3], tasks[6], tasks[7]]) {
      const output = path.join(directory, `list-${task.cohort}.json`), trace = path.join(directory, `trace-${task.cohort}.jsonl`);
      const stdout = fs.openSync(path.join(directory, `list-${task.cohort}.stdout.txt`), 'w');
      const stderr = fs.openSync(path.join(directory, `list-${task.cohort}.stderr.txt`), 'w');
      let child;
      try {
        child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'list', 'tests/kimi-context-ui.windows-diag.test.tsx',
          '--testNamePattern', '^diagnostic ', `--json=${output}`, '--retry=0', '--maxWorkers=1', '--no-file-parallelism'],
        { cwd: root, env: childEnv(task, trace), shell: false, windowsHide: true, timeout: 60_000, stdio: ['ignore', stdout, stderr] });
      } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
      const entry = { cohort: task.cohort, expected_count: task.keys.length, exit_code: child.status, spawn_error: !!child.error,
        logs: { stdout: safeLog(path.join(directory, `list-${task.cohort}.stdout.txt`)), stderr: safeLog(path.join(directory, `list-${task.cohort}.stderr.txt`)) } };
      result.collection.push(entry);
      assert.equal(child.status, 0);
      const listed = JSON.parse(fs.readFileSync(output, 'utf8'));
      entry.actual_count = Array.isArray(listed) ? listed.length : null;
      entry.names = Array.isArray(listed) ? listed.map(test => expectedNames(task).includes(test?.name) ? test.name : 'other') : [];
      assert.deepEqual(listed.map(test => test.name), expectedNames(task));
      assert.ok(listed.every(test => fs.realpathSync(test.file) === fs.realpathSync(path.join(root, 'tests/kimi-context-ui.windows-diag.test.tsx'))));
      assert.ok(!fs.existsSync(trace), 'collection must not install hooks');
      entry.hooks_installed = false;
    }
    result.stage = 'complete'; result.outcome = 'passed';
  } catch (error) {
    // Local preflight evidence only, outside the runner's upload allowlist.
    fs.writeFileSync(path.join(directory, 'preflight.error.private.txt'), String(error?.stack ?? 'unknown preflight failure'));
    result.error = diagnosticErrors(error?.message); process.exitCode = 1;
  }
  write(); console.log(JSON.stringify(result, null, 2));
}
const operation = process.argv[2] === '--preflight' ? preflight : main;
operation().catch(error => {
  const reasons = ['native_windows_required', 'pinned_node_required', 'diagnostic_ref_required', 'manual_event_required', 'checkout_sha_mismatch',
    'single_repair_commit_required', 'diagnostic_ancestry_mismatch', 'diff_scope_mismatch', 'dirty_checkout', 'protected_blob_changed',
    'runner_temp_required', 'unsupported_mode'];
  console.error(JSON.stringify({ outcome: 'controller_failed', reason: reasons.includes(error?.message) ? error.message : 'other',
    ...diagnosticErrors(error?.message) }));
  process.exitCode = 1;
});
