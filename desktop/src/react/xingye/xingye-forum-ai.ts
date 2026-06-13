/**
 * 「秘密空间 · TA 的论坛小号」AI 生成入口。
 *
 * 编排：收集上下文（profile + 最近聊天 + 关系 + 设定库 always/keyword）→ 构 prompt →
 * 调 /api/xingye/phone-generate → normalize → 本地确定性组装 → 返回可落地记录。
 * 不写存储；调用方（UI / 心跳）拿到记录后用 xingye-forum-store 落地。
 *
 * 三个公开入口：
 *  - generateForumBootstrap：首开生成 1 个小号 + 一批帖子 + 派生私信。
 *  - generateForumBatch：给已有小号增量生成帖子（可能新开小号）+ 派生私信。
 *  - maybeAppendForumAfterHeartbeat：心跳成功后低概率追加（best-effort，全 swallow）。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { readXingyeRoleProfile } from './xingye-profile-store';
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
import {
  buildForumBatchPrompt,
  buildForumBootstrapPrompt,
  buildForumDmPrompt,
} from './xingye-forum-prompts';
import {
  assembleAccount,
  assembleDmThreads,
  assemblePosts,
  buildForumDedupeAnchorBlock,
  deriveForumDmPeers,
  type ForumDmPeerCandidate,
} from './xingye-forum-assemble';
import {
  normalizeForumBatchResult,
  normalizeForumBootstrapResult,
  normalizeForumDmResult,
  type ForumAccount,
  type ForumPost,
  type ForumThread,
} from './xingye-forum-types';
import {
  appendForumAccount,
  appendForumPosts,
  appendForumThreads,
  listForumAccounts,
  listForumPosts,
  readForumMeta,
} from './xingye-forum-store';

const DM_PEERS_BOOTSTRAP = 3;
const DM_PEERS_BATCH = 2;
/** 心跳成功后追加一批论坛动态的概率（与联系人记录 0.1、礼物掉落 0.1 同量级）。 */
export const HEARTBEAT_FORUM_APPEND_RATE = 0.1;

// ── 上下文收集（与专访 ai 同源的样板，复用共享工具） ──────────────────────────────

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

async function readLoreMemoryMarkdown(agentId: string): Promise<string | null> {
  try {
    const data = (await postXingyeStorage({
      action: 'read',
      agentId,
      relativePath: 'lore-memory.md',
      binary: false,
    })) as { missing?: boolean; content?: unknown };
    if (data?.missing || typeof data?.content !== 'string') return null;
    const text = data.content.replace(/^<!--[\s\S]*?-->\s*/m, '').trim();
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
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 3000);
  return buildStableLoreFromAlwaysEntries(agentId, 2600).trim();
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
  ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

interface ForumGatheredContext {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName: string;
  profile: XingyeRoleProfile | null | undefined;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  recentSceneBlock: string;
  relationshipBlock: string;
}

async function gatherForumContext(
  agent: Agent,
  ownerProfile: XingyeRoleProfile | null | undefined,
  extraQueryParts: string[] = [],
): Promise<ForumGatheredContext> {
  const userName = await resolveXingyeSpeakerUserName();
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);

  let recentContext;
  try {
    recentContext = collectRecentContextForAgent({ agentId: agent.id });
  } catch {
    recentContext = { messages: [], summaryText: '' } as unknown as ReturnType<typeof collectRecentContextForAgent>;
  }

  let recentSceneBlock = '';
  try {
    const excerpts = buildXingyeRecentChatExcerpts({ context: recentContext, userName, agentName });
    recentSceneBlock =
      formatXingyeRecentChatExcerptsForPrompt(excerpts) || describeRecentContextForPrompt(recentContext);
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
    typeof recentContext.summaryText === 'string' ? recentContext.summaryText : '',
    relationshipBlock,
    stableLoreBlock.slice(0, 1800),
    ...extraQueryParts,
  ]);

  let keywordLoreBlock = '';
  try {
    const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
      purpose: 'secret_space_forum',
      queryText,
      includeAlways: false,
      includeKeyword: true,
      maxChars: 2_000,
    });
    keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);
  } catch {
    keywordLoreBlock = '';
  }

  return {
    agent: { id: agent.id, name: agent.name, yuan: agent.yuan },
    userName,
    profile: ownerProfile,
    stableLoreBlock,
    keywordLoreBlock,
    recentSceneBlock,
    relationshipBlock,
  };
}

// ── 模型调用 ──────────────────────────────────────────────────────────────────

async function callForumModel(
  agentId: string,
  prompt: string,
  kind: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({ kind, ownerAgentId: agentId, agentId, prompt, timeoutMs }),
  });
  let data: { ok?: boolean; error?: string; result?: unknown; details?: unknown };
  try {
    data = await response.json();
  } catch {
    throw new Error('解析服务器响应失败');
  }
  if (!response.ok || data?.ok === false || data?.error) {
    const details = Array.isArray(data?.details)
      ? `：${(data.details as { message?: string }[]).map((i) => i.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }
  return data?.result ?? null;
}

// ── 私信子步骤（best-effort，失败返回 []） ──────────────────────────────────────

function pickSubset<T>(items: T[], max: number, rand: () => number): T[] {
  if (items.length <= max) return items.slice();
  const copy = items.slice();
  // Fisher-Yates 取前 max 个
  for (let i = 0; i < max; i += 1) {
    const j = i + Math.floor(rand() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, max);
}

async function buildDmThreadsForPosts(
  ctx: ForumGatheredContext,
  account: ForumAccount,
  posts: ForumPost[],
  maxPeers: number,
  timeoutMs: number,
): Promise<ForumThread[]> {
  try {
    const allPeers = deriveForumDmPeers(posts);
    if (!allPeers.length) return [];
    const peers = pickSubset(allPeers, maxPeers, Math.random);
    const peerMeta = new Map<string, ForumDmPeerCandidate>();
    for (const p of peers) peerMeta.set(p.peerName.toLowerCase(), p);

    const prompt = buildForumDmPrompt({ ...ctx, account, peers });
    const result = await callForumModel(ctx.agent.id, prompt, 'forum_dm', timeoutMs);
    const specs = normalizeForumDmResult(result);
    if (!specs.length) return [];
    return assembleDmThreads(specs, account, peerMeta);
  } catch (error) {
    console.warn('[xingye-forum-ai] DM 生成失败（忽略，不阻塞帖子生成）:', error);
    return [];
  }
}

// ── 公开入口 ──────────────────────────────────────────────────────────────────

export interface ForumBootstrapOutput {
  account: ForumAccount;
  posts: ForumPost[];
  threads: ForumThread[];
}

export async function generateForumBootstrap(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  timeoutMs?: number;
}): Promise<ForumBootstrapOutput> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const ctx = await gatherForumContext(agent, ownerProfile);

  const prompt = buildForumBootstrapPrompt(ctx);
  const result = await callForumModel(agent.id, prompt, 'forum_bootstrap', timeoutMs);
  const normalized = normalizeForumBootstrapResult(result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少合法的小号或帖子。');
  }

  const account = assembleAccount(normalized.account);
  const posts = assemblePosts(normalized.posts, account, { spreadDays: 14 });
  const threads = await buildDmThreadsForPosts(ctx, account, posts, DM_PEERS_BOOTSTRAP, timeoutMs);
  return { account, posts, threads };
}

export interface ForumBatchOutput {
  /** 若模型提议新开小号则有值；否则 null（帖子归属 activeAccount）。 */
  newAccount: ForumAccount | null;
  posts: ForumPost[];
  threads: ForumThread[];
}

export async function generateForumBatch(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  activeAccount: ForumAccount;
  existingAccounts: ForumAccount[];
  recentPosts: ForumPost[];
  forceNewAccount?: boolean;
  timeoutMs?: number;
}): Promise<ForumBatchOutput> {
  const { agent, ownerProfile, activeAccount, existingAccounts, recentPosts, forceNewAccount } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const ctx = await gatherForumContext(agent, ownerProfile, [
    activeAccount.themeLabel,
    ...activeAccount.themeKeywords,
  ]);

  const dedupeAnchorBlock = buildForumDedupeAnchorBlock(recentPosts, existingAccounts);
  const prompt = buildForumBatchPrompt({
    ...ctx,
    activeAccount,
    existingAccounts,
    dedupeAnchorBlock,
    forceNewAccount,
  });
  const result = await callForumModel(agent.id, prompt, 'forum_batch', timeoutMs);
  const { posts: postSpecs, newAccount: newAccountSpec } = normalizeForumBatchResult(result);

  // forceNewAccount 时模型却没给新号 → 兜底用 activeAccount，不至于空手而归。
  const newAccount = newAccountSpec ? assembleAccount(newAccountSpec) : null;
  const targetAccount = newAccount ?? activeAccount;

  if (!postSpecs.length) {
    return { newAccount, posts: [], threads: [] };
  }
  const posts = assemblePosts(postSpecs, targetAccount, { spreadDays: 1 });
  const threads = await buildDmThreadsForPosts(ctx, targetAccount, posts, DM_PEERS_BATCH, timeoutMs);
  return { newAccount, posts, threads };
}

/**
 * 心跳成功后调用：以 HEARTBEAT_FORUM_APPEND_RATE 概率给一个已初始化的论坛小号追加一批动态。
 * 不会 bootstrap（小号需用户先打开论坛生成）。失败全部 swallow——best-effort，不阻塞心跳 UI。
 */
export async function maybeAppendForumAfterHeartbeat(
  agent: Agent | null,
  options: { probability?: number; randomSource?: () => number } = {},
): Promise<{ appended: boolean }> {
  if (!agent?.id) return { appended: false };
  try {
    const random = options.randomSource ?? Math.random;
    const probability = options.probability ?? HEARTBEAT_FORUM_APPEND_RATE;
    if (random() >= probability) return { appended: false };

    const meta = await readForumMeta(agent.id);
    if (!meta?.initializedAt) return { appended: false };

    const accounts = await listForumAccounts(agent.id);
    if (!accounts.length) return { appended: false };

    const activeAccount = accounts[Math.floor(random() * accounts.length) % accounts.length];
    const allPosts = await listForumPosts(agent.id);
    const recentPosts = allPosts.filter((p) => p.accountId === activeAccount.accountId).slice(0, 12);
    const ownerProfile = await readXingyeRoleProfile(agent.id);

    const out = await generateForumBatch({
      agent,
      ownerProfile,
      activeAccount,
      existingAccounts: accounts,
      recentPosts,
    });

    if (out.newAccount) await appendForumAccount(agent.id, out.newAccount);
    if (out.posts.length) await appendForumPosts(agent.id, out.posts);
    if (out.threads.length) await appendForumThreads(agent.id, out.threads);
    return { appended: out.posts.length > 0 || Boolean(out.newAccount) };
  } catch (error) {
    console.warn('[xingye-forum-ai] heartbeat append failed:', error);
    return { appended: false };
  }
}
