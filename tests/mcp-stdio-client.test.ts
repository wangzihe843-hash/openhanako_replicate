import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  McpStdioClient,
  resolveMcpStdioSpawnSpec,
} from "../core/mcp/clients/stdio-client.ts";
import { McpManager } from "../core/mcp/manager.ts";

class FakeProcess extends EventEmitter {
  declare exitCode: any;
  declare kill: any;
  declare stderr: any;
  declare stdin: any;
  declare stdout: any;
  constructor() {
    super();
    this.exitCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = {
      // A well-behaved MCP server exits when its stdin reaches EOF.
      end: vi.fn(() => {
        if (this.exitCode == null) {
          this.exitCode = 0;
          queueMicrotask(() => this.emit("exit", 0, null));
        }
      }),
      write: vi.fn((line) => {
        const message = JSON.parse(String(line));
        if (message.id == null) return true;
        queueMicrotask(() => {
          this.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-11-25", capabilities: {} },
          })}\n`);
        });
        return true;
      }),
    };
    this.kill = vi.fn(() => {
      this.exitCode = 0;
      this.emit("exit", 0);
    });
  }
}

describe("MCP stdio client", () => {
  it("cancels one published tool request without stopping the shared stdio connector", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);
    const writes = [];
    const reply = (id, result) => proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    proc.stdin.write.mockImplementation((line) => {
      const message = JSON.parse(line);
      writes.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => reply(message.id, { protocolVersion: "2025-11-25", capabilities: {} }));
      } else if (message.method === "tools/list") {
        queueMicrotask(() => reply(message.id, { tools: [{ name: "write" }] }));
      }
      return true;
    });
    let stored = {
      enabled: true,
      connectors: [{ id: "local", command: "fixture-mcp", tools: [{ name: "write" }] }],
    };
    const manager = new McpManager({ dataDir: "/unused-mcp-fixture", log: console }, {
      configStore: { get: () => stored, set: (_key, value) => { stored = value; } },
      fetchImpl: vi.fn(async () => { throw new Error("Unexpected network access"); }),
    });
    manager._bus = { request: async () => ({ config: {
      mcp: { connectors: { local: { enabled: true, tools: { write: true } } } },
    } }) };
    await manager.startConnector("local");
    const tool = manager.getAllTools().find((entry) => entry.name === "mcp_local_write");
    const controller = new AbortController();
    const ctx = Object.freeze({ agentId: "fixture-agent" });
    try {
      const cancelled = tool.execute("cancelled", { caller: "cancelled" }, controller.signal, undefined, ctx)
        .then(() => null, (err) => err);
      const survivor = tool.execute("survivor", { caller: "survivor" }, undefined, undefined, ctx);
      await vi.waitFor(() => expect(writes.filter((entry) => entry.method === "tools/call")).toHaveLength(2));
      const calls = writes.filter((entry) => entry.method === "tools/call");
      const cancelledId = calls.find((entry) => entry.params.arguments.caller === "cancelled").id;
      const survivorId = calls.find((entry) => entry.params.arguments.caller === "survivor").id;
      controller.abort();
      expect(await cancelled).toMatchObject({ name: "AbortError" });
      expect(writes.filter((entry) => entry.method === "notifications/cancelled")).toEqual([{
        jsonrpc: "2.0", method: "notifications/cancelled",
        params: { requestId: cancelledId, reason: "Request cancelled" },
      }]);
      expect(manager.clients.get("local")._pending.size).toBe(1);
      reply(cancelledId, { content: [{ type: "text", text: "late" }] });
      expect(manager.clients.get("local")._pending.size).toBe(1);
      reply(survivorId, { content: [{ type: "text", text: "ok" }] });
      expect((await survivor).content[0].text).toBe("ok");
      expect(manager.clients.get("local")._pending.size).toBe(0);
      expect(manager.clients.get("local").running).toBe(true);
      expect(manager.reconnectState.size).toBe(0);
      expect(proc.stdin.end).not.toHaveBeenCalled();
      expect(proc.kill).not.toHaveBeenCalled();
      expect(ctx).not.toHaveProperty("signal");
    } finally {
      await manager.dispose();
    }
  });

  it("never sends an already-aborted request or a cancellation for initialize", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);
    const client = new McpStdioClient({ id: "local", command: "fixture-mcp" });
    await client.start();
    try {
      const controller = new AbortController();
      controller.abort();
      proc.stdin.write.mockClear();
      await expect(client.callTool("write", {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(proc.stdin.write).not.toHaveBeenCalled();
      expect(client._pending.size).toBe(0);
      const initializing = new AbortController();
      proc.stdin.write.mockImplementation(() => true);
      const pending = client.request("initialize", {}, { signal: initializing.signal }).catch((err) => err);
      initializing.abort();
      expect(await pending).toMatchObject({ name: "AbortError" });
      expect(proc.stdin.write).toHaveBeenCalledTimes(1);
      expect(client._pending.size).toBe(0);
    } finally {
      await client.stop();
    }
  });

  it("cleans up the request when a stdio write throws", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);
    const client = new McpStdioClient({ id: "local", command: "fixture-mcp" });
    await client.start();
    try {
      proc.stdin.write.mockImplementation(() => { throw new Error("broken pipe"); });
      const controller = new AbortController();
      await expect(client.callTool("write", {}, { signal: controller.signal })).rejects.toThrow("broken pipe");
      expect(client._pending.size).toBe(0);
      controller.abort();
      expect(proc.stdin.write).toHaveBeenCalledTimes(3); // initialize, initialized, failed call
    } finally {
      await client.stop();
    }
  });

  it("passes connector env and registry settings to spawned stdio servers", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const proc = new FakeProcess();
      spawnMock.mockReturnValueOnce(proc);

      const client = new McpStdioClient({
        id: "local",
        command: "npx",
        args: ["-y", "mcp-server-example"],
        env: { API_KEY: "secret" },
        registryUrl: "https://registry.npmmirror.com",
      }, { log: console });

      await client.start();

      expect(spawnMock).toHaveBeenCalledWith(
        "npx",
        ["-y", "mcp-server-example"],
        expect.objectContaining({
          env: expect.objectContaining({
            API_KEY: "secret",
            NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com",
          }),
          windowsHide: true,
        }),
      );

      await client.stop();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("fires onClose with expected=false when the child exits unexpectedly", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);
    const onClose = vi.fn();

    const client = new McpStdioClient({
      id: "local",
      command: "npx",
      args: ["-y", "mcp-server-example"],
    }, { log: console, onClose });

    await client.start();
    expect(client.running).toBe(true);

    // Child dies on its own (crash / killed by OS), not via stop().
    proc.exitCode = 1;
    proc.emit("exit", 1, null);

    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false }));
  });

  it("answers an inbound stdio server request with method-not-found instead of dropping it", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);

    const client = new McpStdioClient({
      id: "local",
      command: "npx",
      args: ["-y", "mcp-server-example"],
    }, { log: console });

    await client.start();
    proc.stdin.write.mockClear();

    // The server asks us something we do not implement. Silently swallowing it
    // leaves the server blocked on a reply that never comes.
    proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "elicitation/create", params: {} })}\n`);
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalled());

    expect(JSON.parse(String(proc.stdin.write.mock.calls[0][0]))).toEqual({
      jsonrpc: "2.0",
      id: 99,
      error: { code: -32601, message: "Method not found: elicitation/create" },
    });

    await client.stop();
  });

  it("does not report an unexpected close when stop() terminates the child", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc);
    const onClose = vi.fn();

    const client = new McpStdioClient({
      id: "local",
      command: "npx",
      args: ["-y", "mcp-server-example"],
    }, { log: console, onClose });

    await client.start();
    await client.stop();

    // A deliberate stop must never be reported as an unexpected disconnect.
    const unexpectedCalls = onClose.mock.calls.filter(([info]) => info && info.expected === false);
    expect(unexpectedCalls).toHaveLength(0);
  });

  it("escalates SIGTERM to SIGKILL when a child ignores graceful shutdown", async () => {
    vi.useFakeTimers();
    try {
      const proc = new FakeProcess();
      // A stubborn child ignores stdin EOF, forcing the kill escalation path.
      proc.stdin.end = vi.fn();
      // Override kill so SIGTERM is ignored; only SIGKILL actually exits.
      proc.kill = vi.fn((signal) => {
        if (signal === "SIGKILL") {
          proc.exitCode = 0;
          proc.emit("exit", null, "SIGKILL");
        }
        return true;
      });
      spawnMock.mockReturnValueOnce(proc);

      const client = new McpStdioClient({
        id: "stubborn",
        command: "npx",
        args: [],
      }, { log: console });

      await client.start();
      const stopPromise = client.stop();

      // After the graceful window, SIGTERM is sent; child still alive.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      // After the force window, SIGKILL is sent and the child finally exits.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      await stopPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps Windows .cmd shims with cmd.exe while preserving registry env", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "pdf",
      command: "npx.cmd",
      args: ["-y", "@sylphx/pdf-reader-mcp"],
      registryUrl: "https://registry.npmmirror.com",
    }, {
      platform: "win32",
      baseEnv: {
        PATH: "C:\\nodejs",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      existsSync: (candidate) => candidate === "C:\\nodejs\\npx.cmd",
    });

    expect(spec.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(spec.args).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\nodejs\\npx.cmd -y @sylphx/pdf-reader-mcp",
    ]);
    expect(spec.env.NPM_CONFIG_REGISTRY).toBe("https://registry.npmmirror.com");
  });

  it("wraps bare Windows commands so PATHEXT shims can be resolved by cmd.exe", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "local",
      command: "pdf-reader-mcp",
      args: ["--stdio"],
    }, {
      platform: "win32",
      baseEnv: { PATH: "C:\\tools", ComSpec: "cmd.exe" },
      existsSync: () => false,
    });

    expect(spec.command).toBe("cmd.exe");
    expect(spec.args).toEqual(["/d", "/s", "/c", "pdf-reader-mcp --stdio"]);
  });

  it("keeps Windows .exe commands on direct spawn", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "node",
      command: "node.exe",
      args: ["server.js"],
    }, {
      platform: "win32",
      baseEnv: { PATH: "C:\\nodejs", PATHEXT: ".EXE;.CMD" },
      existsSync: (candidate) => candidate === "C:\\nodejs\\node.exe",
    });

    expect(spec.command).toBe("C:\\nodejs\\node.exe");
    expect(spec.args).toEqual(["server.js"]);
  });

  it("quotes spaced Windows shim paths in the cmd.exe command line", () => {
    const spec = resolveMcpStdioSpawnSpec({
      id: "spaced",
      command: "C:\\Program Files\\nodejs\\npx.cmd",
      args: ["-y", "package with spaces"],
    }, {
      platform: "win32",
      baseEnv: { ComSpec: "cmd.exe" },
      existsSync: () => true,
    });

    expect(spec.args).toEqual([
      "/d",
      "/s",
      "/c",
      "\"C:\\Program Files\\nodejs\\npx.cmd\" -y \"package with spaces\"",
    ]);
  });
});
