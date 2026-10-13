import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { McpHttpError, McpStreamableHttpClient } from "../core/mcp/clients/http-client.ts";
import {
  complete, delay, envelope, gate, harness, heldBody, httpModes, json, modes, packet,
  truncated, until, watch, type Mode,
} from "./fixtures/mcp-http-fixture.ts";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(mode: Mode, options = {}) {
  const h = await harness(mode, options);
  cleanups.push(() => h.dispose());
  return h;
}
const sse = (text: string) => new Response(text, { headers: { "Content-Type": "text/event-stream" } });

describe.each(httpModes)("%s successful HTTP body", (mode) => {
  it.each(["application/json", "text/event-stream"])("preserves the original %s I/O error without replay", async (contentType) => {
    const h = await fixture(mode, { autoReconnect: true });
    const error = new TypeError("body interrupted after the action executed");
    h.reply((body) => truncated(
      (contentType === "application/json" ? JSON.stringify(envelope(body.id, complete(mode))) : packet(body.id, complete(mode))).slice(0, 30),
      { contentType, error },
    ));
    await expect(h.client.callTool("write", {})).rejects.toBe(error);
    expect(h.calls).toHaveLength(1);
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0].needsAuth).toBe(false);
    expect(h.manager.clientErrors.get("remote")).toBe(error.message);
    expect(h.client.running).toBe(false);
    await h.manager.startConnector("remote");
    expect(h.manager.clients.get("remote").running).toBe(true);
    expect(h.calls).toHaveLength(1); // Reconnect only establishes the client and lists tools.
  });

  it.each(["text", "json"])("uses native Response.%s rejection as a control", async (method) => {
    const error = new TypeError("native body interrupted");
    const response = truncated('{"jsonrpc":"2.0",', { error });
    await expect(response[method]()).rejects.toBe(error);
  });

  const compatible = [
    "normal", "content-empty", "structured-null", "rpc-null", "bare-null",
    "empty-200", "empty-202", "empty-204", "json-wrong-id", "json-notification",
    "sse-normal", "sse-heartbeat-result", "sse-wrong-id-result",
  ];
  it.each(compatible)("keeps existing successful-read behavior: %s", async (kind) => {
    const h = await fixture(mode);
    const result = complete(mode);
    h.reply((body) => {
      if (kind === "content-empty") return h.respond(body, { ...result, content: [] });
      if (kind === "structured-null") return h.respond(body, { ...result, structuredContent: null });
      if (kind === "rpc-null") return h.respond(body, null);
      if (kind === "bare-null") return json(null);
      if (kind.startsWith("empty-")) return new Response(null, { status: Number(kind.slice(6)) });
      if (kind === "json-wrong-id") return json(envelope(body.id + 100, result));
      if (kind === "json-notification") return json({ jsonrpc: "2.0", method: "notifications/message" });
      if (kind.startsWith("sse-")) return sse(
        (kind === "sse-heartbeat-result" ? ": ping\n\ndata: \n\n" : "")
        + (kind === "sse-wrong-id-result" ? packet(body.id + 1, complete(mode, "unrelated")) : "")
        + packet(body.id, result),
      );
      return h.respond(body, result);
    });
    const value = await h.client.callTool("write", {});
    // The empty/mismatched JSON envelope cases are pre-existing permissiveness,
    // not valid MCP tool results. This patch must not change protocol validation.
    if (["rpc-null", "bare-null"].includes(kind) || kind.startsWith("empty-")) expect(value).toBeNull();
    else if (kind === "json-notification") expect(value).toBeUndefined();
    else if (kind === "content-empty") expect(value.content).toEqual([]);
    else if (kind === "structured-null") expect(value.structuredContent).toBeNull();
    else expect(value).toEqual(result);
    expect(h.closes).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
  });

  it.each(["json-malformed", "sse-malformed", "rpc-error", "sse-no-match", "sse-heartbeat-only", "fetch-rejects"])(
    "keeps explicit failure for %s", async (kind) => {
      const h = await fixture(mode);
      const error = new TypeError("fetch interrupted");
      h.reply((body) => {
        if (kind === "fetch-rejects") throw error;
        if (kind === "json-malformed") return new Response('{"jsonrpc":');
        if (kind === "sse-malformed") return sse("data: {broken\n\n");
        if (kind === "sse-no-match") return sse(packet(body.id + 1, complete(mode)));
        if (kind === "sse-heartbeat-only") return sse(": ping\n\n");
        return json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "RPC failed" } });
      });
      const out = await watch(h.client.callTool("write", {}));
      expect(out.error).toBeInstanceOf(Error);
      if (kind === "fetch-rejects") expect(out.error).toBe(error);
      if (kind.endsWith("malformed")) expect(out.error).toBeInstanceOf(SyntaxError);
      if (kind === "rpc-error") expect(out.error.message).toContain("RPC failed");
      if (kind === "sse-no-match" || kind === "sse-heartbeat-only") expect(out.error.message).toContain("not found in SSE");
      expect(h.calls).toHaveLength(1);
      expect(h.closes).toHaveLength(1);
      expect(h.closes[0].needsAuth).toBe(false);
    },
  );

  it("preserves source AbortError identity and the connection", async () => {
    const h = await fixture(mode);
    const error = new DOMException("source cancelled", "AbortError");
    h.reply((body) => truncated(JSON.stringify(envelope(body.id, complete(mode))).slice(0, 30), { error }));
    await expect(h.client.callTool("write", {})).rejects.toBe(error);
    expect(h.closes).toHaveLength(0);
    expect(h.client.running).toBe(true);
  });

  it("preserves a structured tool error without closing the connector", async () => {
    const h = await fixture(mode);
    const result = { ...complete(mode, "business rejected"), isError: true, structuredContent: { rejected: true } };
    h.reply((body) => h.respond(body, result));
    expect(await h.client.callTool("write", {})).toEqual(result);
    expect(h.closes).toHaveLength(0);
  });

  it.each([400, 401, 403, 404, 503])("preserves HTTP %i and headers when its diagnostic body fails", async (status) => {
    const h = await fixture(mode);
    h.reply((body) => h.calls.length > 1 ? h.respond(body, complete(mode)) : (() => {
      const response = truncated("diagnostic prefix", { status });
      response.headers.set("X-Fixture", "kept");
      return response;
    })());
    const out = await watch(h.client.callTool("write", {}));
    if (mode === "legacy" && status === 404) {
      expect(out.error).toBeUndefined();
      expect(h.calls).toHaveLength(2); // Existing bounded session recovery.
    } else {
      expect(out.error).toBeInstanceOf(McpHttpError);
      expect(out.error.status).toBe(status);
      expect(out.error.headers.get("X-Fixture")).toBe("kept");
      expect(h.calls).toHaveLength(1);
    }
    expect(h.manager.connectorStatusFor("remote") === "needs-auth").toBe(status === 401 || status === 403);
  });

  it("keeps cached tools and publication when tools/list cannot be read", async () => {
    const h = await fixture(mode);
    const before = structuredClone(h.manager.getConfig().connectors[0].tools);
    const names = h.manager.getAllTools().map((tool) => tool.name);
    const error = new TypeError("list body interrupted");
    h.replyList((body) => truncated(JSON.stringify(envelope(body.id, { tools: before })).slice(0, 30), { error }));
    await expect(h.manager.refreshTools("remote")).rejects.toBe(error);
    expect(h.manager.getConfig().connectors[0].tools).toEqual(before);
    expect(h.manager.getAllTools().map((tool) => tool.name)).toEqual(names);
  });

  it.each(["resource", "app-tool"])("propagates %s read failure to the manager caller", async (kind) => {
    const h = await fixture(mode);
    const error = new TypeError("app response body interrupted");
    const reply = (body) => truncated(JSON.stringify(envelope(body.id, complete(mode))).slice(0, 30), { error });
    h.reply(reply);
    h.replyResource(reply);
    await expect(kind === "resource" ? h.manager.readResource("remote", "ui://fixture")
      : h.manager.callAppTool("remote", "write", {})).rejects.toBe(error);
    expect(h.all.filter(({ body }) => body.method === (kind === "resource" ? "resources/read" : "tools/call"))).toHaveLength(1);
  });

  it.each(["failure-first", "success-first"])("does not replay or abort an independent sibling: %s", async (order) => {
    const h = await fixture(mode);
    const fail = gate(), success = gate();
    cleanups.push(() => { fail.resolve(); success.resolve(); });
    h.reply(async (body) => {
      const bad = body.params.arguments.tag === "fail";
      await (bad ? fail : success).promise;
      return bad ? truncated(JSON.stringify(envelope(body.id, complete(mode))).slice(0, 30))
        : h.respond(body, complete(mode, "survivor"));
    });
    const a = watch(h.run(undefined, { tag: "fail" }));
    const b = watch(h.run(undefined, { tag: "success" }));
    await until(() => h.calls.length === 2);
    if (order === "failure-first") {
      fail.resolve(); await a;
      expect(h.calls[1].init.signal.aborted).toBe(false);
      success.resolve();
    } else { success.resolve(); await b; fail.resolve(); }
    expect((await a).value.isError).toBe(true);
    expect((await b).value.content[0].text).toBe("survivor");
    expect(h.calls).toHaveLength(2);
    expect(h.closes).toHaveLength(1);
  });

  it.each(["late-old-client", "double-failure"])("isolates connector lifecycle: %s", async (kind) => {
    const h = await fixture(mode);
    const blocked = gate();
    cleanups.push(() => blocked.resolve());
    h.reply(async (body) => { await blocked.promise; return truncated(JSON.stringify(envelope(body.id, complete(mode))).slice(0, 30)); });
    const a = watch(h.run());
    const b = kind === "double-failure" ? watch(h.run()) : null;
    await until(() => h.calls.length === (b ? 2 : 1));
    let current;
    if (!b) {
      await h.manager.stopConnector("remote");
      await h.manager.startConnector("remote");
      current = h.manager.clients.get("remote");
      expect(current).not.toBe(h.client);
    }
    blocked.resolve();
    expect((await a).value.isError).toBe(true);
    if (b) expect((await b).value.isError).toBe(true);
    await delay();
    expect(h.closes).toHaveLength(b ? 1 : 0);
    if (current) {
      expect(current.running).toBe(true);
      expect(h.manager.clients.get("remote")).toBe(current);
    }
  });

  it("gives caller cancellation priority over a pending non-2xx diagnostic", async () => {
    const h = await fixture(mode);
    const body = heldBody();
    const response = new Response(body.response.body, { status: 401 });
    h.reply(() => response);
    const controller = new AbortController();
    const running = watch(h.client.callTool("write", {}, { signal: controller.signal }));
    await body.reading;
    controller.abort();
    expect((await running).error).toBe(controller.signal.reason);
    body.controller.error(new TypeError("late diagnostic error"));
    await delay();
    expect(h.closes).toHaveLength(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("bounds a stalled body by the existing request deadline without replay", async () => {
    const h = await fixture(mode);
    const body = heldBody();
    h.client.server.timeout = 0.05;
    h.reply(() => body.response);
    const out = await watch(h.client.callTool("write", {}));
    expect(out.error?.name).toBe("TimeoutError");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].init.signal.aborted).toBe(true);
    body.controller.error(new TypeError("late body failure"));
    await delay();
    expect(h.closes).toHaveLength(0); // Existing request-deadline cancellation policy.
    expect(h.client.running).toBe(true);
    expect(getEventListeners(h.calls[0].init.signal, "abort")).toHaveLength(0);
  });
});

it("rejects failed initialization before sending initialized or becoming running", async () => {
  const methods = [];
  const error = new TypeError("initialize body interrupted");
  const client = new McpStreamableHttpClient({ id: "init", url: "https://fixture.invalid", protocolVersion: "2025-11-25" }, {
    log: { ...console, debug() {} }, fetchImpl: async (_url, init) => {
      if (init.method === "DELETE") return new Response(null, { status: 202 });
      const body = JSON.parse(init.body);
      methods.push(body.method);
      return truncated(JSON.stringify(envelope(body.id, { protocolVersion: "2025-11-25", capabilities: {} })).slice(0, 30), { error });
    },
  });
  cleanups.push(() => client.stop());
  await expect(client.start()).rejects.toBe(error);
  expect(client.running).toBe(false);
  expect(methods).toEqual(["initialize"]);
});

describe.each(modes)("%s notification", (mode) => {
  it.each([200, 202, 204])("accepts a no-id %i acknowledgement without reading a result body", async (status) => {
    const h = await fixture(mode);
    let response: Response;
    h.replyNotify(() => (response = status === 204 ? new Response(null, { status }) : truncated("unread ack", { status })));
    await (mode === "sse" ? h.client.notify("notifications/initialized", {}) : h.client._notify("notifications/initialized", {}));
    expect(response.bodyUsed).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.closes).toHaveLength(0);
  });
});

describe("legacy SSE acknowledgements and GET results", () => {
  it.each(["heartbeat", "wrong-id", "malformed", "duplicate", "post-204", "post-200-body-error", "reader-error", "eof", "post-503", "no-match"])(
    "keeps existing %s semantics", async (kind) => {
      const h = await fixture("sse");
      const error = new TypeError("GET body interrupted");
      h.reply((body) => {
        if (kind === "reader-error") { queueMicrotask(() => h.failStream(error)); return new Response(null, { status: 202 }); }
        if (kind === "eof") { queueMicrotask(() => h.closeStream()); return new Response(null, { status: 202 }); }
        if (kind === "post-503") return truncated("unread diagnostic", { status: 503 });
        queueMicrotask(() => {
          if (kind === "heartbeat") h.sendRaw(": ping\n\ndata: \n\n");
          if (kind === "wrong-id" || kind === "no-match") h.send(envelope(body.id + 100, complete("sse", "wrong")));
          if (kind === "malformed") h.sendRaw("data: {bad\n\n");
          if (kind !== "no-match") h.send(envelope(body.id, complete("sse")));
          if (kind === "duplicate") h.send(envelope(body.id, complete("sse", "late")));
        });
        return kind === "post-200-body-error" ? truncated("ignored acknowledgement")
          : new Response(null, { status: kind === "post-204" ? 204 : 202 });
      });
      const out = await watch(h.client.request("tools/call", { name: "write", arguments: {} }, { timeout: 100 }));
      if (["reader-error", "eof", "post-503", "no-match"].includes(kind)) {
        expect(out.error).toBeInstanceOf(Error);
        if (kind === "reader-error") expect(out.error).toBe(error);
        if (kind === "post-503") expect(out.error.status).toBe(503);
      } else expect(out.value).toEqual(complete("sse"));
      expect(h.calls).toHaveLength(1);
      expect(h.client._pending.size).toBe(0);
      // Future ids are kept in the existing early-response queue. Settled ids
      // (the duplicate case) are discarded. Do not change this parser policy.
      expect(h.client._queued.size).toBe(kind === "wrong-id" || kind === "no-match" ? 1 : 0);
    },
  );
});

describe.each(modes)("%s published successful results", (mode) => {
  it.each(["normal", "content-empty", "rpc-null"])("preserves %s", async (kind) => {
    const h = await fixture(mode);
    const result = kind === "rpc-null" ? null : { ...complete(mode), ...(kind === "content-empty" ? { content: [] } : {}) };
    h.reply((body) => h.respond(body, result));
    const value = await h.run();
    expect(value.isError === true).toBe(false);
    if (kind === "rpc-null") expect(value.content).toEqual([{ type: "text", text: "null" }]);
    else expect(value).toEqual(result);
    expect(h.calls).toHaveLength(1);
    expect(h.closes).toHaveLength(0);
  });
});
