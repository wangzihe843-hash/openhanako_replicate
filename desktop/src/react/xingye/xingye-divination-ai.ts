import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import { loadDivinationEntries } from './xingye-app-entry-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import type {
  XingyeDivinationAgentLike,
  XingyeDivinationMethodId,
} from './xingye-divination-method-resolver';
import { buildDivinationReadingPrompt } from './xingye-divination-prompts';
import { normalizeTitleForDedup } from './xingye-files-dedupe';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { sanitizeDivinationReadingContent } from './phone-divination-narrative';

export type DivinationReadingResult = {
  title: string;
  agentQuestion: string;
  content: string;
  /**
   * 运势评分（综合 + 三分项），0-100 整数。模型未返回或返回非法值 → undefined，
   * 渲染端按"无运势"处理，不显示评分/宜忌/幸运区。
   */
  fortuneScore?: { overall: number; career: number; love: number; wealth: number };
  omens?: { good: string; bad: string };
  luckyDirection?: string;
  luckyColor?: string;
};

function formatRelationshipBlock(agentId: string): string {
  const storage = getXingyePersistenceStorage();
  const state = getRelationshipState(agentId, storage);
  if (!state) return '';
  return JSON.stringify(
    {
      mood: state.mood,
      relationshipLabel: state.relationshipLabel,
      stateSummary: state.stateSummary,
      lastReason: state.lastReason,
      affection: state.affection,
      trust: state.trust,
    },
    null,
    2,
  );
}

function clampLine(value: string, maxChars: number): string {
  const t = value.replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 占卜跨次连续性锚点：从已有占卜历史抽样，让模型避免短期内反复抽到
 * 同一张牌/同一卦象/同一类解读。
 *
 * 与 interview / news 的连续性锚点同款思路，但占卜有个特殊的张力：
 * **卦象/牌面是有限可枚举的**（塔罗 78 张 / 易经 64 卦 / 卢恩 24 符），
 * 抽多了必然有重复，硬拒绝是不现实的；也不能让"防重复"压过占卜本身
 * 应有的随机性。
 *
 * 所以这里做分层 soft anchor：
 *  - **硬避免**：最近 5 次的 method+symbol+agentQuestion → 「请明确避免」
 *  - **软避免**：再往前 3 次 → 「也尽量错开」
 * 这种分层提示和 news 的「masthead 沿用 vs headline 换主题」是一类做法。
 *
 * 不做"模型生成了重复 symbol 就拒收"的硬逻辑——塔罗 78 张抽多了必然
 * 重复，硬拒绝会让重试风暴；仅在 prompt 端做引导，模型自然就会偏好换牌。
 *
 * @param agentId 角色 id
 * @param opts.method 可选 method 过滤：仅 anchor 同 method 的历史。本次
 *   占法是 'tarot' 时，传 'tarot' 就只看塔罗历史，让模型在塔罗内部换牌；
 *   传 undefined 则跨 method 全量 anchor（兜底/未知占法路径）。
 *   不同 method 的"符号"完全是异质的（塔罗的「恋人牌」和易经的「☰」），
 *   跨 method 喊"别重复"对模型没指导价值，反而稀释提示。
 */
export async function buildDivinationContinuityAnchorBlock(
  agentId: string,
  opts?: { method?: XingyeDivinationMethodId | string | null },
): Promise<string> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return '';
  try {
    const all = await loadDivinationEntries(aid);
    if (!all.length) return '';
    const filterMethod = (opts?.method ?? '').toString().trim();
    // method 过滤：本次占法明确 → 仅看同 method 历史。注意 oracle_generic
    // 兼容了「心象提示」草稿，跨 method 喊别重复也没意义。
    const filtered = filterMethod
      ? all.filter((e) => (e.metadata?.method ?? '') === filterMethod)
      : all;
    if (!filtered.length) return '';
    // listJsonl 不保证顺序——这里按 createdAt 倒序自己排一遍，取最近 8 条。
    const sorted = [...filtered].sort((a, b) => {
      const ta = Date.parse(a.createdAt || '');
      const tb = Date.parse(b.createdAt || '');
      const na = Number.isNaN(ta) ? 0 : ta;
      const nb = Number.isNaN(tb) ? 0 : tb;
      return nb - na;
    });
    const recent = sorted.slice(0, 8);

    type Sample = { method: string; methodLabel: string; symbols: string; topic: string; body: string };
    const seenTopicKeys = new Set<string>();
    const samples: Sample[] = [];
    for (const entry of recent) {
      const meta = entry.metadata ?? {};
      const method = (meta.method ?? '').toString().trim();
      const methodLabel = (meta.methodLabel ?? '').toString().trim();
      const symbols = Array.isArray(meta.symbols)
        ? meta.symbols
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter((s) => s.length > 0)
            .slice(0, 4)
            .join(' ')
        : '';
      const topicRaw = ((meta.agentQuestion ?? meta.question ?? '') as string).toString();
      const topic = clampLine(topicRaw, 40);
      const bodyRaw = (entry.content ?? '').toString();
      const body = clampLine(bodyRaw.replace(/【[^】]+】/g, ' '), 40);
      // 用 files-dedupe 的 normalizeTitle 给「同题去重」：同一晚连续重抽
      // 同一问题会写出几乎一样的 agentQuestion，列两条价值不大。
      const topicKey = normalizeTitleForDedup(topic) || normalizeTitleForDedup(body);
      if (topicKey && seenTopicKeys.has(topicKey)) continue;
      if (topicKey) seenTopicKeys.add(topicKey);
      samples.push({ method, methodLabel, symbols, topic, body });
      if (samples.length >= 8) break;
    }
    if (!samples.length) return '';

    // 分层：硬避免（最近 5）/ 软避免（其后 3）。硬段措辞强一点，让模型
    // 真的换牌；软段就提一句"也尽量错开"。
    const hard = samples.slice(0, 5);
    const soft = samples.slice(5);

    const renderSample = (s: Sample): string => {
      const methodTag = s.methodLabel || s.method || '占卜';
      const symbolTag = s.symbols ? `［${s.symbols}］` : '';
      const topicTag = s.topic ? `「${s.topic}」` : '';
      const bodyTag = s.body ? `—${s.body}` : '';
      return `  · [${methodTag}]${symbolTag}${topicTag}${bodyTag}`;
    };

    const lines: string[] = [];
    if (hard.length) {
      lines.push('- 最近抽过这几次（请明确避免再抽到同一张牌/同一卦象/同一类解读切入角度）：');
      for (const s of hard) lines.push(renderSample(s));
    }
    if (soft.length) {
      lines.push('- 再之前几次（不强制，但也尽量错开符号与切入角度）：');
      for (const s of soft) lines.push(renderSample(s));
    }
    if (filterMethod) {
      lines.push(
        `- 注：以上仅列出同占法（${filterMethod}）的历史；本占法的符号池有限（如塔罗 78 张 / 易经 64 卦），允许偶发重复，但不要连续几次都落在同一张/同一卦上。`,
      );
    }
    return lines.join('\n');
  } catch {
    // 读历史失败不应阻塞生成主流程，回退到空 anchor。
    return '';
  }
}

function coerceScoreInt(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(Math.max(0, Math.min(100, num)));
}

/**
 * 解析 fortuneScore：四项必须全有且都能 coerce 到 [0,100]。任一缺失/非法 → undefined（不带分数）。
 * "全或无"语义匹配 entry-store 的写入要求。
 */
function parseFortuneScore(raw: unknown): DivinationReadingResult['fortuneScore'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const overall = coerceScoreInt(r.overall);
  const career = coerceScoreInt(r.career);
  const love = coerceScoreInt(r.love);
  const wealth = coerceScoreInt(r.wealth);
  if (overall === null || career === null || love === null || wealth === null) return undefined;
  return { overall, career, love, wealth };
}

function parseOmens(raw: unknown): DivinationReadingResult['omens'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const good = typeof r.good === 'string' ? clampLine(r.good, 30) : '';
  const bad = typeof r.bad === 'string' ? clampLine(r.bad, 30) : '';
  if (!good || !bad) return undefined;
  return { good, bad };
}

export function normalizeDivinationReadingResult(raw: unknown): DivinationReadingResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const contentRaw = typeof record.content === 'string' ? record.content : '';
  const bodyRaw = typeof record.body === 'string' ? record.body : '';
  const content = sanitizeDivinationReadingContent(contentRaw || bodyRaw);
  if (!content || content.length < 16) return null;

  const agentQuestionRaw = typeof record.agentQuestion === 'string'
    ? record.agentQuestion
    : (typeof record.question === 'string' ? record.question : '');
  const agentQuestion = clampLine(agentQuestionRaw, 80);
  if (!agentQuestion) return null;

  const titleRaw = typeof record.title === 'string' ? record.title : '';
  const title = clampLine(titleRaw, 80) || agentQuestion.slice(0, 48);

  const result: DivinationReadingResult = { title, agentQuestion, content };
  const fortuneScore = parseFortuneScore(record.fortuneScore);
  if (fortuneScore) result.fortuneScore = fortuneScore;
  const omens = parseOmens(record.omens);
  if (omens) result.omens = omens;
  const luckyDirection = typeof record.luckyDirection === 'string' ? clampLine(record.luckyDirection, 20) : '';
  if (luckyDirection) result.luckyDirection = luckyDirection;
  const luckyColor = sanitizeLuckyColor(record.luckyColor);
  if (luckyColor) result.luckyColor = luckyColor;
  return result;
}

/**
 * luckyColor 要求是「<形容>的<颜色>色」描述性短语（prompt 端已说明）。模型偶尔不
 * 守约，会回 #RRGGBB / rgb()/hsl() 这种 CSS 颜色码——渲染端不再画色卡，光秃秃的
 * "#D4C5A9" 单独出现是噪音，所以这里直接 reject。其他形态（含汉字的描述短语）
 * 全部放行，最长截到 28 字符兜底。
 */
const HEX_OR_FUNCTIONAL_COLOR_RE = /^#?[0-9a-f]{3,8}$|^(rgba?|hsla?|hwb|lab|lch|color)\s*\(/i;

function sanitizeLuckyColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = clampLine(value, 28);
  if (!trimmed) return undefined;
  if (HEX_OR_FUNCTIONAL_COLOR_RE.test(trimmed)) return undefined;
  return trimmed;
}

export type GenerateDivinationReadingArgs = {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  methodId: XingyeDivinationMethodId;
  methodLabel: string;
  symbols: readonly string[];
  agentLike: XingyeDivinationAgentLike;
  userProvidedTheme?: string;
  resolverReason?: string;
  timeoutMs?: number;
  /**
   * 「正式加工」路径用：把心象草稿作为种子注入 prompt（见
   * xingye-divination-prompts.ts 的 seedNarrative 块）。普通正式占卜不传。
   */
  seedNarrative?: { agentQuestion?: string; content?: string };
};

/**
 * 调用 `POST /api/xingye/phone-generate`（`kind: divination_reading`），生成一次占卜叙事；
 * 与日记 / 秘密空间 / MM Chat / TA 状态等模块一致，由模型生成文本，本地仅做 sanitize 与字段归一。
 */
export async function generateDivinationReadingWithAI(
  args: GenerateDivinationReadingArgs,
): Promise<DivinationReadingResult> {
  const { agent, methodId, methodLabel, symbols, agentLike, userProvidedTheme, resolverReason, seedNarrative } = args;
  const timeoutMs = args.timeoutMs ?? 90_000;

  const userName = await resolveXingyeSpeakerUserName();
  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';
  // 跨次连续性锚点：按当前占法过滤同 method 历史，分层告诉模型「最近抽过这几次，请换」。
  // 失败/无历史 → 空字符串，prompt 端会渲染「（无；这是 TA 的第一次占卜）」。
  const continuityAnchorBlock = await buildDivinationContinuityAnchorBlock(agent.id, { method: methodId });

  const prompt = buildDivinationReadingPrompt({
    agent,
    userName,
    agentLike,
    methodId,
    methodLabel,
    symbols,
    userProvidedTheme,
    resolverReason,
    recentSceneBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
    seedNarrative,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'divination_reading',
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
      ? `：${(data.details as { message?: string }[])
        .map((item) => item.message ?? '')
        .join('；')}`
      : '';
    throw new Error(`${data?.error || '占卜生成失败'}${details}`);
  }

  const normalized = normalizeDivinationReadingResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少正文 / agentQuestion 或 JSON 解析失败');
  }
  return normalized;
}
