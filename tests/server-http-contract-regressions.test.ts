import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createCorsMiddleware } from "../server/http/cors-policy.ts";
import { authorizeHttpRoute, isPublicHttpRoute } from "../server/http/route-security.ts";
import { createBridgeRoute } from "../server/routes/bridge.ts";
import { createDeskRoute } from "../server/routes/desk.ts";
import { MediaPublisher } from "../lib/bridge/media-publisher.ts";

const roots: string[] = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-contract-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("server HTTP contract regressions", () => {
  it("allows a PATCH preflight from the desktop while preserving the origin restriction", async () => {
    const app = new Hono();
    app.use("*", createCorsMiddleware());
    app.patch("/api/channels/crew", c => c.json({ ok: true }));
    for (const origin of ["null", "http://localhost:5173"]) {
      const response = await app.request("/api/channels/crew", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "PATCH" },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-methods")?.split(/,\s*/)).toContain("PATCH");
    }
    const untrusted = await app.request("/api/channels/crew", {
      method: "OPTIONS",
      headers: { origin: "https://untrusted.invalid", "access-control-request-method": "PATCH" },
    });
    expect(untrusted.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("lets only token media GET/HEAD reach the publisher without credentials", async () => {
    const root = tempRoot();
    const filePath = path.join(root, "media.txt");
    fs.writeFileSync(filePath, "published media");
    let now = 1000;
    const publisher = new MediaPublisher({
      baseUrl: "https://mock.invalid",
      allowedRoots: [root],
      ttlMs: 1000,
      now: () => now,
    });
    const issued = publisher.publish({ id: "file_mock", filePath, mime: "text/plain" });
    const app = new Hono();
    app.use("*", async (c, next) => {
      const policy = authorizeHttpRoute({ method: c.req.method, path: c.req.path, principal: null });
      if (!policy.allowed) return c.json({ error: "forbidden" }, 403);
      await next();
    });
    app.route("/api", createBridgeRoute({ hanakoHome: root }, { mediaPublisher: publisher }));
    const routePath = new URL(issued.publicUrl).pathname;
    const response = await app.request(routePath);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("published media");
    const head = await app.request(routePath, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await app.request("/api/bridge/media/unknown_token")).status).toBe(404);
    now = 2001;
    expect((await app.request(routePath)).status).toBe(404);
    for (const [method, route] of [
      ["POST", routePath], ["PUT", routePath], ["DELETE", routePath],
      ["GET", "/api/bridge/media"], ["GET", routePath + "/extra"],
      ["GET", "/api/bridge/status"], ["POST", "/api/bridge/config"],
      ["GET", "/api/bridge/media/token%2Fextra"],
    ]) {
      expect(isPublicHttpRoute({ method, path: route })).toBe(false);
      expect((await app.request(route, { method })).status).toBe(403);
    }
  });

  it.each(["{broken", "", "{}", '{"content":42}', "null", "[]"])(
    "rejects invalid Jian input without changing the existing document (%s)",
    async body => {
      const root = tempRoot();
      const cwd = path.join(root, "workspace");
      fs.mkdirSync(cwd);
      const jian = path.join(cwd, "jian.md");
      fs.writeFileSync(jian, "keep this instruction");
      const app = new Hono();
      app.route("/api", createDeskRoute({
        hanakoHome: path.join(root, "hana"),
        homeCwd: cwd,
        deskCwd: cwd,
      }, null));
      const response = await app.request("/api/desk/jian", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(fs.readFileSync(jian, "utf8")).toBe("keep this instruction");
    },
  );

  it("still writes and explicitly clears Jian content", async () => {
    const root = tempRoot();
    const cwd = path.join(root, "workspace");
    fs.mkdirSync(cwd);
    const app = new Hono();
    app.route("/api", createDeskRoute({
      hanakoHome: path.join(root, "hana"), homeCwd: cwd, deskCwd: cwd,
    }, null));
    const put = (content: string | null) => app.request("/api/desk/jian", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    expect((await put("new instruction")).status).toBe(200);
    expect(fs.readFileSync(path.join(cwd, "jian.md"), "utf8")).toBe("new instruction");
    expect((await put(null)).status).toBe(200);
    expect(fs.existsSync(path.join(cwd, "jian.md"))).toBe(false);
  });
});
