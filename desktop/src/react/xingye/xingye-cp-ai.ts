/**
 * 「你和 TA 的 CP」板块 AI 生成入口。
 *
 * 编排：判定「有没有新聊天」(水位线闸门) → 收集上下文(复用 forum 的 gatherForumContext) →
 * 构 prompt → 调 /api/xingye/phone-generate(kind=cp_board) → normalize → 解析/锁定 CP 马甲 →
 * 本地确定性组装 → 返回可落地记录。不写存储；调用方拿到结果后用 xingye-cp-store 落地。
 *
 * 与论坛小号的关键差异：
 *  - **不自动初始化**：只有用户主动点「偷看更新」才生成；不挂心跳。
 *  - **新聊天闸门**：用聊天签名(watermark)判定；无聊天 / 无新聊天直接返回闸门状态，不调模型。
 *  - **没有 agent 主动主题帖**：生成只产 NPC 帖；agent 内容仅来自评论 + 用户「替 TA 发送」的草稿。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { collectRecentContextForAgent } from './xingye-recent-context';
import { gatherForumContext } from './xingye-forum-ai';
import type { ForumAccount } from './xingye-forum-types';
import { buildCpBoardPrompt, type CpExistingAccountHint } from './xingye-cp-prompts';
import {
  assembleCpAltFromForumAccount,
  assembleCpAltFromSpec,
  assembleCpDrafts,
  assembleCpPosts,
  buildCpDedupeAnchorBlock,
  cpChatSignature,
} from './xingye-cp-assemble';
import {
  normalizeCpBoardResult,
  type CpAltAccount,
  type CpDraft,
  type CpMeta,
  type CpPost,
} from './xingye-cp-types';

// ── 新聊天水位线闸门 ───────────────────────────────────────────────────────────

export type CpChatGateStatus = 'ok' | 'no_chat' | 'no_new_chat';

export interface CpChatGate {
  status: CpChatGateStatus;
  /** 当前聊天签名（生成成功后写进 meta.watermark）。 */
  signature: string;
}

function buildChatSignature(agentId: string): { signature: string; hasChat: boolean } {
  let recent;
  try {
    recent = collectRecentContextForAgent({ agentId });
  } catch {
    return { signature: '', hasChat: false };
  }
  const last = recent.messages[recent.messages.length - 1];
  const signature = cpChatSignature({
    messageCount: recent.messages.length,
    lastCreatedAt: last?.createdAt,
    summaryText: recent.summaryText,
  });
  return { signature, hasChat: recent.hasOpenHanakoMessages };
}

/**
 * 同步预判闸门（供 UI 决定按钮可用性 / 提示文案，不调模型）：
 *  - no_chat：当前角色根本没有可读的最近聊天 → 「缺少聊天内容，无法更新」。
 *  - no_new_chat：有聊天但与上次生成时一致（没新料） → 「没有新的聊天内容」。
 *  - ok：有新聊天，可以生成。
 */
export function evaluateCpChatGate(params: { agentId: string; watermark?: string }): CpChatGate {
  const { signature, hasChat } = buildChatSignature(params.agentId);
  if (!hasChat) return { status: 'no_chat', signature };
  if (params.watermark && signature === params.watermark) return { status: 'no_new_chat', signature };
  return { status: 'ok', signature };
}

// ── 模型调用 ──────────────────────────────────────────────────────────────────

async function callCpModel(agentId: string, prompt: string, timeoutMs: number): Promise<unknown> {
  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({ kind: 'cp_board', ownerAgentId: agentId, agentId, prompt, timeoutMs }),
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

// ── 公开入口 ──────────────────────────────────────────────────────────────────

const CP_FALLBACK_ALT_SPEC = { username: '蹲墙根潜水', bio: '只是路过磕一口', themeLabel: '潜水' };

/** 解析 CP 名：已锁定 → 沿用；否则用模型给的；都没有 → 各取名字首字拼一个 2 字缩写兜底。 */
function resolveCpName(
  lockedName: string | null | undefined,
  specName: string,
  userName: string,
  agentName: string,
): string {
  if (lockedName && lockedName.trim()) return lockedName.trim();
  if (specName && specName.trim()) return specName.trim();
  const u = Array.from(userName.trim());
  const a = Array.from(agentName.trim());
  if (u.length && a.length) return `${u[0]}${a[0]}`;
  return '你和 TA';
}

function resolveAlt(
  metaAlt: CpAltAccount | null | undefined,
  pickUsername: string | null | undefined,
  newAlt: { username: string; bio: string; themeLabel: string } | null | undefined,
  forumAccounts: ForumAccount[],
): CpAltAccount {
  // 已锁定 → 永远沿用，保证 CP 身份稳定。
  if (metaAlt) return metaAlt;
  // 模型挑了一个现有小号。
  if (pickUsername) {
    const found = forumAccounts.find((a) => a.username.toLowerCase() === pickUsername.toLowerCase());
    if (found) return assembleCpAltFromForumAccount(found);
  }
  // 模型新造了一个 CP 马甲。
  if (newAlt) return assembleCpAltFromSpec(newAlt);
  // 兜底：有现有小号就拿第一个；否则造一个默认潜水马甲。
  if (forumAccounts.length) return assembleCpAltFromForumAccount(forumAccounts[0]);
  return assembleCpAltFromSpec(CP_FALLBACK_ALT_SPEC);
}

export type CpBoardGenerateResult =
  | { status: 'no_chat' }
  | { status: 'no_new_chat' }
  | {
      status: 'ok';
      cpName: string;
      alt: CpAltAccount;
      posts: CpPost[];
      drafts: CpDraft[];
      followReaction: string;
      /** 本次聊天签名；调用方写进 meta.watermark。 */
      signature: string;
    };

/**
 * 生成 / 追加一批 CP 板内容。先过新聊天闸门（no_chat / no_new_chat 直接返回，不调模型）；
 * 通过后调模型并组装。alt 首次解析后由调用方写进 meta 锁定，之后沿用。
 */
export async function generateCpBoardBatch(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  meta: CpMeta | null;
  forumAccounts: ForumAccount[];
  recentPosts: CpPost[];
  timeoutMs?: number;
}): Promise<CpBoardGenerateResult> {
  const { agent, ownerProfile, meta, forumAccounts, recentPosts } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;

  const gate = evaluateCpChatGate({ agentId: agent.id, watermark: meta?.watermark });
  if (gate.status !== 'ok') return { status: gate.status };

  const lockedAlt = meta?.alt ?? null;
  const ctx = await gatherForumContext(
    agent,
    ownerProfile,
    ['CP 同人 感情 关系', ...(lockedAlt ? [lockedAlt.themeLabel] : [])],
    'secret_space_cp',
  );

  const existingAccounts: CpExistingAccountHint[] = forumAccounts.map((a) => ({
    username: a.username,
    themeLabel: a.themeLabel,
    bio: a.bio,
  }));

  const prompt = buildCpBoardPrompt({
    ...ctx,
    existingAccounts,
    lockedAlt,
    lockedCpName: meta?.cpName ?? null,
    dedupeAnchorBlock: buildCpDedupeAnchorBlock(recentPosts),
    followed: meta?.followed ?? false,
  });

  const result = await callCpModel(agent.id, prompt, timeoutMs);
  const normalized = normalizeCpBoardResult(result);
  if (!normalized) {
    throw new Error('模型返回无效：没有刷出可用的 CP 帖。');
  }

  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';
  const cpName = resolveCpName(meta?.cpName, normalized.cpName, ctx.userName, agentName);
  const alt = resolveAlt(lockedAlt, normalized.alt.pickUsername, normalized.alt.newAlt, forumAccounts);
  const posts = assembleCpPosts(normalized.posts, alt.username, { spreadDays: 2 });
  const drafts = assembleCpDrafts(normalized.drafts, posts);

  return {
    status: 'ok',
    cpName,
    alt,
    posts,
    drafts,
    followReaction: normalized.followReaction,
    signature: gate.signature,
  };
}
