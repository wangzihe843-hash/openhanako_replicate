// Schema-only telemetry and a pure final-evidence validator. Never serialize error payloads.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TAG = 'network-diagnostic-v2';
const allowed = new Set([
  'supervisor:bootstrap', 'supervisor:seal', 'cli:spawn', 'cli:exit', 'cli:close', 'cli:error',
  'deadline', 'control:sent', 'control:error', 'control:received', 'cli:kill-request', 'cli:kill-result',
  'process:bootstrap', 'process:exit', 'process:uncaught-monitor', 'worker:seal',
  'fork:created', 'fork:spawn', 'fork:exit', 'fork:close', 'fork:error-monitor',
  'fork:started', 'fork:stopped', 'fork:kill-request', 'fork:kill-result', 'control:kill-error',
  'module:queued', 'module:collected', 'test-case:ready', 'test-case:result',
  'test-import:start', 'module-body:start', 'request-require:start', 'request-require:end',
  'module-registration:end', 'test-body:start', 'test-body:end', 'afterEach:start', 'afterEach:end',
  'reset:start', 'reset:returned', 'sockets-destroy:start', 'sockets-destroy:end',
  'servers-close:start', 'servers-close:end', 'ws-terminate:start', 'ws-terminate:returned',
]);
const numeric = ['childPid', 'code', 'case', 'forkId'];
const expectedCases = Object.freeze(["enforces Hono's body limit on unknown-length streaming uploads", "serves HTTP and upgrades WebSockets through the installed Hono adapter pair", "keeps Undici redirects, response streams and aborts functional", "uses the configured Undici CONNECT proxy without external DNS or requests", "preserves Telegram HTTP requests and bypasses the proxy after a loopback redirect", "updates real requests from the same Telegram options across direct and proxy changes"]);
const expectedLock = '67a67662f1164aaeb43e22bebee03580e8238ccf771a6adbb3bd007e2e35c2fb';
const rowKeys = new Set(['v','runId','event','pid','ppid','seq','at','writeFailures','transportFailures',...numeric,'signal','accepted','role','kind','result','origin','taskId']);
function validRow(r) {
  if (!r || typeof r !== 'object' || Object.keys(r).some(k => !rowKeys.has(k)) || r.v !== 2 || !/^[a-f0-9]{32}$/.test(r.runId || '') || !allowed.has(r.event)) return false;
  for (const k of ['pid','ppid','seq','at','writeFailures','transportFailures']) if (!Number.isSafeInteger(r[k]) || r[k] < 0) return false;
  for (const k of numeric) if (Object.hasOwn(r, k) && r[k] !== null && !Number.isSafeInteger(r[k])) return false;
  if (Object.hasOwn(r, 'signal') && r.signal !== null && (typeof r.signal !== 'string' || !/^SIG[A-Z0-9]{1,12}$/.test(r.signal))) return false;
  if (Object.hasOwn(r, 'accepted') && typeof r.accepted !== 'boolean') return false;
  for (const [k, values] of [['role',['cli','worker']],['kind',['vitest-fork','other']],['result',['passed','failed','skipped','pending']],['origin',['uncaughtException','unhandledRejection']]]) if (Object.hasOwn(r,k) && !values.includes(r[k])) return false;
  return !Object.hasOwn(r,'taskId') || (typeof r.taskId === 'string' && /^[a-f0-9]{64}$/.test(r.taskId));
}
function validEnvelope(e) { return !!e && typeof e === 'object' && Object.keys(e).length === 2 && typeof e.writeFailed === 'boolean' && validRow(e.row); }
let seq = 0, writeFailures = 0, transportFailures = 0;
const taskKey = id => crypto.createHash('sha256').update(String(id)).digest('hex');
function failureFlag() {
  try { fs.writeFileSync(path.join(process.env.NETWORK_DIAG_OUT, `observer-failure-${process.pid}.flag`), 'incomplete\n'); } catch {}
}
function captureTask(caseNumber, context, names) {
  // Only diagnostic metadata access is guarded; original test/cleanup exceptions are never caught.
  try {
    const task = context.task;
    if (typeof task.id !== 'string') throw new Error('Diagnostic task identity unavailable');
    return { case: caseNumber ?? names.indexOf(task.name) + 1, taskId: taskKey(task.id) };
  } catch {
    failureFlag();
    return { case: caseNumber ?? 0, taskId: taskKey('diagnostic-task-identity-unavailable') };
  }
}
function forward(envelope) {
  if (!validEnvelope(envelope)) { transportFailures++; failureFlag(); return; }
  if (!process.send || !process.connected) { transportFailures++; failureFlag(); return; }
  try {
    process.send({ tag: TAG, envelope }, error => { if (error) { transportFailures++; failureFlag(); } });
  } catch { transportFailures++; failureFlag(); }
}
function mark(event, detail = {}, noIPC = false) {
  if (!allowed.has(event)) throw new Error('Unknown diagnostic event');
  const row = { v: 2, runId: process.env.NETWORK_DIAG_RUN, event, pid: process.pid, ppid: process.ppid,
    seq: ++seq, at: Date.now(), writeFailures, transportFailures };
  for (const k of numeric) if (detail[k] === null || Number.isSafeInteger(detail[k])) row[k] = detail[k];
  if (detail.signal === null || (typeof detail.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(detail.signal))) row.signal = detail.signal;
  if (typeof detail.accepted === 'boolean') row.accepted = detail.accepted;
  if (['cli', 'worker'].includes(detail.role)) row.role = detail.role;
  if (['vitest-fork', 'other'].includes(detail.kind)) row.kind = detail.kind;
  if (['passed', 'failed', 'skipped', 'pending'].includes(detail.result)) row.result = detail.result;
  if (['uncaughtException', 'unhandledRejection'].includes(detail.origin)) row.origin = detail.origin;
  if (typeof detail.taskId === 'string' && /^[a-f0-9]{64}$/.test(detail.taskId)) row.taskId = detail.taskId;
  let writeFailed = false;
  try {
    fs.appendFileSync(path.join(process.env.NETWORK_DIAG_OUT, `events-${process.pid}.jsonl`), JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch {
    writeFailed = true; writeFailures++; failureFlag();
    try { process.stderr.write('[network-diagnostic] event write failed; evidence incomplete\n'); } catch {}
  }
  // Supervisor has no parent IPC. The CLI exit callback is synchronously sealed to disk only.
  if (!noIPC) forward({ row, writeFailed });
  return row;
}
function readEvidence(root) {
  const input = { files: [], ipc: [], ioIssues: [], flags: [], identity: null, session: null };
  const hashes = [];
  function read(name, limit = 2 * 1024 * 1024) {
    try {
      const bytes = fs.readFileSync(path.join(root, name));
      if (bytes.length > limit) throw new Error();
      hashes.push([name, crypto.createHash('sha256').update(bytes).digest('hex')]);
      return bytes.toString('utf8');
    } catch { input.ioIssues.push('required-file-unreadable'); return null; }
  }
  let names = [];
  try { names = fs.readdirSync(root).sort(); } catch { input.ioIssues.push('directory-unreadable'); }
  for (const name of ['identity.json', 'session.json', 'transport.json']) {
    const raw = read(name);
    try {
      const obj = JSON.parse(raw);
      if (name === 'identity.json') input.identity = obj;
      else if (name === 'session.json') input.session = obj;
      else input.ipc = obj;
    } catch { input.ioIssues.push('required-json-invalid'); }
  }
  for (const name of names) {
    const match = /^events-(\d+)\.jsonl$/.exec(name);
    if (match) {
      const raw = read(name);
      if (raw === null) continue;
      try {
        if (!raw.endsWith('\n')) throw new Error();
        const lines = raw.trimEnd().split('\n');
        if (lines.length > 4096) throw new Error();
        input.files.push({ pid: Number(match[1]), rows: lines.map(l => JSON.parse(l)) });
      } catch { input.ioIssues.push('event-jsonl-invalid'); }
    }
    if (/^observer-failure-\d+\.flag$/.test(name)) { input.flags.push(true); read(name, 1024); }
  }
  input.digest = crypto.createHash('sha256').update(JSON.stringify(hashes.sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
  return input;
}
function validateEvidence(input) {
  const issues = new Set(input.ioIssues || []);
  const fail = reason => issues.add(reason);
  const s = input.session || {}, identity = input.identity || {};
  if (identity.sourceCommit !== '4357162b20417dab20e65a27dda1002a96467d0a' || identity.sourceTree !== 'cefa2d2636954006272e1e0801db27fb35bcf996' || identity.sourceTestBlob !== '8e23b13e968f36eca053d2c896cac81d869d66ec' || identity.lockSha256 !== expectedLock || !/^[a-f0-9]{40}$/.test(identity.observedTestBlob || '') || !Array.isArray(identity.cases) || identity.cases.length !== 6 || identity.cases.some((x, i) => x.case !== i + 1 || x.name !== expectedCases[i]) || identity.diagnosticVersion !== 2) fail('identity-invalid');
  if (s.v !== 2 || !/^[a-f0-9]{32}$/.test(s.runId || '') || !Number.isSafeInteger(s.supervisorPid) || !Number.isSafeInteger(s.cliPid)) fail('session-invalid');
  if (input.flags?.length) fail('observer-io-or-ipc-failure');
  const rows = [], byPid = new Map();
  for (const f of input.files || []) {
    if (byPid.has(f.pid)) fail('duplicate-process-file');
    const valid = [];
    byPid.set(f.pid, valid);
    if (!Array.isArray(f.rows)) { fail('event-jsonl-invalid'); continue; }
    f.rows.forEach((r, i) => {
      if (!validRow(r) || r.runId !== s.runId || r.pid !== f.pid || r.seq !== i + 1) { fail('event-schema-or-sequence'); return; }
      if (r.writeFailures !== 0 || r.transportFailures !== 0) fail('observer-io-or-ipc-failure');
      rows.push(r); valid.push(r);
    });
  }
  const supervisor = byPid.get(s.supervisorPid) || [], cliRows = byPid.get(s.cliPid) || [];
  if (supervisor[0]?.event !== 'supervisor:bootstrap' || supervisor.at(-1)?.event !== 'supervisor:seal') fail('supervisor-seal-missing');
  if (cliRows[0]?.event !== 'process:bootstrap' || cliRows[0]?.role !== 'cli' || cliRows[0]?.ppid !== s.supervisorPid || cliRows.at(-1)?.event !== 'process:exit') fail('cli-seal-missing');
  const count = (rs, event) => rs.filter(r => r.event === event);
  function once(rs, event) { const a = count(rs, event); if (a.length !== 1) fail('missing-or-duplicate-lifecycle'); return a[0]; }
  const cliSpawn = once(supervisor, 'cli:spawn'), cliExit = once(supervisor, 'cli:exit'), cliClose = once(supervisor, 'cli:close');
  const raw = r => r && Object.hasOwn(r, 'code') && Object.hasOwn(r, 'signal') && (r.code === null || Number.isSafeInteger(r.code)) && (r.signal === null || /^SIG[A-Z0-9]{1,12}$/.test(r.signal));
  if (!raw(cliExit) || !raw(cliClose) || !(cliSpawn?.seq < cliExit?.seq && cliExit?.seq < cliClose?.seq) || cliSpawn?.childPid !== s.cliPid || cliExit?.childPid !== s.cliPid || cliClose?.childPid !== s.cliPid || cliExit?.code !== cliClose?.code || cliExit?.signal !== cliClose?.signal) fail('cli-exit-close-incomplete');
  const forks = [];
  for (const created of rows.filter(r => r.event === 'fork:created')) {
    const rs = rows.filter(r => r.pid === created.pid && r.forkId === created.forkId && r.event.startsWith('fork:'));
    const spawned = once(rs, 'fork:spawn'), exit = once(rs, 'fork:exit'), close = once(rs, 'fork:close');
    if (!Number.isSafeInteger(created.forkId) || !Number.isSafeInteger(created.childPid) || count(rs, 'fork:created').length !== 1 || rs.some(r => r.childPid !== created.childPid)) fail('fork-identity-inconsistent');
    const closed = !!(spawned && raw(exit) && raw(close) && created.seq < spawned.seq && spawned.seq < exit.seq && exit.seq < close.seq && exit.code === close.code && exit.signal === close.signal);
    if (!closed) fail('fork-exit-close-unconfirmed');
    const workerRows = byPid.get(created.childPid) || [];
    if (workerRows[0]?.event !== 'process:bootstrap' || workerRows[0]?.role !== 'worker' || workerRows[0]?.ppid !== created.pid || count(workerRows, 'worker:seal').length !== 1 || workerRows.at(-1)?.event !== 'worker:seal' || count(rs, 'fork:stopped').length !== 1) fail('worker-seal-missing-or-late-event');
    // closed is evidence of exit/close, not evidence of an acceptable worker result.
    const requests = count(rs, 'fork:kill-request'), results = count(rs, 'fork:kill-result');
    const started = count(rs, 'fork:started'), stopped = count(rs, 'fork:stopped');
    const sameChild = Number.isSafeInteger(created.childPid) && Number.isSafeInteger(created.forkId)
      && rs.every(r => r.childPid === created.childPid && r.kind === created.kind);
    // Accept SIGTERM only with one unambiguous, accepted request on this exact run/owner/forkId/child.
    // A different signal, failed/extra request, or incomplete lifecycle remains non-success.
    const explainedSIGTERM = closed && sameChild && created.kind === 'vitest-fork'
      && exit.code === null && exit.signal === 'SIGTERM'
      && workerRows[0]?.role === 'worker' && workerRows[0]?.ppid === created.pid
      && count(workerRows, 'worker:seal').length === 1 && workerRows.at(-1)?.event === 'worker:seal'
      && started.length === 1 && stopped.length === 1 && requests.length === 1 && results.length === 1
      && requests[0].signal === 'SIGTERM' && results[0].accepted === true
      && spawned.seq < started[0].seq && started[0].seq < stopped[0].seq
      && stopped[0].seq < requests[0].seq && requests[0].seq < results[0].seq && results[0].seq < exit.seq;
    const normalZeroExit = closed && exit.code === 0 && exit.signal === null;
    const expectedTermination = normalZeroExit || explainedSIGTERM;
    const termination = !closed ? 'unconfirmed' : normalZeroExit ? 'code-zero'
      : explainedSIGTERM ? 'requested-sigterm' : 'unexpected';
    if (!expectedTermination) fail('fork-unexpected-or-unconfirmed-termination');
    forks.push({ ownerPid: created.pid, forkId: created.forkId, childPid: created.childPid, exitObserved: !!exit, closeObserved: !!close, code: exit?.code ?? null, signal: exit?.signal ?? null, closeCode: close?.code ?? null, closeSignal: close?.signal ?? null, closed, expectedTermination, termination });
  }
  if (forks.length === 0) fail('no-fork-observed');
  const known = new Set([s.supervisorPid, s.cliPid, ...forks.map(f => f.childPid)]);
  if ([...byPid.keys()].some(pid => !known.has(pid))) fail('unregistered-process-log');
  for (const r of rows.filter(r => r.event.startsWith('fork:'))) if (!forks.some(f => f.ownerPid === r.pid && f.forkId === r.forkId)) fail('fork-event-without-creation');
  // Compare the independently received IPC copy against every non-supervisor disk event.
  // CLI process:exit is a synchronous disk-only seal (sending IPC from exit is unreliable).
  const expected = rows.filter(r => r.pid !== s.supervisorPid && r.event !== 'process:exit').map(r => JSON.stringify(r)).sort();
  const actual = [];
  if (!Array.isArray(input.ipc)) fail('ipc-transcript-invalid');
  else for (const e of input.ipc) { if (!validEnvelope(e)) { fail('ipc-transcript-invalid'); continue; } if (e.writeFailed) fail('observer-io-or-ipc-failure'); if (!e.row) fail('ipc-transcript-invalid'); else actual.push(JSON.stringify(e.row)); }
  if (JSON.stringify(expected) !== JSON.stringify(actual.sort())) fail('disk-ipc-transcript-mismatch');
  const globalEvents = ['module:queued','module:collected','test-import:start','module-body:start','request-require:start','request-require:end','module-registration:end'];
  for (const event of globalEvents) once(rows, event);
  let testsPassed = true;
  const taskIds = [];
  const phases = ['test-body:start','test-body:end','afterEach:start','reset:start','reset:returned','sockets-destroy:start','sockets-destroy:end','servers-close:start','servers-close:end','afterEach:end'];
  for (let n = 1; n <= 6; n++) {
    const rs = rows.filter(r => r.case === n);
    const ready = once(rs, 'test-case:ready'), result = once(rs, 'test-case:result');
    if (!ready || !/^[a-f0-9]{64}$/.test(ready.taskId || '')) fail('case-task-identity-invalid');
    if (ready?.pid !== s.cliPid || result?.pid !== s.cliPid) fail('case-reporter-process-mismatch');
    const id = ready?.taskId;
    if (id) taskIds.push(id);
    if (rs.some(r => r.taskId !== id)) fail('case-task-identity-mismatch');
    if (result?.result !== 'passed') testsPassed = false;
    const ordered = phases.map(event => once(rs, event));
    if (ordered.every(Boolean) && (!forks.some(f => f.childPid === ordered[0].pid) || ordered.some((r, i) => r.pid !== ordered[0].pid || (i > 0 && r.seq <= ordered[i - 1].seq)))) fail('phase-boundary-order');
    const body = rs.find(r => r.event === 'test-body:start'), end = rs.find(r => r.event === 'test-body:end');
    const cleanup = rs.find(r => r.event === 'afterEach:start'), cleanupEnd = rs.find(r => r.event === 'afterEach:end');
    if (body && end && (body.pid !== end.pid || body.seq >= end.seq)) fail('body-boundary-order');
    if (cleanup && cleanupEnd && (cleanup.pid !== cleanupEnd.pid || cleanup.seq >= cleanupEnd.seq)) fail('cleanup-boundary-order');
    if (body && cleanup && body.pid === cleanup.pid && end && end.seq >= cleanup.seq) fail('late-body-finally-overlap');
  }
  if (taskIds.length !== 6 || new Set(taskIds).size !== 6 || rows.some(r => (r.event.startsWith('test-body:') || r.event.startsWith('afterEach:')) && !(r.case >= 1 && r.case <= 6))) fail('case-task-map-invalid');
  once(rows.filter(r => r.case === 2), 'ws-terminate:start'); once(rows.filter(r => r.case === 2), 'ws-terminate:returned');
  if (rows.some(r => ['cli:error','control:error','control:kill-error','process:uncaught-monitor','fork:error-monitor','deadline'].includes(r.event) || r.accepted === false)) fail('runtime-or-observer-error-recorded');
  const cliSuccess = cliExit?.code === 0 && cliExit?.signal === null && cliClose?.code === 0 && cliClose?.signal === null;
  return { complete: issues.size === 0, testsPassed, cliSuccess, issues: [...issues].sort(),
    cli: { pid: Number.isSafeInteger(s.cliPid) ? s.cliPid : null, code: cliExit?.code ?? null, signal: cliExit?.signal ?? null, closeCode: cliClose?.code ?? null, closeSignal: cliClose?.signal ?? null, exitObserved: !!cliExit, closeObserved: !!cliClose },
    forks, unconfirmedForks: forks.filter(f => !f.closed), unconfirmedCLI: !(cliExit && cliClose && raw(cliExit) && raw(cliClose)), allForksClosed: forks.length > 0 && forks.every(f => f.closed), allForksExpectedTermination: forks.length > 0 && forks.every(f => f.expectedTermination) };
}
function wrapperCode(report, timedOut) {
  // Preserve ordinary test exit failures. Raw platform codes/signals remain verbatim in final.json.
  if (Number.isInteger(report.cli.code) && report.cli.code > 0 && report.cli.code <= 255) return report.cli.code;
  if (timedOut) return 124;
  if (!report.cliSuccess) return 1;
  return report.complete && report.testsPassed && report.allForksClosed && report.allForksExpectedTermination ? 0 : 86;
}
module.exports = { TAG, validEnvelope, captureTask, mark, forward, taskKey, readEvidence, validateEvidence, wrapperCode };
