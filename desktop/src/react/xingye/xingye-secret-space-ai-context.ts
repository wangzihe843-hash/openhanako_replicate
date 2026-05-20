/**
 * xingye-secret-space-ai-context.ts — SecretSpace lore runtime options（纯映射，无模型）。
 *
 * 供 `xingye-secret-space-ai.ts` 调用 `collectXingyeLoreRuntimeContext` 时使用。
 *
 * 严格约束：
 * - 不调用任何模型。
 * - 不修改 SecretSpace records / UI / 短信 / 通讯录。
 * - 不写持久层。
 * - 不经由本文件读取 OpenHanako 记忆候选内容（`memory_fragment` 的 purpose 仅作 lore keyword 查询用途，
 *   实际「私藏回忆 → 记忆候选」仍在 `xingye-memory-candidate-store`）。
 *
 * 仅把分类映射到 `XingyeLoreRuntimeContextPurpose`：`state` → `relationship_state`，其余为 `secret_space_*`。
 */

import {
  buildXingyeLoreRuntimeQueryText,
  type XingyeLoreRuntimeContextOptions,
  type XingyeLoreRuntimeContextPurpose,
} from './xingye-lore-runtime-context';

export type XingyeSecretSpaceLoreCategory =
  | 'state'
  | 'dream'
  | 'draft_reply'
  | 'unsent_moment'
  | 'saved_item'
  | 'memory_fragment'
  | 'interview';

/**
 * SecretSpace AI 生成允许使用的 purpose 子集。
 * 与 `XingyeLoreRuntimeContextPurpose` 的子集对应：`state` 使用 `relationship_state`，其余为 `secret_space_*`。
 */
export type XingyeSecretSpaceLorePurpose = Extract<
  XingyeLoreRuntimeContextPurpose,
  | 'relationship_state'
  | 'secret_space_dream'
  | 'secret_space_draft_reply'
  | 'secret_space_unsent_moment'
  | 'secret_space_saved_item'
  | 'secret_space_memory_fragment'
  | 'secret_space_interview'
>;

const CATEGORY_TO_PURPOSE: Record<XingyeSecretSpaceLoreCategory, XingyeSecretSpaceLorePurpose> = {
  state: 'relationship_state',
  dream: 'secret_space_dream',
  draft_reply: 'secret_space_draft_reply',
  unsent_moment: 'secret_space_unsent_moment',
  saved_item: 'secret_space_saved_item',
  memory_fragment: 'secret_space_memory_fragment',
  interview: 'secret_space_interview',
};

export function getSecretSpaceLorePurpose(category: XingyeSecretSpaceLoreCategory): XingyeSecretSpaceLorePurpose {
  return CATEGORY_TO_PURPOSE[category];
}

/**
 * 给定一个 SecretSpace 分类（可选附带 seedText），返回适合喂给
 * `collectXingyeLoreRuntimeContext(agentId, options)` 的 options。
 *
 * 该函数完全是纯函数：不读、不写、不调模型。
 */
export function buildSecretSpaceLoreRuntimeOptions(
  category: XingyeSecretSpaceLoreCategory,
  seedText?: string | null,
): XingyeLoreRuntimeContextOptions {
  const queryText = buildXingyeLoreRuntimeQueryText([seedText ?? '']);
  return {
    purpose: CATEGORY_TO_PURPOSE[category],
    queryText,
    maxChars: 2_000,
    includeAlways: true,
    includeKeyword: true,
  };
}
