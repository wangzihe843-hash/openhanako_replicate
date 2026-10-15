import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { SessionExecutionRegistry, wrapWithSessionExecutionCancellation } from "../lib/session-execution-registry.ts";
import { wrapWithSessionPermission } from "../lib/tools/session-permission-wrapper.ts";
import { PluginManager } from "../core/plugin-manager.ts";
import { McpManager } from "../core/mcp/manager.ts";

function fixture() {
  const cwd = path.resolve("/tmp/ctx-fixture");
  const sessionPath = path.join(cwd, "session.jsonl");
  const signal = new AbortController().signal;
  const runtime = createExtensionRuntime();
  const runner = new ExtensionRunner([], runtime, cwd, SessionManager.inMemory(cwd), null);
  const model = vi.fn(() => ({ id: "initial" }));
  const tools = vi.fn(() => [{ name: "child" }]);
  const nested = vi.fn(async (parent, name, args, options) => ({ parent, name, args, options }));
  runner.bindCore({ getThinkingLevel: () => "off" } as Parameters<ExtensionRunner["bindCore"]>[0], {
    getModel: model, getScopedModels: () => [], getCallableTools: tools,
    getSignal: () => signal, executeTool: nested,
  } as unknown as Parameters<ExtensionRunner["bindCore"]>[1]);
  const ctx = runner.createToolContext("parent", signal);
  const manager = { getSessionId: () => "native-id", getSessionFile: () => sessionPath, getCwd: () => cwd };
  Object.defineProperties(ctx, {
    sessionId: { value: "session-id" },
    sessionPath: { value: sessionPath },
    sessionManager: { get: () => manager, configurable: false },
  });
  const symbol = Symbol("context-marker");
  Object.defineProperty(ctx, symbol, { value: "marker" });
  return { ctx, signal, runner, tools, model, nested, symbol, manager, sessionPath };
}

function permission(tool) {
  return wrapWithSessionPermission([tool], {
    getPermissionMode: () => "operate", getSessionIdForPath: () => "session-id",
  })[0];
}

describe("tool runtime context descriptors", () => {
  it.each(["pi", "legacy"])("retains SDK closures and lazy getters across repeated wrappers (%s)", async style => {
    const f = fixture();
    const registry = new SessionExecutionRegistry();
    let received;
    const inner = permission({ name: "read", execute: async (...args) => { received = args[4] || args[2]; } });
    const tool = wrapWithSessionExecutionCancellation([permission(inner)], { registry })[0];
    if (style === "pi") await tool.execute("parent", {}, f.signal, undefined, f.ctx);
    else await tool.execute("parent", {}, f.ctx);

    expect(f.tools).not.toHaveBeenCalled();
    expect(f.model).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(received, "executeTool"))
      .toEqual(Object.getOwnPropertyDescriptor(f.ctx, "executeTool"));
    expect(received[f.symbol]).toBe("marker");
    expect(received.sessionId).toBe("session-id");
    expect(received.sessionPath).toBe(f.sessionPath);
    expect(received.sessionManager).not.toBe(f.manager);
    expect(received.sessionManager.getSessionId()).toBe("native-id");
    for (const key of ["sessionId", "sessionPath", "sessionManager"]) {
      expect(Object.getOwnPropertyDescriptor(received, key)).toMatchObject({ writable: false, configurable: false });
    }
    f.tools.mockReturnValue([{ name: "changed-child" }]);
    f.model.mockReturnValue({ id: "changed" });
    expect(received.tools).toEqual([{ name: "changed-child" }]);
    expect(received.model.id).toBe("changed");
    await received.executeTool("child", { value: 1 });
    expect(f.nested).toHaveBeenCalledExactlyOnceWith("parent", "child", { value: 1 }, { signal: f.signal });
    const override = new AbortController().signal;
    await received.executeTool("child", {}, { signal: override });
    expect(f.nested).toHaveBeenLastCalledWith("parent", "child", {}, { signal: override });
    expect(registry.activeCount("session-id")).toBe(0);
    f.runner.invalidate("stale fixture runner");
    expect(() => received.tools).toThrow("stale fixture runner");
    expect(() => received.model).toThrow("stale fixture runner");
    await expect(received.executeTool("child", {})).rejects.toThrow("stale fixture runner");
    expect(f.nested).toHaveBeenCalledTimes(2);
  });

  it.each([3, 5])("preserves descriptors in dynamic pi_tool plugins with %i arguments", async arity => {
    const f = fixture();
    let received;
    const execute = arity === 5
      ? async (_id, _args, _signal, _update, ctx) => { received = ctx; return "ok"; }
      : async (_id, _args, ctx) => { received = ctx; return "ok"; };
    const manager = new PluginManager({ pluginsDir: "/unused", dataDir: "/unused" } as ConstructorParameters<typeof PluginManager>[0]);
    const remove = manager.addTool("fixture", { name: "parent", invocationStyle: "pi_tool", execute });
    try {
      const tool = manager.getAllTools()[0];
      if (arity === 3) await tool.execute("parent", {}, f.ctx);
      else await tool.execute("parent", {}, f.signal, undefined, f.ctx);
      expect(f.model).not.toHaveBeenCalled();
      expect(f.tools).not.toHaveBeenCalled();
      expect(received.executeTool).toBe(f.ctx.executeTool);
      expect(Object.getOwnPropertyDescriptor(received, "tools"))
        .toEqual(Object.getOwnPropertyDescriptor(f.ctx, "tools"));
      await received.executeTool("child", {});
      expect(f.nested).toHaveBeenCalledExactlyOnceWith("parent", "child", {}, { signal: f.signal });
    } finally { remove(); }
  });

  it.each(["pi", "legacy"])("keeps MCP context descriptors when injecting the effective signal (%s)", async style => {
    const f = fixture();
    const controller = new AbortController();
    let received;
    const execute = vi.fn(async (_id, _args, ctx) => { received = ctx; return { content: [{ type: "text", text: "ok" }] }; });
    const tool = McpManager.prototype._publishTool.call({}, { name: "fixture", execute });
    if (style === "pi") await tool.execute("parent", {}, controller.signal, undefined, f.ctx);
    else await tool.execute("parent", {}, f.ctx);
    expect(received.signal).toBe(style === "pi" ? controller.signal : f.signal);
    expect(f.tools).not.toHaveBeenCalled();
    expect(f.model).not.toHaveBeenCalled();
    expect(received.executeTool).toBe(f.ctx.executeTool);
    expect(Object.getOwnPropertyDescriptor(received, "tools"))
      .toEqual(Object.getOwnPropertyDescriptor(f.ctx, "tools"));
    controller.abort();
    await expect(tool.execute("aborted", {}, controller.signal, undefined, f.ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
