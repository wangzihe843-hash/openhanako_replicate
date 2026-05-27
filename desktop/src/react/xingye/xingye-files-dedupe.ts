/**
 * 资料柜（files）入库前的硬去重兜底。
 *
 * 双层防御里的「硬过滤」一层：
 *   1. propose-draft / generateFilesDraftWithAI 的 prompt 已经把已有 entries
 *      喂给模型让它在源头偏好 update 形态（参见 xingye-files-prompts.ts 的
 *      existingEntriesBlock）；
 *   2. 但模型仍可能忽视提示、或一时没识别出已有同主题条目——本模块在
 *      `appendFileEntry` / `confirmFileDraft (action='add')` 入 entries 前
 *      再过一遍，命中相似条目就拦截（UI 决定是「改为 update」还是「force 新建」）。
 *
 * 抽出来单独成模块：纯函数、无 React / fs 依赖，只接 entry 数据；好单测、也方便
 * 服务端镜像（如果以后想在 `lib/xingye/files-drafts.js` 入 drafts 前也过一遍）。
 *
 * 对比 accounting-dedupe：accounting 按"月度类目槽位 / 餐次槽位 / 通勤槽位"判重
 * （领域知识强）；files 没有这种自然槽位，只能按"同 folder 内 title 相近"
 * 判重，所以这边走 normalize + bigram Jaccard。
 */

import type { XingyeFileEntry } from './xingye-files-store';

/**
 * 归一化 title 用于比较：
 *   1. trim
 *   2. 全角标点 → 半角
 *   3. 中英文常见包裹符号（《》「」""''）整体删掉——同一主题两次写可能有人加书名号有人不加
 *   4. 多个连续空白 → 单个空格
 *   5. 英文部分小写
 *
 * 中文字符本身不做大小写转换（无意义）。
 */
export function normalizeTitleForDedup(title: string): string {
  if (typeof title !== 'string') return '';
  let s = title.trim();
  if (!s) return '';
  s = s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[《》「」『』"'""'']/g, '');
  s = s.replace(/\s+/g, ' ');
  s = s.toLowerCase();
  return s;
}

/**
 * 把字符串切成相邻 2-字符 set。
 *
 * 用 bigram 而不是 trigram：中文短 title（典型 5–12 字）trigram 集合太小，
 * Jaccard 分数离散（要么 0 要么 1）；bigram 信号更稳。
 *
 * 长度 < 2 → 单元素集合（就是它自己），让单字 title 也能比较。
 */
export function toBigramSet(text: string): Set<string> {
  if (!text) return new Set();
  if (text.length < 2) return new Set([text]);
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) {
    out.add(text.slice(i, i + 2));
  }
  return out;
}

/**
 * Jaccard 相似度：|A ∩ B| / |A ∪ B|，0–1 区间。
 * 空集合相比为 0（不当作"完全相同"——那是 exact_dup 的活）。
 */
export function bigramJaccard(a: string, b: string): number {
  const A = toBigramSet(normalizeTitleForDedup(a));
  const B = toBigramSet(normalizeTitleForDedup(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter += 1;
  const union = A.size + B.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/**
 * Levenshtein 编辑距离。经典 DP，O(m*n)。
 *
 * 入参先 normalizeTitleForDedup 归一化（trim / 全半角 / 包裹符号 / 大小写）。
 * 对资料柜 title（短串）量级毫无压力。
 */
export function levenshtein(a: string, b: string): number {
  const A = normalizeTitleForDedup(a);
  const B = normalizeTitleForDedup(b);
  if (A === B) return 0;
  if (!A.length) return B.length;
  if (!B.length) return A.length;
  const m = A.length;
  const n = B.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

export type FilesDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'exact_dup'; entry: XingyeFileEntry }
  | { kind: 'similar'; entry: XingyeFileEntry; score: number; via: 'jaccard' | 'edit' };

/**
 * Bigram Jaccard 阈值。0.75 经验值。
 *
 * **bigram 不负责"插/删/改单字"——那是 Levenshtein 路径的活**。
 * 这条路径专门兜"换序 / 同义字替换 / 局部改写"等 token 级真实重叠率高的 case；
 * 0.75 严一点反而减少"看起来字重叠但主题不同"（如 "天气真好" vs "今天天气"，
 * Jaccard = 0.2 自然不会命中，但其它中等重叠的 0.5–0.7 区间也不该误判）。
 */
export const FILES_DUPLICATE_JACCARD_THRESHOLD = 0.75;
/**
 * Bigram 命中时的"长度差兜底"：超过 2 字放过。
 * 防止 "师父" 这种短前缀误命中 "师父说过的几句话"。
 */
export const FILES_DUPLICATE_LEN_TOLERANCE = 2;
/**
 * Levenshtein 编辑距离阈值：≤ 2 即视为高度相似。
 * 处理 bigram 漏判的"插/删/改单字"主线场景。
 */
export const FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD = 2;
/**
 * Levenshtein 路径要求**较短串至少 3 字**——防止 "师父" 和 "师父的话" 这种
 * "短前缀 + 1 个 token" 的对子被编辑距离误命中（编辑距离也只有 2，但主题明显不同）。
 */
export const FILES_DUPLICATE_MIN_LEN_FOR_EDIT = 3;

/**
 * 主决策函数：candidate 是否与 existingEntries 里某条形成「重复 / 高度相似」。
 *
 * 比较只在 **同 folder** 内做——「世界观整理」夹和「人际关系」夹里都有
 * 一条叫《师父》的笔记是合理的，跨柜子不算重复。
 *
 * 命中规则（**短路顺序**）：
 *   1. normalizeTitleForDedup 后字符串完全相等 → exact_dup
 *   2. Levenshtein 编辑距离 ≤ 2 且较短串 ≥ 3 字 → similar（via=edit）
 *      主路径：单字插/删/改的"几乎同名" case，bigram 在这种 case 上严重低估。
 *   3. bigramJaccard ≥ 0.6 且 |len(A) - len(B)| ≤ 2 → similar（via=jaccard）
 *      兜底：处理"换序 / 同义字替换 / 局部改写"。
 *   4. 否则 → unique
 *
 * candidate.title 归一化后为空 → unique（title 都没有，没法比，放过）。
 */
export function detectFilesDuplicate(
  candidate: { title: string; folderId: string },
  existingEntries: XingyeFileEntry[],
): FilesDuplicateResult {
  const candTitle = normalizeTitleForDedup(candidate.title);
  if (!candTitle) return { kind: 'unique' };
  const folderId = candidate.folderId.trim();
  if (!folderId) return { kind: 'unique' };

  let bestSimilar: { entry: XingyeFileEntry; score: number; via: 'jaccard' | 'edit' } | null = null;
  for (const entry of existingEntries) {
    if (entry.folderId !== folderId) continue;
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
