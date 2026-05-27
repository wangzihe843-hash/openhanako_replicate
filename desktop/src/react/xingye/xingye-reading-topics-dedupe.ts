/**
 * 阅读话题（reading_topics）生成去重 / 跨期连续性锚点。
 *
 * 与 divination / annotation 的区别：
 *  - reading-topics 产物是「Open Library subject 标签」+ 中文 label，不是 entry；
 *    没有自己的 entries.jsonl。"历史"靠两个数据源回溯：
 *      a) 用户书架（book-catalog）里已经收录过的书——书名 / 作者，AI 不要总推同样的书；
 *      b) 上一次推荐的 subjects（如果调用方愿意持久化最近一次结果）。
 *  - "重复"在 topics 这里有时间窗：30 天内反复推同一本书是噪音，但半年后再推同
 *    一类话题用户已经忘了，是合理的——所以时间窗 30 天。
 *
 * 双层防御：
 *   1. **anchor block（前置 prompt）**：把书架里已有的「书名 / 作者」列出来（≤ 8 条），
 *      让模型知道 TA 已经收过哪些类别 / 哪些书，不要再推同样的标签或同一本书。
 *   2. **后置过滤**：按"书名相似度"判重——candidate 是一个 topic（subject+label+reason），
 *      existing 是用户已有的书（{ title, authors }）。candidate.label 与已有书名相似度
 *      ≥ 0.75 视为重复（含 30 天窗口）。
 *
 * 纯函数模块，无 React / fs / store 依赖。
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
 * 历史"已有书"的最小契约——只要 title / authors / createdAt 即可。
 * 对应 XingyeBookCatalogEntry（见 xingye-reading-book-catalog.ts）。
 */
export type ReadingBookLike = {
  title: string;
  authors?: readonly string[];
  /** 入库时间；用于时间窗判定。 */
  createdAt?: string;
};

/** anchor block 抽样的书架数量上限。 */
export const TOPICS_ANCHOR_SAMPLE_LIMIT = 8;
/**
 * 判重的时间窗（天）。30 天内反复推同一本书 / 同一类别 → 视为重复；
 * 超过窗口同样的话题再推一次是合理的（用户可能忘了）。
 */
export const TOPICS_DUPLICATE_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 构造 prompt 用的「书架已有书 anchor block」。
 *
 * 规则：
 *  - 取最新 8 本（调用方应按 createdAt desc 传入）；
 *  - 每条一行：`· 《书名》 — 作者1 / 作者2`；
 *
 * 没数据 → 返回空字符串，prompt 端会渲染「（无；这是 TA 的第一次发现新书）」。
 */
export function buildTopicsContinuityAnchorBlock(
  books: readonly ReadingBookLike[],
): string {
  if (!books.length) return '';
  const samples = books.slice(0, TOPICS_ANCHOR_SAMPLE_LIMIT);
  const lines: string[] = [
    '- TA 书架上已经收过的书（请推荐不同类型/不同书名，不要再让 TA 看到同一本或同一作者反复出现）：',
  ];
  for (const b of samples) {
    const title = b.title.trim() || '无名书';
    const authors = (b.authors ?? [])
      .map((a) => (typeof a === 'string' ? a.trim() : ''))
      .filter(Boolean)
      .slice(0, 3)
      .join(' / ');
    const authorPart = authors ? ` — ${authors}` : '';
    lines.push(`  · 《${title}》${authorPart}`);
  }
  return lines.join('\n');
}

export type TopicDuplicateCandidate = {
  /**
   * topic 候选展示字段。reading-topics 返回的 label 是中文短语（≤ 12 字），
   * 这里也可以传具体某本书的"书名"做更精确的判重——所以字段名叫 displayText 而非 label。
   */
  displayText: string;
};

export type TopicDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'exact_dup'; book: ReadingBookLike }
  | { kind: 'similar'; book: ReadingBookLike; score: number; method: 'jaccard' | 'edit' };

export type TopicDuplicateOptions = {
  windowDays?: number;
  now?: () => number;
};

/**
 * 后置去重决策：判断 candidate.displayText（书名 / 中文 label）是否与书架里
 * 近 30 天入库的某本书的书名高度相似。
 *
 * 短路顺序：
 *   1. normalizeTitleForDedup(displayText) 与 normalize(book.title) 完全相等 → exact_dup
 *   2. Levenshtein ≤ 2 且较短串 ≥ 3 → similar(method=edit)
 *   3. bigramJaccard ≥ 0.75 → similar(method=jaccard)
 *   4. 否则 unique
 *
 * 时间窗：只对 book.createdAt >= now - windowDays * MS_PER_DAY 的书做比较。
 * book 没有 createdAt 字段（数据缺失）→ 视为"在窗口内"参与比较，保守拦截。
 *
 * candidate.displayText 归一化后为空 → unique。
 */
export function detectTopicDuplicate(
  candidate: TopicDuplicateCandidate,
  existingBooks: readonly ReadingBookLike[],
  options: TopicDuplicateOptions = {},
): TopicDuplicateResult {
  const candText = normalizeTitleForDedup(candidate.displayText);
  if (!candText) return { kind: 'unique' };
  const windowDays = Math.max(1, options.windowDays ?? TOPICS_DUPLICATE_WINDOW_DAYS);
  const now = (options.now ?? Date.now)();
  const cutoff = now - windowDays * MS_PER_DAY;

  let bestSimilar: { book: ReadingBookLike; score: number; method: 'jaccard' | 'edit' } | null = null;

  for (const book of existingBooks) {
    // 时间窗：有 createdAt 就严格比；没有 createdAt 视为在窗口内（保守拦截）
    if (book.createdAt) {
      const createdAtMs = Date.parse(book.createdAt);
      if (!Number.isNaN(createdAtMs) && createdAtMs < cutoff) continue;
    }
    const bookTitle = normalizeTitleForDedup(book.title);
    if (!bookTitle) continue;
    if (bookTitle === candText) {
      return { kind: 'exact_dup', book };
    }
    const minLen = Math.min(bookTitle.length, candText.length);
    if (minLen >= FILES_DUPLICATE_MIN_LEN_FOR_EDIT) {
      const dist = levenshtein(bookTitle, candText);
      if (dist <= FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD) {
        const score = 1 - dist / Math.max(bookTitle.length, candText.length);
        if (!bestSimilar || score > bestSimilar.score) {
          bestSimilar = { book, score, method: 'edit' };
        }
        continue;
      }
    }
    const jScore = bigramJaccard(book.title, candidate.displayText);
    if (jScore >= FILES_DUPLICATE_JACCARD_THRESHOLD) {
      if (!bestSimilar || jScore > bestSimilar.score) {
        bestSimilar = { book, score: jScore, method: 'jaccard' };
      }
    }
  }
  if (bestSimilar) return { kind: 'similar', ...bestSimilar };
  return { kind: 'unique' };
}
