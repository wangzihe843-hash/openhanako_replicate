import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpLegacySseClient } from "../core/mcp/clients/http-client.ts";

function gate<T>() {
  let resolve: (value: T) => void;
  let reject: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const encoder = new TextEncoder();
const complete = { content: [{ type: "text", text: "ok" }] };
const quiet = { ...console, debug() {}, warn() {} };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const outcome = (promise) => promise.then(value => ({ value, error: null }), error => ({ value: null, error }));
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture({ endpoint = true, initialize = true, getAuthToken = null, onClose = null } = {}) {
  const streams = [];
  const posts = [];
  const closes = vi.fn(info => onClose?.(info));
  let getGate = null;
  let noBody = false;
  const emit = (stream, wire) => stream.controller.enqueue(encoder.encode(wire));
  const reply = (stream, id, result: unknown = complete) => emit(stream, `data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
  const fetchImpl = vi.fn(async (url, init) => {
    if (init.method === "GET") {
      const stream = { index: streams.length + 1, signal: init.signal, controller: null, body: null,
        late: null, nativeReader: null, release: vi.fn(), cancel: vi.fn(), sourceCancel: vi.fn() };
      stream.body = new ReadableStream({ start(controller) { stream.controller = controller; }, cancel: stream.sourceCancel });
      const getReader = stream.body.getReader.bind(stream.body);
      // Delay the delivery of an already-started read even after cancel. This
      // models a queued continuation, not a claim about native TCP frequency.
      stream.body.getReader = () => {
        const reader = getReader();
        stream.nativeReader = reader;
        return {
          read: async () => {
            const value = await reader.read();
            return stream.late ? stream.late.promise : value;
          },
          cancel: (reason) => { stream.cancel(reason); return reader.cancel(reason); },
          releaseLock: () => { stream.release(); reader.releaseLock(); },
        };
      };
      streams.push(stream);
      if (endpoint) emit(stream, `event: endpoint\ndata: /messages?g=${stream.index}\n\n`);
      const response = new Response(noBody ? null : stream.body, { headers: { "Content-Type": "text/event-stream" } });
      if (getGate) { const pending = getGate; getGate = null; await pending.promise; }
      return response;
    }
    const body = JSON.parse(init.body);
    posts.push({ url: String(url), body, signal: init.signal });
    const stream = streams.find(s => String(url).endsWith(`/messages?g=${s.index}`));
    expect(stream).toBeDefined();
    if (body.method === "initialize" && initialize) reply(stream, body.id, { protocolVersion: "2024-11-05", capabilities: {} });
    return new Response(null, { status: 202 });
  });
  const client = new McpLegacySseClient({ id: "local", url: "http://127.0.0.1:1/sse", timeout: 2 },
    { fetchImpl, log: quiet, onClose: closes, getAuthToken });
  const reads = vi.spyOn(client, "_readSse");
  cleanups.push(async () => {
    await client.stop();
    for (const stream of streams) {
      stream.late?.resolve({ done: true, value: undefined });
      try { stream.controller.close(); } catch { /* Already closed or cancelled by the test. */ }
    }
    await Promise.allSettled(reads.mock.results.map(result => result.value));
  });
  return { client, streams, posts, closes, fetchImpl, reads, emit, reply,
    holdGet: (value) => { getGate = value; }, noBody: () => { noBody = true; } };
}

describe("legacy SSE current reader termination", () => {
  for (const kind of ["error", "source-abort", "eof"])
    for (const count of [0, 2])
      it(`${kind} settles ${count} requests before one close and releases the reader`, async () => {
        const f = fixture({ onClose: () => { void f.client.stop(); } });
        await f.client.start();
        const callers = Array.from({ length: count }, () => new AbortController());
        const pending = callers.map(c => outcome(f.client.callTool("write", {}, { signal: c.signal })));
        await vi.waitFor(() => expect(f.posts.filter(p => p.body.method === "tools/call")).toHaveLength(count));
        const stream = f.streams[0];
        const error = kind === "source-abort" ? new DOMException("source aborted", "AbortError") : new TypeError("reader failed");
        if (kind === "eof") stream.controller.close(); else stream.controller.error(error);
        const results = await Promise.all(pending);
        await turn();
        for (const result of results) {
          if (kind === "eof") expect(result.error?.message).toMatch(/stream closed/);
          else expect(result.error).toBe(error);
        }
        expect(f.client.running).toBe(false);
        expect(f.client.messageEndpoint).toBe("");
        expect(f.client._pending.size).toBe(0);
        expect(f.closes).toHaveBeenCalledTimes(1);
        expect(f.closes.mock.calls[0][0]).toMatchObject({ expected: false, needsAuth: false });
        expect(stream.signal.aborted).toBe(true);
        expect(stream.body.locked).toBe(false);
        expect(stream.release).toHaveBeenCalledTimes(1);
        for (const caller of callers) expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
        await f.client.stop();
        await f.client.stop();
        expect(f.closes).toHaveBeenCalledTimes(1);
      });

  for (const phase of ["before-endpoint", "during-initialize"])
    for (const kind of ["error", "source-abort", "eof"])
      it(`${kind} ${phase} fails startup promptly without initialized or a duplicate close`, async () => {
        const f = fixture({ endpoint: phase !== "before-endpoint", initialize: false });
        let settled = false;
        const starting = outcome(f.client.start()).then(result => { settled = true; return result; });
        await vi.waitFor(() => expect(f.streams).toHaveLength(1));
        if (phase === "during-initialize") await vi.waitFor(() => expect(f.client._pending.size).toBe(1));
        const error = kind === "source-abort" ? new DOMException("startup source abort", "AbortError") : new TypeError("startup read failed");
        if (kind === "eof") f.streams[0].controller.close(); else f.streams[0].controller.error(error);
        await turn();
        expect(settled).toBe(true); // A read completion must not wait for the endpoint/request timeout.
        const result = await starting;
        if (kind === "eof") expect(result.error?.message).toMatch(/stream closed/);
        else expect(result.error).toBe(error);
        expect(f.posts.some(p => p.body.method === "notifications/initialized")).toBe(false);
        expect(f.client.running).toBe(false);
        expect(f.client._pending.size).toBe(0);
        expect(f.closes).toHaveBeenCalledTimes(1);
        expect(f.streams[0].body.locked).toBe(false);
      });

  it("rejects a missing body immediately and closes once", async () => {
    const f = fixture(); f.noBody();
    let settled = false;
    const starting = outcome(f.client.start()).then(result => { settled = true; return result; });
    await turn();
    expect(settled).toBe(true);
    expect((await starting).error?.message).toMatch(/no readable body/);
    expect(f.posts).toHaveLength(0);
    expect(f.closes).toHaveBeenCalledTimes(1);
    expect(f.client.running).toBe(false);
  });

  it("stop settles startup before the endpoint and releases the reader without unexpected close", async () => {
    const f = fixture({ endpoint: false });
    let settled = false;
    const starting = outcome(f.client.start()).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    await f.client.stop(); await turn();
    expect(settled).toBe(true);
    expect((await starting).error?.message).toMatch(/stopped/);
    expect(f.streams[0].signal.aborted).toBe(true);
    expect(f.streams[0].body.locked).toBe(false);
    expect(f.closes).not.toHaveBeenCalled();
  });

  it("stop rejects pending with the existing stopped reason and clears partial/queued data", async () => {
    const f = fixture(); await f.client.start();
    const pending = outcome(f.client.callTool("write", {}));
    await vi.waitFor(() => expect(f.client._pending.size).toBe(1));
    f.emit(f.streams[0], 'data: {"jsonrpc":"2.0","id":999,"result":{"old":true}}\n\ndata: partial');
    await turn();
    expect(f.client._queued.size).toBe(1);
    await f.client.stop(); await f.client.stop(); await turn();
    expect((await pending).error?.message).toBe("MCP connector stopped");
    expect(f.client._queued.size).toBe(0);
    expect(f.client._buffer).toBe("");
    expect(f.streams[0].body.locked).toBe(false);
    expect(f.closes).not.toHaveBeenCalled();
  });
});

describe("legacy SSE generation ownership", () => {
  it("a stop during overlapping startup cannot be undone by an earlier start continuation", async () => {
    const f = fixture();
    const first = outcome(f.client.start());
    const second = outcome(f.client.start());
    await f.client.stop();
    const results = await Promise.all([first, second]);
    expect(results.every(result => result.error)).toBe(true);
    expect(f.client.running).toBe(false);
    expect(f.posts).toHaveLength(0);
    expect(f.closes).not.toHaveBeenCalled();
  });

  it("overlapping starts settle the superseded start and retain only the newest connection", async () => {
    const f = fixture();
    const first = outcome(f.client.start());
    const second = outcome(f.client.start());
    const results = await Promise.all([first, second]);
    expect(results[0].error).toBeTruthy();
    expect(results[1].error).toBeNull();
    expect(f.client.running).toBe(true);
    expect(f.posts.filter(p => p.body.method === "initialize")).toHaveLength(1);
    expect(f.closes).not.toHaveBeenCalled();
  });

  it("disposes a GET body when stop wins immediately after fetch resolution", async () => {
    const f = fixture();
    const delivered = gate<Response>();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const fetchImpl = vi.fn(() => delivered.promise);
    f.client.fetchImpl = fetchImpl;
    const starting = outcome(f.client.start());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    delivered.resolve(new Response(body));
    queueMicrotask(() => { void f.client.stop(); });
    expect((await starting).error?.message).toBe("MCP connector stopped");
    await turn();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(f.reads).not.toHaveBeenCalled();
    expect(f.closes).not.toHaveBeenCalled();
  });

  for (const kind of ["error", "source-abort", "eof", "endpoint", "queued-response", "partial"])
    it(`ignores old ${kind} delivery after stop and reopening the same client`, async () => {
      const f = fixture(); await f.client.start();
      const old = f.streams[0];
      old.late = gate();
      // Settle the native read, but hold its delivery across stop/reopen.
      f.emit(old, ": delayed\n\n"); await turn();
      await f.client.stop(); await f.client.start();
      const current = f.streams[1];
      const pending = outcome(f.client.callTool("write", {}));
      await vi.waitFor(() => expect(f.posts.filter(p => p.body.method === "tools/call")).toHaveLength(1));
      const request = f.posts.find(p => p.body.method === "tools/call");
      const endpoint = f.client.messageEndpoint;
      if (kind === "error" || kind === "source-abort") old.late.reject(kind === "error"
        ? new TypeError("old reader failed") : new DOMException("old abort delivered", "AbortError"));
      else old.late.resolve(kind === "eof" ? { done: true, value: undefined } : { done: false, value: encoder.encode(
        kind === "endpoint" ? "event: endpoint\ndata: /messages?g=1\n\n"
          : kind === "partial" ? "data: stale partial"
            : 'data: {"jsonrpc":"2.0","id":999,"result":{"old":true}}\n\n',
      ) });
      await turn();
      expect(f.client.running).toBe(true);
      expect(f.client.messageEndpoint).toBe(endpoint);
      expect(f.client._pending.size).toBe(1);
      expect(f.client._queued.size).toBe(0);
      expect(f.client._buffer).toBe("");
      expect(f.closes).not.toHaveBeenCalled();
      expect(current.signal.aborted).toBe(false);
      expect(old.body.locked).toBe(false);
      expect(old.release).toHaveBeenCalledTimes(1);
      f.reply(current, request.body.id);
      expect((await pending).value).toEqual(complete);
      expect(f.posts.filter(p => p.body.method === "initialize").map(p => p.body.id)).toEqual([1, 2]);
      expect(request.body.id).toBe(3); // IDs are never reset on reopen.
    });

  for (const phase of ["headers", "fetch"])
    for (const resolution of ["success", "failure"])
      it(`old ${phase} ${resolution} cannot start or stop the replacement connection`, async () => {
        const delayed = gate(); let tokenCalls = 0;
        const f = fixture({ getAuthToken: phase === "headers" ? () => ++tokenCalls === 1 ? delayed.promise : "" : null });
        if (phase === "fetch") f.holdGet(delayed);
        let settled = false;
        const oldStart = outcome(f.client.start()).then(result => { settled = true; return result; });
        await vi.waitFor(() => expect(phase === "headers" ? tokenCalls : f.streams.length).toBe(1));
        await f.client.stop(); await turn();
        expect(settled).toBe(true);
        await f.client.start();
        const current = f.streams.at(-1);
        const endpoint = f.client.messageEndpoint;
        if (resolution === "failure") delayed.reject(new TypeError("old setup failed")); else delayed.resolve("");
        await oldStart; await turn();
        expect(f.client.running).toBe(true);
        expect(f.client.messageEndpoint).toBe(endpoint);
        expect(current.signal.aborted).toBe(false);
        expect(f.closes).not.toHaveBeenCalled();
        expect(f.posts.filter(p => p.body.method === "initialize")).toHaveLength(1);
        expect(f.streams).toHaveLength(phase === "headers" ? 1 : 2);
        if (phase === "fetch" && resolution === "success") {
          expect(f.streams[0].body.locked).toBe(false);
          expect(f.streams[0].sourceCancel).toHaveBeenCalledTimes(1);
        }
      });

  it("does not dispatch an old POST after its headers finish on a reopened connection", async () => {
    let delayed = null;
    const f = fixture({ getAuthToken: () => delayed ? delayed.promise : "" });
    await f.client.start();
    const tokenGate = gate(); delayed = tokenGate;
    const pending = outcome(f.client.callTool("write", {}));
    await turn();
    await f.client.stop(); delayed = null; await f.client.start();
    tokenGate.resolve(""); await turn();
    expect((await pending).error?.message).toBe("MCP connector stopped");
    expect(f.posts.filter(p => p.body.method === "tools/call")).toHaveLength(0);
    expect(f.client.running).toBe(true);
    expect(f.closes).not.toHaveBeenCalled();
  });

  it("allows reopening from the close callback without the old finally clearing the new reader", async () => {
    let reopening;
    const f = fixture({ onClose: () => { reopening = f.client.start(); } });
    await f.client.start();
    const old = f.streams[0];
    old.controller.error(new TypeError("reader failed"));
    await turn(); await reopening;
    expect(f.client.running).toBe(true);
    expect(f.streams[1].signal.aborted).toBe(false);
    expect(old.body.locked).toBe(false);
    const pending = outcome(f.client.callTool("write", {}));
    await vi.waitFor(() => expect(f.posts.filter(p => p.body.method === "tools/call")).toHaveLength(1));
    f.reply(f.streams[1], f.posts.at(-1).body.id);
    expect((await pending).value).toEqual(complete);
    await f.client.stop(); await turn();
    expect(f.streams[1].body.locked).toBe(false);
    expect(f.closes).toHaveBeenCalledTimes(1);
  });
});
