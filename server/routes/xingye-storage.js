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
import {
  appendXingyeEvent,
  appendXingyeEventOnce,
  withXingyeAgentEventLock,
} from "../../lib/xingye/events.js";
import { safeJson } from "../hono-helpers.ts";
import { realPath } from "../utils/path-security.ts";

const XINGYE_ROOT_DIR = "xingye";
/**
 * 渲染端 event log（events/log.json）的相对路径。
 *
 * 渲染端追加/标记消费走 appendEventLog / markEventConsumed 两个 action，二者都在
 * lib/xingye/events.js 的 per-agent 锁内做 read-modify-write，与服务端进程内的
 * appendXingyeEvent / heartbeat consumer 串行化——避免渲染端裸 readJson+writeJson
 * 与服务端 read→rename 交错，把 draft_proposed 之类事件静默吃掉（跨进程竞态）。
 * 字面量与 desktop 端 XINGYE_EVENT_LOG_RELATIVE_PATH 保持一致。
 */
const XINGYE_EVENT_LOG_RELATIVE_PATH = "events/log.json";
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
/**
 * 「用户本人」的保留存储作用域。
 *
 * 朋友圈支持「用户以自己身份发帖」后，用户的帖子存在 agents/__user__/xingye/ 下。
 * 用户没有 agent 记录，engine.getAgent("__user__") 查不到——故该 id 跳过 agent 存在性
 * 校验，但仍要过 SAFE_AGENT_ID_RE 与全部路径安全检查。
 *
 * 字面量与 desktop 端 XINGYE_MOMENT_USER_AUTHOR_ID、xingye-state-store 的
 * USER_TARGET_ID 保持一致（"__user__"），双下划线包裹不会和真实角色 id 冲突。
 */
const RESERVED_USER_SCOPE_ID = "__user__";
const ACTIONS = new Set([
  "readJson",
  "writeJson",
  "appendJsonl",
  "listJsonl",
  "writeJsonl",
  "deleteJsonlRecord",
  "read",
  "write",
  "append",
  "list",
  "delete",
  "appendEventLog",
  "markEventConsumed",
]);

function isSafeAgentId(agentId) {
  return typeof agentId === "string" && SAFE_AGENT_ID_RE.test(agentId);
}

/** appendEventLog 的 event 入参：必须是普通对象（具体字段交给 events.js 归一化/校验）。 */
function isInput(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

/** Align with desktop `normalizeRecord` / listJsonl: stable string ids for JSONL rows. */
function jsonlRecordFieldAsString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** `secret-space/dream.jsonl` → `dream` (forward slashes). */
function secretSpaceCategoryFromJsonlRelativePath(relativePath) {
  const norm = String(relativePath ?? "").replace(/\\/g, "/");
  const m = /^secret-space\/([^/]+)\.jsonl$/.exec(norm);
  return m ? m[1] : null;
}

function isAgentLoreEntriesJsonPath(relativePath) {
  return String(relativePath ?? "").replace(/\\/g, "/") === "lore/entries.json";
}

/** events/log.json（接受反斜杠写法）—— 只有这个文件能走 appendEventLog/markEventConsumed。 */
function isXingyeEventLogPath(relativePath) {
  return String(relativePath ?? "").replace(/\\/g, "/") === XINGYE_EVENT_LOG_RELATIVE_PATH;
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
    // 保留作用域 __user__（用户本人）没有 agent 记录，跳过存在性校验；其余 id 仍需是已注册角色。
    if (agentId !== RESERVED_USER_SCOPE_ID && !engine.getAgent?.(agentId)) {
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
          // entries.json 落盘 + 派生 lore-memory.md 同步必须作为一个 per-agent 原子段：lore/entries.json
          // 的 syncXingyeStableLoreMemoryFile 本身是对 lore-memory.md 的无锁 RMW，两个并发 writeJson 交错会
          // 让 lore-memory.md（core/agent.js 注入的 '# 星野核心设定' prompt 来源）与 entries.json 失配。
          // 与 writeJsonl/deleteJsonlRecord 同锁串行化；锁段不嵌套取锁（sync 内部不再取同锁），无死锁。
          await withXingyeAgentEventLock(agentId, async () => {
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
          });
          return c.json({ ok: true });
        }
        case "appendJsonl": {
          if (!Object.prototype.hasOwnProperty.call(body || {}, "data")) {
            return c.json({ error: "data required" }, 400);
          }
          // 追加也要进 per-agent 锁：与持锁的 writeJsonl/deleteJsonlRecord（read→filter→atomicWrite
          // RMW）串行化。否则 RMW 读完快照、rename 之前，这里 appendFile 插进去的新行会被基于旧快照的
          // rename 静默覆盖丢失（commit 57292f8a 修过对称方向，独漏这条 append→RMW 方向）。O_APPEND
          // 对并发 append 本就原子、服务端 *-drafts.js append 也已持同锁，问题只在「无锁 append vs 持锁整表
          // RMW」。锁段不嵌套取锁，无死锁。
          await withXingyeAgentEventLock(agentId, async () => {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await fs.promises.appendFile(target, `${JSON.stringify(body.data)}\n`, "utf-8");
          });
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
        case "writeJsonl": {
          if (!Array.isArray(body?.records)) {
            return c.json({ error: "records required" }, 400);
          }
          const content = body.records.length
            ? `${body.records.map((record) => JSON.stringify(record)).join("\n")}\n`
            : "";
          // 渲染端整表覆写（确认/丢弃草稿等）也要进 per-agent 锁：否则会和服务端持锁的
          // *-drafts.js append（如 heartbeat 追加 drafts.jsonl）交错，把刚追加的草稿行
          // 静默覆盖掉。串行化的只是这一次 atomicWrite，不跨无关 await。
          await withXingyeAgentEventLock(agentId, async () => {
            await atomicWrite(target, Buffer.from(content, "utf-8"));
          });
          return c.json({ ok: true });
        }
        case "deleteJsonlRecord": {
          const recordId = typeof body?.recordId === "string" ? body.recordId.trim() : "";
          if (!recordId) {
            return c.json({ error: "recordId is required" }, 400);
          }
          // 渲染端删除单行（确认后清掉草稿等）是 read→filter→atomicWrite 的 RMW：必须进
          // per-agent 锁，与服务端持锁的 *-drafts.js append 串行化，否则两者交错会把刚 append
          // 的草稿行连带覆盖丢失。锁只罩这一段 RMW，纯查询/过滤的本地 helper 不会再取锁。
          const deleted = await withXingyeAgentEventLock(agentId, async () => {
            const { missing, content } = await readUtf8OrMissing(target);
            if (missing) return false;
            const lines = content.split(/\r?\n/);
            const kept = [];
            let removed = false;
            const catFromPath = secretSpaceCategoryFromJsonlRelativePath(relativePath);
            /** Same ordering as listJsonl: only successfully parsed JSON lines get indices (0, 1, …). */
            let parsedSuccessIndex = 0;
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) {
                kept.push(line);
                continue;
              }
              let obj;
              try {
                obj = JSON.parse(trimmed);
              } catch {
                kept.push(line);
                continue;
              }
              const rowKey = jsonlRecordFieldAsString(obj?.key);
              const rowId = jsonlRecordFieldAsString(obj?.id);
              const idMatch = rowKey === recordId || rowId === recordId;
              const syntheticEligible = !rowKey && !rowId;
              const syntheticId = catFromPath ? `${catFromPath}-${parsedSuccessIndex}` : null;
              const syntheticMatch = Boolean(
                syntheticEligible && syntheticId != null && recordId === syntheticId,
              );
              const isMatch = !removed && (idMatch || syntheticMatch);
              if (isMatch) {
                removed = true;
              } else {
                kept.push(line);
              }
              parsedSuccessIndex += 1;
            }
            if (!removed) return false;
            const out = kept.join("\n");
            await atomicWrite(target, Buffer.from(out === "" ? "" : `${out}\n`, "utf-8"));
            return true;
          });
          return c.json({ ok: true, deleted });
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
        case "appendEventLog": {
          // 渲染端追加事件：复用 lib/xingye/events.js 里带 per-agent 锁的 append helper，
          // 让渲染端来源的写入与服务端来源（pinned 工具、heartbeat consumer 等）串行化。
          if (!isXingyeEventLogPath(relativePath)) {
            return c.json({ error: "appendEventLog only supports events/log.json" }, 400);
          }
          const input = body?.event;
          if (!isInput(input)) {
            return c.json({ error: "event required" }, 400);
          }
          // events.js 自己从 agentDir 推 events/log.json，不用 target。
          const targetAgentDir = path.join(engine.agentsDir, agentId);
          const dedupeKey = typeof body?.dedupeKey === "string" ? body.dedupeKey.trim() : "";
          const event = dedupeKey
            ? await appendXingyeEventOnce({ agentDir: targetAgentDir, agentId, input, dedupeKey })
            : await appendXingyeEvent({ agentDir: targetAgentDir, agentId, input });
          if (!event) {
            return c.json({ error: "invalid event" }, 400);
          }
          return c.json({ ok: true, event });
        }
        case "markEventConsumed": {
          // 渲染端把某事件标记为已被某 consumer 消费：read-modify-write 同样要进 per-agent 锁，
          // 否则会和并发 append 交错把对方写入吃掉（与 heartbeat consumer 用同一把锁）。
          if (!isXingyeEventLogPath(relativePath)) {
            return c.json({ error: "markEventConsumed only supports events/log.json" }, 400);
          }
          const eventId = typeof body?.eventId === "string" ? body.eventId.trim() : "";
          const consumer = typeof body?.consumer === "string" ? body.consumer.trim() : "";
          if (!eventId || !consumer) {
            return c.json({ error: "eventId and consumer are required" }, 400);
          }
          const updated = await withXingyeAgentEventLock(agentId, async () => {
            const { missing, content } = await readUtf8OrMissing(target);
            if (missing) return null;
            let raw;
            try {
              raw = JSON.parse(content);
            } catch {
              return null;
            }
            const events = raw && Array.isArray(raw.events) ? raw.events : [];
            const index = events.findIndex((e) => e && e.id === eventId);
            if (index < 0) return null;
            const next = {
              ...events[index],
              consumedBy: {
                ...(events[index]?.consumedBy ?? {}),
                [consumer]: new Date().toISOString(),
              },
            };
            events[index] = next;
            await atomicWrite(
              target,
              Buffer.from(`${JSON.stringify({ ...raw, version: 1, events }, null, 2)}\n`, "utf-8"),
            );
            return next;
          });
          return c.json({ ok: true, event: updated });
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
