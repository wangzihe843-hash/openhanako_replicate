import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createDeviceCredential, revokeDevice, revokeDeviceCredential } from "../core/device-registry.ts";
import { createServerAuthService } from "../core/server-auth.ts";
import { authenticateWebSession } from "../core/web-session-store.ts";
import { createWebAuthRoute } from "../server/routes/web-auth.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cookie-source-"));
  dirs.push(dir);
  let now = "2026-10-06T00:00:00.000Z";
  const issued = createDeviceCredential(dir, {
    serverNodeId: "fixture-node", userId: "fixture-user", studioIds: ["fixture-studio"],
    displayName: "Fixture browser", deviceKind: "browser", trustState: "lan",
    scopes: ["chat", "files.read"], expiresAt: "2026-10-06T01:00:00.000Z", now,
  });
  const auth = createServerAuthService({ hanakoHome: dir, loopbackToken: "fixture-local", runtimeContext: {} });
  const app = new Hono();
  app.route("/api", createWebAuthRoute({ hanakoHome: dir, authService: auth, getConnectionKind: () => "lan", now: () => now }));
  const login = await app.request("/api/web-auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: issued.secret }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const session = () => app.request("/api/web-auth/session", { headers: { cookie } });
  expect(await (await session()).json()).toMatchObject({ authenticated: true, principal: { scopes: ["chat", "files.read"] } });
  const update = (file: string, field: string, patch: Record<string, unknown>) => {
    const filePath = path.join(dir, file);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    Object.assign(data[field][0], patch);
    fs.writeFileSync(filePath, JSON.stringify(data));
  };
  return { dir, issued, cookie, session, auth, update, setNow: (value: string) => { now = value; }, now: () => now };
}

describe("device browser sessions retain their source authorization boundary", () => {
  it.each(["device", "credential", "expiry"])("rejects the cookie after source %s becomes invalid", async reason => {
    const f = await fixture();
    if (reason === "device") revokeDevice(f.dir, f.issued.device.deviceId);
    if (reason === "credential") revokeDeviceCredential(f.dir, f.issued.credential.credentialId);
    if (reason === "expiry") f.setNow("2026-10-06T01:00:00.000Z");
    expect(await (await f.session()).json()).toEqual({ authenticated: false, principal: null });
    expect(authenticateWebSession(f.dir, f.cookie, { now: f.now() })).toBeNull();
    expect(f.auth.authenticateRequest({ cookieHeader: f.cookie, connectionKind: "local", now: f.now() })).toBeNull();
  });

  it.each([
    ["device-credentials.json", "credentials", { status: "rotated" }],
    ["device-credentials.json", "credentials", { expiresAt: "invalid-date" }],
    ["device-credentials.json", "credentials", { deviceId: "other-device" }],
    ["device-credentials.json", "credentials", { userId: "other-user" }],
    ["device-credentials.json", "credentials", { serverNodeId: "other-node" }],
    ["device-credentials.json", "credentials", { studioIds: ["other-studio"] }],
    ["device-credentials.json", "credentials", { scopes: ["chat"] }],
    ["devices.json", "devices", { userId: "other-user" }],
    ["devices.json", "devices", { serverNodeId: "other-node" }],
    ["devices.json", "devices", { studioIds: ["other-studio"] }],
    ["devices.json", "devices", { trustState: "tunnel" }],
  ] as const)("rejects stale source bindings in %s: %j %j", async (file, field, patch) => {
    const f = await fixture();
    f.update(file, field, patch);
    expect(await (await f.session()).json()).toEqual({ authenticated: false, principal: null });
  });

  it.each(["missing", "corrupt"])("fails closed for a %s source registry", async state => {
    const f = await fixture();
    const target = path.join(f.dir, "device-credentials.json");
    if (state === "missing") fs.unlinkSync(target);
    else fs.writeFileSync(target, "{broken");
    expect(await (await f.session()).json()).toEqual({ authenticated: false, principal: null });
  });

  it("retains valid sessions without inheriting subsequently added permissions", async () => {
    const f = await fixture();
    f.update("device-credentials.json", "credentials", { scopes: ["chat", "files.read", "secrets.write"] });
    expect(await (await f.session()).json()).toMatchObject({ authenticated: true, principal: { scopes: ["chat", "files.read"] } });
  });
});
