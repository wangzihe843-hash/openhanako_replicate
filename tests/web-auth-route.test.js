import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-web-auth-route-"));
}

function runtimeContext() {
  return {
    serverId: "server_local",
    serverNodeId: "node_local",
    userId: "user_local",
    studioId: "studio_local",
    connectionKind: "lan",
    credentialKind: "device_credential",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: ["chat", "resources", "files"],
  };
}

describe("web auth route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("exchanges a paired device credential for an HttpOnly browser session cookie", async () => {
    tmpDir = makeTmpDir();
    const { createDeviceCredential } = await import("../core/device-registry.js");
    const { createServerAuthService } = await import("../core/server-auth.js");
    const { createWebAuthRoute } = await import("../server/routes/web-auth.js");
    const issued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "Phone Browser",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat", "resources.read", "files.read", "files.write"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const authService = createServerAuthService({
      hanakoHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext,
    });
    const app = new Hono();
    app.route("/api", createWebAuthRoute({
      hanakoHome: tmpDir,
      authService,
      getConnectionKind: () => "lan",
      secureCookies: false,
      now: () => "2026-05-16T00:00:01.000Z",
    }));

    const login = await app.request("/api/web-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mobile Safari" },
      body: JSON.stringify({ credential: issued.secret }),
    });

    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie");
    expect(setCookie).toContain("hana_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(issued.secret);
    const body = await login.json();
    expect(body).toMatchObject({
      ok: true,
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        scopes: ["chat", "resources.read", "files.read", "files.write"],
      },
    });

    const session = await app.request("/api/web-auth/session", {
      headers: { Cookie: setCookie.split(";")[0] },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      authenticated: true,
      principal: { userId: "user_local", studioId: "studio_local" },
    });
  });
});
