/**
 * 日程模块「入库前的硬去重 + AI 反重复锚点」纯函数模块。
 *
 * 日程实体结构（XingyeScheduleEntry / XingyePendingScheduleDraft）：
 *   - dateLabel：自然语言日期串，"周三 14:00"、"明天上午"、"2026-05-30" 都合法
 *   - title：事件名，"开周会"、"和阿言喝咖啡"
 *   - timeText / content / note / category：辅助字段
 *
 * 真实重复场景：
 *   - 同一周心跳巡检多次触发，LLM 各自生成了「周三 14:00 开周会」两次
 *   - 用户手动建了一条「明天去医院」，AI 又自动提议同一条
 *
 * 三件事：
 *   1. detectScheduleDuplicate(candidate, existing) → 同 dateLabel + 标题
 *      高度相似 → 返回 'exact_dup' / 'similar' / 'unique'，复用 files-dedupe
 *      的 normalize + bigram + Levenshtein 工具；
 *   2. filterSameDayScheduleDuplicates(drafts, existing) → 数组级 filter，
 *      命中即丢；同时对本批内部去重；
 *   3. buildScheduleContinuityAnchorBlock(events) → 抽最近 14 天 / 未来 7
 *      天的 (dateLabel + title) 列表，喂回 prompt，让 LLM 避开撞期标题。
 *
 * 设计取舍：accounting 走"slot 时间窗"（早 / 午 / 晚 / 通勤），强领域语义；
 * schedule 没有这种自然 slot——同一天「14:00 开会」+「20:00 看演出」是合理
 * 的两条，按 title 相似度判更稳。文件柜 dedupe 也是这套路，所以 schedule
 * 直接复用 files-dedupe 的相似度工具，避免重复实现。
 *
 * 抽出来单独成模块：纯函数、无 React / fs 依赖，好单测。
 */

import {
  bigramJaccard,
  levenshtein,
  normalizeTitleForDedup,
} from './xingye-files-dedupe';

/**
 * 日期归一化：把 dateLabel 收敛成一个稳定 key 用于"同日"判断。
 *
 * 不解析自然语言——"周三 14:00"、"2026-05-30"、"明天"都是合法 dateLabel，
 * 用户/AI 写法各异。这里只做：
 *   1. trim
 *   2. 全角空格 → 半角
 *   3. 大小写归一
 *   4. 全角标点 → 半角标点（句号 / 逗号等不要影响匹配）
 *
 * 不剥时间部分——「2026-05-30 14:00」和「2026-05-30 20:00」是不同 slot，
 * 不应该相互去重；保留 timeText 在 key 里区分。
 *
 * 若两条 dateLabel 写法本质不同（"周三" vs "2026-05-27"，恰好都是周三），
 * normalize 不会让它们撞 key——这是有意的：自然语言的不确定性下，宁可漏判
 * 也不要把不同事件错判成同日重复。
 */
export function normalizeScheduleDateKey(dateLabel: string | undefined): string {
  if (typeof dateLabel !== 'string') return '';
  let s = dateLabel.trim();
  if (!s) return '';
  s = s.replace(/\u3000/g, ' ');
  s = s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\s+/g, ' ');
  s = s.toLowerCase();
  return s;
}

export type ScheduleDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'exact_dup'; existingTitle: string }
  | { kind: 'similar'; existingTitle: string; score: number; via: 'jaccard' | 'edit' };

/**
 * 与 files-dedupe 同套阈值（已在 files 场景验证可用）。
 *
 * Jaccard 0.75：换序 / 同义字替换 / 局部改写的 token-overlap 兜底。
 * Edit ≤ 2 + minLen 3：单字增删改的"几乎同名"主路径。
 * 长度差 ≤ 2：防止"开会" 误匹"开周会大会"。
 */
const SCHEDULE_DUPLICATE_JACCARD_THRESHOLD = 0.75;
const SCHEDULE_DUPLICATE_LEN_TOLERANCE = 2;
const SCHEDULE_DUPLICATE_EDIT_DISTANCE_THRESHOLD = 2;
const SCHEDULE_DUPLICATE_MIN_LEN_FOR_EDIT = 3;

/**
 * 主决策函数：candidate（dateLabel + title）是否与 existingEntries 里某条
 * 形成「同日同事件 / 同日高度相似事件」。
 *
 * 比较只在 **同 normalize 后的 dateLabel** 内做——"周三 14:00 开会"和
 * "周四 09:00 开会"都叫「开会」但不重复，跨日子不算。
 *
 * 命中规则（短路顺序，与 files-dedupe 同）：
 *   1. normalizeTitleForDedup 后字符串完全相等 → exact_dup
 *   2. Levenshtein ≤ 2 且较短串 ≥ 3 字 → similar（via=edit）
 *   3. bigramJaccard ≥ 0.75 且 |len(A) - len(B)| ≤ 2 → similar（via=jaccard）
 *   4. 否则 → unique
 *
 * candidate.title / dateLabel 任一归一化后为空 → unique（数据太薄不好判，放过）。
 */
export function detectScheduleDuplicate(
  candidate: { title: string; dateLabel: string },
  existing: Array<{ title: string; dateLabel: string }>,
): ScheduleDuplicateResult {
  const candTitle = normalizeTitleForDedup(candidate.title);
  const candDateKey = normalizeScheduleDateKey(candidate.dateLabel);
  if (!candTitle || !candDateKey) return { kind: 'unique' };

  let bestSimilar: { existingTitle: string; score: number; via: 'jaccard' | 'edit' } | null = null;
  for (const entry of existing) {
    if (normalizeScheduleDateKey(entry.dateLabel) !== candDateKey) continue;
    const entryTitle = normalizeTitleForDedup(entry.title);
    if (!entryTitle) continue;
    if (entryTitle === candTitle) {
      return { kind: 'exact_dup', existingTitle: entry.title };
    }
    const minLen = Math.min(entryTitle.length, candTitle.length);
    if (minLen >= SCHEDULE_DUPLICATE_MIN_LEN_FOR_EDIT) {
      const dist = levenshtein(entryTitle, candTitle);
      if (dist <= SCHEDULE_DUPLICATE_EDIT_DISTANCE_THRESHOLD) {
        const score = 1 - dist / Math.max(entryTitle.length, candTitle.length);
        if (!bestSimilar || score > bestSimilar.score) {
          bestSimilar = { existingTitle: entry.title, score, via: 'edit' };
        }
        continue;
      }
    }
    if (Math.abs(entryTitle.length - candTitle.length) > SCHEDULE_DUPLICATE_LEN_TOLERANCE) {
      continue;
    }
    const score = bigramJaccard(entry.title, candidate.title);
    if (score >= SCHEDULE_DUPLICATE_JACCARD_THRESHOLD) {
      if (!bestSimilar || score > bestSimilar.score) {
        bestSimilar = { existingTitle: entry.title, score, via: 'jaccard' };
      }
    }
  }
  if (bestSimilar) return { kind: 'similar', ...bestSimilar };
  return { kind: 'unique' };
}

/**
 * 「同日同事件」数组级 filter——drafts 数组里挨条过 detectScheduleDuplicate；
 * 命中（exact_dup / similar）即丢。已通过的草稿会被加入"已占用"集合，
 * 让本批内部也去重（AI 一次返回 2 条同日同题事件，第二条被丢）。
 */
export function filterSameDayScheduleDuplicates<T extends {
  title?: string;
  dateLabel?: string;
}>(
  drafts: T[],
  existing: Array<{ title: string; dateLabel: string }>,
): T[] {
  const occupied: Array<{ title: string; dateLabel: string }> = [...existing];
  const out: T[] = [];
  for (const d of drafts) {
    const title = (d.title ?? '').trim();
    const dateLabel = (d.dateLabel ?? '').trim();
    if (!title || !dateLabel) {
      out.push(d);
      continue;
    }
    const verdict = detectScheduleDuplicate({ title, dateLabel }, occupied);
    if (verdict.kind === 'exact_dup' || verdict.kind === 'similar') continue;
    occupied.push({ title, dateLabel });
    out.push(d);
  }
  return out;
}

/**
 * 「最近 14 天 + 未来 7 天事件」锚点块——拼进 prompt，告诉 LLM
 * 「近期日历里已经排过这些事，请不要再重复提同样的标题」。
 *
 * 入参 events 形态宽松：只要有 `dateLabel` + `title` 即可（兼容 entries /
 * drafts 两种形态）。
 *
 * 抽样策略：
 *  - 按 dateLabel 自然字典序排序（"2026-05-27" / "周三" 各自归类——
 *    具体哪个在前不重要，LLM 看到列表就够避雷）；
 *  - 最多展示 maxEntries 条（默认 20），按时间局部性截断；
 *  - 每条渲染 "[dateLabel] title (timeText)"。
 *
 * 没有历史/未来 → 返回空字符串，prompt 端渲染占位"（无）"。
 */
export function buildScheduleContinuityAnchorBlock(
  events: Array<{ dateLabel: string; title: string; timeText?: string }>,
  options: { maxEntries?: number } = {},
): string {
  const max = Math.max(1, options.maxEntries ?? 20);
  const cleaned = events
    .filter((e) => e.dateLabel && e.title)
    .map((e) => ({
      dateLabel: e.dateLabel.trim(),
      title: e.title.trim(),
      timeText: e.timeText?.trim() ?? '',
    }));
  if (!cleaned.length) return '';

  const sorted = [...cleaned].sort((a, b) => a.dateLabel.localeCompare(b.dateLabel));
  const sliced = sorted.slice(0, max);

  const lines = sliced.map((e) => {
    const timePart = e.timeText ? ` (${e.timeText})` : '';
    return `  · [${e.dateLabel}] ${e.title}${timePart}`;
  });
  return [
    `- 近期日历里已经安排过的事件（请不要再重复同标题）：`,
    ...lines,
  ].join('\n');
}
