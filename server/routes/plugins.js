import { Hono } from "hono";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { extractZip } from "../../lib/extract-zip.js";
import { resolveAgent } from "../utils/resolve-agent.js";
import { fromRoot } from "../../shared/hana-root.js";
import { DEFAULT_THEME } from "../../desktop/src/shared/theme-registry.cjs";
import { registerSessionFileFromRequest } from "../../lib/session-files/session-file-response.js";
import { createDefaultPluginMarketplace } from "../../lib/plugin-marketplace.js";

const MAX_PLUGIN_RELEASE_PACKAGE_SIZE = 50 * 1024 * 1024;

/**
 * 代理分发：将 /plugins/:pluginId/* 的请求转发到对应 plugin 子 app。
 * @param {import("hono").Context} c
 * @param {import("hono").Hono} pluginApp
 * @param {string} pluginId
 * @param {string} [agentId] - 当前 agent id，注入到子请求的 X-Hana-Agent-Id header
 */
async function proxyToPlugin(c, pluginApp, pluginId, agentId) {
  const url = new URL(c.req.url);
  const prefix = `/plugins/${pluginId}`;
  const prefixIndex = url.pathname.indexOf(prefix);
  const subPath = prefixIndex !== -1
    ? url.pathname.slice(prefixIndex + prefix.length) || "/"
    : "/";
  url.pathname = subPath;

  const headers = new Headers(c.req.raw.headers);
  if (agentId) headers.set("X-Hana-Agent-Id", agentId);

  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  const subReq = new Request(url.toString(), {
    method: c.req.method,
    headers,
    body: hasBody ? c.req.raw.body : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
  });
  return pluginApp.fetch(subReq);
}

/**
 * Standalone route proxy (for tests).
 * @param {Map<string, import("hono").Hono>} routeRegistry
 */
export function createPluginProxyRoute(routeRegistry) {
  const route = new Hono();
  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = routeRegistry.get(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    return proxyToPlugin(c, pluginApp, pluginId);
  });
  return route;
}

async function installPluginFromPath({ engine, pm, sourcePath, sessionPath }) {
  const stat = fs.statSync(sourcePath);
  const sourceFile = registerSessionFileFromRequest(engine, {
    sessionPath,
    filePath: sourcePath,
    label: path.basename(sourcePath),
    origin: "plugin_install_source",
    storageKind: "install_source",
  });
  let targetDir;
  const userPluginsDir = pm.getUserPluginsDir();
  fs.mkdirSync(userPluginsDir, { recursive: true });

  if (sourcePath.endsWith(".zip")) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-"));
    await extractZip(sourcePath, tmpDir);
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    const pluginSrc = entries.length === 1 && entries[0].isDirectory()
      ? path.join(tmpDir, entries[0].name)
      : tmpDir;
    const dirName = path.basename(pluginSrc);
    targetDir = path.join(userPluginsDir, dirName);
    const tmpTarget = targetDir + ".installing";
    if (fs.existsSync(tmpTarget)) fs.rmSync(tmpTarget, { recursive: true });
    fs.cpSync(pluginSrc, tmpTarget, { recursive: true });
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
    fs.renameSync(tmpTarget, targetDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } else if (stat.isDirectory()) {
    const dirName = path.basename(sourcePath);
    targetDir = path.join(userPluginsDir, dirName);
    const tmpTarget = targetDir + ".installing";
    if (fs.existsSync(tmpTarget)) fs.rmSync(tmpTarget, { recursive: true });
    fs.cpSync(sourcePath, tmpTarget, { recursive: true });
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
    fs.renameSync(tmpTarget, targetDir);
  } else {
    const err = new Error("Path must be a .zip file or directory");
    err.status = 400;
    throw err;
  }

  if (!pm.isValidPluginDir(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    const err = new Error("Not a valid plugin directory");
    err.status = 400;
    throw err;
  }

  const entry = await pm.installPlugin(targetDir);
  await engine.syncPluginExtensions();
  return {
    ...entry,
    ...(sourceFile ? { sourceFile } : {}),
  };
}

function safePathSegment(value, fallback) {
  const text = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return text || fallback;
}

function decodeHttpConfigValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === null ? undefined : value]),
  );
}

function decodeHttpConfigBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { values: {}, scope: "global", agentId: undefined, sessionPath: undefined };
  }
  const hasValuesEnvelope = Object.prototype.hasOwnProperty.call(body, "values");
  const rawValues = hasValuesEnvelope
    ? body.values
    : Object.fromEntries(
        Object.entries(body).filter(([key]) => !["scope", "agentId", "sessionPath"].includes(key)),
      );
  return {
    values: decodeHttpConfigValues(rawValues),
    scope: body.scope || "global",
    agentId: body.agentId,
    sessionPath: body.sessionPath,
  };
}

async function downloadMarketplaceRelease({ engine, plugin }) {
  const dist = plugin?.distribution;
  if (!dist || dist.kind !== "release") {
    const err = new Error("Plugin has no release distribution");
    err.status = 400;
    throw err;
  }
  if (!dist.packageUrl || !dist.sha256) {
    const err = new Error("Plugin release distribution is missing packageUrl or sha256");
    err.status = 400;
    throw err;
  }

  const expectedSha256 = String(dist.sha256).trim();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    const err = new Error("Plugin release sha256 must be 64 lowercase hex characters");
    err.status = 400;
    throw err;
  }

  const packageUrl = new URL(dist.packageUrl);
  if (packageUrl.protocol !== "https:") {
    const err = new Error("Plugin release packageUrl must use https");
    err.status = 400;
    throw err;
  }

  const fetchImpl = engine.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    const err = new Error("fetch is unavailable");
    err.status = 500;
    throw err;
  }
  if (!engine.hanakoHome) {
    const err = new Error("HANA_HOME is unavailable for plugin release installation");
    err.status = 500;
    throw err;
  }

  const res = await fetchImpl(packageUrl.toString());
  if (!res.ok) {
    const err = new Error(`Plugin release download failed: ${res.status}`);
    err.status = 502;
    throw err;
  }
  const contentLength = Number(res.headers?.get?.("content-length") || 0);
  if (contentLength > MAX_PLUGIN_RELEASE_PACKAGE_SIZE) {
    const err = new Error("Plugin release package is too large");
    err.status = 413;
    throw err;
  }

  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_PLUGIN_RELEASE_PACKAGE_SIZE) {
    const err = new Error("Plugin release package is too large");
    err.status = 413;
    throw err;
  }
  const actualSha256 = crypto.createHash("sha256").update(body).digest("hex");
  if (actualSha256 !== expectedSha256) {
    const err = new Error("Plugin release sha256 mismatch");
    err.status = 502;
    throw err;
  }

  const pluginId = safePathSegment(plugin.id, "plugin");
  const version = safePathSegment(plugin.version, "0.0.0");
  const downloadsDir = path.join(engine.hanakoHome, "plugin-install-sources", pluginId, version);
  fs.mkdirSync(downloadsDir, { recursive: true });
  const packagePath = path.join(downloadsDir, `${pluginId}-${version}.zip`);
  fs.writeFileSync(packagePath, body);
  return packagePath;
}

function isMarketplacePluginInstallable(plugin, marketplace) {
  if (plugin.distribution?.kind === "source") {
    return !!marketplace.resolveSourceDistribution(plugin);
  }
  if (plugin.distribution?.kind === "release") {
    return !!(plugin.distribution.packageUrl && plugin.distribution.sha256);
  }
  return false;
}

function sanitizeMarketplacePluginForClient(plugin) {
  const {
    readme: _readme,
    readmePath: _readmePath,
    distribution,
    ...rest
  } = plugin;
  return {
    ...rest,
    distribution: distribution
      ? {
          kind: distribution.kind,
          ...(distribution.path ? { path: distribution.path } : {}),
          ...(distribution.packageUrl ? { packageUrl: distribution.packageUrl } : {}),
          ...(distribution.sha256 ? { sha256: distribution.sha256 } : {}),
        }
      : null,
  };
}

/**
 * Plugin management REST API + route proxy (combined).
 * @param {import('../../core/engine.js').HanaEngine} engine
 */
export function createPluginsRoute(engine) {
  const route = new Hono();

  /**
   * 可见插件过滤 + 序列化（单一出口，所有返回插件列表的端点共用）。
   * hidden 插件（系统插件）永远不暴露给前端管理页。
   * @param {object} [opts]
   * @param {string} [opts.source] - 按 source 过滤（"community" | "builtin"）
   */
  function visiblePlugins(pm, opts = {}) {
    let plugins = pm.listPlugins().filter(p => !p.hidden);
    if (opts.source) plugins = plugins.filter(p => p.source === opts.source);
    return plugins.map(p => ({
      id: p.id, name: p.name, version: p.version,
      description: p.description, status: p.status,
      activationState: p.activationState || null,
      activationEvents: Array.isArray(p.activationEvents) ? p.activationEvents : [],
      activationError: p.activationError || null,
      source: p.source || "community", trust: p.trust || "restricted",
      contributions: p.contributions,
      error: p.error || null,
    }));
  }

  // ── Management API (specific routes first) ──

  route.get("/plugins", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    return c.json(visiblePlugins(pm, { source: c.req.query("source") }));
  });

  route.get("/plugins/config-schemas", (c) => {
    const pm = engine.pluginManager;
    return c.json(pm?.getAllConfigSchemas() || []);
  });

  route.get("/plugins/event-bus/capabilities", (c) => {
    const bus = engine.getEventBus?.() || engine.eventBus || null;
    const capabilities = typeof bus?.listCapabilities === "function"
      ? bus.listCapabilities()
      : [];
    return c.json(capabilities);
  });

  route.get("/plugins/diagnostics", (c) => {
    const pm = engine.pluginManager;
    const bus = engine.getEventBus?.() || engine.eventBus || null;
    return c.json({
      plugins: typeof pm?.getDiagnostics === "function"
        ? pm.getDiagnostics().filter(p => !p.hidden)
        : [],
      eventBus: typeof bus?.listCapabilities === "function" ? bus.listCapabilities() : [],
      tasks: typeof engine.taskRegistry?.listAll === "function" ? engine.taskRegistry.listAll() : [],
      schedules: typeof engine.taskRegistry?.listSchedules === "function" ? engine.taskRegistry.listSchedules() : [],
    });
  });

  function getMarketplace() {
    return engine.pluginMarketplace || createDefaultPluginMarketplace({
      hanakoHome: engine.hanakoHome,
      fetchImpl: engine.fetch,
    });
  }

  route.get("/plugins/marketplace", async (c) => {
    const pm = engine.pluginManager;
    const marketplace = getMarketplace();
    const data = await marketplace.load();
    const installed = new Map((pm?.listPlugins?.() || []).map((plugin) => [plugin.id, plugin]));
    return c.json({
      ...data,
      plugins: data.plugins.map((plugin) => {
        const installedPlugin = installed.get(plugin.id);
        return {
          ...sanitizeMarketplacePluginForClient(plugin),
          installed: !!installedPlugin,
          installedVersion: installedPlugin?.version || null,
          canInstall: isMarketplacePluginInstallable(plugin, marketplace),
        };
      }),
    });
  });

  route.get("/plugins/marketplace/:id/readme", async (c) => {
    const marketplace = getMarketplace();
    try {
      const readme = await marketplace.getReadme(c.req.param("id"));
      if (readme === null) return c.json({ error: "not found" }, 404);
      return c.json({ pluginId: c.req.param("id"), markdown: readme });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/plugins/marketplace/:id/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const marketplace = getMarketplace();
    const plugin = await marketplace.getPlugin(c.req.param("id"));
    if (!plugin) return c.json({ error: "not found" }, 404);
    const sourcePath = marketplace.resolveSourceDistribution(plugin);
    const { sessionPath } = await c.req.json().catch(() => ({}));
    try {
      const installPath = sourcePath || await downloadMarketplaceRelease({ engine, plugin });
      const entry = await installPluginFromPath({ engine, pm, sourcePath: installPath, sessionPath });
      return c.json(entry);
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.get("/plugins/:id/config-schema", (c) => {
    const pm = engine.pluginManager;
    const schema = pm?.getConfigSchema(c.req.param("id"));
    if (!schema) return c.json({ error: "not found" }, 404);
    return c.json(schema);
  });

  route.get("/plugins/:id/config", (c) => {
    const pm = engine.pluginManager;
    const config = pm?.getConfig(c.req.param("id"), {
      scope: c.req.query("scope") || "global",
      agentId: c.req.query("agentId") || undefined,
      sessionPath: c.req.query("sessionPath") || undefined,
    });
    if (!config) return c.json({ error: "not found" }, 404);
    return c.json(config);
  });

  route.put("/plugins/:id/config", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const body = await c.req.json();
    try {
      const { values, scope, agentId, sessionPath } = decodeHttpConfigBody(body);
      const config = pm.setConfig(c.req.param("id"), values, {
        scope,
        agentId,
        sessionPath,
      });
      const { rawValues: _rawValues, ...safeConfig } = config;
      return c.json(safeConfig);
    } catch (err) {
      if (err?.code === "PLUGIN_CONFIG_INVALID") {
        return c.json({ error: err.message, code: err.code, fields: err.errors || [] }, 400);
      }
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Plugin install ──
  route.post("/plugins/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const { path: sourcePath, sessionPath } = await c.req.json();
    if (!sourcePath) return c.json({ error: "path is required" }, 400);

    try {
      return c.json(await installPluginFromPath({ engine, pm, sourcePath, sessionPath }));
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  // ── Plugin delete ──
  route.delete("/plugins/:id", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    try {
      const pluginDir = await pm.removePlugin(id);
      await engine.syncPluginExtensions();
      if (pluginDir && fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Plugin enable/disable ──
  route.put("/plugins/:id/enabled", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    const { enabled } = await c.req.json();
    try {
      if (enabled) {
        await pm.enablePlugin(id);
      } else {
        await pm.disablePlugin(id);
      }
      await engine.syncPluginExtensions();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Global plugin settings ──
  route.get("/plugins/settings", (c) => {
    const pm = engine.pluginManager;
    return c.json({
      allow_full_access: pm?.getAllowFullAccess() || false,
      plugins_dir: pm?.getUserPluginsDir() || "",
    });
  });

  route.put("/plugins/settings", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const { allow_full_access } = await c.req.json();
    if (typeof allow_full_access === "boolean") {
      await pm.setFullAccess(allow_full_access);
      await engine.syncPluginExtensions();
    }
    return c.json(visiblePlugins(pm, { source: "community" }));
  });

  // ── Plugin UI panel endpoints ──

  route.get("/plugins/pages", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const pages = pm.getPages().map(p => ({
      pluginId: p.pluginId,
      title: p.title,
      icon: p.icon,
      routeUrl: `/api/plugins/${p.pluginId}${p.route}`,
      hostCapabilities: Array.isArray(p.hostCapabilities) ? p.hostCapabilities : [],
    }));
    return c.json(pages);
  });

  route.get("/plugins/widgets", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const widgets = pm.getWidgets().map(w => ({
      pluginId: w.pluginId,
      title: w.title,
      icon: w.icon,
      routeUrl: `/api/plugins/${w.pluginId}${w.route}`,
      hostCapabilities: Array.isArray(w.hostCapabilities) ? w.hostCapabilities : [],
    }));
    return c.json(widgets);
  });

  route.get("/plugins/ui-host-capabilities", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    return c.json(pm.getUiHostCapabilityGrants?.() || []);
  });

  route.get("/plugins/settings-tabs", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const tabs = pm.getSettingsTabs().map(t => ({
      pluginId: t.pluginId,
      id: t.id,
      title: t.title,
      icon: t.icon,
      nativeComponent: t.nativeComponent,
    }));
    return c.json(tabs);
  });

  route.get("/plugins/theme.css", (c) => {
    const theme = c.req.query("theme") || DEFAULT_THEME;
    // Sanitize theme name to prevent path traversal
    const safeName = path.basename(theme).replace(/[^a-zA-Z0-9_-]/g, "");
    const candidates = [
      fromRoot("desktop", "src", "themes", `${safeName}.css`),
      fromRoot("desktop", "dist-renderer", "themes", `${safeName}.css`),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) {
      c.header("Content-Type", "text/css");
      return c.body("/* theme not found */");
    }
    let css = fs.readFileSync(found, "utf-8");
    // Flatten selectors for iframe consumption:
    // [data-theme="xxx"], :root:not([data-theme]) → :root
    // [data-theme="xxx"] → :root
    css = css.replace(/\[data-theme="[^"]*"\](?:,\s*:root:not\(\[data-theme\]\))?/g, ":root");
    c.header("Content-Type", "text/css");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(css);
  });

  // ── Plugin route proxy (catch-all last) ──

  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = engine.pluginManager?.getRouteApp(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    const url = new URL(c.req.url);
    const prefix = `/plugins/${pluginId}`;
    const prefixIndex = url.pathname.indexOf(prefix);
    const subPath = prefixIndex !== -1
      ? url.pathname.slice(prefixIndex + prefix.length) || "/"
      : "/";
    await engine.pluginManager?.activatePluginRoute?.(pluginId, subPath);
    const agent = resolveAgent(engine, c);
    const agentId = agent?.id || null;
    return proxyToPlugin(c, pluginApp, pluginId, agentId);
  });

  return route;
}
