/**
 * 阅读批注（reading_notes，annotationSource='ai'）生成去重 / 跨期连续性锚点。
 *
 * 数据模型说明（见 PhoneReadingNotesApp ReadingNoteMetadata / xingye-reading-notes-drafts）：
 *  - 批注 entry 走 `apps/reading_notes/entries.jsonl`（appId='reading_notes'）；
 *  - metadata.bookId 标识"这条批注属于哪本书"——批注的判重必须**按 bookId 分桶**
 *    （跨书不算重复：同一句话在两本不同书里被引用、各自批注一次是合理的）；
 *  - metadata.passageHash 用于"同一本书里同一段原文只能被批注一次"——这是
 *    UI 现有的硬过滤；本模块不重复实现 hash 命中，专门处理"原文不同但批注内容
 *    高度相似"的情况（AI 反复在同一本书里写"这一段让我想起 XX"这种通用感想）。
 *
 * 双层防御：
 *   1. **anchor block（前置 prompt）**：把同一本书已有的批注列出来（≤ 12 条，
 *      「标题 + 批注开头第一句」），让模型看到自己在这本书里已经写过什么。
 *   2. **后置过滤**：用 files-dedupe 的 bigramJaccard / Levenshtein，比对
 *      **同 bookId** 池子里的「批注标题」与「批注开头」两层任一命中即视为重复。
 *
 *      注：任务最初提到「同 page 范围 ±2」，但 ReadingNoteMetadata 里没有 page
 *      字段（只有 passage / passageHash），所以"邻近性"实际靠 bookId 分桶
 *      （同一本书） + passageHash（同段原文，UI 已硬过滤）已经足够；本模块
 *      在剩下的"同书不同段"维度上做相似度判重。
 *
 * 纯函数模块，无 React / fs / store 依赖；IO 放在调用方。
 */

import {
  FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD,
  FILES_DUPLICATE_JACCARD_THRESHOLD,
  FILES_DUPLICATE_MIN_LEN_FOR_EDIT,
  bigramJaccard,
  levenshtein,
  normalizeTitleForDedup,
} from './xingye-files-dedupe';

/**
 * 模块对入参的最小契约：只要带 bookId 和 title / annotation 文本即可。
 * 实际 store 里的 ReadingNoteEntry 满足这一形态（metadata.bookId + entry.title
 * + entry.content）。这里不直接 import 完整类型，让模块更可移植 / 好测。
 */
export type AnnotationLike = {
  /** 用于分桶；不带 bookId 的笔记（未归类）不会参与判重。 */
  bookId: string;
  /** entry.title。 */
  title: string;
  /** 批注本体（对应 entry.content）。 */
  annotation: string;
};

/** anchor block 抽样的同书批注数量上限。 */
export const ANNOTATION_ANCHOR_SAMPLE_LIMIT = 12;
/** anchor block 里批注开头截取的字符数。 */
export const ANNOTATION_OPENING_SAMPLE_LENGTH = 30;

function sliceCodePoints(text: string, n: number): string {
  if (!text) return '';
  const chars = [...text];
  return chars.slice(0, n).join('');
}

/**
 * 把一段批注 body 抽成可比较的 opening：取首行（按 \n 切）+ 截前 N 字。
 * 首句优先用句号/问号/感叹号切，若首句 < 8 字则退回到首 N 字。
 */
function extractOpening(annotation: string, n: number = ANNOTATION_OPENING_SAMPLE_LENGTH): string {
  if (!annotation) return '';
  const firstLine = annotation.split(/\n+/)[0]?.trim() ?? '';
  if (!firstLine) return '';
  const sentenceMatch = firstLine.match(/^[^。！？!?]+[。！？!?]?/);
  const candidate = sentenceMatch?.[0]?.trim() ?? firstLine;
  // 太短的首句意义不大，回退到首 N 字
  if ([...candidate].length < 8) return sliceCodePoints(firstLine, n);
  return sliceCodePoints(candidate, n);
}

/**
 * 构造 prompt 用的「这本书已有批注 anchor block」。
 *
 * 规则：
 *  - 按 bookId 过滤，只列出同书已写过的批注；
 *  - 取最新 12 条（调用方应按 createdAt desc 传入）；
 *  - 每条一行：`· 标题 — 开头第一句`；
 *
 * 没数据 / bookId 为空 → 返回空字符串，prompt 端会渲染「（无；这本书你还没批注过）」。
 */
export function buildAnnotationContinuityAnchorBlock(
  annotations: readonly AnnotationLike[],
  bookId: string,
): string {
  const bid = bookId.trim();
  if (!bid) return '';
  if (!annotations.length) return '';
  const sameBook = annotations.filter((a) => a.bookId === bid);
  if (!sameBook.length) return '';
  const samples = sameBook.slice(0, ANNOTATION_ANCHOR_SAMPLE_LIMIT);
  const lines: string[] = [
    '- 你在这本书上已经写过的批注（请换不同切口/不同感受，不要重复同样的话）：',
  ];
  for (const a of samples) {
    const titleTrimmed = a.title.trim() || '无标题';
    const opening = extractOpening(a.annotation);
    const openingPart = opening ? ` — ${opening}` : '';
    lines.push(`  · ${titleTrimmed}${openingPart}`);
  }
  return lines.join('\n');
}

export type AnnotationDuplicateCandidate = {
  bookId: string;
  title: string;
  annotation: string;
};

export type AnnotationDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'exact_dup'; entry: AnnotationLike; via: 'title' | 'opening' }
  | { kind: 'similar'; entry: AnnotationLike; score: number; via: 'title' | 'opening'; method: 'jaccard' | 'edit' };

/**
 * 后置去重决策。
 *
 * **只在同 bookId 池内比较**——跨书写同样的批注是合理的，不算重复（不同上下文）。
 *
 * 比较两层（按短路顺序）：
 *   1. **标题层**：normalize 后完全相同 → exact_dup(via=title)
 *      Levenshtein ≤ 2 且较短串 ≥ 3 → similar(via=title, method=edit)
 *      bigramJaccard ≥ 0.75 → similar(via=title, method=jaccard)
 *   2. **开头层**：normalize 后开头第一句完全相同 → exact_dup(via=opening)
 *      Levenshtein ≤ 2 且较短串 ≥ 3 → similar(via=opening, method=edit)
 *      bigramJaccard ≥ 0.75 → similar(via=opening, method=jaccard)
 *
 * 标题层优先（更强的"重复主题"信号）。
 *
 * candidate.bookId 为空 / title 和 annotation 都为空 → unique（没法比，放过）。
 */
export function detectAnnotationDuplicate(
  candidate: AnnotationDuplicateCandidate,
  existingAnnotations: readonly AnnotationLike[],
): AnnotationDuplicateResult {
  const bid = candidate.bookId.trim();
  if (!bid) return { kind: 'unique' };
  const candTitle = normalizeTitleForDedup(candidate.title);
  const candOpening = normalizeTitleForDedup(extractOpening(candidate.annotation));
  if (!candTitle && !candOpening) return { kind: 'unique' };

  let bestTitleSimilar: { entry: AnnotationLike; score: number; method: 'jaccard' | 'edit' } | null = null;
  let bestOpeningSimilar: { entry: AnnotationLike; score: number; method: 'jaccard' | 'edit' } | null = null;

  for (const entry of existingAnnotations) {
    if (entry.bookId !== bid) continue;

    // —— 标题层 ——
    if (candTitle) {
      const entryTitle = normalizeTitleForDedup(entry.title);
      if (entryTitle && entryTitle === candTitle) {
        return { kind: 'exact_dup', entry, via: 'title' };
      }
      if (entryTitle) {
        const minLen = Math.min(entryTitle.length, candTitle.length);
        if (minLen >= FILES_DUPLICATE_MIN_LEN_FOR_EDIT) {
          const dist = levenshtein(entryTitle, candTitle);
          if (dist <= FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD) {
            const score = 1 - dist / Math.max(entryTitle.length, candTitle.length);
            if (!bestTitleSimilar || score > bestTitleSimilar.score) {
              bestTitleSimilar = { entry, score, method: 'edit' };
            }
          }
        }
        const jScore = bigramJaccard(entry.title, candidate.title);
        if (jScore >= FILES_DUPLICATE_JACCARD_THRESHOLD) {
          if (!bestTitleSimilar || jScore > bestTitleSimilar.score) {
            bestTitleSimilar = { entry, score: jScore, method: 'jaccard' };
          }
        }
      }
    }

    // —— 开头层 ——
    if (candOpening) {
      const entryOpening = normalizeTitleForDedup(extractOpening(entry.annotation));
      if (entryOpening && entryOpening === candOpening) {
        return { kind: 'exact_dup', entry, via: 'opening' };
      }
      if (entryOpening) {
        const minLen = Math.min(entryOpening.length, candOpening.length);
        if (minLen >= FILES_DUPLICATE_MIN_LEN_FOR_EDIT) {
          const dist = levenshtein(entryOpening, candOpening);
          if (dist <= FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD) {
            const score = 1 - dist / Math.max(entryOpening.length, candOpening.length);
            if (!bestOpeningSimilar || score > bestOpeningSimilar.score) {
              bestOpeningSimilar = { entry, score, method: 'edit' };
            }
          }
        }
        const jScore = bigramJaccard(
          extractOpening(entry.annotation),
          extractOpening(candidate.annotation),
        );
        if (jScore >= FILES_DUPLICATE_JACCARD_THRESHOLD) {
          if (!bestOpeningSimilar || jScore > bestOpeningSimilar.score) {
            bestOpeningSimilar = { entry, score: jScore, method: 'jaccard' };
          }
        }
      }
    }
  }

  if (bestTitleSimilar) {
    return { kind: 'similar', via: 'title', ...bestTitleSimilar };
  }
  if (bestOpeningSimilar) {
    return { kind: 'similar', via: 'opening', ...bestOpeningSimilar };
  }
  return { kind: 'unique' };
}
