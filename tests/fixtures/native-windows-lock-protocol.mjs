// Transport/observation helpers only. Portable tests do not emulate Win32.
import assert from 'node:assert/strict';
import { clearTimeout, setTimeout } from 'node:timers';

export function createRequestChannel(stream, { timeoutMs = 10000, onMessage = () => {} } = {}) {
  let sequence = 0;
  let buffer = '';
  let pending;
  let failure;
  function fail(error) {
    failure ??= error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
  }
  stream.setEncoding('utf8');
  stream.on('error', fail);
  stream.on('close', () => fail(new Error('Holder channel closed')));
  stream.on('end', () => fail(new Error('Holder channel ended')));
  stream.on('data', data => {
    buffer += data;
    if (buffer.length > 65536) return fail(new Error('Oversized holder response'));
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line);
        onMessage(response);
        assert.ok(pending, 'Unsolicited holder response');
        assert.equal(response.id, pending.id, 'Stale holder response');
        assert.equal(response.command, pending.command, 'Wrong holder command');
        clearTimeout(pending.timer);
        pending.resolve(response);
        pending = undefined;
      } catch (error) { fail(error); }
    }
  });
  return {
    request(command) {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new Error('Concurrent holder request'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => fail(new Error(`Holder ${command} timed out`)), timeoutMs);
        pending = { id, command, resolve, reject, timer };
        stream.write(JSON.stringify({ id, command }) + '\n', error => { if (error) fail(error); });
      });
    },
    close() {
      fail(new Error('Holder channel disposed'));
      stream.destroy();
    },
  };
}

export function assertHeldState(state) {
  assert.equal(state.closed, false);
  assert.equal(state.info.directory, true);
  assert.equal(state.info.deletePending, true, 'Native handle must report DeletePending');
  assert.equal(state.mkdirError, 5, 'CreateDirectoryW must report ERROR_ACCESS_DENIED');
}

// The real graceful-fs mkdir is called once with the original receiver/options.
// Only its first failing callback can be delayed for the release handshake.
// No result/error is manufactured, replaced, suppressed, or retried here.
export function observeMkdir(lockFs, lockPath, onFirstError) {
  const original = lockFs.mkdir;
  const attempts = [];
  let gateError;
  function observed(...args) {
    if (args[0] !== lockPath) return Reflect.apply(original, this, args);
    const callback = args.at(-1);
    return Reflect.apply(original, this, [...args.slice(0, -1), function (...result) {
      const error = result[0];
      attempts.push({ code: error?.code ?? null, syscall: error?.syscall ?? null, path: error?.path ?? null });
      if (attempts.length === 1 && error && onFirstError) {
        // Always forward the original callback arguments, even if the handshake
        // failed. The caller separately fails the experiment on gateError.
        Promise.resolve().then(() => onFirstError(error)).catch(error => { gateError = error; })
          .then(() => Reflect.apply(callback, this, result));
      } else Reflect.apply(callback, this, result);
    }]);
  }
  lockFs.mkdir = observed;
  return {
    attempts,
    check() { if (gateError) throw gateError; },
    restore() {
      assert.equal(lockFs.mkdir, observed, 'The native mkdir observer was replaced');
      lockFs.mkdir = original;
    },
  };
}
