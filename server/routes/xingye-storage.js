/**
 * xingye-storage.js — 星野应用数据受限文件 API
 *
 * 仅允许访问当前 agent workspace 下的 `.xingye/`（Desk subdir 禁止以「.」开头，故不走 /api/desk/files）。
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { realPath } from "../utils/path-security.js";
import { resolveAgent } from "../utils/resolve-agent.js";
import { normalizeWorkspacePath } from "../../shared/workspace-history.js";

const XINGYE_ROOT_DIR = ".xingye";

function workspaceRootForAgent(engine, agent) {
  const ws = engine.getHomeCwd?.(agent.id);
  return normalizeWorkspacePath(ws);
}

function xingyeBaseDir(workspaceRoot) {
  return path.join(workspaceRoot, XINGYE_ROOT_DIR);
}

/**
 * @param {string} baseReal
 * @param {string} relativePath
 * @returns {string|null}
 */
function safeResolveUnderXingye(baseReal, relativePath) {
  const rel = String(relativePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) return baseReal;
  const segments = rel.split("/").filter(Boolean);
  for (const seg of segments) {
    if (seg === "..") return null;
  }
  const joined = path.join(baseReal, ...segments);
  const resolved = path.resolve(joined);
  const prefix = baseReal.endsWith(path.sep) ? baseReal : baseReal + path.sep;
  if (resolved !== baseReal && !resolved.startsWith(prefix)) return null;
  return resolved;
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
    const relativePath = typeof body?.relativePath === "string" ? body.relativePath : "";
    const agentIdHint = typeof body?.agentId === "string" ? body.agentId : null;

    if (!["read", "write", "append", "list", "delete"].includes(action)) {
      return c.json({ error: "invalid action" }, 400);
    }

    let agent;
    try {
      if (agentIdHint) {
        const found = engine.getAgent?.(agentIdHint);
        if (!found) return c.json({ error: `agent "${agentIdHint}" not found` }, 404);
        agent = found;
      } else {
        agent = resolveAgent(engine, c);
      }
    } catch (err) {
      const status = err?.status || 404;
      return c.json({ error: err.message || "agent not found" }, status);
    }

    const workspaceRoot = workspaceRootForAgent(engine, agent);
    if (!workspaceRoot) {
      return c.json({ error: "no workspace for agent" }, 400);
    }

    const base = xingyeBaseDir(workspaceRoot);
    const baseReal = realPath(base) || base;
    try {
      fs.mkdirSync(baseReal, { recursive: true });
    } catch (err) {
      return c.json({ error: `mkdir failed: ${err.message}` }, 500);
    }

    const target = safeResolveUnderXingye(baseReal, relativePath);
    if (!target) {
      return c.json({ error: "invalid relativePath" }, 400);
    }

    try {
      switch (action) {
        case "list": {
          let stat;
          try {
            stat = await fs.promises.stat(target);
          } catch (e) {
            if (e?.code === "ENOENT") return c.json({ entries: [] });
            throw e;
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
            } catch { /* skip */ }
          }
          entries.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
          return c.json({ ok: true, entries });
        }
        case "read": {
          let buf;
          try {
            buf = await fs.promises.readFile(target);
          } catch (e) {
            if (e?.code === "ENOENT") return c.json({ ok: true, content: null, missing: true });
            throw e;
          }
          const binaryHint = body?.binary === true || /\.(png|jpe?g|webp|gif|bin)$/i.test(target);
          if (binaryHint) {
            return c.json({
              ok: true,
              encoding: "base64",
              content: buf.toString("base64"),
            });
          }
          return c.json({ ok: true, encoding: "utf8", content: buf.toString("utf-8") });
        }
        case "write": {
          const encoding = body?.encoding === "base64" ? "base64" : "utf8";
          const content = body?.content;
          if (content === undefined || content === null) {
            return c.json({ error: "content required" }, 400);
          }
          const dir = path.dirname(target);
          await fs.promises.mkdir(dir, { recursive: true });
          const data = encoding === "base64" ? Buffer.from(String(content), "base64") : Buffer.from(String(content), "utf-8");
          const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
          await fs.promises.writeFile(tmp, data);
          await fs.promises.rename(tmp, target);
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
            const st = await fs.promises.stat(target);
            if (st.isDirectory()) {
              await fs.promises.rm(target, { recursive: true, force: true });
            } else {
              await fs.promises.unlink(target);
            }
          } catch (e) {
            if (e?.code !== "ENOENT") throw e;
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
