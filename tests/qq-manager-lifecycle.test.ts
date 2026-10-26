import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ fetch: vi.fn(), sockets: [] as (EventEmitter & { url: string; readyState: number; closed: number; open: () => void; terminate: () => void; ready: () => void })[] }));
vi.mock("undici", async original => ({ ...await original<typeof import("undici")>(), fetch: transport.fetch }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1; static CLOSED = 3;
    readyState = 0; closed = 0;
    constructor(public url: string) { super(); transport.sockets.push(this); }
    send() {}
    open() { this.readyState = 1; this.emit("open"); }
    ready() {
      this.open();
      this.emit("message", Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })));
      this.emit("message", Buffer.from(JSON.stringify({ op: 0, t: "READY", s: 0, d: { session_id: "synthetic-session" } })));
    }
    terminate() { this.closed++; this.readyState = 3; this.emit("close"); }
  }
  return { default: Socket };
});
vi.mock("../lib/bridge/telegram-adapter.ts", () => ({ createTelegramAdapter: vi.fn() }));
vi.mock("../lib/bridge/feishu-adapter.ts", () => ({ createFeishuAdapter: vi.fn() }));
vi.mock("../lib/bridge/dingtalk-adapter.ts", () => ({ createDingTalkAdapter: vi.fn() }));
vi.mock("../lib/bridge/wechat-adapter.ts", () => ({ createWechatAdapter: vi.fn() }));
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";

const credentials = { appID: "synthetic-app", appSecret: "synthetic-secret" };
const managers: BridgeManager[] = [];
const release: (() => void)[] = [];
const tick = () => vi.advanceTimersByTimeAsync(0);
function fixture() {
  const hub = { subscribe: vi.fn(() => vi.fn()), eventBus: { emit: vi.fn() } };
  const manager = new BridgeManager({ engine: { emitEvent: vi.fn() }, hub });
  managers.push(manager);
  return manager;
}
beforeEach(() => { vi.useFakeTimers(); transport.fetch.mockReset(); transport.sockets = []; });
afterEach(async () => { managers.splice(0).forEach(m => m.stopAll()); release.splice(0).forEach(f => f()); await tick(); vi.useRealTimers(); });

it("uses the real adapter to isolate overlapping starts and start-stop-start while registration is pending", async () => {
  const held: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  transport.fetch.mockImplementation((url, init) => url.includes("getAppAccessToken") ? Promise.resolve(Response.json({ access_token: "synthetic-token", expires_in: 7200 })) : new Promise<Response>(resolve => {
    held.push({ signal: init.signal, resolve });
    release.push(() => resolve(Response.json({ url: "wss://synthetic.invalid/late" })));
  }));
  const manager = fixture();
  manager.startPlatform("qq", credentials, "a");
  await tick();
  manager.startPlatform("qq", credentials, "a");
  manager.stopPlatform("qq", "a");
  manager.startPlatform("qq", credentials, "a");
  await tick();
  expect(held).toHaveLength(2);
  expect(held.map(h => h.signal.aborted)).toEqual([true, false]);
  expect(manager.getStatus("a").qq.status).toBe("connecting");
  held[1].resolve(Response.json({ url: "wss://synthetic.invalid/fresh" })); await tick();
  const socket = transport.sockets[0]; socket.open();
  expect(manager.getStatus("a").qq.status).toBe("connecting");
  socket.ready();
  for (const h of held.slice(0, 1)) h.resolve(Response.json({ url: "wss://synthetic.invalid/old" }));
  await tick();
  expect(transport.sockets).toHaveLength(1);
  expect(manager.getStatus("a").qq.status).toBe("connected");
  expect(socket.closed).toBe(0);
  manager.stopAll(); await tick();
  expect(socket.closed).toBe(1); expect(vi.getTimerCount()).toBe(0);
});

it("keeps other agents live when a stopped handshake emits old open/error/close events", async () => {
  let ticket = 0;
  transport.fetch.mockImplementation(async url => url.includes("getAppAccessToken") ? Response.json({ access_token: "synthetic-token", expires_in: 7200 }) : Response.json({ url: `wss://synthetic.invalid/connect?ticket=${++ticket}` }));
  const manager = fixture();
  manager.startPlatform("qq", credentials, "a");
  manager.startPlatform("qq", credentials, "b"); await tick();
  const [old, other] = transport.sockets;
  const saved = ["open", "error", "close"].map(name => old.listeners(name));
  manager.startPlatform("qq", credentials, "a"); await tick();
  const fresh = transport.sockets[2];
  other.ready(); fresh.ready();
  for (const [index, callbacks] of saved.entries()) for (const callback of callbacks) callback(index === 1 ? new Error("obsolete") : undefined);
  expect(manager.getStatus("a").qq.status).toBe("connected");
  expect(manager.getStatus("b").qq.status).toBe("connected");
  expect(other.closed).toBe(0); expect(fresh.closed).toBe(0); expect(old.closed).toBe(1);
  manager.stopAll(); await tick(); expect(vi.getTimerCount()).toBe(0);
});
