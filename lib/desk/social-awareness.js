/**
 * social-awareness.js — agent 间社交「拉力 + 推力」基础设施
 *
 * 目标：让 main agent 主动找其他 agent 私信（dm），但不靠强 prompt 烧 token，
 * 也不会弱到永远不开口。两条腿走路：
 *
 *  1) 常驻 awareness（拉力）：system prompt 里本就有「## 团队」名单（见 core/agent.js
 *     _formatTeamRoster），但它把其他 agent 框成"委派任务的协作者"。awareness 的改动
 *     在那段补一句社交化 reframe——这些人不只是工具人，你可以纯粹为了聊天主动 dm 他们。
 *     复用已有名单，零额外 token。本模块不再单独渲染名单。
 *
 *  2) 事件驱动 staleness（推力）：照搬 heartbeat-consumer 的 autoDraftStaleness
 *     模式——平时心跳完全不提社交（零成本），只有「太久没主动联系任何人」(global)
 *     或「某个具体的人太久没联系」(per-peer) 时，那一次心跳才追加一段软提示。
 *
 * staleness 的「时间」单位是**用户对话条数**（event log 里的 recent_chat.observed），
 * 与 autoDraftStaleness 一致——夜里没人聊就不推进，避免半夜自言自语刷屏。
 *
 * 注意：inter-agent dm 不进 xingye event log（它走 channel-store.appendMessage），
 * 所以「上次主动 dm 谁」必须由 dm-tool 自己记到 peer-state.json，这里读它。
 *
 * 刻意只记**主动发起**（dm-tool），不记 DmRouter 里的"被动回复"：staleness 的语义
 * 是"距离上次**主动**找人多久"。如果回复也重置计数器，那只回复、从不主动的 agent
 * 就永远收不到推力。两边各自只在主动发起时重置——天然形成"双方都会时不时主动起话头"
 * 的来回，而不是固定一方当话痨。
 */

import fs from "fs";
import path from "path";
import {
  DEFAULT_SOCIAL_GLOBAL_THRESHOLD,
  DEFAULT_SOCIAL_PER_PEER_THRESHOLD,
  SOCIAL_THRESHOLD_MIN,
  SOCIAL_THRESHOLD_MAX,
} from "../../shared/default-workspace-constants.ts";

/**
 * 距离上次主动 dm **任何人** 累计 ≥ 这么多条用户对话，就在心跳里追加「该社交了」软提示。
 * 默认 80（比 autoDraftStaleness 的 50 更克制：社交比写草稿更"打扰"，节奏放慢一档）。
 * 可被 agent config 的 `desk.social_global_threshold` 覆盖（见 resolveSocialThresholds）。
 * 默认值/边界都在 shared/default-workspace-constants.js，与前端 WorkTab 同源。
 */
export const SOCIAL_GLOBAL_STALENESS_THRESHOLD = DEFAULT_SOCIAL_GLOBAL_THRESHOLD;

/**
 * 距离上次 dm **某个具体的人** 累计 ≥ 这么多条用户对话，就把这个人单独列为「很久没联系」。
 * 默认 200，远大于 global：global 控"开不开口"，per-peer 控"别让某个人被永久遗忘"——
 * 是兜底，不是主推力，所以阈值高。可被 `desk.social_per_peer_threshold` 覆盖。
 */
export const SOCIAL_PER_PEER_STALENESS_THRESHOLD = DEFAULT_SOCIAL_PER_PEER_THRESHOLD;

/** 心跳软提示里最多点名几个候选人（最久没联系的优先）。 */
export const SOCIAL_CANDIDATE_COUNT = 2;

/** awareness / 候选里 summary 的截断长度（按字符；中文友好）。 */
const SOCIAL_SUMMARY_MAX_CHARS = 48;

/** peer-state.json 相对 agentDir 的路径。和 xingye 其它状态放一起。 */
export const SOCIAL_PEER_STATE_RELATIVE_PATH = path.join("xingye", "social", "peer-state.json");

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 把任意输入夹到 [MIN, MAX] 的整数；非有限数 → fallback。 */
function clampThreshold(value, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(SOCIAL_THRESHOLD_MIN, Math.min(SOCIAL_THRESHOLD_MAX, n));
}

/**
 * 从 agent 的 `desk` config 解析社交阈值。缺省 / 非法值回退到默认常量，并 clamp 到
 * [SOCIAL_THRESHOLD_MIN, MAX]——后端这层 clamp 是防御：即使用户手改 config.yaml 填了
 * 0 或天文数字，也不会让心跳行为失控。前端 UI 用同样的边界。
 *
 * @param {object} [desk] - agent.config.desk
 * @returns {{ globalThreshold:number, perPeerThreshold:number }}
 */
export function resolveSocialThresholds(desk) {
  const d = isRecord(desk) ? desk : {};
  return {
    globalThreshold: clampThreshold(d.social_global_threshold, DEFAULT_SOCIAL_GLOBAL_THRESHOLD),
    perPeerThreshold: clampThreshold(d.social_per_peer_threshold, DEFAULT_SOCIAL_PER_PEER_THRESHOLD),
  };
}

function normalizeDateString(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** summary 压成单行 + 截断，纯展示用。 */
function compactSummary(summary, max = SOCIAL_SUMMARY_MAX_CHARS) {
  if (typeof summary !== "string") return "";
  const oneLine = summary.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max).trim()}…`;
}

export function resolvePeerStatePath(agentDir) {
  return path.join(agentDir, SOCIAL_PEER_STATE_RELATIVE_PATH);
}

/**
 * 读 peer-state.json，规范化成 { version, lastOutboundDmAt, peers: { [peerId]: { lastOutboundDmAt } } }。
 * 文件不存在 / 损坏 → 返回空壳，不抛。
 */
export function readPeerState(agentDir) {
  const empty = { version: 1, lastOutboundDmAt: null, peers: {} };
  if (!agentDir) return empty;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolvePeerStatePath(agentDir), "utf-8"));
  } catch {
    return empty;
  }
  if (!isRecord(raw)) return empty;
  const peers = {};
  if (isRecord(raw.peers)) {
    for (const [peerId, entry] of Object.entries(raw.peers)) {
      if (!peerId || !isRecord(entry)) continue;
      const at = normalizeDateString(entry.lastOutboundDmAt);
      if (at) peers[peerId] = { lastOutboundDmAt: at };
    }
  }
  return {
    version: 1,
    lastOutboundDmAt: normalizeDateString(raw.lastOutboundDmAt),
    peers,
  };
}

function atomicWritePeerState(agentDir, state) {
  const filePath = resolvePeerStatePath(agentDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, filePath);
}

/**
 * 记一次「本 agent 主动给 peerId 发了 dm」。刷新 global + per-peer 的 lastOutboundDmAt。
 * 失败只 warn 不抛——绝不能因为记账失败把 dm 发送本身搞挂。
 *
 * @param {object} opts
 * @param {string} opts.agentDir - 发送方 agent 的数据目录
 * @param {string} opts.peerId   - 接收方 agent id
 * @param {string} [opts.nowIso] - 时间戳（默认 new Date()）；测试可注入
 * @returns {object|null} 更新后的 state，失败返回 null
 */
export function recordOutboundDm({ agentDir, peerId, nowIso } = {}) {
  if (!agentDir || !peerId) return null;
  const at = normalizeDateString(nowIso) || new Date().toISOString();
  try {
    const state = readPeerState(agentDir);
    state.lastOutboundDmAt = at;
    state.peers = { ...state.peers, [peerId]: { lastOutboundDmAt: at } };
    atomicWritePeerState(agentDir, state);
    return state;
  } catch {
    return null;
  }
}

/** 统计 events 里 createdAt 严格晚于 sinceMs 的 recent_chat.observed 条数。 */
function countChatTurnsSince(events, sinceMs) {
  let n = 0;
  for (const event of events) {
    if (!event || event.type !== "recent_chat.observed") continue;
    const ms = Date.parse(event.createdAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > sinceMs) n += 1;
  }
  return n;
}

/**
 * 计算社交 staleness（global + per-peer 混合）。
 *
 * @param {object} opts
 * @param {Array} opts.events      - 全量 xingye event log（用 recent_chat.observed 数对话条数）
 * @param {object} opts.peerState  - readPeerState 的返回
 * @param {Array<{id:string,name?:string,summary?:string}>} opts.peers
 *   当前可联系的 peer 列表（**已排除自己**）。决定 per-peer 候选 & awareness。
 * @param {number} [opts.globalThreshold]
 * @param {number} [opts.perPeerThreshold]
 * @returns {{
 *   globalChatTurnsSinceLastDm:number,
 *   globalLastDmAt:string|null,
 *   shouldSocialize:boolean,
 *   overduePeerCount:number,
 *   candidatePeers:Array<{peerId,name,summary,chatTurnsSinceLastDm,lastDmAt,neverContacted}>,
 * }}
 *
 * 语义：
 *  - global：距离上次 dm 任何人累计 ≥ globalThreshold 条对话 → shouldSocialize（且有人可聊）
 *  - per-peer：某 peer 距离上次被 dm ≥ perPeerThreshold 条对话 → overdue
 *  - candidatePeers：**永远**给出按 staleness 倒序的 top-N（即便没触发，渲染层据此点名），
 *    这样 global 一旦触发，软提示里总有具体的人可点，而不是干燥的"找个人聊聊"
 *  - 从没联系过的 peer：lastDmAt=null，对话条数按"全部历史"算，neverContacted=true
 */
export function computeSocialStaleness({
  events,
  peerState,
  peers,
  globalThreshold = SOCIAL_GLOBAL_STALENESS_THRESHOLD,
  perPeerThreshold = SOCIAL_PER_PEER_STALENESS_THRESHOLD,
} = {}) {
  const safeEvents = Array.isArray(events) ? events : [];
  const safePeers = Array.isArray(peers) ? peers.filter((p) => p && p.id) : [];
  const state = peerState && isRecord(peerState.peers)
    ? peerState
    : { lastOutboundDmAt: null, peers: {} };

  // ── global ──
  const globalLastDmAt = normalizeDateString(state.lastOutboundDmAt);
  const globalSinceMs = globalLastDmAt ? Date.parse(globalLastDmAt) : -Infinity;
  const globalChatTurns = countChatTurnsSince(safeEvents, globalSinceMs);
  const shouldSocialize = safePeers.length > 0 && globalChatTurns >= globalThreshold;

  // ── per-peer ──
  let overduePeerCount = 0;
  const ranked = safePeers.map((peer) => {
    const entry = state.peers?.[peer.id];
    const lastDmAt = normalizeDateString(entry?.lastOutboundDmAt);
    const sinceMs = lastDmAt ? Date.parse(lastDmAt) : -Infinity;
    const turns = countChatTurnsSince(safeEvents, sinceMs);
    if (turns >= perPeerThreshold) overduePeerCount += 1;
    return {
      peerId: peer.id,
      name: peer.name || peer.id,
      summary: compactSummary(peer.summary),
      chatTurnsSinceLastDm: turns,
      lastDmAt,
      neverContacted: !lastDmAt,
    };
  });

  // 最久没联系的优先；并列时从没联系过的排前面，再按 id 稳定排序
  ranked.sort((a, b) => {
    if (b.chatTurnsSinceLastDm !== a.chatTurnsSinceLastDm) {
      return b.chatTurnsSinceLastDm - a.chatTurnsSinceLastDm;
    }
    if (a.neverContacted !== b.neverContacted) return a.neverContacted ? -1 : 1;
    return a.peerId.localeCompare(b.peerId);
  });

  return {
    globalChatTurnsSinceLastDm: globalChatTurns,
    globalLastDmAt,
    shouldSocialize,
    overduePeerCount,
    candidatePeers: ranked.slice(0, SOCIAL_CANDIDATE_COUNT),
  };
}

/**
 * 渲染心跳软提示里的候选人行（点名最久没联系的人，带 persona 摘要当话头）。
 * 给 heartbeat.js 复用，保证候选人展示格式与 awareness 一致。
 *
 * @param {Array<{peerId,name,summary,chatTurnsSinceLastDm,neverContacted}>} candidatePeers
 * @param {boolean} isZh
 * @returns {string[]} 每个候选人一行（已含 "- " 前缀）
 */
export function formatSocialCandidateLines(candidatePeers, isZh) {
  if (!Array.isArray(candidatePeers)) return [];
  return candidatePeers.map((p) => {
    const name = (p.name && p.name !== p.peerId) ? `${p.name}（${p.peerId}）` : p.peerId;
    const summary = compactSummary(p.summary);
    const persona = summary ? (isZh ? `——${summary}` : ` — ${summary}`) : "";
    // 从没联系过的 peer 明确标注，避免 agent 对没打过交道的人来一句"好久不见"式瞎编。
    const fresh = p.neverContacted ? (isZh ? "（你还没联系过 TA）" : " (you haven't contacted them before)") : "";
    return `- ${name}${persona}${fresh}`;
  });
}
