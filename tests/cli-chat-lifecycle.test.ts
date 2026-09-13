import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import readline from "readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startChat } from "../cli/chat.ts";

class Socket extends EventEmitter {
  readyState = 0;
  sent: any[] = [];
  send = vi.fn((data: string, callback?: (err?: Error) => void) => {
    if (this.readyState !== 1) throw new Error("WebSocket is not open: CONNECTING");
    this.sent.push(JSON.parse(data));
    callback?.();
  });
  open() { this.readyState = 1; this.emit("open"); }
  close() { this.readyState = 3; this.emit("close"); }
  endTurn() { this.emit("message", JSON.stringify({ type: "turn_end", sessionId: "a", sessionPath: "/a" })); }
}

describe("CLI chat input and connection lifecycle", () => {
  let input: PassThrough;
  let rl: readline.Interface;
  let ws: Socket;
  let client: any;
  let exit: any;
  beforeEach(() => {
    input = new PassThrough();
    const create = readline.createInterface;
    vi.spyOn(readline, "createInterface").mockImplementation(() => {
      rl = create({ input, output: new PassThrough(), terminal: false });
      return rl;
    });
    vi.spyOn(readline, "emitKeypressEvents").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const flushWrite = (...args: any[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") callback();
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(flushWrite);
    vi.spyOn(process.stderr, "write").mockImplementation(flushWrite);
    exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    ws = new Socket();
    client = {
      health: async () => ({}), agents: async () => ({ agents: [] }),
      sessions: async () => [{ sessionId: "a", path: "/a" }], switchSession: async () => {},
      newSession: async () => ({ sessionId: "b", path: "/b" }), createWebSocket: () => ws,
    };
  });
  afterEach(() => {
    // Exit remains mocked while lifecycle cleanup releases timers/listeners.
    ws.close();
    ws.removeAllListeners();
    rl?.removeAllListeners();
    rl?.close();
    input.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("B08 retains early piped lines in order until open and each turn completes, then exits at EOF", async () => {
    await startChat(client, { baseUrl: "mock://local" }, { plain: true });
    input.end("first\nsecond\nthird\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(ws.send).not.toHaveBeenCalled();
    ws.open();
    await vi.waitFor(() => expect(ws.sent.map((m) => m.text)).toEqual(["first"]));
    ws.endTurn();
    await vi.waitFor(() => expect(ws.sent.map((m) => m.text)).toEqual(["first", "second"]));
    ws.endTurn();
    await vi.waitFor(() => expect(ws.sent.map((m) => m.text)).toEqual(["first", "second", "third"]));
    ws.endTurn();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("B08 flushes a large response before exiting a real piped subprocess", () => {
    const moduleUrl = new URL("../cli/chat.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { EventEmitter } from 'node:events';
      import { startChat } from ${JSON.stringify(moduleUrl)};
      class Socket extends EventEmitter {
        send(data, callback) {
          callback?.();
          setImmediate(() => {
            this.emit('message', JSON.stringify({ type: 'text_delta', sessionId: 'a', sessionPath: '/a', streamId: 's', delta: 'ANSWER_START' + 'x'.repeat(512 * 1024) + 'ANSWER_END' }));
            this.emit('message', JSON.stringify({ type: 'turn_end', sessionId: 'a', sessionPath: '/a', streamId: 's' }));
          });
        }
        close() { this.emit('close'); }
      }
      const ws = new Socket();
      const client = { health: async () => ({}), agents: async () => ({ agents: [] }), sessions: async () => [{ sessionId: 'a', path: '/a' }], switchSession: async () => {}, createWebSocket: () => ws };
      await startChat(client, { baseUrl: 'mock://local' }, { plain: true });
      setTimeout(() => ws.emit('open'), 30);
    `], { input: "hello\n", encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: process.env });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ANSWER_START${"x".repeat(512 * 1024)}ANSWER_END`);
  });

  it("B08 fails and releases readline when connection fails with unsent input", async () => {
    await startChat(client, { baseUrl: "mock://local" }, { plain: true });
    input.write("unsent\n");
    ws.emit("error", new Error("handshake failed"));
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/unsent|not sent/i));
    ws.open();
    expect(ws.sent).toEqual([]);
  });

  it("B08 finishes an asynchronous command before sending subsequent piped input", async () => {
    let finishNew: (value: any) => void;
    client.newSession = () => new Promise((resolve) => { finishNew = resolve; });
    await startChat(client, { baseUrl: "mock://local" }, { plain: true });
    ws.open();
    input.write("/new\nafter new\n");
    expect(ws.sent).toEqual([]);
    finishNew!({ sessionId: "b", path: "/b" });
    await vi.waitFor(() => expect(ws.sent).toEqual([{ type: "prompt", text: "after new", sessionId: "b", sessionPath: "/b" }]));
    ws.close();
  });

  it("B08 ignores duplicate terminal packets from the preceding stream", async () => {
    await startChat(client, { baseUrl: "mock://local" }, { plain: true });
    ws.open();
    input.write("first\nsecond\nthird\n");
    const event = (payload: any) => ws.emit("message", JSON.stringify({ sessionId: "a", sessionPath: "/a", ...payload }));
    event({ type: "status", isStreaming: true, streamId: "stream-1" });
    event({ type: "status", isStreaming: false, streamId: "stream-1" });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(2));
    event({ type: "turn_end", streamId: "stream-1" });
    event({ type: "status", isStreaming: false, streamId: null });
    expect(ws.sent).toHaveLength(2);
    event({ type: "status", isStreaming: true, streamId: "stream-2" });
    event({ type: "turn_end", streamId: "stream-2" });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(3));
    ws.close();
  });

  it.each(["synchronous", "callback"])("B08 reports %s send failure without claiming success or sending later lines", async (failure) => {
    await startChat(client, { baseUrl: "mock://local" }, { plain: true });
    input.write("first\nsecond\n");
    ws.send.mockImplementation((_data, callback) => {
      if (failure === "synchronous") throw new Error("send failed");
      callback?.(new Error("send failed"));
    });
    ws.open();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/not sent/));
  });

  it("B08 reports disconnect with queued input and rejects late events", async () => {
    await startChat(client, { baseUrl: "mock://local" }, { plain: true });
    ws.open();
    input.write("first\nsecond\n");
    ws.close();
    ws.endTurn();
    input.write("late\n");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(ws.sent.map((m) => m.text)).toEqual(["first"]);
  });

  it("B08 bounds input received before connection and fails explicitly on overflow", async () => {
    await startChat(client, { baseUrl: "mock://local" }, { plain: true });
    input.write("line\n".repeat(1025));
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/queue limit exceeded/));
    ws.open();
    expect(ws.sent).toEqual([]);
  });

  it("B08 times out a handshake that never completes and releases pending input", async () => {
    vi.useFakeTimers();
    await startChat(client, { baseUrl: "mock://local" }, { plain: true });
    input.write("unsent\n");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/timed out/));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("B08 preserves interactive abort identity and removes keypress listeners on quit", async () => {
    const initialListeners = process.stdin.listenerCount("keypress");
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const raw = vi.fn();
    const previousRaw = process.stdin.setRawMode;
    process.stdin.setRawMode = raw as any;
    try {
      await startChat(client, { baseUrl: "mock://local" });
      ws.open();
      input.write("hello\n");
      ws.emit("message", JSON.stringify({ type: "status", sessionId: "a", sessionPath: "/a", streamId: "s1", isStreaming: true }));
      process.stdin.emit("keypress", "", { ctrl: true, name: "c" });
      expect(ws.sent[1]).toEqual({ type: "abort", sessionId: "a", sessionPath: "/a", streamId: "s1" });
      ws.emit("message", JSON.stringify({ type: "turn_end", sessionId: "a", sessionPath: "/a", streamId: "s1" }));
      process.stdin.emit("keypress", "", { ctrl: true, name: "c" });
      expect(exit).toHaveBeenCalledWith(0);
      expect(raw).toHaveBeenLastCalledWith(false);
      expect(process.stdin.listenerCount("keypress")).toBe(initialListeners);
    } finally {
      process.stdin.setRawMode = previousRaw;
      if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
      else delete (process.stdin as any).isTTY;
    }
  });
});
