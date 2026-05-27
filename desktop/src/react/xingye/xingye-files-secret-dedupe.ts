/**
 * 「秘密文件 / 抽屉最底层」入库前的硬去重 + 反重复 anchor block 构建。
 *
 * 与 files-dedupe 的关系：
 *   - files（资料柜）按 folderId 分桶——同 folder 内 title 相近视为重复；
 *   - 隐藏抽屉（secret files）没有 folder 维度，但有 `kind`（weakness / guilty_pleasure /
 *     secret_taste / secret_plan / manual）这条天然分类轴。两条都写 weakness 的「手会抖」
 *     是重复；一条 weakness 一条 secret_plan 的「手会抖」不是。
 *   - 所以按 **kind 维度分桶**，title 相似度阈值 / Levenshtein 阈值全部复用 files-dedupe。
 *
 * 双层防御（与 files / secret-space / interview / news 一致）：
 *   1. **prompt 端 anchor**：buildSecretFilesContinuityAnchorBlock 抽最近 8 条
 *      已存在条目的「kind · 标题」，让模型在源头偏好换 kind / 换主题；
 *   2. **入库前兜底**：detectSecretFilesDuplicate 在 appendHiddenEntry 前过一遍，
 *      命中 exact_dup / similar 直接拒绝（调用方可降级为 warn）。
 *
 * 用户备忘提醒：这些条目的内容主语是 agent（TA 写在抽屉底层的私密底牌），
 * 不是 user——anchor block 渲染时按「TA 的近期秘密条目」措辞。
 */

import {
  bigramJaccard,
  levenshtein,
  normalizeTitleForDedup,
  FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD,
  FILES_DUPLICATE_JACCARD_THRESHOLD,
  FILES_DUPLICATE_LEN_TOLERANCE,
  FILES_DUPLICATE_MIN_LEN_FOR_EDIT,
} from './xingye-files-dedupe';
import type {
  XingyeHiddenFileEntry,
  XingyeHiddenFileEntryKind,
} from './xingye-files-secret-store';

export type SecretFilesDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'exact_dup'; entry: XingyeHiddenFileEntry }
  | { kind: 'similar'; entry: XingyeHiddenFileEntry; score: number; via: 'jaccard' | 'edit' };

/** 抽样窗口：anchor block 最多看最近多少条。 */
const ANCHOR_SAMPLE_WINDOW = 8;

/** kind → 中文标签，用于 anchor block 与拒绝提示。 */
const KIND_LABELS: Record<XingyeHiddenFileEntryKind, string> = {
  weakness: '个人弱点',
  guilty_pleasure: '见不得光的喜好',
  secret_taste: '与人设有张力的偏好',
  secret_plan: '不可告人的打算',
  manual: '手写补充',
};

/**
 * 主决策：candidate 是否与 existingEntries 内某条形成「重复 / 高度相似」。
 *
 * 比较只在**同 kind**内做——一条 weakness 的「TA 怕黑」和一条 secret_plan 的
 * 「TA 想等天黑后离开」语义上正交，跨 kind 不算重复。
 *
 * 命中规则（同 files-dedupe 短路顺序）：
 *   1. normalizeTitleForDedup 后字符串完全相等 → exact_dup
 *   2. Levenshtein 编辑距离 ≤ 2 且较短串 ≥ 3 字 → similar（via=edit）
 *   3. bigramJaccard ≥ 0.75 且 |len(A) - len(B)| ≤ 2 → similar（via=jaccard）
 *   4. 否则 → unique
 */
export function detectSecretFilesDuplicate(
  candidate: { title: string; kind: XingyeHiddenFileEntryKind },
  existingEntries: XingyeHiddenFileEntry[],
): SecretFilesDuplicateResult {
  const candTitle = normalizeTitleForDedup(candidate.title);
  if (!candTitle) return { kind: 'unique' };
  const candKind = candidate.kind;

  let bestSimilar: { entry: XingyeHiddenFileEntry; score: number; via: 'jaccard' | 'edit' } | null = null;
  for (const entry of existingEntries) {
    if (entry.kind !== candKind) continue;
    const entryTitle = normalizeTitleForDedup(entry.title);
    if (!entryTitle) continue;
    if (entryTitle === candTitle) {
      return { kind: 'exact_dup', entry };
    }
    const minLen = Math.min(entryTitle.length, candTitle.length);
    if (minLen >= FILES_DUPLICATE_MIN_LEN_FOR_EDIT) {
      const dist = levenshtein(entryTitle, candTitle);
      if (dist <= FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD) {
        const score = 1 - dist / Math.max(entryTitle.length, candTitle.length);
        if (!bestSimilar || score > bestSimilar.score) {
          bestSimilar = { entry, score, via: 'edit' };
        }
        continue;
      }
    }
    if (Math.abs(entryTitle.length - candTitle.length) > FILES_DUPLICATE_LEN_TOLERANCE) {
      continue;
    }
    const score = bigramJaccard(entry.title, candidate.title);
    if (score >= FILES_DUPLICATE_JACCARD_THRESHOLD) {
      if (!bestSimilar || score > bestSimilar.score) {
        bestSimilar = { entry, score, via: 'jaccard' };
      }
    }
  }
  if (bestSimilar) return { kind: 'similar', ...bestSimilar };
  return { kind: 'unique' };
}

/**
 * 给 secret-files seed prompt 用的「反重复锚点 block」。
 *
 * 渲染最近 ANCHOR_SAMPLE_WINDOW 条已有条目的「kind 标签 · 标题」，
 * 让模型在源头偏好换 kind / 换主题。
 *
 * - 没有历史 → 返回空串，prompt 端会渲染「（无；这是 TA 第一次往抽屉里写东西）」；
 * - 输入数组期望按时间倒序（与 listHiddenEntries 默认排序一致）；
 * - 内部按 kind 分桶展示，每桶最多 3 条，避免 prompt 撑爆。
 */
export function buildSecretFilesContinuityAnchorBlock(
  entries: XingyeHiddenFileEntry[],
): string {
  if (!Array.isArray(entries) || entries.length === 0) return '';

  const buckets = new Map<XingyeHiddenFileEntryKind, string[]>();
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= ANCHOR_SAMPLE_WINDOW) break;
    scanned += 1;
    const title = (entry?.title ?? '').trim();
    if (!title) continue;
    const list = buckets.get(entry.kind) ?? [];
    if (list.length >= 3) continue;
    list.push(title.slice(0, 40));
    buckets.set(entry.kind, list);
  }
  if (buckets.size === 0) return '';

  const order: XingyeHiddenFileEntryKind[] = [
    'weakness',
    'guilty_pleasure',
    'secret_taste',
    'secret_plan',
    'manual',
  ];
  const lines: string[] = ['- 抽屉里已有的秘密条目（请换不同 kind / 不同主题，不要写几乎同名的）:'];
  for (const k of order) {
    const list = buckets.get(k);
    if (!list || list.length === 0) continue;
    const label = KIND_LABELS[k] ?? k;
    lines.push(`  · [${label}] ${list.map((t) => `《${t}》`).join('、')}`);
  }
  return lines.join('\n');
}

export { KIND_LABELS as SECRET_FILES_KIND_LABELS };
