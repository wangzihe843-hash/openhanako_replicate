/**
 * 「秘密空间」5 个 AI 可生成子类型的入库前硬去重 + 反重复 anchor block 构建。
 *
 * 用户明确反馈：「秘密空间梦境也会反复生成相同内容」——dream 是最严重的 case，
 * 其它 4 个（draft_reply / saved_item / unsent_moment / state）顺手一起做。
 *
 * 双层防御（参考 files-dedupe / interview-ai 的 buildInterviewContinuityAnchorBlock）：
 *   1. **prompt 端反重复**：把最近 N 条同子类型记录抽样成 anchor block 喂给模型，
 *      在源头让 LLM 偏好「换不同主题/角度/意象」。
 *   2. **入库前兜底**：normalize 完落库前再过一遍 `detectSecretSpaceDuplicate`，
 *      撞了 exact_dup 直接丢弃（dream 尤其如此——反复同主题是用户痛点）。
 *
 * 每个子类型一个 anchor block 构建函数，**不**做泛用——5 个子类型抽样字段差太多：
 *   - dream：标题（梦境主题）+ tags（意象关键词）
 *   - draft_reply：meta（收件人）+ 正文开头（回复主旨）
 *   - saved_item：标题（物品/句子名）+ meta（分类）+ source（出处）
 *   - unsent_moment：正文第一句（朋友圈开头）
 *   - state：标题 + 正文开头（心绪关键词）
 *
 * 与 interview / news anchor block 一致的渲染风格：markdown bullet + 「请换不同…」指令。
 *
 * 纯函数模块，**不**接 React / fs / store，调用方先用 `listSecretSpaceRecords` 拿到数组再传进来。
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
import type { SecretSpaceSampleRecord } from './secret-space-record-types';

export type SecretSpaceDedupeSubtype =
  | 'dream'
  | 'draft_reply'
  | 'saved_item'
  | 'unsent_moment'
  | 'state';

/** 抽样窗口：每个子类型最多看最近多少条做反重复（足够覆盖近期生成，不至于把 prompt 撑爆）。 */
const ANCHOR_SAMPLE_WINDOW = 8;

/** 抽样后塞进 anchor 的条数上限（avoid prompt bloat）。 */
const ANCHOR_SAMPLE_RENDER_LIMIT = 6;

/** 抽样字段截断长度（每条 bullet 上限）——梦境关键词、朋友圈开头都用这个值。 */
const ANCHOR_FIELD_MAX = 40;

/** Anchor 块要不要前置 `## 跨期连续性` 这种 markdown 头由 prompt 端拼，本模块只返回 bullet 块。 */
function joinLines(lines: string[]): string {
  return lines.filter((l) => l && l.trim()).join('\n');
}

function firstNonEmptyLine(body: string | undefined | null, max = ANCHOR_FIELD_MAX): string {
  if (typeof body !== 'string') return '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t) return t.length > max ? `${t.slice(0, max)}…` : t;
  }
  return '';
}

/* ------------------------------------------------------------------------ *
 * Anchor block 构建：每个子类型一个，**不**写成泛用模板。
 * ------------------------------------------------------------------------ */

/**
 * 梦境：用户反馈最严重的反复重复 case。
 *   - 标题 = 梦境主题；tags = 关键意象。
 *   - 模型最常见的偷懒是「又写了一遍水/回不去的车/听到歌」，所以两者都列出来。
 */
export function buildDreamContinuityAnchorBlock(records: SecretSpaceSampleRecord[]): string {
  if (!records.length) return '';
  const window = records.slice(0, ANCHOR_SAMPLE_WINDOW);
  const titleSamples: string[] = [];
  const imagerySeen = new Set<string>();
  const imagerySamples: string[] = [];
  for (const r of window) {
    const t = (r.title ?? '').trim();
    if (t && titleSamples.length < ANCHOR_SAMPLE_RENDER_LIMIT) {
      titleSamples.push(t.length > ANCHOR_FIELD_MAX ? `${t.slice(0, ANCHOR_FIELD_MAX)}…` : t);
    }
    const tags = Array.isArray(r.tags) ? r.tags : [];
    for (const tag of tags) {
      const k = tag.trim();
      if (!k) continue;
      if (imagerySeen.has(k)) continue;
      imagerySeen.add(k);
      imagerySamples.push(k);
      if (imagerySamples.length >= 12) break;
    }
  }
  if (!titleSamples.length && !imagerySamples.length) return '';
  const lines: string[] = [];
  if (titleSamples.length) {
    lines.push('- 近期梦境主题（请换完全不同的主题，不要重复以下内容）：');
    for (const t of titleSamples) lines.push(`  · ${t}`);
  }
  if (imagerySamples.length) {
    lines.push(`- 近期已用过的梦境意象（请换不同的象征，不要再用以下意象）：${imagerySamples.map((k) => `「${k}」`).join('、')}`);
  }
  return joinLines(lines);
}

/**
 * 草稿回复：抽收件人（meta）+ 回复主旨（正文第一行）。
 *   - meta 是 "给 你"/"给 妈妈"/"给 自己"——多写同一个收件人不算重复（人很可能反复给同一个人写）。
 *   - 但 "给 你 + 同一个回复主旨" 就是重复——所以两者一起列出来。
 */
export function buildDraftReplyContinuityAnchorBlock(records: SecretSpaceSampleRecord[]): string {
  if (!records.length) return '';
  const window = records.slice(0, ANCHOR_SAMPLE_WINDOW);
  const samples: string[] = [];
  for (const r of window) {
    if (samples.length >= ANCHOR_SAMPLE_RENDER_LIMIT) break;
    const recipient = (r.meta ?? '').trim();
    const opener = firstNonEmptyLine(r.body, ANCHOR_FIELD_MAX);
    if (!recipient && !opener) continue;
    const left = recipient ? `${recipient} ｜ ` : '';
    samples.push(`${left}${opener || '（空）'}`);
  }
  if (!samples.length) return '';
  const lines: string[] = ['- 近期草稿回复（收件人 ｜ 开头一句；请换不同的对象或主旨，不要重复以下内容）：'];
  for (const s of samples) lines.push(`  · ${s}`);
  return joinLines(lines);
}

/**
 * 收藏物：抽 title（物品/句子名）+ meta（分类：句子/对话/瞬间/片段）+ source（出处）。
 *   - 用户反馈：模型容易反复"收藏同一句 Camus"；title + source 两个维度都要看。
 */
export function buildSavedItemContinuityAnchorBlock(records: SecretSpaceSampleRecord[]): string {
  if (!records.length) return '';
  const window = records.slice(0, ANCHOR_SAMPLE_WINDOW);
  const samples: string[] = [];
  const sourceSeen = new Set<string>();
  const sourceSamples: string[] = [];
  for (const r of window) {
    if (samples.length < ANCHOR_SAMPLE_RENDER_LIMIT) {
      const t = (r.title ?? '').trim();
      const m = (r.meta ?? '').trim();
      if (t || m) {
        const left = m ? `[${m}] ` : '';
        samples.push(`${left}${t || firstNonEmptyLine(r.body, ANCHOR_FIELD_MAX) || '（空）'}`);
      }
    }
    const src = (r.source ?? '').trim();
    if (src && !sourceSeen.has(src) && sourceSamples.length < 6) {
      sourceSeen.add(src);
      sourceSamples.push(src.length > ANCHOR_FIELD_MAX ? `${src.slice(0, ANCHOR_FIELD_MAX)}…` : src);
    }
  }
  if (!samples.length && !sourceSamples.length) return '';
  const lines: string[] = [];
  if (samples.length) {
    lines.push('- 近期已收藏的条目（请换不同的句子/物品，不要重复以下内容）：');
    for (const s of samples) lines.push(`  · ${s}`);
  }
  if (sourceSamples.length) {
    lines.push(`- 近期已用过的出处（请换不同的作者/场景，不要再引以下源）：${sourceSamples.map((s) => `「${s}」`).join('、')}`);
  }
  return joinLines(lines);
}

/**
 * 未发出朋友圈：抽正文第一句。
 *   - 朋友圈是短句体，标题往往就是开头截断——所以正文第一行是最稳的反重复抓手。
 */
export function buildUnsentMomentContinuityAnchorBlock(records: SecretSpaceSampleRecord[]): string {
  if (!records.length) return '';
  const window = records.slice(0, ANCHOR_SAMPLE_WINDOW);
  const samples: string[] = [];
  for (const r of window) {
    if (samples.length >= ANCHOR_SAMPLE_RENDER_LIMIT) break;
    const opener = firstNonEmptyLine(r.body, ANCHOR_FIELD_MAX);
    if (opener) samples.push(opener);
  }
  if (!samples.length) return '';
  const lines: string[] = ['- 近期未发出朋友圈开头（请换不同的情绪/场景，不要重复以下开头）：'];
  for (const s of samples) lines.push(`  · ${s}`);
  return joinLines(lines);
}

/**
 * 心绪/状态：抽 title + 正文开头（心绪关键词通常都在 title）。
 *   - state 的 RelationshipStatePanel 主视图也吃 lore，这里只针对 jsonl 短笔记反复重复。
 *
 * 命名注意：与 `xingye-state-dedupe.ts` 的 `buildStateContinuityAnchorBlock`（关系
 * 状态历史栈）是两个不同概念——后者是 RelationshipState 的演化锚点，本函数是
 * 秘密空间里 `state` 子类型的短笔记锚点。前缀 `SecretSpace` 是为了避免命名冲突。
 */
export function buildSecretSpaceStateContinuityAnchorBlock(records: SecretSpaceSampleRecord[]): string {
  if (!records.length) return '';
  const window = records.slice(0, ANCHOR_SAMPLE_WINDOW);
  const samples: string[] = [];
  for (const r of window) {
    if (samples.length >= ANCHOR_SAMPLE_RENDER_LIMIT) break;
    const t = (r.title ?? '').trim();
    const opener = firstNonEmptyLine(r.body, ANCHOR_FIELD_MAX);
    if (!t && !opener) continue;
    samples.push(t && opener ? `${t}｜${opener}` : t || opener);
  }
  if (!samples.length) return '';
  const lines: string[] = ['- 近期心绪/状态记录（请换不同的情绪切面，不要重复以下条目）：'];
  for (const s of samples) lines.push(`  · ${s}`);
  return joinLines(lines);
}

/** 子类型 → anchor 构建函数 dispatch table，方便调用方按 category 直接取。 */
export const SECRET_SPACE_ANCHOR_BUILDERS: Record<
  SecretSpaceDedupeSubtype,
  (records: SecretSpaceSampleRecord[]) => string
> = {
  dream: buildDreamContinuityAnchorBlock,
  draft_reply: buildDraftReplyContinuityAnchorBlock,
  saved_item: buildSavedItemContinuityAnchorBlock,
  unsent_moment: buildUnsentMomentContinuityAnchorBlock,
  state: buildSecretSpaceStateContinuityAnchorBlock,
};

/* ------------------------------------------------------------------------ *
 * 入库前兜底：detectSecretSpaceDuplicate
 *
 * 复用 files-dedupe 的 normalize / bigramJaccard / levenshtein 与阈值常量。
 * 决策规则与 detectFilesDuplicate 同构（**短路顺序**）：
 *   1. normalize 后 title 完全相等 → exact_dup
 *   2. Levenshtein 编辑距离 ≤ 2 且较短串 ≥ 3 字 → similar(via=edit)
 *   3. bigramJaccard ≥ 0.75 且 |len(A) - len(B)| ≤ 2 → similar(via=jaccard)
 *   4. 否则 → unique
 *
 * 与 files-dedupe 不同的是：**没有 folderId 维度**——secret-space 按 subtype 隔离，
 * existing 数组就只该是同一个 subtype 的记录（调用方负责筛）。
 *
 * dream 子类型推荐："撞 exact_dup 直接丢弃；similar 则保留（角度可能不同）"。
 * 其它子类型推荐："撞 exact_dup 同样丢弃；similar 由调用方按需重试"。
 * 本函数只判定，不决定丢/留——交给 generateSecretSpaceRecordWithAI 决策。
 * ------------------------------------------------------------------------ */

export type SecretSpaceDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'exact_dup'; record: SecretSpaceSampleRecord }
  | { kind: 'similar'; record: SecretSpaceSampleRecord; score: number; via: 'jaccard' | 'edit' };

export function detectSecretSpaceDuplicate(
  candidate: { title: string; body?: string },
  existing: SecretSpaceSampleRecord[],
  /**
   * subtype 现在只用于将来扩展（如果某子类型规则需要特化）；
   * 目前所有 subtype 都共用 title 相似度判定，保留入参便于以后无破坏性扩展。
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  subtype: SecretSpaceDedupeSubtype,
): SecretSpaceDuplicateResult {
  const candTitle = normalizeTitleForDedup(candidate.title);
  if (!candTitle) return { kind: 'unique' };

  let bestSimilar:
    | { record: SecretSpaceSampleRecord; score: number; via: 'jaccard' | 'edit' }
    | null = null;

  for (const record of existing) {
    const recTitle = normalizeTitleForDedup(record.title ?? '');
    if (!recTitle) continue;
    if (recTitle === candTitle) {
      return { kind: 'exact_dup', record };
    }
    const minLen = Math.min(recTitle.length, candTitle.length);
    if (minLen >= FILES_DUPLICATE_MIN_LEN_FOR_EDIT) {
      const dist = levenshtein(recTitle, candTitle);
      if (dist <= FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD) {
        const score = 1 - dist / Math.max(recTitle.length, candTitle.length);
        if (!bestSimilar || score > bestSimilar.score) {
          bestSimilar = { record, score, via: 'edit' };
        }
        continue;
      }
    }
    if (Math.abs(recTitle.length - candTitle.length) > FILES_DUPLICATE_LEN_TOLERANCE) {
      continue;
    }
    const score = bigramJaccard(record.title ?? '', candidate.title);
    if (score >= FILES_DUPLICATE_JACCARD_THRESHOLD) {
      if (!bestSimilar || score > bestSimilar.score) {
        bestSimilar = { record, score, via: 'jaccard' };
      }
    }
  }
  if (bestSimilar) return { kind: 'similar', ...bestSimilar };
  return { kind: 'unique' };
}
