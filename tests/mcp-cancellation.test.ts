import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpManager } from "../core/mcp/manager.ts";
import { ConfirmStore } from "../lib/confirm-store.ts";
import { MCP_PROTOCOL_VERSION_2026_07_28 } from "../core/mcp/clients/protocol-version.ts";

function barrier<T = unknown>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });
}

const complete = { content: [{ type: "text", text: "ok" }] };
const inputRequired = {
  resultType: "input_required", requestState: "opaque-state",
  inputRequests: { answer: { method: "elicitation/create", params: { message: "Continue?" } } },
};
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

// Only the network and persisted config are fakes. Tool publication, permission
// checks, lazy start, OAuth refresh deduplication and all transports are real.
function harness(mode = "modern") {
  let stored = {
    enabled: true,
    connectors: [{
      id: "remote", name: "Remote", url: "https://mcp.test/rpc",
      transport: mode === "sse" ? "sse" : "streamable-http",
      authType: "oauth", oauthClientId: "fixture-client",
      oauth: {
        accessToken: "fixture-old", refreshToken: "fixture-refresh",
        tokenEndpoint: "https://mcp.test/token", expiresAt: Date.now() + 3_600_000,
      },
      tools: [{ name: "write", inputSchema: { type: "object" } }],
    }],
  };
  const tokenGate = barrier<Response>();
  const discoveryGate = barrier<void>();
  const handshakeGate = barrier<void>();
  const calls = [];
  const notifications = [];
  const tokenRequests = [];
  let holdDiscovery = false;
  let holdHandshake = false;
  let handshakeFailure = false;
  let toolReply = async (_body, _init): Promise<unknown> => complete;
  let tokenReply = () => tokenGate.promise;
  let sseController;
  const encoder = new TextEncoder();
  const sendSse = (body) => sseController.enqueue(encoder.encode(`data: ${JSON.stringify(body)}\n\n`));
  const fetchImpl = vi.fn(async (url, init: RequestInit = {}) => {
    if (String(url) === "https://mcp.test/token") {
      tokenRequests.push(init);
      return tokenReply();
    }
    if (init.method === "DELETE") return new Response(null, { status: 202 });
    if (init.method === "GET" && mode === "sse") {
      return new Response(new ReadableStream({
        start(controller) {
          sseController = controller;
          controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
          init.signal.addEventListener("abort", () => controller.close(), { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    const body = JSON.parse(String(init.body));
    if (body.id == null) {
      notifications.push(body);
      return new Response(null, { status: 202 });
    }
    let result;
    if (body.method === "server/discover") {
      if (holdDiscovery) await discoveryGate.promise;
      if (mode !== "modern") return new Response("Not found", { status: 404 });
      result = { supportedVersions: [MCP_PROTOCOL_VERSION_2026_07_28], capabilities: {} };
    } else if (body.method === "initialize") {
      if (holdHandshake) await handshakeGate.promise;
      if (handshakeFailure) return json({ error: "unauthorized" }, 401);
      result = { protocolVersion: "2025-11-25", capabilities: {} };
    } else if (body.method === "tools/list") {
      result = { tools: [{ name: "write", inputSchema: { type: "object" } }] };
    } else if (body.method === "tools/call") {
      calls.push({ body, init });
      result = await toolReply(body, init);
      if (result instanceof Response) return result;
    } else {
      throw new Error(`Unexpected fixture request: ${body.method}`);
    }
    const reply = { jsonrpc: "2.0", id: body.id, result };
    if (mode === "sse") {
      queueMicrotask(() => sendSse(reply));
      return new Response(null, { status: 202 });
    }
    return json(reply, 200, body.method === "initialize" ? { "MCP-Session-Id": "fixture-session" } : {});
  });
  const confirmStore = new ConfirmStore();
  const emitEvent = vi.fn();
  const runtime = new McpManager({ dataDir: "/unused-mcp-fixture", log: { debug() {}, warn() {}, info() {}, error() {} } }, {
    configStore: { get: () => stored, set: (_key, value) => { stored = value; } },
    fetchImpl, confirmStore, emitEvent,
  });
  runtime._bus = { request: vi.fn(async () => ({ config: {
    mcp: { connectors: { remote: { enabled: true, tools: { write: true } } } },
  } })) };
  runtime.registerCachedTools();
  const tool = runtime.getAllTools().find((entry) => entry.name === "mcp_remote_write");
  const ctx = { agentId: "fixture-agent", sessionPath: "/fixture/session.jsonl" };
  cleanups.push(async () => {
    tokenGate.resolve(json({ access_token: "fixture-new", expires_in: 3600 }));
    discoveryGate.resolve();
    handshakeGate.resolve();
    confirmStore.abortBySession(ctx.sessionPath);
    await runtime.dispose();
  });
  return {
    runtime, tool, ctx, calls, notifications, tokenRequests, fetchImpl, confirmStore, emitEvent,
    tokenGate, discoveryGate, handshakeGate,
    holdDiscovery: () => { holdDiscovery = true; },
    holdHandshake: () => { holdHandshake = true; },
    failHandshake: () => { handshakeFailure = true; },
    expireToken: () => { stored.connectors[0].oauth.expiresAt = Date.now() - 1; },
    replyWith: (fn) => { toolReply = fn; },
    replyTokenWith: (fn) => { tokenReply = fn; },
    run: (signal, args = {}) => tool.execute("call-fixture", args, signal, undefined, ctx),
  };
}

function observe(promise) {
  const state: { done?: Promise<void>; value?: unknown; error?: Error } = {};
  state.done = promise.then((value) => { state.value = value; }, (error) => { state.error = error; });
  return state;
}

async function expectAborted(state) {
  await vi.waitFor(() => expect(state.error?.name).toBe("AbortError"), { timeout: 500 });
}

function expectLive(h) {
  expect(h.runtime.clients.get("remote")?.running).toBe(true);
  expect(h.runtime.clientErrors.size).toBe(0);
  expect(h.runtime.reconnectState.size).toBe(0);
  expect(h.runtime.connectorStatus.size).toBe(0);
}

// Independent acceptance reproduced this through the published five-argument
// tool, manager, real OAuth error classifier and each actual HTTP transport.
describe.each(["modern", "streamable-legacy", "sse"])("shared refresh lifecycle (%s)", (mode) => {
  describe.each(["pre-refresh", "401-refresh"])("%s", (phase) => {
    async function startRefresh() {
      const h = harness(mode);
      await h.runtime.startConnector("remote");
      if (phase === "pre-refresh") h.expireToken();
      else h.replyWith(async () => json({ error: "unauthorized" }, 401));
      const refresh = vi.spyOn(h.runtime, "_refreshConnectorToken");
      const close = vi.spyOn(h.runtime, "_onClientClose");
      const controller = new AbortController();
      const cancelled = observe(h.run(controller.signal));
      await vi.waitFor(() => expect(h.tokenRequests).toHaveLength(1));
      const shared = observe(refresh.mock.results[0].value);
      return { h, refresh, close, controller, cancelled, shared };
    }

    it.each([1, 2])("reports invalid_grant after all %i waiters cancel", async (count) => {
      const { h, refresh, close, controller, cancelled } = await startRefresh();
      const lastController = new AbortController();
      const last = count === 2 ? observe(h.run(lastController.signal)) : cancelled;
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(count));
      controller.abort();
      await expectAborted(cancelled);
      lastController.abort();
      await expectAborted(last);
      expectLive(h);
      expect(h.runtime.refreshInFlight.size).toBe(1);
      expect(h.tokenRequests[0].signal?.aborted).not.toBe(true);
      expect(close).not.toHaveBeenCalled();

      h.tokenGate.resolve(json({ error: "invalid_grant", error_description: "fixture refresh expired" }, 400));
      await vi.waitFor(() => expect(h.runtime.refreshInFlight.size).toBe(0));
      expect(h.runtime.connectorStatusFor("remote")).toBe("needs-auth");
      expect(h.runtime.clientErrors.get("remote")).toMatch(/fixture refresh expired/);
      expect(h.runtime.clients.has("remote")).toBe(false);
      expect(h.runtime.reconnectState.size).toBe(0);
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith("remote", expect.objectContaining({ needsAuth: true, expected: false }));
      expect(h.calls).toHaveLength(phase === "pre-refresh" ? 0 : count);
      expect(h.tokenRequests).toHaveLength(1);
      expect(cancelled.error.name).toBe("AbortError");
      expect(last.error.name).toBe("AbortError");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(lastController.signal, "abort")).toHaveLength(0);
    });

    it("reports the original failure to surviving waiters and closes only once", async () => {
      const { h, refresh, close, controller, cancelled } = await startRefresh();
      const survivors = [observe(h.run(undefined)), observe(h.run(undefined))];
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
      controller.abort();
      await expectAborted(cancelled);
      expectLive(h);
      h.tokenGate.resolve(json({ error: "invalid_grant", error_description: "fixture refresh expired" }, 400));
      await Promise.all(survivors.map((state) => state.done));
      for (const state of survivors) {
        expect(state.value).toMatchObject({
          isError: true, content: [{ type: "text", text: expect.stringContaining("fixture refresh expired") }],
        });
      }
      expect(h.runtime.connectorStatusFor("remote")).toBe("needs-auth");
      expect(close).toHaveBeenCalledTimes(1);
      expect(h.tokenRequests).toHaveLength(1);
      expect(h.calls).toHaveLength(phase === "pre-refresh" ? 0 : 3);
    });

    it("records a detached transient refresh failure without classifying it as needs-auth", async () => {
      const { h, close, controller, cancelled } = await startRefresh();
      controller.abort();
      await expectAborted(cancelled);
      h.tokenGate.resolve(json({ error: "temporarily_unavailable" }, 503));
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      expect(close).toHaveBeenCalledWith("remote", expect.objectContaining({ needsAuth: false }));
      expect(h.runtime.connectorStatusFor("remote")).toBe("reconnecting");
      expect(h.runtime.clientErrors.get("remote")).toMatch(/temporarily_unavailable/);
      expect(h.calls).toHaveLength(phase === "pre-refresh" ? 0 : 1);
      expect(h.tokenRequests).toHaveLength(1);
    });

    it("does not report an AbortError from shared auth work as connection failure", async () => {
      const { h, close, controller, cancelled, shared } = await startRefresh();
      controller.abort();
      await expectAborted(cancelled);
      const response = json({});
      response.text = async () => { throw new DOMException("fixture aborted auth", "AbortError"); };
      h.tokenGate.resolve(response);
      await shared.done;
      expect(shared.error?.name).toBe("AbortError");
      expect(close).not.toHaveBeenCalled();
      expectLive(h);
    });

    it.each(["success", "invalid_grant"])("ignores an old refresh %s after new OAuth credentials and a new connection", async (outcome) => {
      const { h, close, controller, cancelled, shared } = await startRefresh();
      controller.abort();
      await expectAborted(cancelled);
      const oldClient = h.runtime.clients.get("remote");
      await h.runtime.saveConnectorOAuth("remote", {
        accessToken: "fixture-reauthorized", refreshToken: "fixture-new-refresh",
        tokenEndpoint: "https://mcp.test/token", obtainedAt: Date.now(), expiresIn: 3600,
      });
      h.replyWith(async () => complete);
      await h.runtime.startConnector("remote");
      const newClient = h.runtime.clients.get("remote");
      expect(newClient).not.toBe(oldClient);

      h.tokenGate.resolve(outcome === "success"
        ? json({ access_token: "fixture-obsolete", refresh_token: "fixture-obsolete-refresh", expires_in: 3600 })
        : json({ error: "invalid_grant", error_description: "fixture obsolete failure" }, 400));
      await shared.done;
      expect(h.runtime.getConfig().connectors[0].oauth.accessToken).toBe("fixture-reauthorized");
      expect(h.runtime.getConfig().connectors[0].oauth.refreshToken).toBe("fixture-new-refresh");
      expect(h.runtime.clients.get("remote")).toBe(newClient);
      expectLive(h);
      expect(close).not.toHaveBeenCalled();
      expect(cancelled.error.name).toBe("AbortError");
      expect((await h.run(undefined)).content).toEqual(complete.content);
    });

    it.each(["success", "invalid_grant"])("keeps a newer refresh alive when old %s settles after credentials change", async (outcome) => {
      const { h, close, cancelled, shared } = await startRefresh();
      const client = h.runtime.clients.get("remote");
      // Persistence can change credentials without replacing the live client.
      // Keep the original waiter active to verify stale errors never close it.
      h.runtime._writeConnectorOAuth("remote", {
        accessToken: "fixture-reauthorized", refreshToken: "fixture-new-refresh",
        tokenEndpoint: "https://mcp.test/token", obtainedAt: Date.now() - 2000, expiresIn: 1,
      });
      const newGate = barrier<Response>();
      h.replyTokenWith(() => newGate.promise);
      h.replyWith(async () => complete);
      const newer = observe(h.run(undefined));
      try {
        await vi.waitFor(() => expect(h.tokenRequests).toHaveLength(2));
        h.tokenGate.resolve(outcome === "success"
          ? json({ access_token: "fixture-obsolete", expires_in: 3600 })
          : json({ error: "invalid_grant" }, 400));
        await shared.done;
        await expectAborted(cancelled);
        expect(h.runtime.refreshInFlight.size).toBe(1);
        expect(h.runtime.getConfig().connectors[0].oauth.accessToken).toBe("fixture-reauthorized");
        expect(h.runtime.clients.get("remote")).toBe(client);
        expect(close).not.toHaveBeenCalled();
        expectLive(h);
      } finally {
        newGate.resolve(json({ access_token: "fixture-latest", expires_in: 3600 }));
        await newer.done;
      }
      expect(newer.value).toMatchObject(complete);
      expect(h.runtime.getConfig().connectors[0].oauth.accessToken).toBe("fixture-latest");
      expect(h.runtime.refreshInFlight.size).toBe(0);
      expectLive(h);
    });
  });

  it.each(["success", "invalid_grant"])("ignores an old refresh %s after restarting with the same credentials", async (outcome) => {
    const h = harness(mode);
    await h.runtime.startConnector("remote");
    h.replyWith(async () => json({ error: "unauthorized" }, 401));
    const controller = new AbortController();
    const cancelled = observe(h.run(controller.signal));
    await vi.waitFor(() => expect(h.tokenRequests).toHaveLength(1));
    const shared = observe(h.runtime.refreshIfPossible("remote"));
    controller.abort();
    await expectAborted(cancelled);
    const credentials = h.runtime.getConfig().connectors[0].oauth;
    await h.runtime.stopConnector("remote");
    h.replyWith(async () => complete);
    await h.runtime.startConnector("remote");
    const client = h.runtime.clients.get("remote");
    h.tokenGate.resolve(outcome === "success"
      ? json({ access_token: "fixture-obsolete", expires_in: 3600 })
      : json({ error: "invalid_grant" }, 400));
    await shared.done;
    expect(h.runtime.clients.get("remote")).toBe(client);
    expect(h.runtime.getConfig().connectors[0].oauth).toEqual(credentials);
    expectLive(h);
  });
});

describe.each(["stop", "dispose", "remove"])("detached refresh after %s", (action) => {
  it.each(["success", "invalid_grant"])("ignores late %s without resurrecting credentials or connection state", async (outcome) => {
    const h = harness();
    await h.runtime.startConnector("remote");
    h.expireToken();
    const controller = new AbortController();
    const cancelled = observe(h.run(controller.signal));
    await vi.waitFor(() => expect(h.tokenRequests).toHaveLength(1));
    const shared = observe(h.runtime.refreshIfPossible("remote"));
    controller.abort();
    await expectAborted(cancelled);
    if (action === "stop") await h.runtime.stopConnector("remote");
    if (action === "dispose") await h.runtime.dispose();
    if (action === "remove") await h.runtime.removeConnector("remote");
    const config = h.runtime.getConfig();
    h.tokenGate.resolve(outcome === "success"
      ? json({ access_token: "fixture-obsolete", expires_in: 3600 })
      : json({ error: "invalid_grant" }, 400));
    await shared.done;
    expect(h.runtime.getConfig()).toEqual(config);
    expect(h.runtime.clients.size).toBe(0);
    expect(h.runtime.connectorStatus.size).toBe(0);
    expect(h.runtime.clientErrors.size).toBe(0);
    expect(h.runtime.reconnectState.size).toBe(0);
    expect(h.runtime.refreshInFlight.size).toBe(0);
  });
});

describe.each(["modern", "streamable-legacy", "sse"])("MCP cancellation through the published tool (%s)", (mode) => {
  it("rejects an already-aborted SDK call without starting the connector", async () => {
    const h = harness(mode);
    const controller = new AbortController();
    controller.abort(new Error("Stopped by user"));
    const state = observe(h.run(controller.signal));
    await expectAborted(state);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted direct client call without dispatching", async () => {
    const h = harness(mode);
    await h.runtime.startConnector("remote");
    const controller = new AbortController();
    controller.abort();
    h.fetchImpl.mockClear();
    await expect(h.runtime.clients.get("remote").callTool("write", {}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expectLive(h);
  });

  it("abandons one token waiter promptly without cancelling the shared refresh or the other call", async () => {
    const h = harness(mode);
    await h.runtime.startConnector("remote");
    h.expireToken();
    const controller = new AbortController();
    const cancelled = observe(h.run(controller.signal, { caller: "cancelled" }));
    const survivor = observe(h.run(undefined, { caller: "survivor" }));
    await vi.waitFor(() => expect(h.tokenRequests).toHaveLength(1));
    controller.abort();
    try {
      await expectAborted(cancelled);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(h.calls).toHaveLength(0);
      expect(h.runtime.refreshInFlight.size).toBe(1);
      expect(h.tokenRequests[0].signal?.aborted).not.toBe(true);
    } finally {
      h.tokenGate.resolve(json({ access_token: "fixture-new", expires_in: 3600 }));
      await Promise.all([cancelled.done, survivor.done]);
    }
    expect(survivor.value).toMatchObject(complete);
    expect(h.calls.map((call) => call.body.params.arguments)).toEqual([{ caller: "survivor" }]);
    expectLive(h);
  });

  it("does not retry a cancelled 401 waiter after the shared refresh completes", async () => {
    const h = harness(mode);
    await h.runtime.startConnector("remote");
    h.replyWith(async (_body, init) => init.headers.Authorization === "Bearer fixture-old"
      ? json({ error: "unauthorized" }, 401) : complete);
    const controller = new AbortController();
    const cancelled = observe(h.run(controller.signal, { caller: "cancelled" }));
    const survivor = observe(h.run(undefined, { caller: "survivor" }));
    await vi.waitFor(() => {
      expect(h.calls).toHaveLength(2);
      expect(h.tokenRequests).toHaveLength(1);
    });
    controller.abort();
    try {
      await expectAborted(cancelled);
      expect(h.runtime.refreshInFlight.size).toBe(1);
      expectLive(h);
    } finally {
      h.tokenGate.resolve(json({ access_token: "fixture-new", expires_in: 3600 }));
      await Promise.all([cancelled.done, survivor.done]);
    }
    expect(survivor.value).toMatchObject(complete);
    expect(h.calls.filter((call) => call.body.params.arguments.caller === "cancelled")).toHaveLength(1);
    expect(h.calls.filter((call) => call.body.params.arguments.caller === "survivor")).toHaveLength(2);
    expect(h.calls.at(-1).body.params.arguments.caller).toBe("survivor");
    expectLive(h);
  });

  it("aborts only the in-flight request and ignores its late result", async () => {
    const h = harness(mode);
    await h.runtime.startConnector("remote");
    const replyGate = barrier();
    h.replyWith(async (body) => body.params.arguments.caller === "cancelled" ? replyGate.promise : complete);
    const controller = new AbortController();
    const cancelled = observe(h.run(controller.signal, { caller: "cancelled" }));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const request = h.calls[0];
    controller.abort();
    try {
      await expectAborted(cancelled);
      expect(request.init.signal.aborted).toBe(true);
      expectLive(h);
      const survivor = await h.run(undefined, { caller: "survivor" });
      expect(survivor.content).toEqual(complete.content);
      if (mode !== "modern") {
        await vi.waitFor(() => expect(h.notifications).toContainEqual({
          jsonrpc: "2.0", method: "notifications/cancelled",
          params: { requestId: request.body.id, reason: "Request cancelled" },
        }));
      }
    } finally {
      replyGate.resolve(complete);
    }
    // Let the fake remote's late success reach the real transport.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).toHaveLength(2);
    expect(h.runtime.clients.get("remote")._pending?.size || 0).toBe(0);
    expect(h.runtime.clients.get("remote")._queued?.size || 0).toBe(0);
    expectLive(h);
  });

  it("bounds a token wait and cannot send after the deadline", async () => {
    const h = harness(mode);
    await h.runtime.startConnector("remote");
    h.expireToken();
    vi.useFakeTimers();
    const client = h.runtime.clients.get("remote");
    const state = observe(client.callTool("write", {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.tokenRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(state.error?.name).toBe("TimeoutError");
    h.tokenGate.resolve(json({ access_token: "fixture-new", expires_in: 3600 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(0);
    expectLive(h);
  });
});

describe("MCP cancellation at manager boundaries", () => {
  it("honors the legacy runtime-context signal without mutating either context", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const context = Object.freeze({ ...h.ctx, signal: controller.signal });
    await expect(h.tool.execute("legacy-call", {}, context)).rejects.toMatchObject({ name: "AbortError" });
    expect(h.ctx).not.toHaveProperty("signal");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("cannot dispatch when cancelled while waiting for agent policy", async () => {
    const h = harness();
    const policyGate = barrier();
    h.runtime._bus.request.mockReturnValueOnce(policyGate.promise);
    const controller = new AbortController();
    const state = observe(h.run(controller.signal));
    await vi.waitFor(() => expect(h.runtime._bus.request).toHaveBeenCalled());
    controller.abort();
    await expectAborted(state);
    policyGate.resolve({ config: { mcp: { connectors: { remote: { enabled: true } } } } });
    await state.done;
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not dispatch after a shared lazy start finishes", async () => {
    const h = harness();
    h.holdDiscovery();
    const controller = new AbortController();
    const cancelled = observe(h.run(controller.signal, { caller: "cancelled" }));
    const survivor = observe(h.run(undefined, { caller: "survivor" }));
    await vi.waitFor(() => expect(h.runtime._lazyStarts.size).toBe(1));
    controller.abort();
    try {
      await expectAborted(cancelled);
      expect(h.calls).toHaveLength(0);
    } finally {
      h.discoveryGate.resolve();
      await Promise.all([cancelled.done, survivor.done]);
    }
    expect(survivor.value).toMatchObject(complete);
    expect(h.calls.map((call) => call.body.params.arguments.caller)).toEqual(["survivor"]);
    expectLive(h);
  });

  it("does not replay a tool after cancellation during session reinitialization", async () => {
    const h = harness("streamable-legacy");
    await h.runtime.startConnector("remote");
    h.holdHandshake();
    h.replyWith(async () => json({ error: "session expired" }, 404));
    const controller = new AbortController();
    const state = observe(h.run(controller.signal));
    await vi.waitFor(() => expect(h.fetchImpl.mock.calls.filter(([, init]) =>
      init.method === "POST" && JSON.parse(String(init.body)).method === "initialize")).toHaveLength(2));
    controller.abort();
    await expectAborted(state);
    h.handshakeGate.resolve();
    await vi.waitFor(() => expectLive(h));
    expect(h.calls).toHaveLength(1);
    expect(h.notifications.filter((entry) => entry.method === "notifications/cancelled")).toHaveLength(0);
  });

  it("preserves a successful input round and removes listeners after completion", async () => {
    const h = harness();
    await h.runtime.startConnector("remote");
    h.replyWith(async () => h.calls.length === 1 ? inputRequired : complete);
    const controller = new AbortController();
    const pending = h.run(controller.signal);
    await vi.waitFor(() => expect(h.emitEvent).toHaveBeenCalledTimes(1));
    h.confirmStore.resolve(h.emitEvent.mock.calls[0][0].request.confirmId, "confirmed", { choice: "yes" });
    expect((await pending).content).toEqual(complete.content);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].body.params).toMatchObject({
      requestState: "opaque-state", inputResponses: { answer: { action: "accept", content: { choice: "yes" } } },
    });
    expect(h.calls[1].body.params).not.toHaveProperty("signal");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    expect(h.calls).toHaveLength(2);
    expect(h.confirmStore.size).toBe(0);
  });

  it("still reports a real shared handshake failure after its cancelled waiter has left", async () => {
    const h = harness("streamable-legacy");
    await h.runtime.startConnector("remote");
    h.holdHandshake();
    h.failHandshake();
    h.replyWith(async () => json({ error: "session expired" }, 404));
    const controller = new AbortController();
    const state = observe(h.run(controller.signal));
    await vi.waitFor(() => expect(h.fetchImpl.mock.calls.filter(([, init]) =>
      init.method === "POST" && JSON.parse(String(init.body)).method === "initialize")).toHaveLength(2));
    controller.abort();
    await expectAborted(state);
    expect(h.runtime.connectorStatus.size).toBe(0);
    h.handshakeGate.resolve();
    await vi.waitFor(() => expect(h.runtime.connectorStatus.get("remote")).toBe("needs-auth"), { timeout: 500 });
    expect(h.runtime.clientErrors.get("remote")).toMatch(/authentication failed/);
    expect(h.calls).toHaveLength(1);
    expect(state.error.name).toBe("AbortError");
  });

  it.each(["confirmed", "rejected"])("does not send a %s continuation after cancellation", async (action) => {
    const h = harness();
    await h.runtime.startConnector("remote");
    h.replyWith(async () => h.calls.length === 1 ? inputRequired : complete);
    const controller = new AbortController();
    const state = observe(h.run(controller.signal));
    await vi.waitFor(() => expect(h.confirmStore.size).toBe(1));
    const confirmId = h.emitEvent.mock.calls[0][0].request.confirmId;
    // Settle the form and abort in the same turn, before its await resumes.
    h.confirmStore.resolve(confirmId, action, { answer: "fixture" });
    controller.abort();
    await expectAborted(state);
    expect(h.calls).toHaveLength(1);
    expectLive(h);
  });

  it("cleans up only its own pending input form and never resumes from a late answer", async () => {
    const h = harness();
    await h.runtime.startConnector("remote");
    h.replyWith(async () => inputRequired);
    const unrelated = h.confirmStore.create("unrelated", {}, h.ctx.sessionPath);
    const onResolved = vi.fn();
    h.confirmStore.onResolved = onResolved;
    const controller = new AbortController();
    const state = observe(h.run(controller.signal));
    await vi.waitFor(() => expect(h.emitEvent).toHaveBeenCalledTimes(1));
    const confirmId = h.emitEvent.mock.calls[0][0].request.confirmId;
    controller.abort();
    await expectAborted(state);
    expect(h.confirmStore.get(confirmId)).toBeNull();
    expect(h.confirmStore.get(unrelated.confirmId)).not.toBeNull();
    expect(onResolved).toHaveBeenCalledWith(confirmId, "aborted");
    expect(h.confirmStore.resolve(confirmId, "confirmed", {})).toBe(false);
    expect(h.calls).toHaveLength(1);
  });
});

describe.each(["modern", "streamable-legacy"])("Streamable HTTP response cancellation (%s)", (mode) => {
  it.each([200, 401])("keeps cancellation attached while reading a %s response body", async (status) => {
    const h = harness(mode);
    await h.runtime.startConnector("remote");
    const textGate = barrier<string>();
    const bodyRead = vi.fn(() => textGate.promise);
    h.replyWith(async () => {
      const response = json({}, status);
      response.text = bodyRead;
      return response;
    });
    const controller = new AbortController();
    const state = observe(h.run(controller.signal));
    await vi.waitFor(() => expect(bodyRead).toHaveBeenCalled());
    controller.abort();
    await expectAborted(state);
    expect(h.calls[0].init.signal.aborted).toBe(true);
    textGate.resolve(JSON.stringify({ jsonrpc: "2.0", id: h.calls[0].body.id, result: complete }));
    await state.done;
    expect(h.tokenRequests).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    expectLive(h);
  });
});
