/**
 * 朋友圈短动态草稿生成（`generateXingyeMomentDraftWithAI`）。
 *
 * 与 journal/secret-space 同链路：`POST /api/xingye/phone-generate`，`kind: 'moments'`。
 * 上下文（profile / 最近聊天 / 关系 / heartbeat / lore）任一缺失都优雅降级为「（无）」，不抛错。
 * 不写入 moments store；返回结果由调用方塞回 MomentComposer 编辑框，**不直接发帖**。
 */
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { getVirtualContacts, resolveContactDisplayName } from './xingye-phone-store';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { postXingyeStorage } from './xingye-storage-api';
import {
  buildMomentDraftPrompt,
  type XingyeMomentPeerAgentHint,
  type XingyeMomentVirtualContactHint,
} from './xingye-moments-prompts';
import type {
  XingyeMomentSeedComment,
  XingyeMomentSeedLike,
} from './xingye-moments-store';

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

function clampMomentContent(s: string, maxCodePoints: number): string {
  const t = s.trim();
  const chars = [...t];
  if (chars.length <= maxCodePoints) return t;
  return `${chars.slice(0, maxCodePoints).join('')}…`;
}

export type NormalizedMomentDraft = {
  content: string;
  seedLikes: XingyeMomentSeedLike[];
  seedComments: XingyeMomentSeedComment[];
};

type ResolvedActorRef =
  | { actorType: 'virtual_contact'; actorId: string; actorName: string }
  | { actorType: 'agent'; actorId: string; actorName: string };

type ActorRefIndex = Map<string, ResolvedActorRef>;

function buildActorRefIndex(
  virtualContacts: ReadonlyArray<XingyeMomentVirtualContactHint>,
  peerAgents: ReadonlyArray<XingyeMomentPeerAgentHint>,
  ownerAgentId: string,
): ActorRefIndex {
  const index: ActorRefIndex = new Map();
  for (const c of virtualContacts) {
    if (!c?.id || !c?.displayName) continue;
    // virtual_contact actorId 用 owner-scoped 命名空间，避免和其他 agent 的同名联系人冲突。
    index.set(`vc:${c.id}`, {
      actorType: 'virtual_contact',
      actorId: `${ownerAgentId}:${c.id}`,
      actorName: c.displayName,
    });
  }
  for (const a of peerAgents) {
    if (!a?.id || !a?.displayName) continue;
    if (a.id === ownerAgentId) continue; // 不允许 self-like / self-comment
    index.set(`agent:${a.id}`, {
      actorType: 'agent',
      actorId: a.id,
      actorName: a.displayName,
    });
  }
  return index;
}

function resolveActorRef(raw: unknown, index: ActorRefIndex): ResolvedActorRef | null {
  if (typeof raw !== 'string') return null;
  const ref = raw.trim();
  if (!ref) return null;
  return index.get(ref) ?? null;
}

function parseLikeEntries(
  raw: unknown,
  index: ActorRefIndex,
  maxLikes: number,
): XingyeMomentSeedLike[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: XingyeMomentSeedLike[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const resolved = resolveActorRef(record.ref ?? record.actorRef, index);
    if (!resolved) continue;
    const dedupeKey = `${resolved.actorType}:${resolved.actorId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      actorType: resolved.actorType,
      actorId: resolved.actorId,
      actorName: resolved.actorName,
    });
    if (out.length >= maxLikes) break;
  }
  return out;
}

function parseCommentEntries(
  raw: unknown,
  index: ActorRefIndex,
  maxComments: number,
  maxBodyChars: number,
): XingyeMomentSeedComment[] {
  if (!Array.isArray(raw)) return [];
  const out: XingyeMomentSeedComment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const resolved = resolveActorRef(record.ref ?? record.actorRef, index);
    if (!resolved) continue;
    const bodyRaw = record.body ?? record.content;
    if (typeof bodyRaw !== 'string') continue;
    const body = bodyRaw.trim();
    if (!body) continue;
    out.push({
      actorType: resolved.actorType,
      actorId: resolved.actorId,
      actorName: resolved.actorName,
      body: clampMomentContent(body, maxBodyChars),
    });
    if (out.length >= maxComments) break;
  }
  return out;
}

/**
 * 校验 / 收窄朋友圈 AI 生成结果。
 * 若未提供 pools，则 likes / comments 一律被丢弃（无法 resolve ref）。
 */
export function normalizeMomentDraftResult(
  raw: unknown,
  pools: {
    ownerAgentId?: string;
    virtualContacts?: ReadonlyArray<XingyeMomentVirtualContactHint>;
    peerAgents?: ReadonlyArray<XingyeMomentPeerAgentHint>;
  } = {},
): NormalizedMomentDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const contentRaw = record.content;
  const bodyRaw = record.body;
  const content = typeof contentRaw === 'string'
    ? contentRaw.trim()
    : (typeof bodyRaw === 'string' ? bodyRaw.trim() : '');
  if (!content) return null;

  const index = buildActorRefIndex(
    pools.virtualContacts ?? [],
    pools.peerAgents ?? [],
    typeof pools.ownerAgentId === 'string' ? pools.ownerAgentId.trim() : '',
  );

  return {
    content: clampMomentContent(content, 280),
    seedLikes: parseLikeEntries(record.likes, index, 4),
    seedComments: parseCommentEntries(record.comments, index, 3, 60),
  };
}

/**
 * 调用 `POST /api/xingye/phone-generate`（`kind: 'moments'`）。
 * 不写入存储；调用方将 `content` 填回 MomentComposer 编辑框；
 * 同时把 `seedLikes` / `seedComments` 缓存在 composer state，在 user 点「发表」时一并随
 * `createXingyeMomentPost` 写入。
 *
 * 与 mail-ai 一致地从通讯录拉 virtual_contacts 作为可选互动者池；peerAgents 由调用方
 * 传入（roster 中除发帖 agent 自己外的其他角色）。任意池为空时仅意味着对应互动条目会被丢弃，
 * 整体生成不抛错。
 */
export async function generateXingyeMomentDraftWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  peerAgents?: ReadonlyArray<XingyeMomentPeerAgentHint>;
  timeoutMs?: number;
}): Promise<NormalizedMomentDraft> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const userName = await resolveXingyeSpeakerUserName();
  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  // 镜像 mail-ai：从通讯录拉 12 条 virtual_contact 作为可选互动者池。
  // displayName 走通讯录 UI 同源的 `resolveContactDisplayName`（meta.remark 优先 → contact.displayName），
  // 保证朋友圈里显示的互动者名字与通讯录里看到的一致。
  let virtualContacts: XingyeMomentVirtualContactHint[] = [];
  try {
    virtualContacts = getVirtualContacts(agent.id)
      .slice(0, 12)
      .map((c) => ({
        id: c.id,
        displayName: resolveContactDisplayName(agent.id, 'virtual_contact', c.id, [], {}),
        kind: c.kind,
        relationshipHint: c.relationshipHint,
      }));
  } catch {
    virtualContacts = [];
  }

  const peerAgents = (params.peerAgents ?? []).filter((a) => a?.id && a.id !== agent.id);

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    recentContext.summaryText,
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
    virtualContacts.map((c) => c.displayName).join(' '),
    peerAgents.map((a) => a.displayName).join(' '),
  ]);

  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'journal_draft',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const prompt = buildMomentDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    virtualContacts,
    peerAgents,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'moments',
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

  const normalized = normalizeMomentDraftResult(data?.result, {
    ownerAgentId: agent.id,
    virtualContacts,
    peerAgents,
  });
  if (!normalized) {
    throw new Error('模型返回无效：缺少正文或 JSON 解析失败');
  }
  return normalized;
}
