/**
 * 日记（journal）生成去重 / 跨期连续性锚点。
 *
 * 与 files / news 的区别：
 *  - 没有自然 slot（不像 accounting 有"月度类目槽位"）；
 *  - 一篇日记没有"folder" 维度——所有日记都在同一个 agentId 的池子里。
 *
 * 双层防御：
 *   1. **anchor block（前置 prompt）**：把最近 8 篇日记的「标题 + 开头 30 字 + 日期」
 *      列出来塞 prompt，要求模型避免重复主题/切口；如果发现近几天连续都有日记，
 *      额外提示「最近几天的主题：…，今天请换一个切口」。
 *   2. **后置过滤（normalize 之后）**：用 files-dedupe 同款的 bigramJaccard /
 *      Levenshtein，比对「标题」与「开头 30 字」**两层**任一命中即视为重复。
 *      命中 exact_dup 由调用方决定丢弃 / 重试 / 提示用户。
 *
 * 纯函数模块，无 React / fs 依赖，只接数据；IO（拉 listJournalEntries）放在
 * xingye-journal-ai.ts 里调，便于测试。
 */

import {
  FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD,
  FILES_DUPLICATE_JACCARD_THRESHOLD,
  FILES_DUPLICATE_MIN_LEN_FOR_EDIT,
  bigramJaccard,
  levenshtein,
  normalizeTitleForDedup,
} from './xingye-files-dedupe';
import type { XingyeJournalEntry } from './xingye-journal-store';

/** anchor block 抽样的日记数量上限。 */
export const JOURNAL_ANCHOR_SAMPLE_LIMIT = 8;
/** 后置去重时 body 比较截取的字符数（按 code points）。 */
export const JOURNAL_OPENING_SAMPLE_LENGTH = 30;
/** anchor block 里"最近几天连续有日记"的窗口（天）。 */
export const JOURNAL_RECENT_RUN_DAYS = 3;
/**
 * 开头层「前缀包含」判定的较短串最小字符数。
 *
 * 一篇日记的 body 总长不到 30 字（opening 上限）时，extractOpening 会拿到 body 全文。
 * 此时若候选的 opening 包含 existing 的全文 opening 作为前缀（或反之），其实是
 * "把上一篇日记的开头照抄一遍、后面再续两句" 的复读场景——应当判为 exact_dup。
 *
 * 阈值 12 字：太短的前缀（如 "今天天气"）虽然字面相同，但日记里很可能本来就是套话开头，
 * 不算复读；12 字大致是 "今天又下了一整天的雨" 这种"句子已经成形" 的最低长度，
 * 命中这种重叠才有意义。
 */
export const JOURNAL_OPENING_PREFIX_MIN_LEN = 12;

/**
 * 取字符串前 N 个 code point（支持 emoji / CJK 扩展字符），不破坏代理对。
 */
function sliceCodePoints(text: string, n: number): string {
  if (!text) return '';
  const chars = [...text];
  return chars.slice(0, n).join('');
}

/**
 * 把一段 body 抽成可比较的 opening：trim → 取首行 → 截前 30 字。
 * 首行用 `/\n+/` 切，避免 markdown 段落破坏。
 */
function extractOpening(body: string, n: number = JOURNAL_OPENING_SAMPLE_LENGTH): string {
  if (!body) return '';
  const firstLine = body.split(/\n+/)[0] ?? '';
  return sliceCodePoints(firstLine.trim(), n);
}

/**
 * 构造 prompt 用的「最近 N 篇日记锚点 block」。
 *
 * 规则：
 *  - 取最新 8 篇（store 已按 dayKey desc + createdAt desc 排序）；
 *  - 每条一行：`· [YYYY-MM-DD] 标题 — 开头30字`；
 *  - 如果最近 3 天里有 ≥ 2 篇日记 → 额外加一行「最近几天主题：…，今天请换一个切口」。
 *
 * 没数据 / 不足 1 条 → 返回空字符串，prompt 端会渲染「（无）」。
 */
export function buildJournalContinuityAnchorBlock(
  entries: readonly XingyeJournalEntry[],
): string {
  if (!entries.length) return '';
  const samples = entries.slice(0, JOURNAL_ANCHOR_SAMPLE_LIMIT);
  const lines: string[] = ['- 最近写过的日记（请换主题/换笔调/换角度，不要重复同一件事）：'];
  for (const e of samples) {
    const opening = extractOpening(e.body);
    const titleTrimmed = e.title.trim() || '无标题';
    const openingPart = opening ? ` — ${opening}` : '';
    lines.push(`  · [${e.dayKey}] ${titleTrimmed}${openingPart}`);
  }

  // 最近几天连续有日记 → 列出最近 N 天的主题，提示换切口。
  // 以 entries[0] 的 dayKey 为锚点；如果连续 ≥ 2 天有日记，列出这些主题。
  const recentTitles: string[] = [];
  const seenDays = new Set<string>();
  for (const e of entries) {
    if (seenDays.has(e.dayKey)) continue;
    seenDays.add(e.dayKey);
    recentTitles.push(`${e.dayKey} ${e.title.trim() || '无标题'}`);
    if (seenDays.size >= JOURNAL_RECENT_RUN_DAYS) break;
  }
  if (recentTitles.length >= 2) {
    lines.push(`- 最近几天的主题：${recentTitles.join('；')}。今天请换一个切口。`);
  }
  return lines.join('\n');
}

export type JournalDuplicateCandidate = {
  title: string;
  body: string;
};

export type JournalDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'exact_dup'; entry: XingyeJournalEntry; via: 'title' | 'opening' }
  | { kind: 'similar'; entry: XingyeJournalEntry; score: number; via: 'title' | 'opening'; method: 'jaccard' | 'edit' };

/**
 * 后置去重决策。
 *
 * 比较两层（按短路顺序）：
 *   1. **标题层**：normalizeTitleForDedup(title) === existing → exact_dup(via=title)
 *      标题层 Levenshtein ≤ 2 且较短串 ≥ 3 → similar(via=title, method=edit)
 *      标题层 bigramJaccard ≥ 0.75 → similar(via=title, method=jaccard)
 *   2. **开头层**：normalize 后两边的 opening (前 30 字) 完全相同 → exact_dup(via=opening)
 *      开头层 Levenshtein ≤ 2 且较短串 ≥ 3 → similar(via=opening, method=edit)
 *      开头层 bigramJaccard ≥ 0.75 → similar(via=opening, method=jaccard)
 *
 * 任何一层命中即返回（短路；标题层优先）。
 * 比较只看「最近 30 篇」——日记是流水时间序，远古的不再做防重复，
 * 否则用户半年前写过类似主题，今天又想写同样心情就被拦了，反而违背日记本意。
 *
 * candidate.title / body 都为空 → unique（没法比，放过）。
 */
export function detectJournalDuplicate(
  candidate: JournalDuplicateCandidate,
  existingEntries: readonly XingyeJournalEntry[],
  options: { maxRecent?: number } = {},
): JournalDuplicateResult {
  const candTitle = normalizeTitleForDedup(candidate.title);
  const candOpening = normalizeTitleForDedup(extractOpening(candidate.body));
  if (!candTitle && !candOpening) return { kind: 'unique' };
  const maxRecent = Math.max(1, options.maxRecent ?? 30);
  const pool = existingEntries.slice(0, maxRecent);

  let bestTitleSimilar: { entry: XingyeJournalEntry; score: number; method: 'jaccard' | 'edit' } | null = null;
  let bestOpeningSimilar: { entry: XingyeJournalEntry; score: number; method: 'jaccard' | 'edit' } | null = null;

  for (const entry of pool) {
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
      const entryOpening = normalizeTitleForDedup(extractOpening(entry.body));
      if (entryOpening && entryOpening === candOpening) {
        return { kind: 'exact_dup', entry, via: 'opening' };
      }
      if (entryOpening) {
        /**
         * 前缀包含：existing 的 body 整段 < 30 字时，extractOpening 拿到的就是 body 全文；
         * 这时如果 candidate 把它整段抄了下来再续两句，比较时一头是短串、另一头是长串，
         * 字面不会"完全相等"，但语义上是 100% 复读，仍按 exact_dup 处理。
         *
         * 阈值 JOURNAL_OPENING_PREFIX_MIN_LEN 防止 "今天天气"/"今天天气真好" 这种
         * 套话开头被误命中（4 字前缀 < 12，跳过）。
         */
        const shorter = entryOpening.length <= candOpening.length ? entryOpening : candOpening;
        const longer = entryOpening.length <= candOpening.length ? candOpening : entryOpening;
        if (
          shorter.length >= JOURNAL_OPENING_PREFIX_MIN_LEN
          && shorter !== longer
          && longer.startsWith(shorter)
        ) {
          return { kind: 'exact_dup', entry, via: 'opening' };
        }
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
          extractOpening(entry.body),
          extractOpening(candidate.body),
        );
        if (jScore >= FILES_DUPLICATE_JACCARD_THRESHOLD) {
          if (!bestOpeningSimilar || jScore > bestOpeningSimilar.score) {
            bestOpeningSimilar = { entry, score: jScore, method: 'jaccard' };
          }
        }
      }
    }
  }

  /**
   * 开头层 similar 优先于标题层（仅限"非 exact_dup"路径）。
   *
   * 反直觉但更稳：日记标题常带"夜路"/"想他"/"夜班札记"等情绪短语，编辑距离 ≤ 2 的
   * 标题（如 "夜班札记 1" / "夜班札记 2"）其实是"刻意标号区分的两篇"——按字面相似
   * 拦下来反而违背用户意图。开头 30 字才是真正的"是不是又写了同一件事"信号。
   *
   * exact_dup 路径仍然标题优先：当标题完全相等时（line 141 提前 return）已经
   * 锁定为 via=title，不会走到这里。
   */
  if (bestOpeningSimilar) {
    return { kind: 'similar', via: 'opening', ...bestOpeningSimilar };
  }
  if (bestTitleSimilar) {
    return { kind: 'similar', via: 'title', ...bestTitleSimilar };
  }
  return { kind: 'unique' };
}
