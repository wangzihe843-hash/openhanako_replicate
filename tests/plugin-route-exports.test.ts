import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { PluginManager } from "../core/plugin-manager.ts";
import { freshImport } from "../core/fresh-import.ts";
import { EventBus } from "../hub/event-bus.ts";
import { createPluginsRoute } from "../server/routes/plugins.ts";

// Use the installed ESM Hono entry for real on-disk synthetic plugins. Nothing
// is installed, no loader is mocked, and every HTTP request stays in memory.
const honoUrl = pathToFileURL(path.resolve("node_modules/hono/dist/index.js")).href;
const honoImport = `import { Hono } from ${JSON.stringify(honoUrl)};`;
let root: string;
let managers: PluginManager[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-route-exports-"));
  managers = [];
});

afterEach(async () => {
  try {
    for (const pm of managers) {
      for (const entry of pm.listPlugins()) await pm.unloadPlugin(entry.id);
      expect(pm.routeRegistry.size).toBe(0);
    }
  } finally {
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function plugin(id: string, files: Record<string, string>, manifest: Record<string, unknown> = {}) {
  const dir = path.join(root, "plugins", id);
  fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id, trust: "full-access", ...manifest }));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, "routes", name), source);
  return dir;
}

function manager({ allow = true, disabled = [], bus = new EventBus() }:
  { allow?: boolean; disabled?: string[]; bus?: EventBus } = {}) {
  const pm = new PluginManager({
    pluginsDirs: [path.join(root, "empty-builtin"), path.join(root, "plugins")],
    dataDir: path.join(root, "data"), bus,
    preferencesManager: {
      getAllowFullAccessPlugins: () => allow,
      getDisabledPlugins: () => disabled,
      setDisabledPlugins: () => {},
    },
  } as ConstructorParameters<typeof PluginManager>[0]);
  managers.push(pm);
  return pm;
}

function host(pm: PluginManager, withPrincipal = false) {
  const app = new Hono<{ Variables: { authPrincipal: Record<string, string> } }>();
  if (withPrincipal) app.use("*", async (c, next) => {
    // This represents the trusted authentication output, not an auth bypass in
    // production. The global authentication middleware is outside this test.
    c.set("authPrincipal", {
      kind: "owner", principalId: c.req.header("X-Synthetic-Principal") || "synthetic-owner",
      credentialKind: "loopback_token", connectionKind: "local",
    });
    await next();
  });
  app.route("/api", createPluginsRoute({
    pluginManager: pm, currentAgentId: "must-not-be-inherited",
    getAgent: (id: string) => ["alpha", "beta"].includes(id) ? { id } : null,
  }));
  return app;
}

async function load(pm: PluginManager) {
  pm.scan();
  await pm.loadAll();
  return host(pm);
}

const staticRoute = (routePath: string, value: string) => `${honoImport}
  const route = new Hono();
  route.get(${JSON.stringify(routePath)}, c => c.json({ value: ${JSON.stringify(value)}, plugin: c.get("pluginCtx")?.pluginId }));
  export default route;`;

describe("on-disk plugin route exports through the production router", () => {
  it.each(["js", "ts"])("mounts a static .%s Hono app with the existing filename prefix", async ext => {
    const dir = plugin("exports", {
      [`webhook.${ext}`]: staticRoute("/webhook", "static"),
      "factory.js": 'export default (app, ctx) => app.get("/factory", c => c.json({ plugin: ctx.pluginId }));',
      "register.js": 'export function register(app, ctx) { app.get("/register", c => c.json({ plugin: ctx.pluginId })); }',
    });
    const direct = (await freshImport(path.join(dir, "routes", `webhook.${ext}`))).default;
    expect(typeof direct).toBe("object");
    expect((await direct.request("/webhook")).status).toBe(200);
    const app = await load(manager());
    const statuses: Record<string, number> = {};
    for (const route of ["factory", "register", "webhook/webhook"]) {
      const response = await app.request(`/api/plugins/exports/${route}`);
      statuses[route] = response.status;
      if (response.ok) expect(await response.json()).toMatchObject({ plugin: "exports" });
    }
    expect(statuses).toEqual({ factory: 200, register: 200, "webhook/webhook": 200 });
    expect((await app.request("/api/plugins/exports/webhook")).status).toBe(404);
    expect((await app.request("/api/plugins/exports/factory/factory")).status).toBe(404);
  });

  it("runs factory and named register exports once each in the same file", async () => {
    plugin("both-functions", { "routes.js": `
      const calls = { factory: 0, register: 0 };
      export default (app, ctx) => { calls.factory++; app.get("/factory", c => c.json({ ...calls, plugin: ctx.pluginId })); };
      export function register(app, ctx) { calls.register++; app.get("/register", c => c.json({ ...calls, plugin: ctx.pluginId })); }
    ` });
    const app = await load(manager());
    for (const route of ["factory", "register"]) {
      expect(await (await app.request(`/api/plugins/both-functions/${route}`)).json())
        .toEqual({ factory: 1, register: 1, plugin: "both-functions" });
    }
  });

  it("mounts static and named register exports without changing the exported app", async () => {
    plugin("both-static", { "static.js": `${staticRoute("/hello", "static")}
      export function register(app, ctx) {
        app.get("/register", c => c.json({ plugin: ctx.pluginId, childRouteCount: route.routes.length }));
      }` });
    const app = await load(manager());
    expect((await app.request("/api/plugins/both-static/static/hello")).status).toBe(200);
    expect(await (await app.request("/api/plugins/both-static/register")).json())
      .toEqual({ plugin: "both-static", childRouteCount: 1 });
  });

  it("injects context before static middleware and isolates concurrent request identities", async () => {
    plugin("context", { "context.ts": `${honoImport}
      const route = new Hono();
      route.use("*", async (c, next) => {
        const before = c.get("pluginRequestContext");
        if (!before || c.get("pluginCtx").pluginId !== "context") throw new Error("missing early context");
        await next();
        if (before !== c.get("pluginRequestContext")) throw new Error("request context replaced");
      });
      route.get("/who", async c => {
        const request = c.get("pluginRequestContext");
        await Promise.resolve();
        return c.json({ plugin: c.get("pluginCtx").pluginId, agent: c.get("agentId"),
          requestAgent: request.agentId, principal: request.principal, grant: request.capabilityGrant,
          spoofedHeader: c.req.header("X-Hana-Agent-Id") ?? null });
      });
      export default route;`,
    }, { capabilities: ["session"], sensitiveCapabilities: ["agent.write"] });
    const pm = manager();
    await load(pm);
    const app = host(pm, true);
    const replies = await Promise.all(["alpha", "beta"].map(async agent => {
      const response = await app.request(`/api/plugins/context/context/who?agentId=${agent}`, {
        headers: { "X-Synthetic-Principal": `owner-${agent}`, "X-Hana-Agent-Id": "spoofed" },
      });
      expect(response.status).toBe(200);
      return response.json();
    }));
    replies.forEach((body, i) => expect(body).toMatchObject({
      plugin: "context", agent: ["alpha", "beta"][i], requestAgent: ["alpha", "beta"][i],
      principal: { principalId: `owner-${["alpha", "beta"][i]}` }, spoofedHeader: null,
      grant: { accessLevel: "full-access", declaredPermissions: ["session", "agent.write"], legacyDeclaration: false },
    }));
    const anonymous = await host(pm).request("/api/plugins/context/context/who");
    expect(await anonymous.json()).toMatchObject({ agent: null, requestAgent: null, principal: null });
    expect((await app.request("/api/plugins/context/context/who?agentId=missing")).status).toBe(404);
    const ctx = pm.getPlugin("context").ctx;
    for (const field of ["agentId", "principal", "pluginRequestContext"]) expect(ctx).not.toHaveProperty(field);
  });

  it.each([
    { name: "namespace", manifest: { capabilities: ["session"] }, status: 200 },
    { name: "sensitive permission", manifest: { sensitiveCapabilities: ["session.write"] }, status: 200 },
    { name: "legacy", manifest: {}, status: 200 },
    { name: "explicit empty", manifest: { capabilities: [] }, status: 403 },
    { name: "unrelated permission", manifest: { capabilities: ["agent"] }, status: 403 },
  ])("preserves static route capability grants: $name", async ({ manifest, status }) => {
    plugin("grant", { "access.js": `${honoImport}
      const route = new Hono();
      route.post("/create", async c => {
        const ctx = c.get("pluginRequestContext");
        return c.json(await ctx.bus.request("session:create", { agentId: ctx.agentId }));
      });
      export default route;`,
    }, manifest);
    const bus = new EventBus();
    const handler = vi.fn(async (_payload: { agentId: string }) => ({ synthetic: true }));
    bus.handle("session:create", handler);
    const app = await load(manager({ bus }));
    const response = await app.request("/api/plugins/grant/access/create?agentId=alpha", { method: "POST" });
    expect(response.status).toBe(status);
    if (status === 200) {
      expect(await response.json()).toEqual({ synthetic: true });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toMatchObject({ agentId: "alpha" });
    } else {
      expect(await response.json()).toMatchObject({ error: "PLUGIN_CAPABILITY_NOT_DECLARED", declared: false, granted: true });
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it.each([
    { trust: "restricted", allow: true, disabled: [], status: "loaded" },
    { trust: "full-access", allow: false, disabled: [], status: "restricted" },
    { trust: "full-access", allow: true, disabled: ["denied"], status: "disabled" },
  ])("does not import routes without admission: $status/$trust", async ({ trust, allow, disabled, status }) => {
    const marker = path.join(root, "route-imported");
    plugin("denied", { "api.js": `import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(marker)}, "synthetic-only");
      ${staticRoute("/who", "must-not-load")}`,
    }, { trust, capabilities: ["session"] });
    const pm = manager({ allow, disabled });
    const app = await load(pm);
    expect(pm.getPlugin("denied").status).toBe(status);
    expect(pm.routeRegistry.has("denied")).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect((await app.request("/api/plugins/denied/api/who")).status).toBe(404);
  });

  it("reuses a shared static app across filenames, plugins and reloads without duplicate middleware", async () => {
    fs.writeFileSync(path.join(root, "shared.js"), `${honoImport}
      const route = new Hono();
      route.use("*", async (c, next) => { c.set("visits", (c.get("visits") || 0) + 1); await next(); });
      route.get("/who", c => c.json({ plugin: c.get("pluginCtx").pluginId, visits: c.get("visits"), routes: route.routes.length }));
      Object.freeze(route.routes);
      export default route;`);
    const shared = 'export { default } from "../../../shared.js";';
    plugin("left", { "one.js": shared, "two.ts": shared });
    plugin("right", { "one.js": shared });
    const pm = manager();
    const app = await load(pm);
    for (let iteration = 0; iteration < 3; iteration++) {
      for (const [id, file] of [["left", "one"], ["left", "two"], ["right", "one"]]) {
        const response = await app.request(`/api/plugins/${id}/${file}/who`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ plugin: id, visits: 1, routes: 2 });
      }
      if (iteration < 2) await pm.enablePlugin("left");
    }
    await pm.unloadPlugin("left");
    expect((await app.request("/api/plugins/left/one/who")).status).toBe(404);
    expect((await app.request("/api/plugins/right/one/who")).status).toBe(200);
  });

  it("replaces a static app on reload and removes it on unload", async () => {
    const dir = plugin("replace", { "api.js": staticRoute("/old", "old") });
    const pm = manager();
    const app = await load(pm);
    expect((await app.request("/api/plugins/replace/api/old")).status).toBe(200);
    const oldApp = pm.getRouteApp("replace");
    fs.writeFileSync(path.join(dir, "routes/api.js"), staticRoute("/new", "new"));
    await pm.enablePlugin("replace");
    expect(pm.getRouteApp("replace")).not.toBe(oldApp);
    expect((await app.request("/api/plugins/replace/api/old")).status).toBe(404);
    const updated = await app.request("/api/plugins/replace/api/new");
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ value: "new", plugin: "replace" });
    await pm.unloadPlugin("replace");
    await pm.unloadPlugin("replace");
    expect((await app.request("/api/plugins/replace/api/new")).status).toBe(404);
  });

  it("keeps unsupported exports and per-file load errors isolated", async () => {
    plugin("invalid", {
      "a-fetch.js": 'export default { fetch() {} }; export function register(app) { app.get("/fetch-register", c => c.text("ok")); }',
      "b-shape.ts": 'export default { fetch() {}, route() {}, routes: {} }; export function register(app) { app.get("/shape-register", c => c.text("ok")); }',
      "c-null.js": 'export default null; export function register(app) { app.get("/null-register", c => c.text("ok")); }',
      "d-throw.js": 'export default () => { throw new Error("synthetic factory failure"); }; export function register(app) { app.get("/must-not-register", c => c.text("bad")); }',
      "e-import.js": 'throw new Error("synthetic import failure");',
      "f-healthy.js": 'export function register(app) { app.get("/healthy", c => c.text("ok")); }',
    });
    const app = await load(manager());
    for (const route of ["fetch-register", "shape-register", "null-register", "healthy"]) {
      expect((await app.request(`/api/plugins/invalid/${route}`)).status).toBe(200);
    }
    expect((await app.request("/api/plugins/invalid/must-not-register")).status).toBe(404);
  });

  it("retains parent error isolation and a static app's custom error handler", async () => {
    plugin("errors", {
      "plain.js": `${honoImport} const route = new Hono(); route.get("/boom", () => { throw new Error("synthetic handler failure"); }); export default route;`,
      "custom.js": `${honoImport} const route = new Hono(); route.onError((_err, c) => c.json({ custom: true }, 418)); route.get("/boom", () => { throw new Error("synthetic custom failure"); }); export default route;`,
    });
    const app = await load(manager());
    const plain = await app.request("/api/plugins/errors/plain/boom");
    expect(plain.status).toBe(500);
    expect(await plain.json()).toEqual({ error: "Plugin internal error", plugin: "errors" });
    const custom = await app.request("/api/plugins/errors/custom/boom");
    expect(custom.status).toBe(418);
    expect(await custom.json()).toEqual({ custom: true });
  });

  it("does not publish a static import completed after unload", async () => {
    let release = () => {};
    const state = { started: false, wait: new Promise<void>(resolve => { release = resolve; }) };
    vi.stubGlobal("__routeExportLoadGate", state);
    plugin("late", { "late.js": `${honoImport}
      globalThis.__routeExportLoadGate.started = true;
      await globalThis.__routeExportLoadGate.wait;
      const route = new Hono(); route.get("/who", c => c.text("obsolete")); export default route;` });
    const pm = manager();
    pm.scan();
    const pending = pm.loadAll();
    try {
      await vi.waitFor(() => expect(state.started).toBe(true));
      await pm.unloadPlugin("late");
    } finally {
      release();
      await pending;
    }
    expect(pm.routeRegistry.has("late")).toBe(false);
    expect((await host(pm).request("/api/plugins/late/late/who")).status).toBe(404);
  });
});
