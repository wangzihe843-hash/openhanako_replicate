import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequestChannel, observeMkdir } from './fixtures/native-windows-lock-protocol.mjs';

// Portable transport/pass-through contracts; these are NOT native Windows passes.
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function transport(timeoutMs = 1000) {
  const responses = new PassThrough();
  const requests = new PassThrough();
  const stream = Duplex.from({ readable: responses, writable: requests });
  const sent: Array<{ id: number; command: string }> = [];
  requests.on('data', data => sent.push(JSON.parse(data.toString())));
  const channel = createRequestChannel(stream, { timeoutMs });
  cleanup.push(() => channel.close());
  return { responses, sent, channel };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('holder request/acknowledgement protocol', () => {
  it('requires correlated complete lines for OPEN, ARM, CHECK and RELEASE', async () => {
    const { responses, sent, channel } = transport();
    for (const command of ['open', 'arm', 'check', 'release']) {
      const pending = channel.request(command);
      const response = { ...sent.at(-1), closed: command === 'release' };
      const encoded = JSON.stringify(response);
      responses.write(encoded.slice(0, 8));
      responses.write(encoded.slice(8) + '\r\n');
      expect(await pending).toEqual(response);
    }
    expect(sent.map(request => request.id)).toEqual([1, 2, 3, 4]);
  });

  it.each([
    ['stale id', '{"id":0,"command":"open"}\n'],
    ['wrong command', '{"id":1,"command":"release"}\n'],
    ['unstructured READY', 'READY\n'],
    ['oversized input', 'x'.repeat(65537)],
  ])('fails closed on %s instead of accepting readiness', async (_name, input) => {
    const { responses, channel } = transport();
    const pending = channel.request('open');
    responses.write(input);
    await expect(pending).rejects.toThrow();
    await expect(channel.request('arm')).rejects.toThrow();
  });

  it('rejects a buffered unsolicited READY before a request', async () => {
    const { responses, channel } = transport();
    responses.write('{"id":1,"command":"open"}\n');
    // Flush the stream event, without a sleep used as a readiness assumption.
    await new Promise<void>(resolve => responses.write('', () => resolve()));
    await expect(channel.request('open')).rejects.toThrow('Unsolicited');
  });

  it('fails on EOF while awaiting a release acknowledgement', async () => {
    const { responses, channel } = transport();
    const pending = channel.request('release');
    responses.end();
    await expect(pending).rejects.toThrow('ended');
  });

  it('rejects overlapping requests without losing the original one', async () => {
    const { responses, channel } = transport();
    const pending = channel.request('open');
    await expect(channel.request('arm')).rejects.toThrow('Concurrent');
    responses.write('{"id":1,"command":"open"}\n');
    await expect(pending).resolves.toEqual({ id: 1, command: 'open' });
  });

  it('uses its deadline only to fail, and never manufactures a release', async () => {
    const { sent, channel } = transport(10);
    await expect(channel.request('check')).rejects.toThrow('timed out');
    expect(sent).toEqual([{ id: 1, command: 'check' }]);
    await expect(channel.request('release')).rejects.toThrow('timed out');
  });
});

describe('real mkdir callback observation', () => {
  function directories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-mkdir-observer-'));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    return { root, target, lockFs: { mkdir: fs.mkdir } };
  }

  it('forwards the same real error once, after the explicit gate, then allows a real retry', async () => {
    const { target, lockFs } = directories();
    const entered = deferred();
    const release = deferred();
    let observedError: unknown;
    let callbacks = 0;
    const observer = observeMkdir(lockFs, target, async (error: unknown) => {
      observedError = error;
      entered.resolve();
      await release.promise;
      fs.rmdirSync(target);
    });
    cleanup.push(() => observer.restore());
    const first = new Promise(resolve => lockFs.mkdir(target, error => { callbacks++; resolve(error); }));
    await entered.promise;
    expect(callbacks).toBe(0);
    expect(observedError).toMatchObject({ code: 'EEXIST', syscall: 'mkdir', path: target });
    release.resolve();
    expect(await first).toBe(observedError);
    expect(callbacks).toBe(1);
    await new Promise<void>((resolve, reject) => lockFs.mkdir(target, error => error ? reject(error) : resolve()));
    observer.check();
    expect(observer.attempts.map((attempt: { code: string | null }) => attempt.code)).toEqual(['EEXIST', null]);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it('retains the native error when the gate fails and exposes the gate failure separately', async () => {
    const { target, lockFs } = directories();
    const gateFailure = new Error('No native RELEASE acknowledgement');
    let observedError: unknown;
    const observer = observeMkdir(lockFs, target, (error: unknown) => { observedError = error; throw gateFailure; });
    const result = await new Promise(resolve => lockFs.mkdir(target, resolve));
    expect(result).toBe(observedError);
    expect(result).toMatchObject({ code: 'EEXIST' });
    expect(() => observer.check()).toThrow(gateFailure);
    observer.restore();
    expect(lockFs.mkdir).toBe(fs.mkdir);
  });

  it('passes other paths and recursive options through without invoking the gate', async () => {
    const { root, target, lockFs } = directories();
    let gates = 0;
    const observer = observeMkdir(lockFs, target, () => { gates++; });
    cleanup.push(() => observer.restore());
    const other = path.join(root, 'other', 'nested');
    const created = await new Promise<string | undefined>((resolve, reject) =>
      lockFs.mkdir(other, { recursive: true }, (error, result) => error ? reject(error) : resolve(result)));
    expect(created).toBe(path.join(root, 'other'));
    expect(fs.statSync(other).isDirectory()).toBe(true);
    expect(observer.attempts).toEqual([]);
    expect(gates).toBe(0);
  });
});
