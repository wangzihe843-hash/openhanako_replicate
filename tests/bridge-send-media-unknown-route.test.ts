import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeRoute } from "../server/routes/bridge.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(error: Error) {
  const hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), "u15-media-route-")); roots.push(hanakoHome);
  const filePath = path.join(hanakoHome, "synthetic.txt"); fs.writeFileSync(filePath, "synthetic");
  const agent = { id: "a", config: { bridge: {} } };
  const engine = { hanakoHome, getAgent: (id: string) => id === "a" ? agent : null, registerSessionFile: vi.fn(() => ({ id: "sf_synthetic" })) };
  const manager = { sendMediaItem: vi.fn(async () => { throw error; }) };
  const app = new Hono(); app.route("/api", createBridgeRoute(engine, manager));
  return { engine, manager, send: () => app.request("/api/bridge/send-media?agentId=a", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: "feishu", chatId: "synthetic", filePath }),
  }) };
}

describe("Bridge media HTTP delivery outcomes", () => {
  it("preserves an unknown outcome as a safe non-retryable envelope without a second send", async () => {
    const error = Object.assign(new Error("synthetic response lost"), {
      deliveryUnknown: true, retryable: true, code: "ECONNRESET", log_id: "synthetic-log", operation: "sendFile", phase: "response",
      config: { appSecret: "synthetic-private-config" }, cause: new Error("synthetic-private-cause"),
    });
    const f = fixture(error); const response = await f.send(); const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      ok: false, error: "delivery_unknown", deliveryUnknown: true, retryable: false, message: "synthetic response lost",
      failure: { name: "Error", message: "synthetic response lost", deliveryUnknown: true, retryable: false, code: "ECONNRESET", log_id: "synthetic-log", operation: "sendFile", phase: "response" },
    });
    expect(JSON.stringify(body)).not.toContain("synthetic-private");
    expect(f.engine.registerSessionFile).toHaveBeenCalledOnce(); expect(f.manager.sendMediaItem).toHaveBeenCalledOnce();
  });
  it.each([
    ["synthetic explicit platform rejection", 500],
    ["QQ 当前 adapter 不能直接消费这个本地 staged file，只能走 public_url fallback", 422],
  ] as const)("retains the known failure response: %s", async (message, status) => {
    const f = fixture(new Error(message)); const response = await f.send();
    expect(response.status).toBe(status); await expect(response.json()).resolves.toEqual({ ok: false, error: message });
    expect(f.manager.sendMediaItem).toHaveBeenCalledOnce();
  });
});
