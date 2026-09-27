/** Agent-scoped, reviewable inputs for proactive Xingye conversation. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readPinnedMemoryItems } from "../memory/pinned-memory-store.ts";

const locks = new Map();
const DAY = 24 * 60 * 60 * 1000;
export const TOPIC_CANDIDATES_RELATIVE_PATH = path.join("xingye", "heartbeat", "topic-candidates.json");
const MAX_TEXT = 280;

function limitedText(value, length = MAX_TEXT) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, length) : "";
}

function iso(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function withLock(agentDir, action) {
  const key = path.resolve(agentDir);
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.then(action, action);
  const settled = next.catch(() => {});
  locks.set(key, settled);
  settled.finally(() => { if (locks.get(key) === settled) locks.delete(key); });
  return next;
}

function fileFor(agentDir) { return path.join(agentDir, TOPIC_CANDIDATES_RELATIVE_PATH); }
function contentHash(content) { return crypto.createHash("sha256").update(content).digest("hex"); }

/** Read only: a direct file edit can bypass pinned_memory.changed events. */
function invalidateChangedPins(rows, agentDir, nowIso) {
  const selected = rows.filter((row) => row.sourceType === "shared_memory"
    && ["pending", "offered"].includes(row.status));
  if (selected.length === 0) return;
  let pins = null;
  try {
    const storeFile = path.join(agentDir, "pinned-memory.json");
    const storeStat = fs.statSync(storeFile);
    const markdownFile = path.join(agentDir, "pinned.md");
    if (fs.existsSync(markdownFile) && fs.statSync(markdownFile).mtimeMs > storeStat.mtimeMs + 1) {
      throw new Error("pinned Markdown changed outside the store");
    }
    const stored = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    if (stored?.version !== 1 || !Array.isArray(stored.items)) throw new Error("invalid pinned memory store");
    pins = new Map(stored.items.map((item) => [item.id, item.content]));
  } catch {
    // If the authoritative pin cannot be checked, never offer its content.
  }
  for (const row of selected) {
    const content = pins?.get(row.source?.pinId);
    if (typeof content === "string" && contentHash(content) === row.source?.contentHash) continue;
    row.status = "invalidated";
    row.updatedAt = nowIso;
  }
}

async function read(agentDir, agentId) {
  let raw;
  try { raw = JSON.parse(await fs.promises.readFile(fileFor(agentDir), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  if (raw?.version !== 1 || raw.agentId !== agentId || !Array.isArray(raw.candidates)) {
    throw new Error("invalid Xingye topic candidate store");
  }
  return raw.candidates.filter((row) => row && row.agentId === agentId && typeof row.id === "string");
}

async function write(agentDir, agentId, rows) {
  const file = fileFor(agentDir);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    await fs.promises.writeFile(tmp, `${JSON.stringify({ version: 1, agentId, candidates: rows }, null, 2)}\n`, "utf8");
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function candidateFromEvent(agentId, event) {
  const payload = event?.payload || {};
  let sourceType, title, reason, ttl;
  if (event.type === "news.entry_appended") {
    title = limitedText(payload.title, 100);
    sourceType = "world_event";
    reason = "角色世界中已写入的报纸事件；仅作为虚构世界内容";
    ttl = 3 * DAY;
  } else return null;
  if (!title || !iso(event.createdAt)) return null;
  const id = `evt-${crypto.createHash("sha256").update(event.id).digest("hex").slice(0, 24)}`;
  return {
    id, agentId, sceneId: null, sourceType,
    source: { eventId: event.id, subjectId: limitedText(event.subjectId, 120) || null, label: event.source },
    title, reason, createdAt: event.createdAt,
    expiresAt: new Date(Date.parse(event.createdAt) + ttl).toISOString(),
    status: "pending", offeredAt: null, lastUsedAt: null, updatedAt: event.createdAt,
  };
}

function refresh(rows, events, nowIso, agentId) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const event of events) {
    const fresh = candidateFromEvent(agentId, event);
    if (fresh && !byId.has(fresh.id)) byId.set(fresh.id, fresh);
    if (event.type === "news.entry_deleted" || event.type === "memory_candidate.deleted") {
      for (const row of byId.values()) {
        if (row.status === "pending" || row.status === "offered") {
          if (row.source?.subjectId && row.source.subjectId === event.subjectId) {
            row.status = "invalidated";
            row.updatedAt = nowIso;
          }
        }
      }
    }
    if (event.type === "pinned_memory.changed") {
      // The event does not identify which pin changed. Fail closed until the
      // user explicitly chooses a shared memory again.
      for (const row of byId.values()) {
        if (row.sourceType === "shared_memory" && ["pending", "offered"].includes(row.status)
          && Date.parse(event.createdAt) > Date.parse(row.createdAt)) {
          row.status = "invalidated";
          row.updatedAt = nowIso;
        }
      }
    }
  }
  for (const row of byId.values()) {
    if (["pending", "offered", "indeterminate"].includes(row.status) && Date.parse(row.expiresAt) <= Date.parse(nowIso)) {
      row.status = "expired";
      row.updatedAt = nowIso;
    }
  }
  // Keep terminal history long enough to explain suppression after event-log retention.
  return [...byId.values()].filter((row) =>
    row.status === "pending" || row.status === "offered" || Date.parse(row.updatedAt) > Date.parse(nowIso) - 30 * DAY,
  ).slice(-500);
}

export async function listTopicCandidates({ agentDir, agentId, now = new Date() }) {
  return withLock(agentDir, async () => {
    const nowIso = now.toISOString();
    const old = await read(agentDir, agentId);
    const rows = refresh(structuredClone(old), [], nowIso, agentId);
    invalidateChangedPins(rows, agentDir, nowIso);
    if (JSON.stringify(rows) !== JSON.stringify(old)) await write(agentDir, agentId, rows);
    return rows;
  });
}

/** Called by the existing heartbeat consumer after quiet/pause checks. Offering is durable. */
export async function offerTopicCandidates({ agentDir, agentId, events = [], sceneId = null, now = new Date(), limit = 3 }) {
  return withLock(agentDir, async () => {
    const nowIso = now.toISOString();
    const old = await read(agentDir, agentId);
    const rows = refresh(structuredClone(old), events, nowIso, agentId);
    invalidateChangedPins(rows, agentDir, nowIso);
    const offered = rows.filter((row) => row.status === "pending" && (!row.sceneId || row.sceneId === sceneId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
    for (const row of offered) { row.status = "offered"; row.offeredAt = nowIso; row.updatedAt = nowIso; }
    if (JSON.stringify(rows) !== JSON.stringify(old)) await write(agentDir, agentId, rows);
    return offered;
  });
}

/** A real-world source is added only by an explicit user request through the local API. */
export async function addRealityTopicCandidate({ agentDir, agentId, title, sourceUrl, reason, expiresAt, now = new Date() }) {
  const safeTitle = limitedText(title, 100);
  const safeReason = limitedText(reason, 180);
  let safeUrl;
  try { const parsed = new URL(sourceUrl); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); safeUrl = parsed.href; }
  catch { throw new Error("sourceUrl must be an HTTP(S) URL"); }
  const expiry = iso(expiresAt);
  if (!safeTitle || !safeReason || !expiry || Date.parse(expiry) <= now.getTime() || Date.parse(expiry) > now.getTime() + 7 * DAY) {
    throw new Error("title, reason and an expiry within seven days are required");
  }
  return withLock(agentDir, async () => {
    const rows = await read(agentDir, agentId);
    const existing = rows.find((row) => row.sourceType === "reality_source"
      && row.source?.url === safeUrl
      && ["pending", "offered", "indeterminate"].includes(row.status)
      && Date.parse(row.expiresAt) > now.getTime());
    if (existing) return existing;
    const row = {
      id: `user-${crypto.randomUUID()}`, agentId, sceneId: null, sourceType: "reality_source",
      source: { url: safeUrl, label: "user-selected reality source" },
      title: safeTitle, reason: safeReason, createdAt: now.toISOString(), expiresAt: expiry,
      status: "pending", offeredAt: null, lastUsedAt: null, updatedAt: now.toISOString(),
    };
    rows.push(row);
    await write(agentDir, agentId, rows.slice(-500));
    return row;
  });
}

/** Selecting a pin is a user action; arbitrary pinned facts are never projected automatically. */
export async function addSharedMemoryTopicCandidate({ agentDir, agentId, pinContent, reason, expiresAt, now = new Date() }) {
  const content = typeof pinContent === "string" ? pinContent.trim() : "";
  const safeReason = limitedText(reason, 180);
  const expiry = iso(expiresAt);
  if (!content || !safeReason || !expiry || Date.parse(expiry) <= now.getTime() || Date.parse(expiry) > now.getTime() + 14 * DAY) {
    throw new Error("pinContent, reason and an expiry within fourteen days are required");
  }
  return withLock(agentDir, async () => {
    const pin = readPinnedMemoryItems(agentDir).find((item) => item.content === content);
    if (!pin) throw new Error("confirmed memory not found");
    const rows = await read(agentDir, agentId);
    const existing = rows.find((row) => row.sourceType === "shared_memory"
      && row.source?.pinId === pin.id
      && ["pending", "offered", "indeterminate"].includes(row.status)
      && Date.parse(row.expiresAt) > now.getTime());
    if (existing) return existing;
    const row = {
      id: `user-${crypto.randomUUID()}`, agentId, sceneId: null, sourceType: "shared_memory",
      source: { pinId: pin.id, contentHash: contentHash(pin.content), label: "user-selected confirmed memory" },
      title: limitedText(content, 100), reason: safeReason, createdAt: now.toISOString(), expiresAt: expiry,
      status: "pending", offeredAt: null, lastUsedAt: null, updatedAt: now.toISOString(),
    };
    rows.push(row);
    await write(agentDir, agentId, rows.slice(-500));
    return row;
  });
}

export async function setTopicCandidateStatus({ agentDir, agentId, id, status, now = new Date() }) {
  if (!["used", "dismissed", "pending"].includes(status)) throw new Error("invalid topic candidate status");
  return withLock(agentDir, async () => {
    const rows = await read(agentDir, agentId);
    const row = rows.find((item) => item.id === id);
    if (!row) throw new Error("topic candidate not found");
    if (Date.parse(row.expiresAt) <= now.getTime()) throw new Error("topic candidate expired");
    if (status === "pending" ? !["offered", "indeterminate"].includes(row.status)
      : status === "dismissed" ? !["pending", "offered", "indeterminate"].includes(row.status)
        : !["offered", "indeterminate"].includes(row.status)) {
      throw new Error("topic candidate cannot make that transition");
    }
    row.status = status;
    row.updatedAt = now.toISOString();
    if (status === "used") row.lastUsedAt = row.updatedAt;
    await write(agentDir, agentId, rows);
    return row;
  });
}

/** Release only untouched offers. Once execution started, an error may follow a
 * real notification; keep that uncertainty visible instead of auto-sending again. */
export async function settleTopicOffers({ agentDir, agentId, ids, status, now = new Date() }) {
  if (!["pending", "indeterminate"].includes(status)) throw new Error("invalid offer settlement");
  return withLock(agentDir, async () => {
    const rows = await read(agentDir, agentId);
    const offered = new Set(ids);
    let changed = false;
    for (const row of rows) {
      if (!offered.has(row.id) || row.status !== "offered") continue;
      row.status = status;
      row.updatedAt = now.toISOString();
      changed = true;
    }
    if (changed) await write(agentDir, agentId, rows);
    return changed;
  });
}
