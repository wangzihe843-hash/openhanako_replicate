/**
 * Restricted Xingye file API.
 *
 * Business data is agent-scoped:
 *   HANA_HOME/agents/{agentId}/xingye/
 *
 * The client provides only agentId, action, and a relative path. This route
 * does not reuse /api/desk/files and does not write workspace .xingye data.
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { syncXingyeStableLoreMemoryFile } from "../../shared/xingye-lore-memory-file.js";
import { safeJson } from "../hono-helpers.js";
import { realPath } from "../utils/path-security.js";

const XINGYE_ROOT_DIR = "xingye";
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const ACTIONS = new Set([
  "readJson",
  "writeJson",
  "appendJsonl",
  "listJsonl",
  "read",
  "write",
  "append",
  "list",
  "delete",
]);

function isSafeAgentId(agentId) {
  return typeof agentId === "string" && SAFE_AGENT_ID_RE.test(agentId);
}

function xingyeBaseDir(engine, agentId) {
  return path.join(engine.agentsDir, agentId, XINGYE_ROOT_DIR);
}

function isInsideBase(realTarget, realBase) {
  if (!realTarget || !realBase) return false;
  const prefix = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
  return realTarget === realBase || realTarget.startsWith(prefix);
}

function realPathAllowMissing(target) {
  const abs = path.resolve(target);
  try {
    return fs.realpathSync(abs);
  } catch (err) {
    if (err?.code !== "ENOENT") return null;

    const pending = [];
    let current = abs;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      pending.push(path.basename(current));
      try {
        const realParent = fs.realpathSync(parent);
        pending.reverse();
        return path.join(realParent, ...pending);
      } catch (e) {
        if (e?.code !== "ENOENT") return null;
        current = parent;
      }
    }
  }
}

function safeResolveUnderXingye(baseReal, relativePath, { allowEmpty = false } = {}) {
  const raw = String(relativePath ?? "");
  if (!raw) return allowEmpty ? baseReal : null;
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return null;

  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (!segments.length) return allowEmpty ? baseReal : null;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return null;
  }

  let decoded = raw;
  try {
    for (let i = 0; i < 3; i += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return null;
  }
  if (decoded !== raw) {
    if (path.isAbsolute(decoded) || /^[A-Za-z]:[\\/]/.test(decoded)) return null;
    const decodedSegments = decoded.split(/[\\/]+/).filter(Boolean);
    if (!decodedSegments.length) return allowEmpty ? baseReal : null;
    for (const segment of decodedSegments) {
      if (segment === "." || segment === "..") return null;
    }
  }

  const target = path.resolve(path.join(baseReal, ...segments));
  const prefix = baseReal.endsWith(path.sep) ? baseReal : baseReal + path.sep;
  if (target !== baseReal && !target.startsWith(prefix)) return null;

  const realTarget = realPathAllowMissing(target);
  if (!realTarget || !isInsideBase(realTarget, baseReal)) return null;
  return target;
}

async function readUtf8OrMissing(target) {
  try {
    return { missing: false, content: await fs.promises.readFile(target, "utf-8") };
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true, content: null };
    throw error;
  }
}

async function atomicWrite(target, data) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, target);
}

function isAgentLoreEntriesJsonPath(relativePath) {
  return String(relativePath ?? "").replace(/\\/g, "/") === "lore/entries.json";
}

/**
 * OpenHanako engine uses `agentsDir === join(hanakoHome, "agents")`.
 * Derive hanakoHome only from `agentsDir` (do not read `engine.hanakoHome` / `engine.agentsHome`).
 */
function resolveHanakoHomeFromAgentsDir(agentsDir) {
  if (typeof agentsDir !== "string") return null;
  const trimmed = agentsDir.trim();
  if (!trimmed) return null;
  return path.dirname(path.resolve(trimmed));
}

export function createXingyeStorageRoute(engine) {
  const route = new Hono();

  route.post("/xingye/storage", async (c) => {
    let body;
    try {
      body = await safeJson(c);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    const action = body?.action;
    const agentId = typeof body?.agentId === "string" ? body.agentId : "";
    const relativePath = typeof body?.relativePath === "string" ? body.relativePath : "";

    if (!ACTIONS.has(action)) {
      return c.json({ error: "invalid action" }, 400);
    }
    if (!agentId) {
      return c.json({ error: "agentId is required" }, 400);
    }
    if (!isSafeAgentId(agentId)) {
      return c.json({ error: "invalid agentId" }, 400);
    }
    if (!engine.getAgent?.(agentId)) {
      return c.json({ error: `agent "${agentId}" not found` }, 404);
    }

    const base = xingyeBaseDir(engine, agentId);
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch (err) {
      return c.json({ error: `mkdir failed: ${err.message}` }, 500);
    }
    const baseReal = realPath(base);
    if (!baseReal) {
      return c.json({ error: "xingye root unavailable" }, 500);
    }

    const target = safeResolveUnderXingye(baseReal, relativePath, { allowEmpty: action === "list" });
    if (!target) {
      return c.json({ error: "invalid relativePath" }, 400);
    }

    try {
      switch (action) {
        case "readJson": {
          const { missing, content } = await readUtf8OrMissing(target);
          if (missing) return c.json({ ok: true, data: null, missing: true });
          try {
            return c.json({ ok: true, data: JSON.parse(content) });
          } catch {
            return c.json({ error: "invalid JSON file" }, 500);
          }
        }
        case "writeJson": {
          if (!Object.prototype.hasOwnProperty.call(body || {}, "data")) {
            return c.json({ error: "data required" }, 400);
          }
          await atomicWrite(target, Buffer.from(JSON.stringify(body.data, null, 2), "utf-8"));
          if (
            isAgentLoreEntriesJsonPath(relativePath)
            && body.data != null
            && typeof body.data === "object"
            && !Array.isArray(body.data)
          ) {
            const hanakoHome = resolveHanakoHomeFromAgentsDir(engine.agentsDir);
            if (!hanakoHome) {
              console.warn(
                `[xingye-storage] skip stable lore-memory sync (${agentId}): engine.agentsDir missing or invalid`,
              );
            } else {
              try {
                await syncXingyeStableLoreMemoryFile({
                  hanakoHome,
                  agentId,
                  entries: body.data,
                });
              } catch (err) {
                console.warn(
                  `[xingye-storage] sync stable lore-memory failed (${agentId}):`,
                  err?.message || err,
                );
              }
            }
          }
          return c.json({ ok: true });
        }
        case "appendJsonl": {
          if (!Object.prototype.hasOwnProperty.call(body || {}, "data")) {
            return c.json({ error: "data required" }, 400);
          }
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.appendFile(target, `${JSON.stringify(body.data)}\n`, "utf-8");
          return c.json({ ok: true });
        }
        case "listJsonl": {
          const { missing, content } = await readUtf8OrMissing(target);
          if (missing) return c.json({ ok: true, records: [] });
          const records = [];
          for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              records.push(JSON.parse(trimmed));
            } catch {
              // Skip malformed lines so one bad record does not hide history.
            }
          }
          return c.json({ ok: true, records });
        }
        case "list": {
          let stat;
          try {
            stat = await fs.promises.stat(target);
          } catch (error) {
            if (error?.code === "ENOENT") return c.json({ ok: true, entries: [] });
            throw error;
          }
          if (!stat.isDirectory()) {
            return c.json({ error: "not a directory" }, 400);
          }
          const names = await fs.promises.readdir(target);
          const entries = [];
          for (const name of names) {
            const full = path.join(target, name);
            try {
              const st = await fs.promises.stat(full);
              entries.push({
                name,
                isDir: st.isDirectory(),
                size: st.size,
                mtime: st.mtime.toISOString(),
              });
            } catch {
              // skip disappearing entries
            }
          }
          entries.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
          return c.json({ ok: true, entries });
        }
        case "read": {
          let buf;
          try {
            buf = await fs.promises.readFile(target);
          } catch (error) {
            if (error?.code === "ENOENT") return c.json({ ok: true, content: null, missing: true });
            throw error;
          }
          const binaryHint = body?.binary === true || /\.(png|jpe?g|webp|gif|bin)$/i.test(target);
          if (binaryHint) {
            return c.json({ ok: true, encoding: "base64", content: buf.toString("base64") });
          }
          return c.json({ ok: true, encoding: "utf8", content: buf.toString("utf-8") });
        }
        case "write": {
          const encoding = body?.encoding === "base64" ? "base64" : "utf8";
          const content = body?.content;
          if (content === undefined || content === null) {
            return c.json({ error: "content required" }, 400);
          }
          const data = encoding === "base64"
            ? Buffer.from(String(content), "base64")
            : Buffer.from(String(content), "utf-8");
          await atomicWrite(target, data);
          return c.json({ ok: true });
        }
        case "append": {
          if (typeof body?.content !== "string" || body.content === "") {
            return c.json({ error: "content required" }, 400);
          }
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.appendFile(target, body.content, "utf-8");
          return c.json({ ok: true });
        }
        case "delete": {
          try {
            const stat = await fs.promises.stat(target);
            if (stat.isDirectory()) {
              await fs.promises.rm(target, { recursive: true, force: true });
            } else {
              await fs.promises.unlink(target);
            }
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          return c.json({ ok: true });
        }
        default:
          return c.json({ error: "unsupported" }, 400);
      }
    } catch (err) {
      return c.json({ error: err.message || String(err) }, 500);
    }
  });

  return route;
}
