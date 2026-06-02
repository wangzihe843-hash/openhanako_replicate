/**
 * 秘密空间多分类 JSON 生成功能（`generateSecretSpaceRecordWithAI`）。
 *
 * 每类放入模型的上下文（与 Xingye AI 审计 §6–7 对齐；无 OpenHanako 聊天缓存时照常降级，不抛错）：
 * - **draft_reply**：`XingyeRoleProfile` + `collectRecentContextForAgent` / `describeRecentContextForPrompt` + lore `secret_space_draft_reply`（`buildSecretSpaceLoreRuntimeOptions`）
 * - **dream**：profile + 同上 recent（可空）+ lore `secret_space_dream`
 * - **saved_item**：profile + 同上 recent（可空）+ lore `secret_space_saved_item` + 用户可选 `seedText`（参与 lore queryText 与 prompt）
 * - **unsent_moment**：profile + 同上 recent（可空）+ lore `secret_space_unsent_moment`；**不**读朋友圈 / moments store
 * - **state**：profile + 同上 recent（可空）+ lore `relationship_state`（与 RelationshipStatePanel 并存；可追加状态类 JSONL 短笔记）
 *
 * 不在此实现：`memory_fragment`（`xingye-memory-candidate-store` 私藏回忆与候选流程）。
 * 不写入：pinned / memory.md / lore 文件；仅由调用方 `appendSecretSpaceRecord` 追加 `secret-space/*.jsonl`。
 */
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  normalizeSecretSpaceDraftRevisions,
  type SecretSpaceDraftRevisions,
} from './secret-space-draft-revisions';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { buildSecretSpaceLoreRuntimeOptions } from './xingye-secret-space-ai-context';
import {
  buildSecretSpaceGenerationPrompt,
  type SecretSpaceAiGenerableCategory,
} from './xingye-secret-space-prompts';
import { listSecretSpaceRecords } from './xingye-secret-space-store';
import {
  SECRET_SPACE_ANCHOR_BUILDERS,
  detectSecretSpaceDuplicate,
  type SecretSpaceDedupeSubtype,
} from './xingye-secret-space-dedupe';

export type { SecretSpaceAiGenerableCategory } from './xingye-secret-space-prompts';
export {
  isSecretSpaceAiGenerableCategory,
  SECRET_SPACE_AI_GENERABLE_CATEGORIES,
} from './xingye-secret-space-prompts';

export function normalizeSecretSpaceAiResult(
  raw: unknown,
): {
  title: string;
  content: string;
  meta?: string;
  tags?: string[];
  revisions?: SecretSpaceDraftRevisions;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const contentRaw = record.content;
  const content = typeof contentRaw === 'string' ? contentRaw.trim() : '';
  if (!content) return null;
  const titleRaw = record.title;
  const title = typeof titleRaw === 'string' && titleRaw.trim()
    ? titleRaw.trim().slice(0, 200)
    : content.slice(0, 48);

  // Optional meta (used for draft recipient, saved-item kind/source, unsent reason)
  const metaRaw = record.meta;
  let meta = typeof metaRaw === 'string' && metaRaw.trim() ? metaRaw.trim().slice(0, 160) : undefined;
  // Append source as suffix to meta if provided (saved_item style)
  const sourceRaw = record.source;
  if (typeof sourceRaw === 'string' && sourceRaw.trim()) {
    const sourceText = sourceRaw.trim().slice(0, 120);
    meta = meta ? `${meta} · ${sourceText}` : sourceText;
  }

  // Optional tags (used for dream imagery keywords)
  const tagsRaw = record.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 6)
        .map((t) => t.slice(0, 12))
    : undefined;

  // Optional draft revisions (only meaningful for draft_reply; harmless if absent).
  // 调用方决定要不要把它落进 metadata.draftRevisions——本 normalizer 只负责提纯。
  const revisions = normalizeSecretSpaceDraftRevisions(record.revisions) ?? undefined;

  return {
    title,
    content,
    meta,
    tags: tags && tags.length ? tags : undefined,
    ...(revisions ? { revisions } : {}),
  };
}

/** owner 角色资料里适合做 lore keyword 命中底座的字段（与小手机 / 各 app 链路一致）。 */
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

/**
 * 调用服务端模型（与通讯录 / 短信 / TA 状态一致：`POST /api/xingye/phone-generate`，`kind: secret_space`）。
 * 不写入存储；由调用方 appendSecretSpaceRecord。
 */
export async function generateSecretSpaceRecordWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  category: SecretSpaceAiGenerableCategory;
  /** 仅 saved_item：可选种子 */
  seedText?: string | null;
  timeoutMs?: number;
}): Promise<{
  title: string;
  content: string;
  meta?: string;
  tags?: string[];
  revisions?: SecretSpaceDraftRevisions;
}> {
  const { agent, ownerProfile, category } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;

  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const userName = await resolveXingyeSpeakerUserName();
  const recentChatBlock = describeRecentContextForPrompt(recentContext);

  const loreSeed = category === 'saved_item' ? (params.seedText ?? '') : '';
  const loreOpts = buildSecretSpaceLoreRuntimeOptions(category, loreSeed || undefined);
  // 冷启动（无种子、无聊天）时 buildSecretSpaceLoreRuntimeOptions 给出的 queryText 仅含 seedText，
  // keyword 型 lore 几乎不可能命中。与小手机 / 占卜等链路对齐：把 owner profile 关键字段 +
  // 最近聊天摘要也并入 queryText，让世界观 keyword 至少能经角色资料 / 近况被命中。
  // always lore 仍照常注入（loreOpts.includeAlways 保持 true，不受影响）。
  const loreQueryText = buildXingyeLoreRuntimeQueryText([
    loreOpts.queryText,
    ...profilePartsForQuery(ownerProfile),
    typeof recentContext.summaryText === 'string' ? recentContext.summaryText : '',
  ]);
  const loreCtx = collectXingyeLoreRuntimeContext(agent.id, { ...loreOpts, queryText: loreQueryText });
  const loreBlock = formatXingyeLoreRuntimeContextBlock(loreCtx);

  // 反重复：拉同子类型最近记录 → 构建 anchor block 喂给模型。
  // 用户痛点：「梦境也会反复生成相同内容」——5 个子类型都加，dream 是头号目标。
  let existingRecords: Awaited<ReturnType<typeof listSecretSpaceRecords>> = [];
  let continuityAnchorBlock = '';
  try {
    existingRecords = await listSecretSpaceRecords(agent.id, category);
    const builder = SECRET_SPACE_ANCHOR_BUILDERS[category as SecretSpaceDedupeSubtype];
    if (builder) continuityAnchorBlock = builder(existingRecords);
  } catch {
    existingRecords = [];
    continuityAnchorBlock = '';
  }

  const prompt = buildSecretSpaceGenerationPrompt({
    category,
    agent,
    userName,
    profile: ownerProfile,
    recentChatBlock,
    loreContextText: loreBlock,
    seedText: category === 'saved_item' ? params.seedText : undefined,
    continuityAnchorBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'secret_space',
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

  const normalized = normalizeSecretSpaceAiResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少正文或 JSON 解析失败');
  }

  // 入库前兜底：撞 exact_dup 直接抛错，让上层 UI 提示用户「TA 又写了一模一样的，换个时间试试」。
  // 选择抛错而不是静默丢弃：用户已经按下了"生成"按钮，无声丢弃会让人以为程序坏了。
  // similar 不拦——可能是同主题但角度不同（尤其 dream），保留。
  const dupSubtype = category as SecretSpaceDedupeSubtype;
  if (SECRET_SPACE_ANCHOR_BUILDERS[dupSubtype] && existingRecords.length > 0) {
    const dup = detectSecretSpaceDuplicate(
      { title: normalized.title, body: normalized.content },
      existingRecords,
      dupSubtype,
    );
    if (dup.kind === 'exact_dup') {
      throw new Error(`模型生成内容与已有记录《${dup.record.title}》完全重复，已自动拦截。请稍后再试或换一个切入点。`);
    }
  }

  return normalized;
}
