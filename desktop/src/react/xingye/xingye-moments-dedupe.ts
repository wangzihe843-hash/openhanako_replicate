/**
 * 朋友圈「内容级」去重 + 跨期反重复锚点。
 *
 * 与 xingye-moments-store / xingye-moments-feed 里已有的「actor 层去重」（同一个人
 * 同一条 post 只能 like 一次、seedLikes 按 actorType:actorId 去重）**职责完全独立**：
 *   - 那个是「谁互动」维度的；
 *   - 本模块只看「正文写了什么」——AI 反复生成相近主题（"今天天气好"、"刚下班好累"、
 *     "凌晨三点的便利店"）时把后续的相似条目拦在写入 posts 之前。
 *
 * 双层防御：
 *   1. buildMomentsContinuityAnchorBlock：把最近 12 条朋友圈做成"作者 + 开头第一句 + 日期"
 *      的小卡片喂给 prompt，让模型在源头偏好换主题；
 *   2. detectMomentContentDuplicate / filterDuplicateMomentDrafts：写入 posts.jsonl 前再
 *      过一遍内容相似度——模型如果忽视提示、写出主题重复的草稿，这里兜底拦截。
 *
 * 内容比对策略借用 xingye-files-dedupe：
 *   - 走 bigramJaccard，比对正文「开头 60 字」（朋友圈没有 title，开头是最稳的主题信号）；
 *   - 阈值复用 FILES_DUPLICATE_JACCARD_THRESHOLD=0.75；
 *   - **关键差异**：按 author（authorAgentId）分桶——同一天 Hanako 写"今天好累"、
 *     林雾写"今天好累"是两个角色各自的真实独立动态，不该跨人判重；只有"同一个 actor
 *     连写两条主题相近的朋友圈"才是 AI 套路问题。
 *
 * 纯函数、无 React / fs 依赖；构造好的 anchor block 由调用方塞进 prompt，命中重复的草稿
 * 由调用方决定丢弃 / 强制写入。
 */

import { bigramJaccard } from './xingye-files-dedupe';
import type { XingyeMomentPost } from './xingye-moments-store';

/**
 * 内容相似度阈值：复用 files-dedupe 的经验值 0.75。
 *
 * 朋友圈开头 60 字的 bigram 集合通常有 30–60 个元素，区分度比短 title 更好——
 * 0.75 严一点能过滤掉"开头模板相同但后文不同"的擦边球（如"今天天气真好，但是…" ×
 * "今天天气真好，所以…"），同时不会误伤"凌晨三点的便利店" × "凌晨三点的港口"
 * （这两个 jaccard 大致 0.2，远低于阈值）。
 */
export const MOMENTS_CONTENT_DUPLICATE_JACCARD_THRESHOLD = 0.75;

/**
 * 比对所用的「正文开头」截取字数。
 *
 * 60 字是经验权衡：
 *   - 太短（< 30）：朋友圈很多都是"今天/昨晚/凌晨…"开头，假阳性多；
 *   - 太长（> 100）：bigram 集合膨胀后 Jaccard 分数被中段共有词稀释，反而漏判
 *     真正"主题相同、措辞稍变"的复读。
 */
export const MOMENTS_CONTENT_DUPLICATE_HEAD_CHARS = 60;

/** Anchor block 抽样上限。12 条≈四五天的朋友圈节奏，足够让模型看出"最近写过哪些主题"。 */
export const MOMENTS_ANCHOR_SAMPLE_LIMIT = 12;
/** Anchor 行里每条正文截取字数（只给模型看主题信号，不要灌全文）。 */
export const MOMENTS_ANCHOR_BODY_HEAD_CHARS = 30;

/**
 * 抽出正文「开头」用于比对。
 *
 * 与 anchor 行的截取字数不同：比对要的是足够稳定的主题指纹（默认 60 字），
 * anchor 行只是给人 / 模型看的提示（默认 30 字）。
 *
 * 故意不做更复杂的归一化（标点 / 全半角）：bigramJaccard 在 60 字尺度上对小差异
 * 已经足够鲁棒；过度归一化反而会让"今天天气真好。" 与 "今天天气，真好" 这种
 * 标点差异被算成完全相同（其实主题确实相同——我们就是要拦它）。
 */
function bodyHead(content: string, max = MOMENTS_CONTENT_DUPLICATE_HEAD_CHARS): string {
  if (typeof content !== 'string') return '';
  const trimmed = content.trim();
  if (!trimmed) return '';
  // 用 code points（Array.from）切，避免拆掉 emoji / 罕见字
  const chars = Array.from(trimmed);
  return chars.slice(0, max).join('');
}

/** 截取每条朋友圈正文的「第一句」，供 anchor 行展示。换行也算句号。 */
function firstSentenceForAnchor(content: string): string {
  if (typeof content !== 'string') return '';
  const trimmed = content.trim();
  if (!trimmed) return '';
  // 找到首个句号 / 问号 / 感叹号 / 换行——含中英文
  const m = trimmed.match(/^[^。！？!?\n]{1,200}/);
  const firstLine = m ? m[0] : trimmed;
  const chars = Array.from(firstLine);
  if (chars.length <= MOMENTS_ANCHOR_BODY_HEAD_CHARS) return chars.join('');
  return `${chars.slice(0, MOMENTS_ANCHOR_BODY_HEAD_CHARS).join('')}…`;
}

/** YYYY-MM-DD 抽取（用于 anchor 行的日期标签）。非法日期返回空串。 */
function ymd(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type MomentForAnchor = Pick<
  XingyeMomentPost,
  'authorAgentId' | 'authorName' | 'content' | 'createdAt'
>;

/**
 * 朋友圈反重复 anchor block（喂给 prompt）。
 *
 * 取最近 N 条（按 createdAt 倒序）朋友圈，每条压成一行：
 *   - `[YYYY-MM-DD] 作者名：开头第一句…`
 *
 * 没有历史 → 返回空串；调用方在 prompt 里展示「（无；这是 TA 的第一条朋友圈）」之类
 * 占位（参考 news / interview prompt 的做法）。
 *
 * **不要让模型回写 anchor block 本身**——它只是上下文，跟"最近场景""关系状态"一样。
 * 这与用户备忘录的「LLM 只回定性核心，批量/数值数据本地确定性生成」原则一致：
 * anchor 是本地确定性产生的，模型只负责"看了之后换个角度写"。
 */
export function buildMomentsContinuityAnchorBlock(
  moments: ReadonlyArray<MomentForAnchor>,
  options: { limit?: number } = {},
): string {
  if (!Array.isArray(moments) || moments.length === 0) return '';
  const limit = Math.max(1, options.limit ?? MOMENTS_ANCHOR_SAMPLE_LIMIT);
  const sorted = [...moments]
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .sort((a, b) => {
      const ta = Date.parse(a.createdAt || '');
      const tb = Date.parse(b.createdAt || '');
      if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
      if (!Number.isFinite(ta)) return 1;
      if (!Number.isFinite(tb)) return -1;
      return tb - ta;
    })
    .slice(0, limit);
  if (!sorted.length) return '';
  const lines: string[] = [];
  lines.push('- 近期朋友圈开头样本（请换主题 / 笔调 / 切口，不要复读同一类感慨）：');
  for (const m of sorted) {
    const date = ymd(m.createdAt) || '日期未知';
    const author = (m.authorName ?? '').trim() || m.authorAgentId || '（匿名）';
    const opener = firstSentenceForAnchor(m.content);
    if (!opener) continue;
    lines.push(`  · [${date}] ${author}：${opener}`);
  }
  // 只剩 header 没有任何条目 → 视为空
  if (lines.length <= 1) return '';
  return lines.join('\n');
}

export type MomentDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'similar'; existing: MomentForAnchor; score: number };

/**
 * 判定一条候选朋友圈是否与「同一个 author」之前发过的某条主题相近。
 *
 * **按 author 分桶**：candidate.authorAgentId 与 existing.authorAgentId 不同 → 一律放过。
 * 不同人发主题相近的朋友圈是正常的人间烟火，不是 AI 套路。
 *
 * 命中规则：
 *   1. candidate.content 归一化后为空 → unique（没法比）；
 *   2. 同 author 的某条 existing，正文开头 60 字的 bigramJaccard ≥ 0.75 → similar；
 *   3. 取分数最高的那条作为返回（便于 UI 提示「与 X 月 X 日那条主题相近」）。
 */
export function detectMomentContentDuplicate(
  candidate: { authorAgentId: string; content: string },
  existing: ReadonlyArray<MomentForAnchor>,
): MomentDuplicateResult {
  const author = (candidate.authorAgentId ?? '').trim();
  if (!author) return { kind: 'unique' };
  const candHead = bodyHead(candidate.content);
  if (!candHead) return { kind: 'unique' };

  let best: { existing: MomentForAnchor; score: number } | null = null;
  for (const m of existing) {
    if (!m || (m.authorAgentId ?? '').trim() !== author) continue;
    const head = bodyHead(m.content);
    if (!head) continue;
    const score = bigramJaccard(head, candHead);
    if (score >= MOMENTS_CONTENT_DUPLICATE_JACCARD_THRESHOLD) {
      if (!best || score > best.score) best = { existing: m, score };
    }
  }
  if (best) return { kind: 'similar', existing: best.existing, score: best.score };
  return { kind: 'unique' };
}

/**
 * 批量 filter：把 candidates 里与 existing 重复（含 candidates 互相之间重复）的去掉。
 *
 * 用于心跳/AI 一次产出多条 draft 草稿的场景——不仅要拦"和已有 post 重复"，还要拦
 * "本批 candidates 互相主题相近"（比如同一次产出里既有「凌晨好困」也有「困到睁不开
 * 眼了」，只保留第一条）。
 *
 * 返回 { kept, dropped }，dropped 里带上具体撞了谁、相似度多少，便于上层做日志或
 * UI 提示。
 */
export function filterDuplicateMomentDrafts<
  T extends { authorAgentId: string; content: string },
>(
  candidates: ReadonlyArray<T>,
  existing: ReadonlyArray<MomentForAnchor>,
): {
  kept: T[];
  dropped: Array<{ candidate: T; against: MomentForAnchor; score: number }>;
} {
  const kept: T[] = [];
  const dropped: Array<{ candidate: T; against: MomentForAnchor; score: number }> = [];
  // 累积已通过的 candidate 作为"虚拟 existing"——同一批里第二条与第一条冲突时也能拦下。
  const runningExisting: MomentForAnchor[] = [...existing];
  for (const c of candidates) {
    const verdict = detectMomentContentDuplicate(c, runningExisting);
    if (verdict.kind === 'similar') {
      dropped.push({ candidate: c, against: verdict.existing, score: verdict.score });
      continue;
    }
    kept.push(c);
    // 同 author 的虚拟条目（createdAt 用 now，仅供本批内部比对）
    runningExisting.push({
      authorAgentId: c.authorAgentId,
      authorName: c.authorAgentId,
      content: c.content,
      createdAt: new Date().toISOString(),
    });
  }
  return { kept, dropped };
}
