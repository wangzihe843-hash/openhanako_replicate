/**
 * 赠礼系统的自初始化 AI 模块：**一次调用产出全部定性层**，之后送礼零 LLM。
 *
 * 产物（落 gifts/state.json）：
 *  - favoriteGiftId：TA 最爱的礼物（从归属集 10 件里按人设挑，**对 user 保密**）
 *  - temperament：礼物反应气质（宽和/挑剔/喜怒无常）
 *  - stances：归属集逐件态度（loved/liked/neutral/disliked）
 *  - replies：命中特殊回复 + 归属集逐件一句 + mundane/historical/alien 三个通用池
 *
 * 数值完全不进 LLM（本地查表见 xingye-gift-dynamics.ts）——「LLM 只回定性核心」。
 * 归属集判定也不进 LLM（resolver 确定性判定，见 xingye-gift-era-resolver.ts）。
 *
 * lore 注入辅助镜像 xingye-accounting-ai.ts（readLoreMemoryMarkdown +
 * buildStableLoreFromAlwaysEntries 在各 ai 模块间按惯例复制，不共享私有实现）。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { postXingyeStorage } from './xingye-storage-api';
import { getGiftSet, type XingyeGiftSet, type XingyeGiftSetId } from './xingye-gift-catalog';
import {
  GIFT_STANCES,
  GIFT_TEMPERAMENTS,
  GIFT_TEMPERAMENT_LABELS,
  type GiftStance,
  type GiftTemperament,
} from './xingye-gift-dynamics';
import type { XingyeGiftReplyPools } from './xingye-gift-store';

const GIFTS_INIT_TIMEOUT_MS = 90_000;

export type XingyeGiftInitResult = {
  favoriteGiftId: string;
  temperament: GiftTemperament;
  stances: Record<string, GiftStance>;
  replies: XingyeGiftReplyPools;
};

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

async function readLoreMemoryMarkdown(agentId: string): Promise<string | null> {
  const aid = agentId.trim();
  if (!aid) return null;
  try {
    const data = (await postXingyeStorage({
      action: 'read',
      agentId: aid,
      relativePath: 'lore-memory.md',
      binary: false,
    })) as { missing?: boolean; content?: unknown };
    if (data?.missing || typeof data?.content !== 'string') return null;
    let text = data.content.trim();
    text = text.replace(/^<!--[\s\S]*?-->\s*/m, '').trim();
    return text || null;
  } catch {
    return null;
  }
}

function buildStableLoreFromAlwaysEntries(agentId: string, maxChars: number): string {
  try {
    const storage = getXingyePersistenceStorage();
    const entries = listLoreEntries(agentId, storage).filter(
      (e) => e.enabled && e.visibility === 'canonical' && e.insertionMode === 'always',
    );
    if (!entries.length) return '';
    const lines: string[] = [];
    let used = 0;
    for (const e of entries) {
      const label = XINGYE_LORE_CATEGORY_LABELS[e.category] ?? e.category;
      const block = `- 《${e.title}》（${label}）\n${e.content.trim()}`;
      if (used + block.length > maxChars && lines.length > 0) break;
      lines.push(block);
      used += block.length + 2;
      if (used >= maxChars) break;
    }
    return lines.join('\n\n');
  } catch {
    return '';
  }
}

async function buildStableLoreBlock(agentId: string): Promise<string> {
  const fromFile = await readLoreMemoryMarkdown(agentId);
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 2800);
  return buildStableLoreFromAlwaysEntries(agentId, 2400).trim();
}

function buildProfileBlock(agent: Agent, profile: XingyeRoleProfile | null): string {
  const lines: string[] = [`- 名字：${profile?.displayName || agent.name}`];
  const push = (label: string, value: string | undefined) => {
    const v = (value ?? '').trim();
    if (v) lines.push(`- ${label}：${truncateChars(v, 220)}`);
  };
  push('一句话人设', profile?.shortBio);
  push('身份', profile?.identitySummary);
  push('背景', profile?.backgroundSummary);
  push('性格', profile?.personalitySummary);
  push('与用户的关系', profile?.relationshipLabel);
  push('说话风格', profile?.speakingStyle);
  push('在意的事', profile?.values);
  push('雷点', profile?.taboos);
  return lines.join('\n');
}

export function buildGiftInitPrompt(args: {
  agent: Agent;
  profile: XingyeRoleProfile | null;
  stableLoreBlock: string;
  nativeSet: XingyeGiftSet;
}): string {
  const { agent, profile, stableLoreBlock, nativeSet } = args;
  const giftLines = nativeSet.items
    .map((item) => `- ${item.id}｜${item.nameZh}｜${item.desc}`)
    .join('\n');
  const giftIds = nativeSet.items.map((item) => item.id).join(' / ');

  return [
    `你在为角色「${profile?.displayName || agent.name}」初始化"赠礼偏好"。用户之后可以送 TA 礼物；你现在要替 TA 决定：最爱哪件、对每件什么态度、收到时会说什么。`,
    '',
    '【角色资料】',
    buildProfileBlock(agent, profile),
    stableLoreBlock ? `\n【核心设定摘录】\n${stableLoreBlock}` : '',
    '',
    `【TA 所在世界观的礼物清单（${nativeSet.labelZh}，共 ${nativeSet.items.length} 件）】`,
    giftLines,
    '',
    '【任务】输出 JSON（只输出 JSON，不要任何其它文字）：',
    '{',
    '  "favoriteGiftId": "<上面清单中某件的 id>",',
    `  "temperament": "<${GIFT_TEMPERAMENTS.join(' | ')}>",`,
    '  "stances": { "<每件礼物的 id>": "loved | liked | neutral | disliked" },',
    '  "replies": {',
    '    "favorite": ["<命中最爱时 TA 说的话>", "<再来一条不同的>"],',
    '    "nativeByGift": { "<每件礼物的 id>": "<收到这件时 TA 说的一句话>" },',
    '    "mundane": ["<4 条：收到「TA 世界里寻常的东西」时的平淡反应，可用 {gift} 占位礼物名>"],',
    '    "historical": ["<4 条：收到「史书/老物件级别的古董」时的反应，可用 {gift} 占位>"],',
    '    "alien": ["<4 条：收到「TA 的世界里根本不存在的陌生之物」时好奇/疑惑的反应，可用 {gift} 占位>"]',
    '  }',
    '}',
    '',
    '【硬性要求】',
    `- favoriteGiftId 必须从这些 id 里选：${giftIds}；stances 里它必须是 "loved" 且全表唯一的 "loved"。`,
    '- stances 必须覆盖全部 10 件；至少 1 件 "disliked"（人设再宽和也有不对胃口的东西），不超过 3 件。',
    `- temperament 三选一：gracious=${GIFT_TEMPERAMENT_LABELS.gracious}、picky=${GIFT_TEMPERAMENT_LABELS.picky}、volatile=${GIFT_TEMPERAMENT_LABELS.volatile}，按性格选最贴的。`,
    '- 所有回复都用 TA 的第一人称口吻说话（贴 speakingStyle，≤40 字），像随口说出来的话，不是客服腔、不是小说旁白。',
    '- nativeByGift 的每句话要体现 TA 对那件礼物的真实态度（stance 是什么，话里就是什么味道；disliked 的话别假装喜欢，但也不用恶语）。',
    '- favorite 两条要有「被戳中了」的失态感/惊喜感，与普通 liked 拉开差距，但不要直说"这是我最爱的"。',
    '- alien 池的核心是「没见过、想不通这是什么」的真实困惑，可以拿 TA 世界里最接近的东西打比方。',
    '- historical 池要有「老物件/有年头的东西」的感慨；mundane 池是「哦，挺常见」的平淡但不失礼。',
  ].filter((line) => line !== null && line !== undefined).join('\n');
}

function normalizeReplyArray(raw: unknown, fallback: string[], max = 6): string[] {
  if (!Array.isArray(raw)) return fallback;
  const list = raw
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => truncateChars(item, 80))
    .slice(0, max);
  return list.length ? list : fallback;
}

/**
 * 校验 + 归一模型输出。宽容解析（缺字段给兜底），但 favoriteGiftId 不合法时
 * 直接抛错 —— 最爱礼物是核心承诺，宁可这次初始化失败重试，也不能静默乱选。
 */
export function normalizeGiftInitResult(
  raw: unknown,
  nativeSet: XingyeGiftSet,
): XingyeGiftInitResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('模型返回不是对象');
  }
  const r = raw as Record<string, unknown>;
  const validIds = new Set(nativeSet.items.map((item) => item.id));

  const favoriteGiftId = typeof r.favoriteGiftId === 'string' ? r.favoriteGiftId.trim() : '';
  if (!validIds.has(favoriteGiftId)) {
    throw new Error(`模型返回的最爱礼物不在归属集内：${favoriteGiftId || '(空)'}`);
  }

  const temperament: GiftTemperament =
    typeof r.temperament === 'string' && (GIFT_TEMPERAMENTS as readonly string[]).includes(r.temperament)
      ? (r.temperament as GiftTemperament)
      : 'gracious';

  const stances: Record<string, GiftStance> = {};
  const rawStances = (r.stances && typeof r.stances === 'object' && !Array.isArray(r.stances))
    ? (r.stances as Record<string, unknown>)
    : {};
  for (const item of nativeSet.items) {
    const value = rawStances[item.id];
    stances[item.id] = typeof value === 'string' && (GIFT_STANCES as readonly string[]).includes(value)
      ? (value as GiftStance)
      : 'neutral';
  }
  // 最爱必须 loved 且唯一：其余 loved 降级为 liked。
  for (const [giftId, stance] of Object.entries(stances)) {
    if (stance === 'loved' && giftId !== favoriteGiftId) stances[giftId] = 'liked';
  }
  stances[favoriteGiftId] = 'loved';

  const rawReplies = (r.replies && typeof r.replies === 'object' && !Array.isArray(r.replies))
    ? (r.replies as Record<string, unknown>)
    : {};
  const nativeByGift: Record<string, string> = {};
  const rawNative = (rawReplies.nativeByGift && typeof rawReplies.nativeByGift === 'object' && !Array.isArray(rawReplies.nativeByGift))
    ? (rawReplies.nativeByGift as Record<string, unknown>)
    : {};
  for (const item of nativeSet.items) {
    const value = rawNative[item.id];
    if (typeof value === 'string' && value.trim()) {
      nativeByGift[item.id] = truncateChars(value, 80);
    }
  }

  const replies: XingyeGiftReplyPools = {
    favorite: normalizeReplyArray(rawReplies.favorite, ['……这个，你怎么知道的。'], 4),
    nativeByGift,
    mundane: normalizeReplyArray(rawReplies.mundane, ['{gift}吗，谢谢，收下了。']),
    historical: normalizeReplyArray(rawReplies.historical, ['{gift}……这可有些年头了吧。']),
    alien: normalizeReplyArray(rawReplies.alien, ['这{gift}……究竟是做什么用的？']),
  };

  return { favoriteGiftId, temperament, stances, replies };
}

/**
 * 跑一次初始化生成。调用方负责：确定 eraSetId（resolver）、把结果连同
 * eraSetId/initializedAt 落进 gifts/state.json、以及失败时的「这次不动」语义。
 */
export async function generateGiftInitWithAI(args: {
  agent: Agent;
  profile: XingyeRoleProfile | null;
  eraSetId: XingyeGiftSetId;
  timeoutMs?: number;
}): Promise<XingyeGiftInitResult> {
  const { agent, profile, eraSetId } = args;
  const timeoutMs = args.timeoutMs ?? GIFTS_INIT_TIMEOUT_MS;
  const nativeSet = getGiftSet(eraSetId);
  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const prompt = buildGiftInitPrompt({ agent, profile, stableLoreBlock, nativeSet });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'gifts_init',
      ownerAgentId: agent.id,
      agentId: agent.id,
      prompt,
      timeoutMs,
    }),
  });

  let data: { ok?: boolean; error?: string; result?: unknown; details?: unknown };
  try {
    data = await response.json();
  } catch {
    throw new Error('解析服务器响应失败');
  }
  if (!response.ok || data?.ok === false || data?.error) {
    const details = Array.isArray(data?.details)
      ? `：${(data.details as { message?: string }[]).map((item) => item.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  return normalizeGiftInitResult(data?.result, nativeSet);
}
