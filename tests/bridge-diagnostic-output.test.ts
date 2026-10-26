import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { createBridgeRoute } from "../server/routes/bridge.ts";

const managers: BridgeManager[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

// Run the real adapter/manager/status route; only the transport is synthetic and
// offline. No account, credentials, network service or application is used.
it.each([
  "X-Api-Key: SYN_HEADER_API; X-Access-Token=SYN_HEADER_ACCESS; context_token=SYN_WX_CONTEXT log_id=trace-local-123 retry_after=3",
  JSON.stringify({ "X-Api-Key": ["SYN_HEADER_API"], "X-Access-Token": { nested: "SYN_HEADER_ACCESS" }, log_id: "trace-local-123", retry_after: 3 }),
])("redacts retried WeChat HTTP errors at real status outputs without changing request credentials: %s", async (body) => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-diagnostic-"));
  directories.push(home);
  const hub = { eventBus: { emit: vi.fn() } };
  const agent = { id: "hana", config: { bridge: { wechat: { enabled: true } } } };
  const engine = { hanakoHome: home, agent: null, currentAgentId: "hana", getAgent: () => agent };
  const manager = new BridgeManager({ engine, hub });
  managers.push(manager);
  const credentials = { botToken: "SYN_REQUEST_AUTH", hanaHome: home };
  manager.startPlatform("wechat", credentials, "hana");
  await vi.advanceTimersByTimeAsync(7_100);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  for (const [url, options] of fetchMock.mock.calls) {
    expect(String(url)).toContain("/ilink/bot/getupdates");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer SYN_REQUEST_AUTH");
    expect(JSON.parse(String(options?.body))).toEqual({ get_updates_buf: "", base_info: { channel_version: "1.0.0" } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
  const app = new Hono();
  app.route("/api", createBridgeRoute(engine, manager));
  const response = await app.request("/api/bridge/status?agentId=hana");
  expect(response.status).toBe(200);
  const outputs = [
    manager._platforms.get("wechat:hana").error,
    JSON.stringify(manager.getStatus("hana")),
    JSON.stringify(hub.eventBus.emit.mock.calls),
    JSON.stringify(await response.json()),
  ];
  manager.stopAll();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  for (const output of outputs) {
    expect(output).not.toMatch(/SYN_HEADER_|SYN_WX_CONTEXT/);
    expect(output).toContain("HTTP 503");
    expect(output).toContain("trace-local-123");
  }
  expect(credentials.botToken).toBe("SYN_REQUEST_AUTH");
  expect(body).toContain("SYN_HEADER_API");
});

it("preserves real WeChat expired-session classification without adding retries", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ ret: -14, errcode: -14, errmsg: "X-Api-Key: SYN_EXPIRED" })));
  vi.stubGlobal("fetch", fetchMock);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-diagnostic-"));
  directories.push(home);
  const manager = new BridgeManager({ engine: { hanakoHome: home, agent: null, getAgent: () => null }, hub: { eventBus: { emit: vi.fn() } } });
  managers.push(manager);
  manager.startPlatform("wechat", { botToken: "SYN_REQUEST_AUTH", hanaHome: home }, "hana");
  await vi.advanceTimersByTimeAsync(8_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(manager.getStatus("hana").wechat).toEqual({ status: "error", error: "session expired" });
});
