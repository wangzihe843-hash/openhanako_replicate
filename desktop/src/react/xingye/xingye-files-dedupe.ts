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
 * Jaccard 相似度（已切好的两个 bigram 集合）：|A ∩ B| / |A ∪ B|，0–1 区间。
 * 空集合相比为 0（不当作"完全相同"——那是 exact_dup 的活）。
 */
function jaccardOfSets(A: Set<string>, B: Set<string>): number {
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter += 1;
  const union = A.size + B.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/**
 * 标题 bigram Jaccard：先 normalizeTitleForDedup 归一再切 bigram。
 * 空集合相比为 0（不当作"完全相同"——那是 exact_dup 的活）。
 */
export function bigramJaccard(a: string, b: string): number {
  return jaccardOfSets(toBigramSet(normalizeTitleForDedup(a)), toBigramSet(normalizeTitleForDedup(b)));
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

// ─────────────────────────────────────────────────────────────────────────
//  跨文件夹查重（content-aware）
//
//  detectFilesDuplicate **只比同 folder 内的 title**（同名笔记跨柜子是合理的）。
//  但模型常犯另一种错：把同一件事（同一个人、同一段往事）几乎一字不差地塞进
//  **不同**文件夹（例：「莉莉丝答应不再瞒伤」同时进「关于 user」和「线索与发现」）。
//  同夹查重拦不到，title 还可能被改写过，所以这里**以正文为主信号**跨夹查重。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 正文归一化（跨文件夹内容查重用）：
 *   1. trim
 *   2. 全角标点 → 半角
 *   3. 删掉所有空白与常见标点（聚焦内容字——换行/逗号/书名号的差异不该影响判重）
 *   4. 英文小写
 *
 * 与 normalizeTitleForDedup 的区别：正文更长、含换行/段落，去标点+去空白后比 bigram 才稳。
 */
export function normalizeBodyForDedup(body: string): string {
  if (typeof body !== 'string') return '';
  let s = body.trim();
  if (!s) return '';
  s = s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\s+/g, '');
  s = s.replace(/[，。、；：！？,.;:!?"'""''（）()【】[\]《》「」『』~·・—\-…]/g, '');
  s = s.toLowerCase();
  return s;
}

/** 正文 bigram Jaccard（跨文件夹内容相似度的主信号）。 */
export function bodyBigramJaccard(a: string, b: string): number {
  return jaccardOfSets(toBigramSet(normalizeBodyForDedup(a)), toBigramSet(normalizeBodyForDedup(b)));
}

/**
 * 标题相似度（0–1）：取「编辑距离归一相似」与「bigram Jaccard」的较大值。
 * 编辑距离路径要求较短串 ≥ 3 字（与同夹查重一致，避免短前缀误判）。
 */
export function titleSimilarity(a: string, b: string): number {
  const A = normalizeTitleForDedup(a);
  const B = normalizeTitleForDedup(b);
  if (!A || !B) return 0;
  const jac = jaccardOfSets(toBigramSet(A), toBigramSet(B));
  const minLen = Math.min(A.length, B.length);
  const maxLen = Math.max(A.length, B.length);
  const edit =
    minLen >= FILES_DUPLICATE_MIN_LEN_FOR_EDIT && maxLen > 0 ? 1 - levenshtein(A, B) / maxLen : 0;
  return Math.max(jac, edit);
}

/** 跨夹查重：正文强相似——单凭正文就判重（哪怕标题被改写）。 */
export const FILES_CROSS_FOLDER_BODY_STRONG = 0.6;
/** 跨夹查重：标题近乎同名——不同夹里几乎一样的标题。 */
export const FILES_CROSS_FOLDER_TITLE_STRONG = 0.72;
/** 跨夹查重：标题 + 正文双中等同时命中（同一主题被改写）。两者都要过，降低误判。 */
export const FILES_CROSS_FOLDER_TITLE_MID = 0.42;
export const FILES_CROSS_FOLDER_BODY_MID = 0.42;

/** 跨夹查重只读这几个字段，所以接结构子集——既能传真 entry，也能传本批草稿的合成条目。 */
export type CrossFolderDedupEntry = Pick<XingyeFileEntry, 'id' | 'title' | 'body' | 'folderId'>;

export type CrossFolderDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'cross_dup'; entry: CrossFolderDedupEntry; score: number; via: 'body' | 'title' | 'combined' };

/**
 * candidate 是否与**别的文件夹**里某条形成「几乎一样的内容」。
 *
 * 命中规则（取相似度最高的那条）：
 *   1. 正文 bigram Jaccard ≥ BODY_STRONG → cross_dup（via=body，最可靠）
 *   2. 标题相似度 ≥ TITLE_STRONG → cross_dup（via=title，"换个夹同名"）
 *   3. 标题 ≥ TITLE_MID **且** 正文 ≥ BODY_MID → cross_dup（via=combined，改写但两信号都指向同主题）
 *
 * 只比 `entry.folderId !== candidate.folderId` 的条目——同夹是 detectFilesDuplicate 的活。
 * candidate 标题与正文都为空 → unique（没料可比，放过）。
 */
export function detectCrossFolderDuplicate(
  candidate: { title: string; body: string; folderId: string },
  existingEntries: ReadonlyArray<CrossFolderDedupEntry>,
): CrossFolderDuplicateResult {
  const candFolder = candidate.folderId.trim();
  if (!normalizeTitleForDedup(candidate.title) && !normalizeBodyForDedup(candidate.body)) {
    return { kind: 'unique' };
  }

  let best: { entry: CrossFolderDedupEntry; score: number; via: 'body' | 'title' | 'combined' } | null = null;
  for (const entry of existingEntries) {
    if (candFolder && entry.folderId.trim() === candFolder) continue; // 跳过同夹
    const tSim = titleSimilarity(candidate.title, entry.title);
    const bSim = bodyBigramJaccard(candidate.body, entry.body);
    let via: 'body' | 'title' | 'combined' | null = null;
    let score = 0;
    if (bSim >= FILES_CROSS_FOLDER_BODY_STRONG) {
      via = 'body';
      score = bSim;
    } else if (tSim >= FILES_CROSS_FOLDER_TITLE_STRONG) {
      via = 'title';
      score = tSim;
    } else if (tSim >= FILES_CROSS_FOLDER_TITLE_MID && bSim >= FILES_CROSS_FOLDER_BODY_MID) {
      via = 'combined';
      score = (tSim + bSim) / 2;
    }
    if (via && (!best || score > best.score)) best = { entry, score, via };
  }
  return best ? { kind: 'cross_dup', ...best } : { kind: 'unique' };
}
