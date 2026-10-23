// Parent/worker preload. Only diagnostic IPC frames are intercepted; Vitest messages pass unchanged.
const cp = require('node:child_process');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { errorMonitor } = require('node:events');
const { TAG, mark, forward } = require('./events.cjs');
const isCLI = path.resolve(process.argv[1] || '') === path.resolve('node_modules/vitest/vitest.mjs');
mark('process:bootstrap', { role: isCLI ? 'cli' : 'worker' });
if (isCLI) process.on('exit', code => mark('process:exit', { code }, true));
process.on('uncaughtExceptionMonitor', (_error, origin) => mark('process:uncaught-monitor', { origin }));
// A worker seal precedes Vitest's real stopped message; it does not wait or change that message.
if (!isCLI && process.send) {
  const originalSend = process.send;
  process.send = function (message) {
    if (message?.__vitest_worker_response__ && message.type === 'stopped') mark('worker:seal');
    return Reflect.apply(originalSend, this, arguments);
  };
}
let forkId = 0;
const owned = new Map();
const originalFork = cp.fork;
cp.fork = function (...args) {
  const child = Reflect.apply(originalFork, this, args);
  const id = ++forkId;
  const kind = String(args[0]).replaceAll('\\', '/').endsWith('/vitest/dist/workers/forks.js') ? 'vitest-fork' : 'other';
  const identity = () => ({ childPid: child.pid ?? null, forkId: id, kind });
  owned.set(id, child);
  // Forward telemetry via the existing IPC channel without exposing diagnostic frames to Vitest's RPC.
  const originalEmit = child.emit;
  child.emit = function (event, message) {
    if (event === 'message' && message?.tag === TAG && message.envelope) { forward(message.envelope); return true; }
    return Reflect.apply(originalEmit, this, arguments);
  };
  mark('fork:created', identity());
  child.once('spawn', () => mark('fork:spawn', identity()));
  child.once('exit', (code, signal) => mark('fork:exit', { ...identity(), code, signal }));
  child.once('close', (code, signal) => { mark('fork:close', { ...identity(), code, signal }); owned.delete(id); });
  child.on(errorMonitor, () => mark('fork:error-monitor', identity()));
  child.on('message', message => {
    if (message?.__vitest_worker_response__ && ['started', 'stopped'].includes(message.type)) mark(`fork:${message.type}`, identity());
  });
  const originalKill = child.kill;
  child.kill = function (signal) {
    mark('fork:kill-request', { ...identity(), signal: signal ?? 'SIGTERM' });
    const accepted = Reflect.apply(originalKill, this, arguments);
    mark('fork:kill-result', { ...identity(), accepted });
    return accepted;
  };
  return child;
};
syncBuiltinESMExports();
if (isCLI) {
  process.on('message', message => {
    if (message?.tag !== TAG || message.runId !== process.env.NETWORK_DIAG_RUN || message.command !== 'stop-owned-handles') return;
    mark('control:received');
    // No taskkill or process.kill(pid): use only live ChildProcess objects created by this preload.
    for (const [id, child] of owned) {
      const stop = signal => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { child.kill(signal); } catch { mark('control:kill-error', { forkId: id, childPid: child.pid ?? null }); }
      };
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), 1000).unref();
    }
  });
  // The diagnostic control listener must not keep an otherwise finished CLI alive.
  process.channel?.unref();
}
