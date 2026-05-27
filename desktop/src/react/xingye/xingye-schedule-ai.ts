import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import { buildScheduleDraftPrompt } from './xingye-schedule-prompts';
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
import {
  buildXingyeSpeakerAiDebugSnapshot,
  buildXingyeRecentChatExcerpts,
  formatXingyeRecentChatExcerptsForPrompt,
  resolveXingyeSpeakerUserName,
  type XingyeSpeakerAiDebugSnapshot,
} from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { postXingyeStorage } from './xingye-storage-api';
import { listScheduleEntries, type XingyeScheduleStatus } from './xingye-schedule-store';
import {
  buildScheduleContinuityAnchorBlock,
  detectScheduleDuplicate,
  filterSameDayScheduleDuplicates,
} from './xingye-schedule-dedupe';

// Re-export so legacy callers that previously imported these names from xingye-schedule-ai
// continue to compile; the canonical home is xingye-schedule-dedupe.
export { detectScheduleDuplicate, filterSameDayScheduleDuplicates };

export type XingyeScheduleAiDraft = {
  title: string;
  dateLabel: string;
  timeText?: string;
  content: string;
  note?: string;
  status: XingyeScheduleStatus;
  category?: string;
};

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

export const buildScheduleRecentChatExcerpts = buildXingyeRecentChatExcerpts;
export const formatScheduleRecentChatExcerptsForPrompt = formatXingyeRecentChatExcerptsForPrompt;
export const buildScheduleAiDebugSnapshot = buildXingyeSpeakerAiDebugSnapshot;

function shouldLogScheduleAiDebug(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as Record<string, unknown>).__XINGYE_DEBUG_SCHEDULE_AI__);
}

function logScheduleAiDebugSnapshot(snapshot: XingyeSpeakerAiDebugSnapshot): void {
  if (!shouldLogScheduleAiDebug()) return;
  console.info('[xingye-schedule-ai] sanitized prompt input', snapshot);
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
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 3200);
  return buildStableLoreFromAlwaysEntries(agentId, 2800).trim();
}

/**
 * 跨期连续性锚点：从 listScheduleEntries 拉最近若干条已落库日程，让
 * xingye-schedule-dedupe 的纯函数 buildScheduleContinuityAnchorBlock 渲染
 * 列表 + 反重复提示。详见该模块的 docstring。
 *
 * 无历史 → 返回空字符串；生成入口会把它替换成「（无）」占位文案。
 *
 * 与 accounting 的「日内独占 slot」不同：日程没有「一天只能 1 个早会」这种
 * 自然资源上限（理论上一天可以多个会），所以这里走「软提示反重复」+
 * filterSameDayScheduleDuplicates 硬过滤（精确同日同 title）双层防御。
 */
async function buildScheduleContinuityAnchorBlockForAgent(agentId: string): Promise<string> {
  try {
    const rows = await listScheduleEntries(agentId);
    if (!rows.length) return '';
    // 按 updatedAt 倒序取最近 20 条；listScheduleEntries 默认按 dateLabel + updatedAt 排，
    // 这里手动按 updatedAt 再 sort 一遍，保证「最近写入」优先（dateLabel 是自然语言时间，
    // 字典序不一定 = 时间序）。
    const recent = [...rows]
      .sort((a, b) => {
        const ta = Date.parse(a.updatedAt);
        const tb = Date.parse(b.updatedAt);
        if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
        return 0;
      })
      .slice(0, 20);
    return buildScheduleContinuityAnchorBlock(recent);
  } catch {
    return '';
  }
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
    profile.displayName,
    profile.shortBio,
    profile.identitySummary,
    profile.backgroundSummary,
    profile.personalitySummary,
    profile.relationshipLabel,
    profile.values,
    profile.taboos,
    profile.relationshipMode,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
}

function normalizeOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return truncateChars(text, max);
}

export function normalizeScheduleDraftResult(raw: unknown): XingyeScheduleAiDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const dateLabel = typeof record.dateLabel === 'string' ? record.dateLabel.trim() : '';
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (!title || !dateLabel || !content) return null;
  const status = record.status === 'done' || record.status === 'skipped' ? record.status : 'planned';
  return {
    title: truncateChars(title, 160),
    dateLabel: truncateChars(dateLabel, 80),
    timeText: normalizeOptional(record.timeText, 80),
    content: truncateChars(content, 1200),
    note: normalizeOptional(record.note, 500),
    status,
    category: normalizeOptional(record.category, 24),
  };
}

export async function generateScheduleDraftWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userName?: string;
  userIntent?: string;
  timeoutMs?: number;
}): Promise<XingyeScheduleAiDraft> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const userIntent = params.userIntent?.trim() ?? '';
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  // 反重复锚点：把最近 10 条已有日程的 title/dateLabel/timeText 喂给模型，
  // 让它避免反复生成「今天约 XX 喝咖啡」这种近邻条目。无历史 → 空串。
  const continuityAnchorBlock = await buildScheduleContinuityAnchorBlockForAgent(agent.id);
  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentChatExcerpts = buildScheduleRecentChatExcerpts({
    context: recentContext,
    userName,
    agentName,
  });
  const recentChatExcerptsBlock = formatScheduleRecentChatExcerptsForPrompt(recentChatExcerpts);
  const recentSceneBlock = recentChatExcerptsBlock || describeRecentContextForPrompt(recentContext);
  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    userIntent,
    recentChatExcerpts.map((excerpt) => `${excerpt.speakerLabel}: ${excerpt.text}`).join('\n') || recentContext.summaryText,
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
  ]);

  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'generic',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const prompt = buildScheduleDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    userIntent,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
  });
  logScheduleAiDebugSnapshot(buildScheduleAiDebugSnapshot({
    userName,
    agentName,
    recentChatExcerpts,
    prompt,
  }));

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'schedule_draft',
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
      ? `：${(data.details as { message?: string }[]).map((item) => item.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  const normalized = normalizeScheduleDraftResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少明确日程安排或 JSON 解析失败');
  }

  // 落库前的「同日同事件」硬过滤兜底（continuity anchor 是软提示，模型仍可能
  // 复读同一天同一题；这里拦在调用方落库之前）。匹配现有日程 → 抛错让 UI
  // 提示用户重生成或换主题，而不是悄悄写入一条重复条目。
  try {
    const existing = await listScheduleEntries(agent.id);
    const dedupResult = filterSameDayScheduleDuplicates([normalized], existing);
    if (dedupResult.length === 0) {
      const verdict = detectScheduleDuplicate(
        { title: normalized.title, dateLabel: normalized.dateLabel },
        existing,
      );
      const dupTitle = verdict.kind === 'exact_dup' || verdict.kind === 'similar'
        ? verdict.existingTitle
        : normalized.title;
      throw new Error(`这条日程与已有「${dupTitle}」(${normalized.dateLabel}) 重复，换一个时间或主题再试一次。`);
    }
  } catch (err) {
    // listScheduleEntries 读盘失败 → 不阻塞主路径，仍然返回 normalized
    // 让用户继续；硬重复在 confirm 阶段还有 from-draft-id 幂等兜底。
    if (err instanceof Error && err.message.startsWith('这条日程与已有')) throw err;
  }

  return normalized;
}
