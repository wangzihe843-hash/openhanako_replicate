/**
 * 秘密空间「四类普通分类」JSON 生成功能（`generateSecretSpaceRecordWithAI`）。
 *
 * 每类放入模型的上下文（与 Xingye AI 审计 §6–7 对齐；无 OpenHanako 聊天缓存时照常降级，不抛错）：
 * - **draft_reply**：`XingyeRoleProfile` + `collectRecentContextForAgent` / `describeRecentContextForPrompt` + lore `secret_space_draft_reply`（`buildSecretSpaceLoreRuntimeOptions`）
 * - **dream**：profile + 同上 recent（可空）+ lore `secret_space_dream`
 * - **saved_item**：profile + lore `secret_space_saved_item` + 用户可选 `seedText`（参与 lore queryText 与 prompt）
 * - **unsent_moment**：profile + 同上 recent（可空）+ lore `secret_space_unsent_moment`；**不**读朋友圈 / moments store
 *
 * 不在此实现：`state`（已有 RelationshipStatePanel / `xingye-state-store`）、`memory_fragment`（`xingye-memory-candidate-store` 私藏回忆与候选流程）。
 * 不写入：pinned / memory.md / lore 文件；仅由调用方 `appendSecretSpaceRecord` 追加 `secret-space/*.jsonl`。
 */
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import {
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { buildSecretSpaceLoreRuntimeOptions } from './xingye-secret-space-ai-context';
import {
  buildSecretSpaceGenerationPrompt,
  type SecretSpaceAiGenerableCategory,
} from './xingye-secret-space-prompts';

export type { SecretSpaceAiGenerableCategory } from './xingye-secret-space-prompts';

export function normalizeSecretSpaceAiResult(raw: unknown): { title: string; content: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const contentRaw = record.content;
  const content = typeof contentRaw === 'string' ? contentRaw.trim() : '';
  if (!content) return null;
  const titleRaw = record.title;
  const title = typeof titleRaw === 'string' && titleRaw.trim()
    ? titleRaw.trim().slice(0, 200)
    : content.slice(0, 48);
  return { title, content };
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
}): Promise<{ title: string; content: string }> {
  const { agent, ownerProfile, category } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;

  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentChatBlock = describeRecentContextForPrompt(recentContext);

  const loreSeed = category === 'saved_item' ? (params.seedText ?? '') : '';
  const loreOpts = buildSecretSpaceLoreRuntimeOptions(category, loreSeed || undefined);
  const loreCtx = collectXingyeLoreRuntimeContext(agent.id, loreOpts);
  const loreBlock = formatXingyeLoreRuntimeContextBlock(loreCtx);

  const prompt = buildSecretSpaceGenerationPrompt({
    category,
    agent,
    profile: ownerProfile,
    recentChatBlock,
    loreContextText: loreBlock,
    seedText: category === 'saved_item' ? params.seedText : undefined,
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
  return normalized;
}
