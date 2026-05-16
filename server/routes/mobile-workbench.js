import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { serveFileContent } from "../http/file-content.js";
import { realPath } from "../utils/path-security.js";

const SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
]);
const SEARCH_LIMIT = 80;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function createMobileWorkbenchRoute(engine) {
  const route = new Hono();

  route.get("/mobile/workbench/files", async (c) => {
    const root = resolveRoot(engine, c.req.query("rootId"));
    const subdir = normalizeSubdirOrError(c.req.query("subdir") || "");
    if (subdir.error) return c.json({ error: subdir.error }, 400);
    const dir = resolveInsideRoot(root.path, subdir.value);
    if (!dir) return c.json({ error: "invalid_path" }, 400);
    return c.json({
      rootId: root.id,
      subdir: subdir.value,
      files: await listFiles(dir),
    });
  });

  route.get("/mobile/workbench/search", async (c) => {
    const root = resolveRoot(engine, c.req.query("rootId"));
    const q = String(c.req.query("q") || "").trim();
    if (!q) return c.json({ rootId: root.id, query: "", results: [] });
    return c.json({
      rootId: root.id,
      query: q,
      results: await searchFiles(root.path, q),
    });
  });

  route.get("/mobile/workbench/content", (c) => serveContent(c, engine, false));
  route.on("HEAD", "/mobile/workbench/content", (c) => serveContent(c, engine, true));

  route.post("/mobile/workbench/actions", async (c) => {
    const body = await safeJson(c);
    const root = resolveRoot(engine, body.rootId);
    const subdir = normalizeSubdirOrError(body.subdir || "");
    if (subdir.error) return c.json({ error: subdir.error }, 400);
    const dir = resolveInsideRoot(root.path, subdir.value);
    if (!dir) return c.json({ error: "invalid_path" }, 400);
    fs.mkdirSync(dir, { recursive: true });

    try {
      switch (body.action) {
        case "mkdir":
          return c.json(await mkdirAction(root, dir, body));
        case "create":
        case "writeText":
          return c.json(await writeTextAction(engine, root, dir, body));
        case "rename":
          return c.json(await renameAction(root, dir, body));
        case "move":
          return c.json(await moveAction(root, dir, body));
        case "safeDelete":
          return c.json(await safeDeleteAction(engine, root, dir, subdir.value, body));
        default:
          return c.json({ error: "unknown_action" }, 400);
      }
    } catch (err) {
      return c.json({ error: err.code || "file_action_failed", detail: err.message }, err.status || 400);
    }
  });

  route.post("/mobile/workbench/upload", async (c) => {
    const body = await safeJson(c);
    const root = resolveRoot(engine, body.rootId);
    const subdir = normalizeSubdirOrError(body.subdir || "");
    if (subdir.error) return c.json({ error: subdir.error }, 400);
    const dir = resolveInsideRoot(root.path, subdir.value);
    if (!dir) return c.json({ error: "invalid_path" }, 400);
    fs.mkdirSync(dir, { recursive: true });

    const files = Array.isArray(body.files) ? body.files : [body];
    const results = [];
    for (const file of files) {
      try {
        const name = normalizePlainNameOrThrow(file.name);
        const contentBase64 = String(file.contentBase64 || "");
        if (!contentBase64) throw routeError("contentBase64 required", "invalid_upload", 400);
        const buffer = Buffer.from(contentBase64, "base64");
        if (buffer.byteLength > MAX_UPLOAD_BYTES) throw routeError("file too large", "file_too_large", 413);
        const target = resolveFileTarget(root.path, dir, name);
        if (!target) throw routeError("invalid path", "invalid_path", 400);
        fs.writeFileSync(target, buffer);
        results.push({ name, ok: true, size: buffer.byteLength });
      } catch (err) {
        results.push({ name: file?.name || null, ok: false, error: err.code || "upload_failed" });
      }
    }
    return c.json({ ok: results.every((item) => item.ok), rootId: root.id, results, files: await listFiles(dir) });
  });

  return route;
}

function serveContent(c, engine, headOnly) {
  try {
    const root = resolveRoot(engine, c.req.query("rootId"));
    const subdir = normalizeSubdirOrError(c.req.query("subdir") || "");
    if (subdir.error) return c.json({ error: subdir.error }, 400);
    const name = normalizePlainNameOrThrow(c.req.query("name"));
    const dir = resolveInsideRoot(root.path, subdir.value);
    if (!dir) return c.json({ error: "invalid_path" }, 400);
    const filePath = resolveFileTarget(root.path, dir, name);
    if (!filePath) return c.json({ error: "invalid_path" }, 400);
    if (!fs.existsSync(filePath)) return c.json({ error: "file_not_found" }, 404);
    return serveFileContent(c, { filePath, filename: name, headOnly });
  } catch (err) {
    return c.json({ error: err.code || "content_failed", detail: err.message }, err.status || 400);
  }
}

async function listFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      items.push({
        name: entry.name,
        isDir: entry.isDirectory(),
        size: entry.isDirectory() ? null : stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`[mobile-workbench] stat failed: ${err.message}`);
    }
  }
  return items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
}

async function searchFiles(rootPath, query) {
  const needle = query.toLowerCase();
  const results = [];
  async function walk(dir) {
    if (results.length >= SEARCH_LIMIT) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    for (const entry of entries) {
      if (results.length >= SEARCH_LIMIT) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = toPortableRelative(rootPath, fullPath);
      const parentSubdir = toPortableRelative(rootPath, path.dirname(fullPath));
      if (entry.name.toLowerCase().includes(needle)) {
        try {
          const stat = await fs.promises.stat(fullPath);
          results.push({
            name: entry.name,
            relativePath,
            parentSubdir,
            isDir: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch {}
      }
      if (entry.isDirectory()) await walk(fullPath);
    }
  }
  await walk(rootPath);
  return results.slice(0, SEARCH_LIMIT);
}

async function mkdirAction(root, dir, body) {
  const name = normalizePlainNameOrThrow(body.name);
  const target = resolveFileTarget(root.path, dir, name);
  if (!target) throw routeError("invalid path", "invalid_path", 400);
  fs.mkdirSync(target, { recursive: false });
  return { ok: true, action: "mkdir", rootId: root.id, files: await listFiles(dir) };
}

async function writeTextAction(engine, root, dir, body) {
  const name = normalizePlainNameOrThrow(body.name);
  const target = resolveFileTarget(root.path, dir, name);
  if (!target) throw routeError("invalid path", "invalid_path", 400);
  if (fs.existsSync(target) && typeof engine.createUserEditCheckpoint === "function") {
    await engine.createUserEditCheckpoint({ filePath: target, reason: "mobile-workbench-edit" }).catch(() => null);
  }
  fs.writeFileSync(target, String(body.content ?? ""), "utf-8");
  return { ok: true, action: body.action, rootId: root.id, files: await listFiles(dir) };
}

async function renameAction(root, dir, body) {
  const oldName = normalizePlainNameOrThrow(body.oldName);
  const newName = normalizePlainNameOrThrow(body.newName);
  const source = resolveFileTarget(root.path, dir, oldName);
  const target = resolveFileTarget(root.path, dir, newName);
  if (!source || !target) throw routeError("invalid path", "invalid_path", 400);
  fs.renameSync(source, target);
  return { ok: true, action: "rename", rootId: root.id, files: await listFiles(dir) };
}

async function moveAction(root, dir, body) {
  const name = normalizePlainNameOrThrow(body.name);
  const destSubdir = normalizeSubdirOrError(body.destSubdir || "");
  if (destSubdir.error) throw routeError(destSubdir.error, destSubdir.error, 400);
  const source = resolveFileTarget(root.path, dir, name);
  const destDir = resolveInsideRoot(root.path, destSubdir.value);
  if (!source || !destDir) throw routeError("invalid path", "invalid_path", 400);
  fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(source, path.join(destDir, name));
  return { ok: true, action: "move", rootId: root.id, files: await listFiles(dir) };
}

async function safeDeleteAction(engine, root, dir, subdir, body) {
  const name = normalizePlainNameOrThrow(body.name);
  const source = resolveFileTarget(root.path, dir, name);
  if (!source || !fs.existsSync(source)) throw routeError("file not found", "file_not_found", 404);
  const trashId = `trash_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const trashDir = path.join(engine.hanakoHome, "trash", "mobile-workbench", trashId);
  fs.mkdirSync(trashDir, { recursive: true });
  const payloadPath = path.join(trashDir, "payload");
  fs.renameSync(source, payloadPath);
  fs.writeFileSync(path.join(trashDir, "metadata.json"), JSON.stringify({
    schemaVersion: 1,
    trashId,
    rootId: root.id,
    originalName: name,
    originalSubdir: subdir,
    deletedAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf-8");
  return { ok: true, action: "safeDelete", rootId: root.id, trashId, files: await listFiles(dir) };
}

function resolveRoot(engine, rootId) {
  const id = typeof rootId === "string" && rootId.trim() ? rootId.trim() : "default";
  if (id !== "default") throw routeError("unknown root", "unknown_root", 404);
  const rootPath = engine.defaultDeskCwd || engine.homeCwd || engine.deskCwd;
  if (!rootPath) throw routeError("no workspace", "no_workspace", 400);
  fs.mkdirSync(rootPath, { recursive: true });
  return { id, path: rootPath };
}

function resolveInsideRoot(rootPath, subdir) {
  const rootReal = realPath(rootPath);
  if (!rootReal) return null;
  const target = subdir ? path.join(rootPath, subdir) : rootPath;
  const targetReal = realPath(target);
  if (targetReal) {
    return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep) ? targetReal : null;
  }
  const parentReal = realPath(path.dirname(target));
  if (!parentReal) return null;
  const full = path.join(parentReal, path.basename(target));
  return full === rootReal || full.startsWith(rootReal + path.sep) ? full : null;
}

function resolveFileTarget(rootPath, dir, name) {
  const target = path.join(dir, name);
  const rootReal = realPath(rootPath);
  if (!rootReal) return null;
  const resolved = realPath(target);
  if (resolved) return resolved === rootReal || resolved.startsWith(rootReal + path.sep) ? resolved : null;
  const parentReal = realPath(path.dirname(target));
  if (!parentReal) return null;
  const full = path.join(parentReal, path.basename(target));
  return full === rootReal || full.startsWith(rootReal + path.sep) ? full : null;
}

function normalizeSubdirOrError(value) {
  const raw = String(value || "").replace(/^\/+|\/+$/g, "");
  if (!raw) return { value: "" };
  if (raw.includes("\\") || raw.split("/").some((part) => part === ".." || part === "." || part.startsWith("."))) {
    return { error: "invalid_subdir" };
  }
  return { value: raw };
}

function normalizePlainNameOrThrow(value) {
  const name = String(value || "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.startsWith(".")) {
    throw routeError("invalid name", "invalid_name", 400);
  }
  return name;
}

function toPortableRelative(root, target) {
  return path.relative(root, target).split(path.sep).filter(Boolean).join("/");
}

function routeError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}
