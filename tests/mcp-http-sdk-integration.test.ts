import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  complete, delay, encoder, envelope, gate, harness, heldBody, httpModes, json,
  modes, packet, truncated, until, watch,
} from "./fixtures/mcp-http-fixture.ts";
import { makeEngine, sdkSession } from "./fixtures/mcp-engine-fixture.ts";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(mode, options = {}) {
  const h = await harness(mode, options);
  cleanups.push(() => h.dispose());
  return h;
}
function engine(h, options = {}) {
  const e = makeEngine(h, options);
  cleanups.push(() => e.dispose());
  return e;
}
async function sdk(e) {
  const s = await sdkSession(e);
  cleanups.push(() => s.dispose());
  return s;
}
function expectErrorAtEveryLayer(out, isError) {
  expect(out.event.isError).toBe(isError);
  expect(out.canonical.isError).toBe(isError);
  expect(out.provider.isError).toBe(isError);
}

describe.each(httpModes)("%s through engine and installed Pi AgentSession", (mode) => {
  describe.each([false, true])("deferred=%s", (deferred) => {
    it.each(["body-json", "body-sse", "rpc-error", "tool-error", "abort-source", "empty"])(
      "preserves %s in event, canonical result and next provider context", async (kind) => {
        const h = await fixture(mode);
        h.reply((body) => {
          if (kind.startsWith("body-")) return truncated(
            (kind === "body-json" ? JSON.stringify(envelope(body.id, complete(mode))) : packet(body.id, complete(mode))).slice(0, 30),
            { contentType: kind === "body-json" ? "application/json" : "text/event-stream" },
          );
          if (kind === "rpc-error") return json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "fixture RPC failure" } });
          if (kind === "tool-error") return h.respond(body, { ...complete(mode, "business rejected"), isError: true, structuredContent: { rejected: true } });
          if (kind === "abort-source") return truncated("prefix", { error: new DOMException("source cancelled", "AbortError") });
          return h.respond(body, { ...complete(mode), content: [], structuredContent: null });
        });
        const e = engine(h, { deferred });
        const s = await sdk(e);
        const out = await s.run();
        expectErrorAtEveryLayer(out, kind !== "empty");
        expect(h.calls).toHaveLength(1);
        expect(e.registry.activeCount(e.sessionId)).toBe(0);
        if (kind.startsWith("body-")) {
          for (const result of [out.event.result, out.canonical, out.provider]) {
            expect(JSON.stringify(result)).toContain("transport body interrupted");
            expect(JSON.stringify(result)).not.toContain("Cannot read properties of null");
          }
          expect(h.closes).toHaveLength(1);
          expect(h.closes[0].needsAuth).toBe(false);
        }
        if (kind === "tool-error") expect(out.event.result.structuredContent).toEqual({ rejected: true });
        if (kind === "empty") {
          expect(out.event.result.content).toEqual([]);
          expect(out.event.result.structuredContent).toBeNull();
        }
        if (["tool-error", "empty", "abort-source"].includes(kind)) expect(h.closes).toHaveLength(0);
      },
    );
  });
});

describe.each([false, true])("legacy SSE SDK compatibility deferred=%s", (deferred) => {
  it.each(["reader-failure", "empty"])("preserves %s at all three result layers", async (kind) => {
    const h = await fixture("sse");
    h.reply((body) => {
      if (kind === "empty") return h.respond(body, { content: [], structuredContent: null });
      queueMicrotask(() => h.failStream(new TypeError("GET body interrupted")));
      return new Response(null, { status: 202 });
    });
    const s = await sdk(engine(h, { deferred }));
    const out = await s.run();
    expectErrorAtEveryLayer(out, kind === "reader-failure");
    expect(h.calls).toHaveLength(1);
    if (kind === "reader-failure") expect(JSON.stringify(out.event.result)).toContain("GET body interrupted");
    else {
      expect(out.event.result.content).toEqual([]);
      expect(out.event.result.structuredContent).toBeNull();
    }
    // The legacy GET reader's connector-state policy is outside this change.
  });
});

describe.each(modes)("%s real SDK cancellation", (mode) => {
  describe.each([false, true])("deferred=%s", (deferred) => {
    it.each(["registry-success", "registry-error", "agent-success", "agent-error"])(
      "settles %s before a late reply and keeps another session alive", async (kind) => {
        const h = await fixture(mode);
        const blocked = gate<Response>();
        const body = heldBody();
        let request;
        h.reply((b) => {
          if (b.params.arguments.tag === "survivor") return h.respond(b, complete(mode, "survivor"));
          request = b;
          return mode === "sse" ? blocked.promise : body.response;
        });
        const e = engine(h, { deferred, sessionId: "cancel" });
        const other = engine(h, { deferred, sessionId: "survive" });
        const s = await sdk(e);
        const running = watch(s.run());
        let settled;
        running.then((value) => { settled = value; });
        let aborting;
        try {
          await until(() => h.calls.length === 1);
          if (mode !== "sse") await body.reading;
          if (kind.startsWith("registry")) e.registry.abortBySession({ sessionId: e.sessionId }, "fixture stop");
          else aborting = s.session.abort();
          await until(() => settled !== undefined, 500);
          expect(h.calls[0].init.signal.aborted).toBe(true);
          const out = s.outcome();
          expect(out.event.isError).toBe(true);
          expect(out.canonical.isError).toBe(true);
          if (kind.startsWith("registry")) expect(out.provider.isError).toBe(true);
          const survivorSignal = new AbortController().signal;
          const result = await other.tool.execute("survivor", other.args({ tag: "survivor" }), survivorSignal, undefined, { signal: survivorSignal });
          expect(result.content[0].text).toBe("survivor");
          expect(survivorSignal.aborted).toBe(false);
        } finally {
          if (mode === "sse") {
            if (kind.endsWith("error")) blocked.reject(new TypeError("late acknowledgement error"));
            else blocked.resolve(h.respond(request, complete(mode, "late result")));
          } else if (kind.endsWith("error")) body.controller.error(new TypeError("late body error"));
          else { body.controller.enqueue(encoder.encode(JSON.stringify(envelope(request.id, complete(mode))))); body.controller.close(); }
          await running;
          await aborting;
        }
        await delay();
        expect(h.calls).toHaveLength(2);
        expect(h.closes).toHaveLength(0);
        expect(h.manager.connectorStatusFor("remote")).toBe("running");
        expect(e.registry.activeCount("cancel")).toBe(0);
        expect(other.registry.activeCount("survive")).toBe(0);
        expect(h.client._pending?.size ?? 0).toBe(0);
        expect(h.client._queued?.size ?? 0).toBe(0);
        expect(getEventListeners(h.calls[0].init.signal, "abort")).toHaveLength(0);
      },
    );
  });
});

it.each(["permission-unavailable", "permission-denied", "unknown-target", "invalid-arguments"])(
  "blocks %s in the real engine before a remote call", async (kind) => {
    const h = await fixture("modern");
    const e = engine(h, { permission: kind.startsWith("permission") ? "auto" : "operate" });
    if (kind === "permission-denied") e.engine._approvalGateway = { review: async () => ({ action: "hard_deny", reason: "fixture policy deny", reasonCode: "fixture_denied" }) };
    if (kind === "unknown-target") e.args = () => ({ server: "remote", tool: "missing", arguments: {} });
    if (kind === "invalid-arguments") e.args = () => ({ server: "remote", tool: "remote_write", arguments: { tag: 55 } });
    const s = await sdk(e);
    const out = await s.run();
    expectErrorAtEveryLayer(out, kind !== "invalid-arguments"); // Existing local schema feedback remains text.
    if (kind === "permission-denied") expect(out.event.result.details.errorCode).toBe("TOOL_APPROVAL_DENIED");
    expect(h.calls).toHaveLength(0);
    expect(h.closes).toHaveLength(0);
  },
);

describe.each([false, true])("SDK execute-once deferred=%s", (deferred) => {
  it.each(["failure", "success"])("executes duplicate toolCallId once on %s", async (kind) => {
    const h = await fixture("modern");
    h.reply((body) => kind === "failure" ? truncated(JSON.stringify(envelope(body.id, complete("modern"))).slice(0, 30)) : h.respond(body, complete("modern")));
    const e = engine(h, { deferred });
    const s = await sdk(e);
    const active = s.session.agent.state.tools.find((tool) => tool.name === e.tool.name);
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([
      active.execute("same-id", e.args({}), signal), active.execute("same-id", e.args({}), signal),
    ]);
    expect(a).toBe(b);
    expect(a.isError === true).toBe(kind === "failure");
    expect(h.calls).toHaveLength(1);
    expect(e.registry.activeCount(e.sessionId)).toBe(0);
  });

  it("rethrows the caller TimeoutError without closing the connector", async () => {
    const h = await fixture("modern");
    const body = heldBody();
    h.reply(() => body.response);
    const e = engine(h, { deferred });
    const controller = new AbortController();
    const reason = new DOMException("caller deadline", "TimeoutError");
    const running = watch(e.tool.execute("timeout", e.args({}), controller.signal, undefined, {}));
    await body.reading;
    controller.abort(reason);
    expect((await running).error).toBe(reason);
    body.controller.error(new TypeError("late body failure"));
    await delay();
    expect(h.closes).toHaveLength(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(e.registry.activeCount(e.sessionId)).toBe(0);
  });
});

describe.each(modes)("%s deferred shared auth", (mode) => {
  describe.each(["pre-refresh", "401"])("%s", (phase) => {
    it.each(["success", "terminal"])("isolates registry cancellation from a %s refresh", async (kind) => {
      const h = await fixture(mode, { oauth: true });
      const token = gate<Response>();
      h.replyToken(() => token.promise);
      if (phase === "pre-refresh") h.expire();
      h.reply((body, init) => init.headers.Authorization === "Bearer fixture-old"
        ? truncated("unauthorized diagnostic", { status: 401 }) : h.respond(body, complete(mode, "survivor")));
      const first = engine(h, { sessionId: "cancel" });
      const second = engine(h, { sessionId: "survive" });
      const upstream = [new AbortController(), new AbortController()];
      const a = watch(first.tool.execute("cancel", first.args({ tag: "cancel" }), upstream[0].signal, undefined, { signal: upstream[0].signal }));
      const b = watch(second.tool.execute("survive", second.args({ tag: "survive" }), upstream[1].signal, undefined, { signal: upstream[1].signal }));
      try {
        await until(() => h.tokenRequests.length === 1 && (phase === "pre-refresh" || h.calls.length === 2));
        first.registry.abortBySession({ sessionId: "cancel" }, "fixture stop");
        expect((await a).error.name).toBe("AbortError");
        expect(h.tokenRequests[0].signal?.aborted).not.toBe(true);
        token.resolve(kind === "success" ? json({ access_token: "fixture-new", expires_in: 3600 })
          : json({ error: "invalid_grant", error_description: "fixture revoked" }, 400));
        const survivor = await b;
        expect(survivor.error).toBeUndefined();
        if (kind === "success") expect(survivor.value.content[0].text).toBe("survivor");
        else expect(survivor.value.isError).toBe(true);
        expect(h.manager.connectorStatusFor("remote")).toBe(kind === "success" ? "running" : "needs-auth");
        expect(h.tokenRequests).toHaveLength(1);
        expect(h.calls.filter(({ body }) => body.params.arguments.tag === "cancel")).toHaveLength(phase === "pre-refresh" ? 0 : 1);
        expect(h.calls.filter(({ body }) => body.params.arguments.tag === "survive")).toHaveLength((phase === "401" ? 1 : 0) + (kind === "success" ? 1 : 0));
      } finally { token.resolve(json({ access_token: "late", expires_in: 3600 })); await Promise.all([a, b]); }
      expect(first.registry.activeCount("cancel")).toBe(0);
      expect(second.registry.activeCount("survive")).toBe(0);
      expect(upstream[1].signal.aborted).toBe(false);
      for (const controller of upstream) expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });
  });
});
