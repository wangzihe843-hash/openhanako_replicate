/**
 * 赠礼系统的盘存层：`agents/{agentId}/xingye/gifts/`。
 *
 *  - state.json：initializedAt + 归属集 + 最爱礼物 + stance/气质/回复池
 *    —— init 一次性写入的「定性层」，是赠礼玩法的单一事实来源。
 *  - log.jsonl：送礼流水（append-only），驱动「是否已命中过最爱」的防刷判定，
 *    也是 UI 的送礼历史。
 *
 * 读语义沿用 loadHistoryState 的硬规则（见 xingye-app-history-state.ts 注释）：
 * 缺文件 → 未初始化默认值；传输/损坏错误 → **必须抛**。对赠礼尤其致命——
 * 把一次瞬时读失败吞成「未初始化」会触发重新 init、重 roll 最爱礼物，
 * 直接打破「最爱固定且对 user 保密」的核心承诺。
 */

import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import type { XingyeGiftSetId } from './xingye-gift-catalog';
import {
  GIFT_STANCES,
  GIFT_TEMPERAMENTS,
  type GiftFamiliarity,
  type GiftReactionTier,
  type GiftStance,
  type GiftTemperament,
} from './xingye-gift-dynamics';
import { XINGYE_GIFT_SETS } from './xingye-gift-catalog';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

const GIFT_STATE_PATH = 'gifts/state.json';
const GIFT_LOG_PATH = 'gifts/log.jsonl';

export type XingyeGiftReplyPools = {
  /** 命中最爱时的特殊回复（1-2 条，TA 的口吻）。 */
  favorite: string[];
  /** native 集逐件一句回复（giftId → 回复）；按 stance 写好。 */
  nativeByGift: Record<string, string>;
  /** 以下三池供非 native 集用，行内可含 {gift} 占位符（运行时替换礼物名）。 */
  mundane: string[];
  historical: string[];
  alien: string[];
};

export type XingyeGiftState = {
  /** 首次初始化完成时间；未初始化 → undefined。 */
  initializedAt?: string;
  /** resolver 判定的归属礼物集（确定性，但落盘后以盘存为准，避免关键词表演进导致漂移）。 */
  eraSetId?: XingyeGiftSetId;
  /** 最爱礼物（native 集内的 giftId）。**不在 UI 显式展示**。 */
  favoriteGiftId?: string;
  temperament?: GiftTemperament;
  /** native 集 giftId → stance。 */
  stances?: Record<string, GiftStance>;
  replies?: XingyeGiftReplyPools;
  version: 1;
};

export type XingyeGiftLogRecord = {
  id: string;
  giftSetId: XingyeGiftSetId;
  giftId: string;
  giftNameZh: string;
  familiarity: GiftFamiliarity;
  tier: GiftReactionTier;
  reply: string;
  /** 实际提交给 updateRelationshipState 的原始冲量（落库前），便于回看与调试。 */
  impulse?: Record<string, number>;
  sentAt: string;
};

const VALID_SET_IDS = new Set(XINGYE_GIFT_SETS.map((set) => set.id));

function safeIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeReplyList(raw: unknown, max = 8): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim())
    .slice(0, max);
}

function normalizeReplies(raw: unknown): XingyeGiftReplyPools | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const nativeByGift: Record<string, string> = {};
  if (r.nativeByGift && typeof r.nativeByGift === 'object' && !Array.isArray(r.nativeByGift)) {
    for (const [giftId, reply] of Object.entries(r.nativeByGift as Record<string, unknown>)) {
      if (typeof reply === 'string' && reply.trim()) nativeByGift[giftId] = reply.trim();
    }
  }
  return {
    favorite: normalizeReplyList(r.favorite, 4),
    nativeByGift,
    mundane: normalizeReplyList(r.mundane),
    historical: normalizeReplyList(r.historical),
    alien: normalizeReplyList(r.alien),
  };
}

function normalize(raw: unknown): XingyeGiftState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1 };
  }
  const r = raw as Record<string, unknown>;
  const out: XingyeGiftState = { version: 1 };
  const initializedAt = safeIso(r.initializedAt);
  if (initializedAt) out.initializedAt = initializedAt;
  if (typeof r.eraSetId === 'string' && VALID_SET_IDS.has(r.eraSetId as XingyeGiftSetId)) {
    out.eraSetId = r.eraSetId as XingyeGiftSetId;
  }
  if (typeof r.favoriteGiftId === 'string' && r.favoriteGiftId.trim()) {
    out.favoriteGiftId = r.favoriteGiftId.trim();
  }
  if (typeof r.temperament === 'string' && (GIFT_TEMPERAMENTS as readonly string[]).includes(r.temperament)) {
    out.temperament = r.temperament as GiftTemperament;
  }
  if (r.stances && typeof r.stances === 'object' && !Array.isArray(r.stances)) {
    const stances: Record<string, GiftStance> = {};
    for (const [giftId, stance] of Object.entries(r.stances as Record<string, unknown>)) {
      if (typeof stance === 'string' && (GIFT_STANCES as readonly string[]).includes(stance)) {
        stances[giftId] = stance as GiftStance;
      }
    }
    out.stances = stances;
  }
  const replies = normalizeReplies(r.replies);
  if (replies) out.replies = replies;
  return out;
}

/**
 * 读取赠礼状态。缺文件 → `{version:1}`（确为未初始化）；其余错误抛出。
 * 调用方（bootstrap / send 流程）须在 try/catch 内，抛出 = 安全地「这次不动」。
 */
export async function loadGiftState(agentId: string): Promise<XingyeGiftState> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return { version: 1 };
  const raw = await backend.readJson<unknown>(aid, GIFT_STATE_PATH);
  return normalize(raw);
}

export async function saveGiftState(
  agentId: string,
  patch: Partial<Omit<XingyeGiftState, 'version'>>,
): Promise<XingyeGiftState> {
  const aid = String(agentId ?? '').trim();
  if (!aid) throw new Error('saveGiftState: agentId is required');
  const current = await loadGiftState(aid);
  const next: XingyeGiftState = { ...current, ...patch, version: 1 };
  await backend.writeJson(aid, GIFT_STATE_PATH, next);
  return next;
}

export async function appendGiftLog(
  agentId: string,
  record: XingyeGiftLogRecord,
): Promise<void> {
  const aid = String(agentId ?? '').trim();
  if (!aid) throw new Error('appendGiftLog: agentId is required');
  await backend.appendJsonl(aid, GIFT_LOG_PATH, record);
}

export async function listGiftLog(agentId: string): Promise<XingyeGiftLogRecord[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  const rows = await backend.listJsonl<XingyeGiftLogRecord>(aid, GIFT_LOG_PATH);
  return rows.filter((row) => row && typeof row === 'object' && typeof row.giftId === 'string');
}

/** 此前是否已命中过最爱（防刷判定的输入；见 resolveGiftReaction.favoriteHitBefore）。 */
export function hasFavoriteHit(log: XingyeGiftLogRecord[]): boolean {
  return log.some((row) => row.tier === 'favorite');
}
