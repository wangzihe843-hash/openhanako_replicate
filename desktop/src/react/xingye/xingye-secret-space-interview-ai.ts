/**
 * 「秘密空间 · TA 的独家专访」AI 生成入口。
 *
 * 与通用 secret_space AI 路径分开，因为 interview 的返回结构是结构化的
 * （hostIntro / 5 题 / backstage / 弹幕），单一 content 字符串装不下。
 *
 * 不写存储；调用方拿到 SecretInterviewMetadata 后用 `appendSecretSpaceRecord('interview', ...)` 落地。
 */
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { listSecretSpaceRecords } from './xingye-secret-space-store';
import {
  buildSecretSpaceLoreRuntimeOptions,
} from './xingye-secret-space-ai-context';
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
  buildXingyeRecentChatExcerpts,
  formatXingyeRecentChatExcerptsForPrompt,
  resolveXingyeSpeakerUserName,
} from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { postXingyeStorage } from './xingye-storage-api';
import { buildSecretInterviewPrompt } from './xingye-secret-space-interview-prompts';
import {
  normalizeSecretInterviewMetadata,
  type SecretInterviewMetadata,
} from './xingye-secret-space-interview-types';

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
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 3200);
  return buildStableLoreFromAlwaysEntries(agentId, 2800).trim();
}

/**
 * 跨期连续性锚点：取最近 4 期专访的 title / hostName / 第一题 q，
 * 让模型沿用栏目名（hostName）+ 不重复同一题。
 */
async function buildInterviewContinuityAnchorBlock(agentId: string): Promise<string> {
  try {
    const rows = await listSecretSpaceRecords(agentId, 'interview');
    if (!rows.length) return '';
    const titleSamples: string[] = [];
    const hostNameSeen = new Set<string>();
    const hostNameSamples: string[] = [];
    const firstQSamples: string[] = [];
    for (const row of rows.slice(0, 8)) {
      // listSecretSpaceRecords 返回的 record 已 normalize，但 metadata
      // 不在 record 里——store 的 normalizeRecord 没透传 metadata 字段。
      // 我们直接从 row.body 兜底拿信息：body 第一行 = title。
      const body = typeof row.body === 'string' ? row.body : '';
      const firstLine = body.split('\n')[0]?.trim() ?? '';
      if (firstLine && titleSamples.length < 4) titleSamples.push(firstLine);
      // body 第三行是 "主持 / xxx"
      const hostLine = body.split('\n')[2]?.trim() ?? '';
      const m = hostLine.match(/^主持\s*\/\s*(.+)$/);
      if (m && m[1] && !hostNameSeen.has(m[1])) {
        hostNameSeen.add(m[1]);
        if (hostNameSamples.length < 4) hostNameSamples.push(m[1]);
      }
      // body 中 Q1. 行
      const q1Match = body.match(/^Q1\.\s*(.+)$/m);
      if (q1Match && q1Match[1] && firstQSamples.length < 4) {
        firstQSamples.push(q1Match[1].slice(0, 40));
      }
    }
    if (!titleSamples.length && !hostNameSamples.length && !firstQSamples.length) return '';
    const lines: string[] = [];
    if (hostNameSamples.length) {
      lines.push(`- 近期主持人 / 栏目笔名样本（请沿用同一位，不要每期换）：${hostNameSamples.map((h) => `「${h}」`).join('、')}`);
    }
    if (titleSamples.length) {
      lines.push(`- 近期专访标题（请换不同切口，不要重复主题）：`);
      for (const t of titleSamples) lines.push(`  · ${t}`);
    }
    if (firstQSamples.length) {
      lines.push(`- 近期开场第一题（请换不同的破冰角度）：`);
      for (const q of firstQSamples) lines.push(`  · ${q}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

function formatRelationshipBlock(agentId: string): string {
  try {
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
  } catch {
    return '';
  }
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

export async function generateSecretInterviewWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 用户出的那一题（可空）。 */
  userQuestion?: string;
  userName?: string;
  timeoutMs?: number;
  /** 录制日（ISO）。不传则用 new Date().toISOString()。 */
  recordedAtIso?: string;
}): Promise<SecretInterviewMetadata> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const userQuestion = params.userQuestion?.trim() ?? '';
  const recordedAtIso = params.recordedAtIso?.trim() || new Date().toISOString();
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const continuityAnchorBlock = await buildInterviewContinuityAnchorBlock(agent.id);

  let recentContext;
  try {
    recentContext = collectRecentContextForAgent({ agentId: agent.id });
  } catch {
    recentContext = { messages: [], summaryText: '' } as unknown as ReturnType<typeof collectRecentContextForAgent>;
  }

  let recentSceneBlock = '';
  try {
    const recentChatExcerpts = buildXingyeRecentChatExcerpts({
      context: recentContext,
      userName,
      agentName,
    });
    recentSceneBlock =
      formatXingyeRecentChatExcerptsForPrompt(recentChatExcerpts)
      || describeRecentContextForPrompt(recentContext);
  } catch {
    try {
      recentSceneBlock = describeRecentContextForPrompt(recentContext);
    } catch {
      recentSceneBlock = '';
    }
  }

  const relationshipBlock = formatRelationshipBlock(agent.id);

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    userQuestion,
    typeof recentContext.summaryText === 'string' ? recentContext.summaryText : '',
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
  ]);

  const loreOpts = buildSecretSpaceLoreRuntimeOptions('interview', userQuestion || undefined);
  const loreOptsWithQuery = { ...loreOpts, queryText, includeAlways: false, maxChars: 2_000 };

  let keywordLoreBlock = '';
  try {
    const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, loreOptsWithQuery);
    keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);
  } catch {
    keywordLoreBlock = '';
  }

  const prompt = buildSecretInterviewPrompt({
    agent,
    userName,
    profile: ownerProfile,
    recordedAtIso,
    userQuestion: userQuestion || undefined,
    continuityAnchorBlock,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'secret_interview_draft',
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

  // 强制把当期 recordedAtIso 覆盖回去（即使模型乱写日期也以系统时间为准）。
  const rawResult = (data?.result && typeof data.result === 'object' && !Array.isArray(data.result))
    ? { ...(data.result as Record<string, unknown>), recordedAt: recordedAtIso }
    : null;

  const normalized = normalizeSecretInterviewMetadata(rawResult);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 title / hostIntro / backstage 或题数不足 5 / 字段不合规。');
  }
  return normalized;
}
