import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import {
  buildJournalContinuityAnchorBlock,
  detectJournalDuplicate,
} from './xingye-journal-dedupe';
import { buildJournalDraftPrompt, buildJournalHistoryPrompt } from './xingye-journal-prompts';
import {
  listJournalEntries,
  XINGYE_JOURNAL_SMUDGED_DAY_KEY,
  type XingyeJournalEntry,
} from './xingye-journal-store';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { postXingyeStorage } from './xingye-storage-api';

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
}

async function buildStableLoreBlock(agentId: string): Promise<string> {
  const fromFile = await readLoreMemoryMarkdown(agentId);
  if (fromFile && fromFile.trim()) {
    return truncateChars(fromFile, 3200);
  }
  const fallback = buildStableLoreFromAlwaysEntries(agentId, 2800);
  return fallback.trim();
}

function safeText(value: string | undefined): string {
  return value?.trim() || '';
}

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

function profilePartsForQuery(profile: XingyeRoleProfile | null | undefined): string[] {
  if (!profile) return [];
  return [
    safeText(profile.displayName),
    safeText(profile.shortBio),
    safeText(profile.identitySummary),
    safeText(profile.backgroundSummary),
    safeText(profile.personalitySummary),
    safeText(profile.relationshipLabel),
    safeText(profile.values),
    safeText(profile.taboos),
    safeText(profile.relationshipMode),
  ];
}

function clampDiaryBody(s: string, maxCodePoints: number): string {
  const t = s.trim();
  const chars = [...t];
  if (chars.length <= maxCodePoints) return t;
  return `${chars.slice(0, maxCodePoints).join('')}…`;
}

export function normalizeJournalDraftResult(raw: unknown): { title: string; body: string; mood?: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const bodyRaw = record.body;
  const contentRaw = record.content;
  const body = typeof bodyRaw === 'string'
    ? bodyRaw.trim()
    : (typeof contentRaw === 'string' ? contentRaw.trim() : '');
  if (!body) return null;
  const titleRaw = record.title;
  const title = typeof titleRaw === 'string' && titleRaw.trim()
    ? titleRaw.trim().slice(0, 200)
    : body.slice(0, 48);
  const moodRaw = record.mood;
  const mood = typeof moodRaw === 'string' && moodRaw.trim() ? moodRaw.trim().slice(0, 24) : undefined;
  return { title, body: clampDiaryBody(body, 520), mood };
}

/**
 * 调用 `POST /api/xingye/phone-generate`（`kind: journal_draft`），与通讯录 / 秘密空间 / TA 状态一致。
 * 不写入日记存储；由调用方填入编辑框。
 */
export async function generateJournalDraftWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  timeoutMs?: number;
}): Promise<{ title: string; body: string; mood?: string }> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const userName = await resolveXingyeSpeakerUserName();

  // 跨期反重复锚点：把最近 8 篇日记的标题 + 开头 30 字塞进 prompt，
  // 让模型在源头就避开"今天又…"反复主题。listJournalEntries 异常时降级为空（不阻断生成）。
  let existingJournalEntries: Awaited<ReturnType<typeof listJournalEntries>> = [];
  try {
    existingJournalEntries = await listJournalEntries(agent.id);
  } catch {
    existingJournalEntries = [];
  }
  const continuityAnchorBlock = buildJournalContinuityAnchorBlock(existingJournalEntries);

  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    recentContext.summaryText,
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
  ]);

  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'journal_draft',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const prompt = buildJournalDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'journal_draft',
      ownerAgentId: agent.id,
      agentId: agent.id,
      prompt,
      timeoutMs,
    }),
  });

  let data: {
    ok?: boolean;
    error?: string;
    result?: unknown;
    details?: unknown;
  };
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
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  const normalized = normalizeJournalDraftResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少正文或 JSON 解析失败');
  }

  // 后置硬过滤：anchor block 已经提示过模型，但模型仍可能复读"今天又…"。
  // 命中 exact_dup 直接抛错由上层 UI 决定是否提示用户重试；similar 不拦截
  // （只是高度相似，让用户自己看到结果决定要不要保留——日记本来就允许相近主题）。
  const dup = detectJournalDuplicate(
    { title: normalized.title, body: normalized.body },
    existingJournalEntries,
  );
  if (dup.kind === 'exact_dup') {
    throw new Error(
      `生成的日记与最近一篇「${dup.entry.title}」(${dup.entry.dayKey}) 几乎重复（${dup.via === 'title' ? '标题' : '开头'}相同）。请稍后再试，或先删除旧条目。`,
    );
  }
  return normalized;
}

export type XingyeJournalHistoryDraft = {
  title: string;
  body: string;
  mood?: string;
  /**
   * YYYY-MM-DD。dateSmudged=false 时严格早于今天；dateSmudged=true 时是哨兵
   * `XINGYE_JOURNAL_SMUDGED_DAY_KEY`（'0001-01-01'），UI 不读这个字面值，
   * 只看 dateSmudged 标记。
   */
  dayKey: string;
  /** 时间不可考（模型没给出合法 dayKey）；UI 渲染污损贴纸。 */
  dateSmudged?: boolean;
};

function todayYmdLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isValidPastDayKey(value: unknown, todayYmd: string): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // 严格早于今天：把字符串当 YYYY-MM-DD 字典序比就行
  return value < todayYmd;
}

/**
 * 规范化首次打开 app 时模型给出的旧日记批量。
 *
 * 设计原则（见用户反馈）：**只在内容层面大规模重复时丢弃日记，不因为日期字段丢日记**。
 *  - dayKey 合法（YYYY-MM-DD 且严格早于今天）→ 保留原值；
 *  - dayKey 缺失 / 格式错 / 未来 → 不丢，标记 dateSmudged=true + 写哨兵 dayKey，
 *    让 UI 渲染"墨迹模糊"的污损贴纸代替日期；
 *  - 同一 dayKey 出现多条 → 允许（同一天写多篇本来就合理），不再去重；
 *  - 标题 / 开头 30 字命中 detectJournalDuplicate 的 exact_dup（批内已收纳条目）
 *    → 视为内容大规模复读，丢弃；similar 不拦截（让用户自己看）。
 *
 * 调用方（PhoneJournalApp 初始化路径）拿到 0 条会抛错，不写 initializedAt，
 * 下次打开重试。但实际能走到 0 条的路径只剩"模型把每一条都写成了同一篇"或者
 * "正文全空"——比之前严格的 dayKey 过滤宽松得多。
 */
export function normalizeJournalHistoryResults(
  raw: unknown,
  todayYmd: string = todayYmdLocal(),
): XingyeJournalHistoryDraft[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object') {
    const entries = (raw as Record<string, unknown>).entries;
    if (Array.isArray(entries)) items = entries;
    else {
      // 兜底兼容 { drafts: [...] }（模型偶尔会用 drafts 关键字）
      const drafts = (raw as Record<string, unknown>).drafts;
      if (Array.isArray(drafts)) items = drafts;
    }
  }

  const accepted: XingyeJournalHistoryDraft[] = [];
  // detectJournalDuplicate 的 existingEntries 入参需要 XingyeJournalEntry 形状；
  // 给它一份"已收纳"条目的 shim，只填它真正读的字段（id/dayKey/title/body）。
  const acceptedAsExisting: XingyeJournalEntry[] = [];
  for (const item of items) {
    const normalized = normalizeJournalDraftResult(item);
    if (!normalized) continue;

    // 批内内容大规模重复 → 丢弃这一条
    const dup = detectJournalDuplicate(
      { title: normalized.title, body: normalized.body },
      acceptedAsExisting,
    );
    if (dup.kind === 'exact_dup') continue;

    const dayKeyRaw = (item as Record<string, unknown>)?.dayKey;
    const valid = isValidPastDayKey(dayKeyRaw, todayYmd);
    const dayKey = valid ? (dayKeyRaw as string) : XINGYE_JOURNAL_SMUDGED_DAY_KEY;
    const dateSmudged = valid ? undefined : true;

    const draft: XingyeJournalHistoryDraft = {
      title: normalized.title,
      body: normalized.body,
      mood: normalized.mood,
      dayKey,
    };
    if (dateSmudged) draft.dateSmudged = true;
    accepted.push(draft);
    acceptedAsExisting.push({
      id: `__pending_${acceptedAsExisting.length}`,
      dayKey,
      title: normalized.title,
      body: normalized.body,
      createdAt: new Date(0).toISOString(),
    });
  }
  return accepted;
}

/**
 * 「首次打开日记 app」时的历史批量生成。
 *
 * 与 generateJournalDraftWithAI 区别：
 *  - prompt 走 buildJournalHistoryPrompt（产 3–5 条 + 每条带 dayKey + 跨期分布）；
 *  - 不依赖 recent chat / heartbeat / relationship —— 首次打开时 user 视角的最近聊天
 *    很可能完全为空，这些块没意义；只用 stable lore + keyword lore + profile；
 *  - 不做"已有日记反重复 anchor"——首次打开时本就没有；
 *  - 返回 multi-entry，每条携带模型选定的 dayKey（无效/缺失的由本地兜底分布在过去）。
 *
 * 任意单条解析失败不会让整批失败，只过滤掉无效条；如果最终一条都没有则抛错。
 */
export async function generateJournalHistoryWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 期望生成的条目数（3–5；越界会被夹紧）。 */
  desiredCount: number;
  timeoutMs?: number;
}): Promise<XingyeJournalHistoryDraft[]> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const desiredCount = Math.max(3, Math.min(5, Math.floor(params.desiredCount ?? 4)));

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const userName = await resolveXingyeSpeakerUserName();

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    stableLoreBlock.slice(0, 2000),
  ]);

  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'journal_draft',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const todayYmd = todayYmdLocal();

  const prompt = buildJournalHistoryPrompt({
    agent,
    userName,
    profile: ownerProfile,
    stableLoreBlock,
    keywordLoreBlock,
    desiredCount,
    todayYmd,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'journal_draft',
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

  const drafts = normalizeJournalHistoryResults(data?.result, todayYmd);
  if (drafts.length === 0) {
    throw new Error('模型返回无效：未生成可用的历史日记');
  }
  return drafts;
}
