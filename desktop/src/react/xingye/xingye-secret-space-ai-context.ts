/**
 * xingye-secret-space-ai-context.ts — Reservation-only helper for future SecretSpace AI generation.
 *
 * 本文件只是为未来的「秘密空间 AI 生成」预留稳定的 purpose + options 映射。
 *
 * 严格约束：
 * - 不调用任何模型。
 * - 不修改 SecretSpace records / UI / 短信 / 通讯录。
 * - 不写持久层。
 * - 不读取任何记忆候选 / openhanako 记忆。
 *
 * 它仅把 SecretSpace 的 category 映射成 `XingyeLoreRuntimeContextPurpose`，
 * 并返回可以喂给 `collectXingyeLoreRuntimeContext` 的 options。
 */

import {
  buildXingyeLoreRuntimeQueryText,
  type XingyeLoreRuntimeContextOptions,
  type XingyeLoreRuntimeContextPurpose,
} from './xingye-lore-runtime-context';

export type XingyeSecretSpaceLoreCategory =
  | 'dream'
  | 'draft_reply'
  | 'unsent_moment'
  | 'saved_item'
  | 'memory_fragment';

/**
 * SecretSpace AI 生成允许使用的 purpose 子集。
 * 与 `XingyeLoreRuntimeContextPurpose` 中的 `secret_space_*` 一一对应，是其严格子类型。
 */
export type XingyeSecretSpaceLorePurpose = Extract<
  XingyeLoreRuntimeContextPurpose,
  | 'secret_space_dream'
  | 'secret_space_draft_reply'
  | 'secret_space_unsent_moment'
  | 'secret_space_saved_item'
  | 'secret_space_memory_fragment'
>;

const CATEGORY_TO_PURPOSE: Record<XingyeSecretSpaceLoreCategory, XingyeSecretSpaceLorePurpose> = {
  dream: 'secret_space_dream',
  draft_reply: 'secret_space_draft_reply',
  unsent_moment: 'secret_space_unsent_moment',
  saved_item: 'secret_space_saved_item',
  memory_fragment: 'secret_space_memory_fragment',
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
