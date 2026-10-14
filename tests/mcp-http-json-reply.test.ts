import { afterEach, describe, expect, it } from "vitest";
import { McpHttpError, McpStreamableHttpClient } from "../core/mcp/clients/http-client.ts";
import { complete, envelope, harness, httpModes, json, watch, type Mode } from "./fixtures/mcp-http-fixture.ts";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(mode: Mode) {
  const h = await harness(mode);
  cleanups.push(() => h.dispose());
  return h;
}

describe.each(httpModes)("%s JSON reply envelope", (mode) => {
  it.each([
    "missing-version", "wrong-version", "missing-id", "null-id", "object-id", "boolean-id", "fractional-id",
    "server-request", "method-with-result", "missing-result", "array", "zero", "false", "string",
    "both", "both-null", "error-null", "error-empty", "error-array", "error-string",
    "code-string", "code-fractional", "message-number", "message-missing",
  ])("rejects %s without replay or auth recovery", async (kind) => {
    const h = await fixture(mode);
    h.reply((body) => {
      const message: Record<string, unknown> = envelope(body.id, complete(mode));
      switch (kind) {
        case "missing-version": delete message.jsonrpc; break;
        case "wrong-version": message.jsonrpc = "1.0"; break;
        case "missing-id": delete message.id; break;
        case "null-id": message.id = null; break;
        case "object-id": message.id = {}; break;
        case "boolean-id": message.id = true; break;
        case "fractional-id": message.id = body.id + 0.5; break;
        case "server-request": delete message.result; message.method = "roots/list"; break;
        case "method-with-result": message.method = null; break;
        case "missing-result": delete message.result; break;
        case "array": return json([message]);
        case "zero": return json(0);
        case "false": return json(false);
        case "string": return json("not a response");
        default: {
          const error: { code?: unknown; message?: unknown } = { code: -32603, message: "server diagnostic" };
          if (kind === "code-string") error.code = "-32603";
          if (kind === "code-fractional") error.code = -32603.5;
          if (kind === "message-number") error.message = 3;
          if (kind === "message-missing") delete error.message;
          message.error = error;
          if (!kind.startsWith("both")) delete message.result;
          if (kind === "both-null" || kind === "error-null") message.error = null;
          if (kind === "error-empty") message.error = {};
          if (kind === "error-array") message.error = [];
          if (kind === "error-string") message.error = "server diagnostic";
        }
      }
      return json(message);
    });
    await expect(h.client.callTool("write", {})).rejects.toThrow("Invalid MCP JSON-RPC response");
    expect(h.calls).toHaveLength(1);
    expect(h.tokenRequests).toHaveLength(0);
    expect(h.closes).toEqual([expect.objectContaining({ expected: false, needsAuth: false })]);
    expect(h.manager.connectorStatusFor("remote")).toBe("stopped");
  });

  it.each([0, -1, "7", ""])("preserves a matching ID %j at the transport boundary", async (id) => {
    const h = await fixture(mode);
    expect(await h.client._postJsonRpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "write" } })).toEqual(complete(mode));
    expect(h.calls[0].body.id).toBe(id);
  });

  it.each([[7, "7"], ["7", 7], [0, "0"], [1.5, 1.5]])("rejects ID %j answered with %j", async (id, replyId) => {
    const h = await fixture(mode);
    h.reply(() => json(envelope(replyId, complete(mode))));
    await expect(h.client._postJsonRpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "write" } })).rejects.toThrow("Invalid MCP JSON-RPC response");
    expect(h.calls).toHaveLength(1);
  });

  // Result presence is an envelope rule; method-specific result schemas are separate.
  it.each([null, false, 0])("preserves a present result %j", async (result) => {
    const h = await fixture(mode);
    h.reply((body) => json(envelope(body.id, result)));
    expect(await h.client.callTool("write", {})).toBe(result);
    expect(h.closes).toHaveLength(0);
  });

  it.each(["matched", "null-id", "missing-id", "wrong-id"])("handles a valid error with %s", async (kind) => {
    const h = await fixture(mode);
    h.reply((body) => {
      const message: Record<string, unknown> = { jsonrpc: "2.0", id: body.id, error: { code: -32700, message: "synthetic parse diagnostic", data: null } };
      if (kind === "null-id") message.id = null;
      if (kind === "missing-id") delete message.id;
      if (kind === "wrong-id") message.id = body.id + 100;
      return json(message);
    });
    await expect(h.client.callTool("write", {})).rejects.toThrow(kind === "wrong-id" ? "Invalid MCP JSON-RPC response" : "synthetic parse diagnostic");
    expect(h.calls).toHaveLength(1);
    expect(h.closes).toEqual([expect.objectContaining({ needsAuth: false })]);
  });

  it.each([400, 401, 403, 404, 503])("retains HTTP %i diagnostics without requiring a response ID", async (status) => {
    const h = await fixture(mode);
    const message = { jsonrpc: "2.0", error: { code: -32600, message: "synthetic invalid request" } };
    h.reply(() => json(message, status, { "X-Diagnostic": "kept" }));
    const out = await watch(h.client._postJsonRpc({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "write" } }));
    expect(out.error).toBeInstanceOf(McpHttpError);
    expect(out.error.status).toBe(status);
    expect(out.error.headers.get("X-Diagnostic")).toBe("kept");
    expect(out.error.body).toBe(JSON.stringify(message));
    expect(h.calls).toHaveLength(1);
  });

  it.each(["bare-null", "wrong-id", "missing-result"])("preserves cached tools and publication after tools/list %s", async (kind) => {
    const h = await fixture(mode);
    const before = structuredClone(h.manager.getConfig().connectors[0].tools);
    const names = h.manager.getAllTools().map((tool) => tool.name);
    h.replyList((body) => json(kind === "bare-null" ? null : kind === "wrong-id"
      ? envelope(body.id + 100, { tools: [] }) : { jsonrpc: "2.0", id: body.id }));
    await expect(h.manager.refreshTools("remote")).rejects.toThrow("Invalid MCP JSON-RPC response");
    expect(h.manager.getConfig().connectors[0].tools).toEqual(before);
    expect(h.manager.getAllTools().map((tool) => tool.name)).toEqual(names);
  });
});

it.each(["bare-null", "wrong-id", "missing-result"])("rejects initialize %s before sending initialized", async (kind) => {
  const methods = [];
  const client = new McpStreamableHttpClient({ id: "init", url: "https://fixture.invalid", protocolVersion: "2025-11-25" }, {
    log: { ...console, debug() {} }, fetchImpl: async (_url, init) => {
      if (init.method === "DELETE") return new Response(null, { status: 202 });
      const body = JSON.parse(init.body);
      methods.push(body.method);
      return json(kind === "bare-null" ? null : kind === "wrong-id"
        ? envelope(body.id + 100, { protocolVersion: "2025-11-25", capabilities: {} }) : { jsonrpc: "2.0", id: body.id });
    },
  });
  cleanups.push(() => client.stop());
  await expect(client.start()).rejects.toThrow("Invalid MCP JSON-RPC response");
  expect(client.running).toBe(false);
  expect(methods).toEqual(["initialize"]);
});
