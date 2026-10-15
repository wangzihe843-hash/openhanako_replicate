// Temporary diagnostic controller. Built-ins only; no network, build, release or credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL, URL as NodeURL } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { kimiProjectionCases } from '../tests/fixtures/kimi-context-cases.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = 'af4c8303f859c0f2577003b6b89b8e950689f89d';
const diagnosticBase = '92c24534db25366fad26dc5d1d269d3073b8c9d1';
const branch = 'diagnostic/windows-kimi-context-20261015';
const allow = ['.github/workflows/build.yml', 'tests/kimi-context-ui.windows-diag.test.tsx',
  'tests/helpers/kimi-context-windows-trace.ts', 'tests/kimi-context-ui.windows-peer.test.tsx', 'scripts/diagnose-windows-kimi-context.mjs'].sort();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const requireThat = (ok, reason) => { if (!ok) throw new Error(reason); };
function scope() {
  requireThat(process.platform === 'win32', 'native_windows_required');
  requireThat(process.version === 'v24.15.0', 'pinned_node_required');
  requireThat(process.env.GITHUB_REF === `refs/heads/${branch}`, 'diagnostic_ref_required');
  requireThat(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'manual_event_required');
  const sha = git('rev-parse', 'HEAD');
  requireThat(sha === process.env.GITHUB_SHA, 'checkout_sha_mismatch');
  requireThat(git('show', '-s', '--format=%P', 'HEAD') === diagnosticBase, 'single_followup_commit_required');
  requireThat(git('merge-base', baseline, diagnosticBase) === baseline, 'diagnostic_ancestry_mismatch');
  verifyGenerated();
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
const targetFile = 'tests/kimi-context-ui.windows-diag.test.tsx';
const peerFile = 'tests/kimi-context-ui.windows-peer.test.tsx';
const order = ['H0L0', 'H1L1', 'H0L1', 'H1L0', 'H1L0', 'H0L1', 'H1L1', 'H0L0'];
const tasks = order.map((cohort, index) => ({ cohort, index, history: cohort[1] === '1', load: cohort[3] === '1',
  keys: [...Array(cohort[1] === '1' ? 16 : 0).fill('prefix'), 'T', ...Array(cohort[3] === '1' ? 24 : 0).fill('peer')], cap: 120000 }));
// Mechanical copies: exact original business bodies for all 16 prefix and 24 peer
// tests. Only T receives the already accepted fine-grained observations.
function generatedSource(peer) {
  const original = fs.readFileSync(path.join(root, 'tests/kimi-context-ui.test.tsx'), 'utf8');
  const first = original.indexOf('it.each('), second = original.indexOf('it.each(', first + 1);
  const replace = (text, from, to) => { requireThat(text.split(from).length === 2, 'generation_anchor_mismatch'); return text.replace(from, to); };
  let header = original.slice(0, first).replace('afterEach, beforeEach,', 'afterAll, afterEach, beforeAll, beforeEach,');
  header = replace(header, 'let fixtureHome: string;', `import * as trace from './helpers/kimi-context-windows-trace';
const peer = ${peer};
const history = process.env.KIMI_DIAG_COHORT?.[1] === '1';
let testIndex = 0;
beforeAll(() => { trace.configureRole(peer); trace.install(ModelManager.prototype, ProviderRegistry.prototype, useSettingsStore); });
afterAll(() => trace.finish());
let fixtureHome: string;`);
  header = replace(header, "  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live calls in UI context tests'));", "  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live calls in UI context tests'));\n  trace.beforeTest(fixtureHome, testIndex++, peer ? 'peer' : history && testIndex <= 16 ? 'prefix' : 'T');");
  for (const [from, to] of [
    ['  cleanup();', "  trace.lifecycle('cleanup.begin');\n  cleanup();\n  trace.lifecycle('cleanup.end');\n  trace.lifecycle('fetch-guard.begin');"],
    ['  expect(globalThis.fetch).not.toHaveBeenCalled();', "  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }\n  catch(error) { trace.lifecycle('fetch-guard.fail'); throw error; }\n  trace.lifecycle('fetch-guard.pass');"],
    ['  vi.restoreAllMocks();', "  vi.restoreAllMocks();\n  trace.lifecycle('restoreMocks.end');\n  trace.lifecycle('fixture.remove.begin');"],
    ['  fs.rmSync(fixtureHome, { recursive: true, force: true });', "  fs.rmSync(fixtureHome, { recursive: true, force: true });\n  trace.lifecycle('fixture.remove.end');\n  trace.health();"],
  ]) header = replace(header, from, to);
  const observed = chunk => replace(chunk, 'async c => {', 'async c => trace.runCase(trace.context(), async () => {').replace(/  \}\);\s*$/, '  }));\n');
  let pending = original.slice(first, second), editing = original.slice(second);
  pending = replace(pending, 'kimiProjectionCases.filter(c => c.base_url && c.api && !c.modelApi)', '(peer || history ? kimiProjectionCases.filter(c => c.base_url && c.api && !c.modelApi) : [])');
  if (peer) return header + observed(pending) + observed(editing);
  const prefix = replace(editing, 'kimiProjectionCases.filter(c => c.base_url && c.api)', '(history ? kimiProjectionCases.filter(c => c.base_url && c.api).slice(0, 10) : [])');
  let target = replace(editing, 'kimiProjectionCases.filter(c => c.base_url && c.api)', "kimiProjectionCases.filter(c => c.label === 'ai' && c.api === 'anthropic-messages' && c.modelApi === 'openai-completions')");
  target = replace(target, '    await manager.init();', '    trace.attachManager(manager, fixtureHome);\n    await manager.init();');
  target = replace(target, '    for (const budget of [{}, ...kimiExplicitBudgets]) {', '    for (const [budgetIndex, budget] of [{}, ...kimiExplicitBudgets].entries()) {\n      await trace.budget(budgetIndex, async () => {');
  target = replace(target, '      unmount();\n    }', '      unmount();\n      });\n    }');
  target = replace(target, '        ? app.request(url, options)', '        ? trace.put(app, url, options)');
  target = replace(target, '      const onRefresh = vi.fn(async () => {});', '      const onRefresh = vi.fn(async () => { trace.onRefresh(); });');
  target = replace(target, '      mocks.hanaFetch.mockImplementation', '      trace.stateSnapshot(manager, useSettingsStore, useSettingsStore.getState().providersSummary[provider] === summary);\n      mocks.hanaFetch.mockImplementation');
  target = replace(target, "      fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));\n      await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));", "      await trace.save('rename', () => fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' })),\n        poll => waitFor(poll), () => expect(onRefresh).toHaveBeenCalledTimes(1),\n        () => onRefresh.mock.calls.length, () => !!screen.queryByRole('textbox'));");
  target = replace(target, "        fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));\n        await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(edited === 1048576 ? 2 : 3));", "        await trace.save(`context-${edited}`, () => fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' })),\n          poll => waitFor(poll), () => expect(onRefresh).toHaveBeenCalledTimes(edited === 1048576 ? 2 : 3),\n          () => onRefresh.mock.calls.length, () => !!screen.queryByRole('textbox'));");
  return header + observed(pending) + observed(prefix) + observed(target);
}
function verifyGenerated() {
  for (const [file, peer] of [[targetFile, false], [peerFile, true]])
    requireThat(fs.readFileSync(path.join(root, file), 'utf8') === generatedSource(peer), 'generated_copy_mismatch');
}
const fieldNames = new Set((`cohort process_index worker_role worker_id pid wall_ms fixture_id test_index case_key budget_index action manager_id runtime_id request_id span_id parent_span_id
event monotonic_ms elapsed_ms outcome http_status sdk_error_count sdk_aborted sdk_errors error_class error_code syscall installation_stage
pending_put_count pending_runtime_refresh_count pending_span_count config_read_id config_error availability_seq kimi_generation xai_generation
refresh_generation publication_generation signal_aborted published refresh_origin provider_id write_revision end_write_revision read_id file_role
lock_attempts_observed wait_timeout_ms test_timeout_ms provider_reset toast_type toast_visible response_ok response_has_error response_has_code
on_refresh_count panel_present deadline_ms event_loop_max_ms event_loop_mean_ms event_loop_utilization pending_kind started_ms response_error_category cpu_user_us cpu_system_us rss_bytes io_read_bytes io_write_bytes resource_available lag_tick_ms
config_present config_api config_context config_contextWindow config_name runtime_present runtime_api runtime_context runtime_contextWindow runtime_name
manager_present manager_api manager_context manager_contextWindow manager_name request_has_context request_context request_has_contextWindow request_contextWindow request_name`).split(/\s+/));
const labels = new Set((`H0L0 H1L0 H0L1 H1L1 prefix peer target T unavailable absent other explicit registration unregistration renamed success error
anthropic-messages openai-completions kimi-coding xai-oauth auth.json models.json models-store.json providers.json provider-catalog.json fixture-other
rename context-1048576 context-262144 EPERM EACCES EBUSY ELOCKED ENOENT ENOTEMPTY ABORT_ERR ETIMEDOUT EINVAL
Error TypeError SyntaxError ReferenceError RangeError AssertionError AbortError DOMException ModelsError CredentialSynchronizationError
ERR_INVALID_ARG_VALUE ERR_INVALID_URL MODULE_NOT_FOUND ERR_MODULE_NOT_FOUND guard lockfile_resolve hook_install restore
mkdir open read write unlink rmdir stat not_found permission lock`).split(/\s+/));
const eventNames = new Set((`instrumentation.ready instrumentation.failure beforeEach.done test.begin test.body.pass test.body.fail budget.begin budget.pass budget.fail
budget.state manager.created PUT.body PUT.body.unreadable onRefresh.enter onRefresh.exit save.click.begin save.click.return waitFor.begin waitFor.poll waitFor.pass waitFor.fail
toast.change cleanup.begin cleanup.end fetch-guard.begin fetch-guard.pass fetch-guard.fail restoreMocks.end fixture.remove.begin fixture.remove.end eventLoop.sample pending.span tail.begin tail.end worker.begin worker.end resource.sample`).split(/\s+/));
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
function sanitizeTrace(text, required = requiredEvents) {
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
  const missing = required.filter(event => !tally[event]);
  return { events, tally, sanitation_error: sanitationError, error_line: errorLine, missing_required_events: missing,
    validation_error: sanitationError ?? (tally['instrumentation.failure'] ? 'instrumentation_failed' : missing.length ? 'required_hook_not_observed' : null) };
}
function safeTrace(raw, destination, required) {
  let content;
  try { content = fs.readFileSync(raw, 'utf8'); }
  catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'read_error', validation_error: 'trace_unavailable', tally: null }; }
  const { events, ...summary } = sanitizeTrace(content, required);
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
    ['instrumentation', /Diagnostic instrumentation failed/], ['live_network', /No live calls|not.toHaveBeenCalled/], ['test_timeout', /timed out/i],
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
let collectedNames;
const expectedNames = task => [...(task.history ? collectedNames.slice(0,17) : [targetName]), ...(task.load ? collectedNames : [])];
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
  const assertions = [...report.testResults].sort((a,b) => Number(a.name?.includes('windows-peer')) - Number(b.name?.includes('windows-peer'))).flatMap(suite => suite.assertionResults);
  const selected = assertions.filter(test => !['pending', 'skipped', 'todo', 'disabled'].includes(test.status));
  const names = expectedNames(task);
  // Keep the original reporter whitespace normalization. 'list --json' below
  // separately checks exact collected names; reporter statuses alone do not prove execution.
  const testName = test => typeof test.fullName === 'string' ? test.fullName.trim() : null;
  result.collected_count = assertions.length;
  result.matching_name_count = assertions.filter(test => names.includes(testName(test))).length;
  result.selected_count = selected.length;
  result.selected = selected.map((test, index) => ({ test_index: index,
    case_key: testName(test) === targetName && index < (task.history ? 17 : 1) ? 'T' : index >= (task.history ? 17 : 1) ? 'peer' : 'prefix',
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
    KIMI_DIAG_PROCESS_INDEX: String(task.index), KIMI_DIAG_TRACE: traceFile, KIMI_DIAG_RESOURCE: '1' };
}
async function execute(task, limitMs) {
  const stem = `${task.index}-${task.cohort}`;
  const rawResult = path.join(base, 'raw', `${stem}.json`), rawTrace = path.join(base, 'raw', `${stem}.jsonl`);
  const args = ['node_modules/vitest/vitest.mjs', 'run', targetFile, ...(task.load ? [peerFile] : []),
    '--retry=0', '--maxWorkers=2', '--fileParallelism', '--isolate', '--reporter=json', `--outputFile=${rawResult}`];
  const start = performance.now();
  const resource = []; let childPid = null;
  const sample = () => resource.push({ controller_pid: process.pid, vitest_pid: childPid, wall_ms: Date.now(), controller_cpu_us: process.cpuUsage(), controller_rss_bytes: process.memoryUsage().rss,
    total_memory_bytes: os.totalmem(), free_memory_bytes: os.freemem(), cpu_count: os.cpus().length, available_parallelism: os.availableParallelism(), io: 'unavailable' });
  sample(); const resourceTimer = setInterval(sample, 500);
  const stdoutFile = path.join(base, 'raw', `${stem}.stdout.txt`), stderrFile = path.join(base, 'raw', `${stem}.stderr.txt`);
  const stdout = fs.openSync(stdoutFile, 'w'), stderr = fs.openSync(stderrFile, 'w');
  let timedOut = false, spawnError = false, killFailure = false;
  const exit = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv(task, rawTrace), shell: false, windowsHide: true,
      stdio: ['ignore', stdout, stderr] });
    childPid = child.pid ?? null; sample();
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
  clearInterval(resourceTimer); sample();
  json(`${stem}.resources.json`, resource);
  fs.closeSync(stdout); fs.closeSync(stderr);
  const elapsed = performance.now() - start;
  const result = { cohort: task.cohort, process_index: task.index, planned_cases: task.keys, elapsed_ms: elapsed,
    vitest_pid: childPid, cap_ms: task.cap, effective_cap_ms: limitMs, exit_code: exit, timed_out: timedOut, spawn_error: spawnError,
    kill_failure: killFailure, deadline_exceeded: timedOut || elapsed > limitMs, outcome: 'failed' };
  result.reporter = safeReport(rawResult, task);
  result.selected_count = result.reporter.selected_count;
  result.selected = result.reporter.selected;
  result.logs = { stdout: safeLog(stdoutFile), stderr: safeLog(stderrFile) };
  // Trace processing is independent of reporter validity/counts; neither failure hides the other.
  json(`${stem}.result.json`, result); // Preserve reporter and first errors before any trace processing.
  try { result.trace = combinedTrace(rawTrace, path.join(base, 'safe', `${stem}.trace.jsonl`), task); }
  catch { result.trace = { state: 'error', tally: null, validation_error: 'trace_processing_error' }; }
  result.trace_tally = result.trace.tally;
  result.validation_error = result.reporter.validation_error ?? result.trace.validation_error;
  result.execution_complete = result.reporter.validation_error === null
    && result.trace_tally?.['test.begin'] === task.keys.length;
  try { result.load_control = loadControl(path.join(base, 'safe', `${stem}.trace.jsonl`), task); }
  catch { result.load_control = { required: task.load, sufficient: false, reason: 'trace_processing_error' }; }
  result.outcome = !result.deadline_exceeded && !spawnError && !killFailure && exit === 0 && result.reporter.success
    && Object.values(result.logs).every(log => log.state === 'ok')
    && !result.validation_error && !result.trace.late_pass_count && result.execution_complete && result.selected.every(test => test.status === 'passed') ? 'passed' : 'failed';
  json(`${stem}.result.json`, result);
  console.log(JSON.stringify({ cohort: result.cohort, process_index: task.index, outcome: result.outcome,
    selected_count: result.selected_count, elapsed_ms: result.elapsed_ms, timed_out: timedOut, validation_error: result.validation_error,
    trace_state: result.trace.state, suite_statuses: result.reporter.suites.map(suite => suite.status) }));
  return result;
}
async function main() {
  const sha = scope(); directories();
  json('scope.json', { sha, baseline, diagnostic_base: diagnosticBase, branch, allowed_files: allow, manual_only: true, contents_permission: 'read', baseline_tree: git('rev-parse', `${baseline}^{tree}`), diagnostic_base_tree: git('rev-parse', `${diagnosticBase}^{tree}`), scope_sha256: createHash('sha256').update(allow.map(file => file + ':' + digest(file)).join('\n')).digest('hex') });
  if (process.argv[2] === '--check-scope') return;
  collectedNames = originalNames();
  requireThat(process.argv[2] === '--run', 'unsupported_mode');
  const sources = [...allow, 'tests/kimi-context-ui.test.tsx', 'tests/fixtures/kimi-context-cases.ts', 'vitest.config.js', 'package-lock.json',
    'node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js', 'node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js',
    'node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js', 'node_modules/@earendil-works/pi-ai/dist/models.js',
    'node_modules/@testing-library/dom/dist/config.js', 'node_modules/@testing-library/react/dist/pure.js'];
  const packages = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'vitest', '@testing-library/dom', '@testing-library/react'];
  json('environment.json', { sha, os: os.type(), release: os.release(), arch: os.arch(), node: process.version,
    npm: execFileSync(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), '--version'], { encoding: 'utf8' }).trim(),
    image_os: process.env.ImageOS, image_version: process.env.ImageVersion, runner_os: process.env.RUNNER_OS,
    packages: Object.fromEntries(packages.map(name => [name, JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'))).version])),
    sha256: Object.fromEntries(sources.map(file => [file, digest(file)])),
    total_budget_ms: 600000, max_processes: 8, max_case_instances: 168, max_synthetic_puts: 3264,
    wait_timeout_ms: 1000, test_timeout_ms: 10000, file_parallelism: true, isolate: true, max_workers: 2, retries: 0,
    observation_strategy_identical: true, tail_ms_per_instrumented_process: 2000 });
  const start = performance.now(), results = [];
  for (const task of tasks) {
    const remaining = 600000 - (performance.now() - start) - 5000;
    if (remaining <= 0) break;
    results.push(await execute(task, Math.min(task.cap, remaining)));
    json('summary.json', { sha, baseline, elapsed_ms: performance.now() - start, ...completion(results),
      failed_latched: results.some(result => result.outcome !== 'passed'), results });
    const latest = results.at(-1);
    if (latest.validation_error || latest.spawn_error || latest.kill_failure || latest.trace_tally?.['instrumentation.failure'] || latest.trace_tally?.['fetch-guard.fail'] || latest.reporter.selected.some(test => test.categories.includes('live_network'))) break;
  }
  const { complete, processes_complete } = completion(results);
  const failed = results.some(result => result.outcome !== 'passed');
  const loadSufficient = results.filter(r => r.load_control.required).every(r => r.load_control.sufficient);
  const deadlineExceeded = performance.now() - start > 600000;
  json('summary.json', { sha, baseline, elapsed_ms: performance.now() - start, complete: complete && !deadlineExceeded,
    processes_complete, deadline_exceeded: deadlineExceeded, failed_latched: failed || deadlineExceeded,
    load_control_sufficient: loadSufficient, outcome: complete && !failed && !deadlineExceeded ? loadSufficient ? 'bounded_sample_not_reproduced' : 'load_control_insufficient'
      : complete && !deadlineExceeded ? 'diagnostic_failure' : 'bounded_diagnosis_incomplete', results });
  if (failed || !complete || deadlineExceeded || !loadSufficient) process.exitCode = 1;
}
function completion(results) {
  const processes_complete = results.length === tasks.length;
  return { processes_complete, complete: processes_complete && results.every(result => result.execution_complete
    && ['ok', 'not_applicable'].includes(result.trace.state)) };
}
function originalNames() {
  const quote = value => typeof value === 'string' ? `'${value}'` : String(value);
  return [
    ...kimiProjectionCases.filter(c => c.base_url && c.api && !c.modelApi).map(c => `keeps pending UI, saved UI and real runtime context consistent at ${quote(c.label)}/${quote(c.api)}`),
    ...kimiProjectionCases.filter(c => c.base_url && c.api).map(c => `keeps saved display, editing and runtime on the same budget branch at ${quote(c.label)}/${quote(c.api)}/${quote(c.modelApi)}`),
  ];
}
function combinedTrace(raw, destination, task) {
  const roles = ['target', ...(task.load ? ['peer'] : [])], summaries = {}, lines = [], tally = {};
  for (const role of roles) {
    const safe = destination + `.${role}.tmp`;
    const required = role === 'target' ? requiredEvents : ['worker.begin', 'worker.end', 'instrumentation.ready', 'beforeEach.done', 'test.begin', 'test.body.pass', 'cleanup.begin', 'fixture.remove.end', 'tail.end'];
    const summary = safeTrace(`${raw}.${role}.jsonl`, safe, required);
    summaries[role] = summary;
    if (fs.existsSync(safe)) { lines.push(...fs.readFileSync(safe, 'utf8').trim().split('\n').filter(Boolean)); fs.unlinkSync(safe); }
    for (const [key, count] of Object.entries(summary.tally ?? {})) tally[key] = (tally[key] ?? 0) + count;
  }
  const events = lines.map(line => JSON.parse(line));
  const counts = Object.fromEntries(roles.map(role => [role, events.filter(e => e.worker_role === role && e.event === 'test.begin').length]));
  const expected = { target: task.history ? 17 : 1, ...(task.load ? { peer: 24 } : {}) };
  const boundariesValid = roles.every(role => counts[role] === expected[role]
    && events.filter(e => e.worker_role === role && e.event === 'fixture.remove.end').length === expected[role]
    && events.filter(e => e.worker_role === role && e.event === 'test.begin').every((e,i) => e.test_index === i));
  const late = events.filter(e => e.event === 'waitFor.pass' && e.elapsed_ms > 1000);
  fs.writeFileSync(destination, lines.join('\n') + '\n');
  const validation_error = Object.values(summaries).find(s => s.validation_error)?.validation_error
    ?? (!boundariesValid ? 'trace_boundary_mismatch' : null);
  return { state: validation_error ? 'incomplete' : 'ok', validation_error, tally, roles: summaries, counts, expected,
    boundaries_valid: boundariesValid, late_pass_count: late.length, safe_event_count: lines.length };
}
function loadControl(file, task) {
  if (!task.load) return { required: false };
  if (!fs.existsSync(file)) return { required: true, sufficient: false, reason: 'trace_unavailable' };
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const peer = events.filter(e => e.worker_role === 'peer'), target = events.filter(e => e.worker_role === 'target');
  const begin = peer.find(e => e.event === 'test.begin'), end = peer.findLast(e => e.event === 'cleanup.end');
  const intervals = peer.filter(e => e.event === 'test.begin').map(e => [e.wall_ms, peer.find(x => x.test_index === e.test_index && x.event.startsWith('test.body.'))?.wall_ms ?? e.wall_ms]);
  const waits = target.filter(e => e.case_key === 'T' && e.event === 'waitFor.begin').map(e => {
    const finish = target.find(x => x.request_id === e.request_id && ['waitFor.pass','waitFor.fail'].includes(x.event));
    return { budget_index: e.budget_index, action: e.action, begin_wall_ms: e.wall_ms, end_wall_ms: finish?.wall_ms ?? null,
      overlap_ms: finish ? intervals.reduce((sum,[a,b]) => sum + Math.max(0, Math.min(finish.wall_ms,b) - Math.max(e.wall_ms,a)),0) : null,
      covered: !!finish && !!begin && !!end && begin.wall_ms <= e.wall_ms && end.wall_ms >= finish.wall_ms };
  });
  const separate = !!begin && target.some(e => e.case_key === 'T' && e.pid !== begin.pid && e.worker_id !== begin.worker_id);
  const peerSamples = peer.filter(e => e.event === 'resource.sample');
  return { required: true, sufficient: separate && waits.length === 24 && waits.every(w => w.covered && w.overlap_ms > 0) && peerSamples.length > 0,
    separate_worker: separate, peer_begin_wall_ms: begin?.wall_ms, peer_end_wall_ms: end?.wall_ms,
    peer_resource_samples: peerSamples.length, waits };
}
async function preflight() {
  const { default: assert } = await import('node:assert/strict');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-2x2-preflight-'));
  const result = { outcome: 'failed', stage: 'versions', platform: process.platform, node: process.version,
    native_initialization_verified: false, test_bodies_executed: 0, directory };
  const write = () => fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify(result, null, 2) + '\n');
  try {
    collectedNames = originalNames();
    result.versions = Object.fromEntries(['vitest', 'vite', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'].map(name =>
      [name, JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version]));
    assert.deepEqual(result.versions, { vitest: '4.1.11', vite: '7.3.5', '@earendil-works/pi-coding-agent': '1.2.0', '@earendil-works/pi-ai': '1.2.0' });
    assert.equal(collectedNames.length,24); assert.equal(collectedNames[16],targetName);
    assert.equal(tasks.length,8); assert.equal(tasks.reduce((n,t) => n+t.keys.length,0),168);
    result.stage = 'mechanical_copy'; verifyGenerated();
    result.source_sha256 = Object.fromEntries(['tests/kimi-context-ui.test.tsx',targetFile,peerFile,'tests/helpers/kimi-context-windows-trace.ts'].map(f => [f,digest(f)]));
    // Check every original assertion occurs unchanged in the generated peer body.
    const original = fs.readFileSync(path.join(root,'tests/kimi-context-ui.test.tsx'),'utf8');
    const peer = fs.readFileSync(path.join(root,peerFile),'utf8');
    for (const line of original.split('\n').filter(l => l.trim().startsWith('expect('))) assert.ok(peer.includes(line.trim()));
    result.mechanical_copy = { passed:true, all_peer_business_statements_from_original:true, full_prefix_count:16, target_original_index:16 };
    result.stage = 'sanitizers';
    const secret = 'DO_NOT_EXPORT_token_or_path';
    const valid = requiredEvents.map(event => JSON.stringify({ event })).join('\n');
    assert.equal(sanitizeTrace(valid).validation_error,null);
    const bad = [ ['null','invalid_trace_record'], ['[]','invalid_trace_record'], ['42','invalid_trace_record'], ['{"event":','invalid_trace_json'],
      [JSON.stringify({event:'test.begin',message:secret}),'unknown_trace_field'],[JSON.stringify({event:secret}),'unknown_trace_event'],
      [JSON.stringify({event:'test.begin',error_code:secret}),'unsafe_trace_string'],[JSON.stringify({event:'test.begin',sdk_errors:null}),'invalid_sdk_errors'],
      [JSON.stringify({event:'test.begin',sdk_errors:[null]}),'invalid_sdk_errors'],[JSON.stringify({event:'test.begin',sdk_errors:[{message:secret}]}),'unsafe_sdk_error_field'],
      [JSON.stringify({event:'test.begin',sdk_errors:[{error_code:secret}]}),'unsafe_trace_string'],
      ['{"event":"test.begin","__proto__":{"message":"'+secret+'"}}','unknown_trace_field'],['{"event":"test.begin","monotonic_ms":1e400}','unsafe_trace_type'] ];
    for (const [raw,error] of bad) {
      const safe = sanitizeTrace('{"event":"test.begin"}\n'+raw);
      assert.equal(safe.sanitation_error,error); assert.equal(safe.error_line,2); assert.equal(safe.events.length,1);
      assert.ok(!JSON.stringify(safe).includes(secret));
    }
    const task = tasks[0];
    const startup = summarizeReport({success:false,testResults:[{status:'failed',assertionResults:[],message:`TypeError [ERR_INVALID_ARG_VALUE]: filename must be a file URL ${secret}`}]},task);
    assert.equal(startup.selected_count,0); assert.equal(startup.validation_error,'selected_case_count_mismatch');
    assert.deepEqual(startup.suites[0].categories,['require_filename']); assert.ok(!JSON.stringify(startup).includes(secret));
    const test = {fullName:targetName,status:'failed',duration:1,failureMessages:[`expected spy toHaveBeenCalledTimes(1) ${secret}`]};
    const failed = summarizeReport({success:false,testResults:[{name:targetFile,status:'failed',message:secret,assertionResults:[test]}]},task);
    assert.equal(failed.selected_count,1); assert.equal(failed.validation_error,null); assert.equal(failed.selected[0].status,'failed');
    assert.deepEqual(failed.selected[0].categories,['refresh_assertion']); assert.ok(!JSON.stringify(failed).includes(secret));
    const missing = path.join(directory,'missing');
    assert.equal(safeReport(missing,task).selected_count,null); assert.equal(safeTrace(missing,missing+'.safe').state,'missing');
    assert.equal(safeTrace(directory,missing).state,'read_error'); assert.equal(safeLog(missing).state,'missing');
    const raw = path.join(directory,'malformed.jsonl'), safe = path.join(directory,'sanitized.jsonl');
    fs.writeFileSync(raw,valid+'\n'+JSON.stringify({event:'test.begin',message:secret}));
    assert.equal(safeTrace(raw,safe).state,'invalid'); assert.ok(!fs.readFileSync(safe,'utf8').includes(secret));
    assert.equal(safeTrace(raw,directory).write_error,true);
    assert.equal(completion(tasks.map(() => ({execution_complete:false,trace:{state:'missing'}}))).complete,false);
    result.sanitizers = {passed:true,malformed_cases:bad.length,startup_and_first_assertion_failure_preserved:true,safe_prefix_preserved:true,sentinel_absent:true};
    result.stage = 'trace_aggregation';
    const syntheticRaw=path.join(directory,'paired-raw'), syntheticSafe=path.join(directory,'paired-safe.jsonl');
    for(const role of ['target','peer']) {
      const metadata={worker_role:role,worker_id:role==='target'?1:2,pid:role==='target'?10:20,wall_ms:100,case_key:role==='target'?'T':'peer'};
      const events=requiredEvents.map(event=>({...metadata,event})).filter(e=>!['test.begin','fixture.remove.end'].includes(e.event));
      for(let i=0;i<(role==='target'?17:24);i++) events.push({...metadata,event:'test.begin',test_index:i}, {...metadata,event:'fixture.remove.end',test_index:i});
      events.push({...metadata,event:'worker.begin'},{...metadata,event:'worker.end'},{...metadata,event:'test.body.pass'},{...metadata,event:'beforeEach.done'});
      fs.writeFileSync(`${syntheticRaw}.${role}.jsonl`,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
    }
    const paired=combinedTrace(syntheticRaw,syntheticSafe,tasks[1]);
    assert.equal(paired.state,'ok');assert.deepEqual(paired.counts,{target:17,peer:24});assert.equal(paired.safe_event_count,paired.roles.target.safe_event_count+paired.roles.peer.safe_event_count);
    assert.equal(loadControl(syntheticSafe,tasks[1]).sufficient,false); // no 24 waiting intervals: never infer load from merely two files.
    fs.appendFileSync(`${syntheticRaw}.target.jsonl`,JSON.stringify({worker_role:'target',event:'waitFor.pass',elapsed_ms:1001})+'\n');
    assert.equal(combinedTrace(syntheticRaw,syntheticSafe,tasks[1]).late_pass_count,1);
    const sortedReport=summarizeReport({success:true,testResults:[{name:peerFile,status:'passed',assertionResults:collectedNames.map(fullName=>({fullName,status:'passed'}))},
      {name:targetFile,status:'passed',assertionResults:collectedNames.slice(0,17).map(fullName=>({fullName,status:'passed'}))}]},tasks[1]);
    assert.equal(sortedReport.validation_error,null);assert.equal(sortedReport.selected_count,41);
    result.trace_aggregation={passed:true,both_files_preserved:true,suite_order_independent:true,late_pass_rejected:true,uncovered_load_rejected:true};
    result.stage = 'deliberate_failure_probe';
    const probe = `tests/kimi-context-preflight-deliberate-${process.pid}.test.ts`;
    const probeReport = path.join(directory,'deliberate-failure.json');
    const probeStdout = fs.openSync(path.join(directory,'deliberate-failure.stdout'),'w');
    const probeStderr = fs.openSync(path.join(directory,'deliberate-failure.stderr'),'w');
    let probeChild;
    try {
      fs.writeFileSync(path.join(root,probe), `import {it} from 'vitest';\nimport {createRequire} from 'node:module';\nimport {URL as NodeURL} from 'node:url';\nit('deliberate first exception',()=>{createRequire(new NodeURL('http://localhost/DO_NOT_EXPORT_token_or_path'));});\n`);
      probeChild=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',probe,'--retry=0','--maxWorkers=2','--fileParallelism','--isolate','--reporter=json',`--outputFile=${probeReport}`],
        {cwd:root,env:childEnv(task,missing),shell:false,timeout:60000,stdio:['ignore',probeStdout,probeStderr]});
    } finally {fs.closeSync(probeStdout);fs.closeSync(probeStderr);fs.rmSync(path.join(root,probe),{force:true});}
    assert.equal(probeChild.status,1);
    const probeSummary=safeReport(probeReport,task);
    assert.equal(probeSummary.selected_count,1);assert.equal(probeSummary.selected[0].status,'failed');
    assert.ok(probeSummary.selected[0].categories.includes('require_filename'));
    assert.ok(probeSummary.selected[0].error_classes.includes('TypeError')); // Vitest JSON omits Node's separate code property.
    assert.ok(!JSON.stringify(probeSummary).includes(secret));
    result.deliberate_failure_probe={passed:true,exit_code:probeChild.status,summary:probeSummary,product_bodies_executed:0};
    result.stage = 'client_transform';
    const { createRequire } = await import('node:module');
    const { createVitest } = await import(pathToFileURL(path.join(root,'node_modules/vitest/dist/node.js')).href);
    const helper = path.join(root,'tests/helpers/kimi-context-windows-trace.ts'), source = fs.readFileSync(helper,'utf8');
    const ctx = await createVitest('test',{root,config:path.join(root,'vitest.config.js'),watch:false},
      {cacheDir:path.join(directory,'vite-cache'),server:{middlewareMode:true,hmr:false,watch:null},plugins:[{name:'diagnostic-negative-control',enforce:'pre',load(id) {
        if(id === helper+'?diagnostic-negative') return source.replace('new NodeURL(','new URL(');
      }}]});
    try {
      const transformed = {};
      for(const file of [helper,path.join(root,targetFile),path.join(root,peerFile)]) {
        const code = (await ctx.vite.environments.client.transformRequest(file)).code;
        transformed[path.relative(root,file)] = createHash('sha256').update(code).digest('hex');
      }
      const current = (await ctx.vite.environments.client.transformRequest(helper)).code;
      const prior = (await ctx.vite.environments.client.transformRequest(helper+'?diagnostic-negative')).code;
      const expression = code => code.match(/createRequire\((new (?:NodeURL|URL)\([^\n]+\))\)/)?.[1];
      const fixed = expression(current), old = expression(prior), moduleURL = /(?:import\.meta|__vite_ssr_import_meta__)\.url/;
      assert.ok(moduleURL.test(fixed)); assert.ok(!fixed.includes('self.location')); assert.ok(old.includes('self.location'));
      const fixedURL = Function('NodeURL','moduleURL',`return ${fixed.replace(moduleURL,'moduleURL')}`)(NodeURL,pathToFileURL(helper).href);
      const oldURL = Function('URL','self',`return ${old}`)(NodeURL,{location:'http://localhost:3000/'});
      assert.throws(() => createRequire(oldURL),{code:'ERR_INVALID_ARG_VALUE'});
      const anchor = path.join(root,'node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js');
      assert.equal(fixedURL.href,pathToFileURL(anchor).href);
      assert.equal(createRequire(fixedURL)('proper-lockfile'),createRequire(anchor)('proper-lockfile'));
      result.client_transform = {passed:true,transformed_sha256:transformed,negative_control:'ERR_INVALID_ARG_VALUE',same_lockfile_instance:true};
    } finally { await ctx.close(); }
    result.stage = 'collection'; result.collection = [];
    for(const task of [null,...tasks.slice(0,4)]) {
      const label = task?.cohort ?? 'original', output = path.join(directory,`list-${label}.json`);
      const stdout = fs.openSync(path.join(directory,`${label}.stdout`),'w'),stderr = fs.openSync(path.join(directory,`${label}.stderr`),'w');
      let child;
      try { child = spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','list',...(task ? [targetFile,...(task.load ? [peerFile] : [])] : ['tests/kimi-context-ui.test.tsx']),
        `--json=${output}`,'--retry=0','--maxWorkers=2','--fileParallelism','--isolate'],
        {cwd:root,env:childEnv(task ?? tasks[0],path.join(directory,`trace-${label}`)),shell:false,timeout:60000,stdio:['ignore',stdout,stderr]});
      } finally { fs.closeSync(stdout);fs.closeSync(stderr); }
      const entry = {cohort:label,exit_code:child.status,spawn_error:!!child.error};result.collection.push(entry);
      assert.equal(child.status,0);
      const listed = JSON.parse(fs.readFileSync(output,'utf8'));
      const group = file => listed.filter(test => fs.realpathSync(test.file) === fs.realpathSync(path.join(root,file))).map(test => test.name);
      if(!task) assert.deepEqual(group('tests/kimi-context-ui.test.tsx'),collectedNames);
      else {
        assert.deepEqual(group(targetFile),task.history ? collectedNames.slice(0,17) : [targetName]);
        assert.deepEqual(task.load ? group(peerFile) : [],task.load ? collectedNames : []);
        assert.equal(listed.length,task.keys.length);
      }
      entry.actual_count = listed.length;entry.names = listed.map(t => t.name);
      assert.ok(!fs.readdirSync(directory).some(f => f.startsWith(`trace-${label}`)));
      entry.hooks_installed=false;
    }
    result.stage='complete';result.outcome='passed';
  } catch(error) {
    fs.writeFileSync(path.join(directory,'preflight.error.private.txt'),String(error?.stack ?? 'unknown'));
    result.error=diagnosticErrors(error?.message);process.exitCode=1;
  }
  write();console.log(JSON.stringify(result,null,2));
}
const operation = process.argv[2] === '--generate' ? async () => { for (const [file,peer] of [[targetFile,false],[peerFile,true]]) fs.writeFileSync(path.join(root,file),generatedSource(peer)); } : process.argv[2] === '--preflight' ? preflight : main;
operation().catch(error => {
  const reasons = ['native_windows_required', 'pinned_node_required', 'diagnostic_ref_required', 'manual_event_required', 'checkout_sha_mismatch',
    'single_followup_commit_required', 'diagnostic_ancestry_mismatch', 'diff_scope_mismatch', 'dirty_checkout', 'protected_blob_changed',
    'runner_temp_required', 'unsupported_mode'];
  console.error(JSON.stringify({ outcome: 'controller_failed', reason: reasons.includes(error?.message) ? error.message : 'other',
    ...diagnosticErrors(error?.message) }));
  process.exitCode = 1;
});
