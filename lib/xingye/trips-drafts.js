/**
 * 服务端「待确认行程草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-trips-store.ts 的 `apps/trips/drafts.jsonl`
 * 是同一物理文件：UI 通过 /api/xingye/storage listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点（与 journal-drafts.js 同构）：
 *  - 仅写 drafts.jsonl，不写 entries.jsonl，不发 trips.entry_appended；需要等用户在
 *    PhoneTripsApp「待确认草稿」区点确认，UI 才会调 confirmTripDraft 把它搬到 entries。
 *  - 写完顺手 append 一条 trips.draft_proposed 事件到 events/log.json，让下一轮心跳
 *    消费者能在「自上次巡检以来」里看到「行程草稿提议×N」。
 *  - 同 agent 内串行化追加复用 lib/xingye/events.js 的 per-agent lock。
 *  - route（竖向路线时间轴）不在草稿里收——渲染端读草稿 / confirm 时 normalizeTripDraft
 *    会按 from/to/mode 兜底一段，避免让模型在 propose 阶段填嵌套结构。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_TRIPS_DRAFTS_RELATIVE_PATH = path.join("apps", "trips", "drafts.jsonl");

/** 与渲染端 xingye-trips-store.ts 的 TRIP_MODE_KEYS 一致（开放枚举的收敛层）。 */
export const TRIP_DRAFT_MODE_KEYS = ["walk", "ride", "cart", "transit", "boat", "rail", "fly", "mystic"];

const TRIP_MODE_LABELS_ZH = {
  walk: "徒步",
  ride: "骑乘",
  cart: "车马",
  transit: "车行",
  boat: "行船",
  rail: "轨道",
  fly: "飞行",
  mystic: "术法",
};

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

function clampStr(value, max) {
  if (typeof value !== "string") return "";
  const t = value.trim();
  if (!t) return "";
  return t.length <= max ? t : t.slice(0, max);
}

function normalizeMode(value) {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (TRIP_DRAFT_MODE_KEYS.includes(v)) return v;
  }
  return "walk";
}

function normalizePlace(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = clampStr(raw.name, 60);
  if (!name) return null;
  const meta = clampStr(raw.meta, 60);
  const place = { name };
  if (meta) place.meta = meta;
  return place;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_TRIPS_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条行程草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{ from: {name:string, meta?:string}, to: {name:string, meta?:string},
 *           chapter?: string, when?: string, serial?: string, cls?: string,
 *           mode?: string, modeLabel?: string, duration?: string, distance?: string,
 *           pass?: string, stampText?: string, noteFrom?: string, noteTo?: string,
 *           mood?: string, moodTags?: string[], source: string, reason?: string,
 *           sourceEventIds?: string[] }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendTripDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const from = normalizePlace(input.from);
  const to = normalizePlace(input.to);
  if (!from || !to) return null;
  const source = clampStr(input.source, 80);
  if (!source) return null;

  const mode = normalizeMode(input.mode);
  const modeLabel = clampStr(input.modeLabel, 60) || TRIP_MODE_LABELS_ZH[mode];
  const chapter = clampStr(input.chapter, 40) || "行程";
  const moodTags = Array.isArray(input.moodTags)
    ? input.moodTags.map((t) => clampStr(t, 24)).filter(Boolean).slice(0, 8)
    : [];
  const reason = clampStr(input.reason, 400);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    serial: clampStr(input.serial, 60),
    when: clampStr(input.when, 40),
    chapter,
    mode,
    modeLabel,
    cls: clampStr(input.cls, 24),
    from,
    to,
    duration: clampStr(input.duration, 40),
    distance: clampStr(input.distance, 40),
    pass: clampStr(input.pass, 40) || "—",
    stampText: clampStr(input.stampText, 12),
    noteFrom: clampStr(input.noteFrom, 200),
    noteTo: clampStr(input.noteTo, 200),
    mood: clampStr(input.mood, 2000),
    moodTags,
    source,
    reason: reason || undefined,
    sourceEventIds,
    createdAt,
  };

  await withXingyeAgentEventLock(agentId, async () => {
    const file = draftsFilePath(agentDir);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, `${JSON.stringify(row)}\n`, "utf-8");
  });

  try {
    await appendXingyeEvent({
      agentDir,
      agentId,
      input: {
        type: "trips.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          chapter,
          from: from.name,
          to: to.name,
          mode,
          reason: reason || null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    /** event log 失败不阻塞 draft 落盘；UI 仍能在「待确认草稿」区看到。 */
    console.warn(`[xingye-trips-drafts] event log append failed: ${err?.message || err}`);
  }

  const { key: _key, ...record } = row;
  return record;
}
