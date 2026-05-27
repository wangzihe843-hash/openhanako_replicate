/**
 * 「待确认短信草稿」入库前的硬去重。
 *
 * 与 files-dedupe 的关系：
 *   - files / files-secret 按 folderId / kind 分桶，title 相似度判重；
 *   - SMS 没有 title——草稿只有 `content`，所以这里用 bigramJaccard 比 content 全文，
 *     同时强约束「同一天 / 同一对方」才有意义（一天给同一个对方发同样的一句话才算重）；
 *   - 跨对方不分享判重：一句「在吗？」对林雾发一次、对师父发一次显然是两件事。
 *
 * 注：prompt 端 anchor（同对方近期 SMS 上下文）在 `xingye-phone-ai.ts` 的
 * `buildSmsContinuityAnchorBlock(agentId, target)` 做——因为它要直接读 thread/draft 的
 * 真相源；这里不重复实现。本模块只负责入库前的硬去重（detectSmsDraftDuplicate），
 * 已被 `xingye-sms-drafts.ts` 的 `appendSmsDraft` 用上。
 *
 * 纯函数模块，不接 React / fs；调用方先把 drafts 数组传进来。
 */

import { bigramJaccard, normalizeTitleForDedup } from './xingye-files-dedupe';
import type { XingyePendingSmsDraft, SmsDraftTargetType } from './xingye-sms-drafts';

/** Bigram Jaccard 阈值：SMS content 通常比 title 长，阈值降一档允许更细的判重。 */
export const SMS_DUPLICATE_JACCARD_THRESHOLD = 0.7;

/** "同日"窗口（毫秒）；只在 24h 内的草稿对子做相似度判重，避免误杀 6 个月前的旧梗。 */
export const SMS_DUPLICATE_SAME_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SmsDraftDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'exact_dup'; draft: XingyePendingSmsDraft }
  | { kind: 'similar'; draft: XingyePendingSmsDraft; score: number };

/**
 * 归一化 SMS content 用于比较：
 *   - 复用 files-dedupe 的 normalizeTitleForDedup（trim / 全角→半角 / 包裹符号 / 小写）；
 *   - 不做额外处理——SMS 短，简单为上。
 */
function normalizeSmsContent(content: string): string {
  return normalizeTitleForDedup(content);
}

/**
 * 主决策：candidate 是否与同对方的近 24h 内已有草稿形成「重复 / 高度相似」。
 *
 * **必须传 targetType + targetId/matchName**——分桶维度。
 *
 * 命中规则：
 *   1. normalizeSmsContent 后字符串完全相等 → exact_dup
 *   2. bigramJaccard ≥ SMS_DUPLICATE_JACCARD_THRESHOLD → similar
 *   3. 否则 → unique
 *
 * 只看 24h 内：6 个月前的同句「在吗」不算重。
 */
export function detectSmsDraftDuplicate(
  candidate: {
    targetType: SmsDraftTargetType;
    targetId?: string;
    matchName?: string;
    content: string;
  },
  existingDrafts: XingyePendingSmsDraft[],
  now: Date = new Date(),
): SmsDraftDuplicateResult {
  const candContent = normalizeSmsContent(candidate.content);
  if (!candContent) return { kind: 'unique' };

  const candTargetId = (candidate.targetId ?? '').trim();
  const candMatchName = (candidate.matchName ?? '').trim();
  /** 没有任何收件人定位字段 → 别去重，让上层校验失败。 */
  if (!candTargetId && !candMatchName) return { kind: 'unique' };

  const nowMs = now.getTime();
  let bestSimilar: { draft: XingyePendingSmsDraft; score: number } | null = null;

  for (const draft of existingDrafts) {
    if (draft.targetType !== candidate.targetType) continue;
    /** 同对方：targetId 完全匹配 或 matchName 完全匹配。 */
    const sameTargetId = candTargetId && draft.targetId && draft.targetId.trim() === candTargetId;
    const sameMatchName = candMatchName && draft.matchName && draft.matchName.trim() === candMatchName;
    if (!sameTargetId && !sameMatchName) continue;

    /** 24h 窗口（解析失败的旧草稿放过，最稳）。 */
    const ts = Date.parse(draft.createdAt);
    if (Number.isFinite(ts) && nowMs - ts > SMS_DUPLICATE_SAME_DAY_WINDOW_MS) continue;

    const draftContent = normalizeSmsContent(draft.content);
    if (!draftContent) continue;
    if (draftContent === candContent) {
      return { kind: 'exact_dup', draft };
    }
    const score = bigramJaccard(draft.content, candidate.content);
    if (score >= SMS_DUPLICATE_JACCARD_THRESHOLD) {
      if (!bestSimilar || score > bestSimilar.score) {
        bestSimilar = { draft, score };
      }
    }
  }
  if (bestSimilar) return { kind: 'similar', ...bestSimilar };
  return { kind: 'unique' };
}
