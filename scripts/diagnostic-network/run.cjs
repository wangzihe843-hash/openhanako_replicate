// One Windows invocation; real ChildProcess handles only; missing evidence never becomes green.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { TAG, validEnvelope, mark, readEvidence, validateEvidence, wrapperCode } = require('./events.cjs');
function verifyFinal(root) {
  try {
    const final = JSON.parse(fs.readFileSync(path.join(root, 'final.json'), 'utf8'));
    const evidence = readEvidence(root), report = validateEvidence(evidence);
    if (final.v !== 2 || final.evidenceDigest !== evidence.digest || JSON.stringify(final.report) !== JSON.stringify(report) || final.wrapperExit !== wrapperCode(report, final.timedOut) || final.wrapperExit !== 0) return 86;
    return 0;
  } catch { return 86; }
}
function main() {
  const root = process.env.NETWORK_DIAG_OUT;
  if (process.argv.includes('--verify-final')) {
    const code = verifyFinal(root);
    console.log(code === 0 ? 'Diagnostic evidence complete; six cases passed; all observed forks exited and closed.' : 'Diagnostic evidence missing, incomplete, changed, or non-success. Preserve original Run step outcome.');
    process.exitCode = code; return;
  }
  if (process.platform !== 'win32' || process.version !== 'v24.15.0' || process.env.CI !== 'true') throw new Error('Requires GitHub Windows / Node 24.15.0');
  if (!root || !path.isAbsolute(root) || fs.readdirSync(root).some(n => /^(events-|session\.json|transport\.json|final\.json|observer-failure-)/.test(n))) throw new Error('Requires fresh prepared diagnostic directory');
  process.env.NETWORK_DIAG_RUN = crypto.randomBytes(16).toString('hex');
  const session = { v: 2, runId: process.env.NETWORK_DIAG_RUN, supervisorPid: process.pid, cliPid: null };
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (['systemroot','windir','comspec','pathext','path','temp','tmp','userprofile','appdata','localappdata'].includes(key.toLowerCase())) env[key] = value;
  Object.assign(env, { CI: 'true', NODE_ENV: 'test', NETWORK_DIAG_OUT: root, NETWORK_DIAG_RUN: session.runId,
    HANA_HOME: path.join(root, '..', 'synthetic-home') });
  fs.mkdirSync(env.HANA_HOME, { recursive: true });
  mark('supervisor:bootstrap', {}, true);
  const transport = [];
  let timedOut = false, finalized = false, cliExited = false, observedCliExit = null;
  const child = cp.fork(path.resolve('node_modules/vitest/vitest.mjs'), [
    'run', 'tests/dependency-network-security.test.ts', '--config', '.network-diagnostic.config.mjs', '--pool=forks', '--maxWorkers=1',
  ], { cwd: process.cwd(), env, execArgv: ['--require', path.join(__dirname, 'parent.cjs')], stdio: ['inherit','inherit','inherit','ipc'], windowsHide: true });
  session.cliPid = child.pid ?? null;
  fs.writeFileSync(path.join(root, 'session.json'), JSON.stringify(session, null, 2) + '\n');
  mark('cli:spawn', { childPid: session.cliPid }, true);
  const timers = [];
  const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  function finish() {
    if (finalized) return;
    finalized = true;
    for (const t of timers) clearTimeout(t);
    mark('supervisor:seal', {}, true);
    let code = 86;
    try {
      fs.writeFileSync(path.join(root, 'transport.json'), JSON.stringify(transport) + '\n');
      const evidence = readEvidence(root), report = validateEvidence(evidence);
      code = wrapperCode(report, timedOut);
      fs.writeFileSync(path.join(root, 'final.json'), JSON.stringify({ v: 2, timedOut, wrapperExit: code,
        evidenceDigest: evidence.digest, report, recovery: report.allForksClosed && !report.unconfirmedCLI ? 'CLI-and-all-observed-forks-have-exit-and-close' : 'unconfirmed; no PID-only cleanup attempted' }, null, 2) + '\n');
      console.log(`Diagnostic wrapper exit=${code}; evidenceComplete=${report.complete}; unconfirmedForks=${report.unconfirmedForks.length}; unconfirmedCLI=${report.unconfirmedCLI}`);
    } catch {
      // A failed final write cannot leave a successful wrapper result.
      code = Number.isInteger(observedCliExit?.code) && observedCliExit.code > 0 && observedCliExit.code <= 255 ? observedCliExit.code : 86;
      try { console.error('Diagnostic final evidence could not be written; non-success.'); } catch {}
    }
    // Finite supervisor lifetime is not a claim that unknown/orphaned descendants were reaped.
    child.unref(); child.channel?.unref();
    process.exit(code);
  }
  child.on('message', message => {
    if (!finalized && message?.tag === TAG && message.envelope) transport.push(validEnvelope(message.envelope) ? message.envelope : { invalid: true });
  });
  child.once('error', () => { if (!finalized) mark('cli:error', { childPid: session.cliPid }, true); });
  child.once('exit', (code, signal) => { cliExited = true; observedCliExit = { code, signal }; if (!finalized) mark('cli:exit', { childPid: session.cliPid, code, signal }, true); });
  child.once('close', (code, signal) => {
    if (!finalized) { mark('cli:close', { childPid: session.cliPid, code, signal }, true); later(finish, 250); }
    // Do not clear the deadline here. finish independently checks all created forks' exit/close evidence.
  });
  later(() => {
    timedOut = true; mark('deadline', { childPid: session.cliPid }, true);
    if (!cliExited && child.connected) {
      mark('control:sent', { childPid: session.cliPid }, true);
      try { child.send({ tag: TAG, runId: session.runId, command: 'stop-owned-handles' }, error => { if (error && !finalized) mark('control:error', { childPid: session.cliPid }, true); }); }
      catch { mark('control:error', { childPid: session.cliPid }, true); }
    }
    later(() => {
      if (!cliExited && !finalized) {
        mark('cli:kill-request', { childPid: session.cliPid, signal: 'SIGKILL' }, true);
        try { mark('cli:kill-result', { childPid: session.cliPid, accepted: child.kill('SIGKILL') }, true); }
        catch { mark('cli:kill-result', { childPid: session.cliPid, accepted: false }, true); }
      }
    }, 3000);
    // Even failed kill/control/close has a finite, explicitly non-success final outcome.
    later(finish, 10000);
  }, 150000);
}
module.exports = { verifyFinal };
if (require.main === module) main();
