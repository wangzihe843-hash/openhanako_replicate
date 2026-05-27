/**
 * 邮件（mail）批量初始化生成的去重 / 跨期连续性锚点。
 *
 * 与 journal 的关键区别：
 *  - 邮件**有发件人维度**——同一个发件人下的多封邮件之间才有"重复主题"的语义；
 *    跨发件人的"主题相近"（比如两家公司都发促销）是正常的，不算重复。
 *  - 一次 mail_init 会一次性生成 6–9 封邮件，所以 anchor block 抽样要**按发件人聚合**，
 *    防止 anchor 被一个高频发件人塞满（譬如同一个 newsletter 占了 6 条样本，
 *    留给其它发件人的样本就被挤掉了，模型看不到全貌）。
 *
 * 双层防御：
 *   1. anchor block（前置 prompt）：从 `XingyeMailMessage[]` 里抽最近 N 条样本，
 *      按发件人聚合，**同一发件人最多 2 条**，总条数上限 8。每条列出
 *      `发件人 | 主题 | 开头第一句`。
 *   2. 后置过滤（normalize 之后）：把新生成的 `XingyeMailAiDraft[]` 逐封与已有
 *      messages **按发件人地址分桶**比对主题相似度——只在同一 fromAddress 内判重，
 *      跨发件人不算重复。
 *
 * 纯函数模块，无 React / fs 依赖，只接数据。
 */

import {
  FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD,
  FILES_DUPLICATE_JACCARD_THRESHOLD,
  FILES_DUPLICATE_MIN_LEN_FOR_EDIT,
  bigramJaccard,
  levenshtein,
  normalizeTitleForDedup,
} from './xingye-files-dedupe';
import type { XingyeMailMessage } from './xingye-mail-store';

/** anchor block 抽样总条数上限。 */
export const MAIL_ANCHOR_SAMPLE_LIMIT = 8;
/** anchor block 同一发件人最多抽几条（避免被某个高频发件人塞满）。 */
export const MAIL_ANCHOR_PER_SENDER_LIMIT = 2;
/** 主题截取长度（用于显示与开头层比对）。 */
export const MAIL_SUBJECT_SAMPLE_LENGTH = 40;
/** 开头第一句截取长度。 */
export const MAIL_OPENING_SAMPLE_LENGTH = 30;

/** 邮件 anchor 抽样里关心的最小字段。 */
type MailLike = Pick<XingyeMailMessage, 'from' | 'subject' | 'body' | 'createdAt'>;

function sliceCodePoints(text: string, n: number): string {
  if (!text) return '';
  const chars = [...text];
  return chars.slice(0, n).join('');
}

function extractOpening(body: string, n: number = MAIL_OPENING_SAMPLE_LENGTH): string {
  if (!body) return '';
  const firstLine = body.split(/\n+/).find((line) => line.trim()) ?? '';
  return sliceCodePoints(firstLine.trim(), n);
}

function normalizeAddressKey(address: string | undefined): string {
  return (address ?? '').trim().toLowerCase();
}

/**
 * 构造 prompt 用的「最近邮件锚点 block」。
 *
 * 规则：
 *  - 按 createdAt desc 排序后扫；
 *  - 按 `from.address.toLowerCase()` 聚合，同一发件人最多 MAIL_ANCHOR_PER_SENDER_LIMIT (=2) 条；
 *  - 总条数上限 MAIL_ANCHOR_SAMPLE_LIMIT (=8)；
 *  - 每条一行：`· [发件人名] <地址> | 主题 — 开头30字`。
 *
 * 空列表 → 空串。
 */
export function buildMailContinuityAnchorBlock(threads: readonly MailLike[]): string {
  if (!threads.length) return '';
  // 已经存的 messages.jsonl 在 listMailMessages 里就按 createdAt desc 排过——
  // 但我们防御性地再排一次，调用方传 raw 数据也能用。
  const sorted = [...threads].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return 0;
  });

  const perSender = new Map<string, number>();
  const samples: MailLike[] = [];
  for (const m of sorted) {
    const key = normalizeAddressKey(m.from?.address);
    if (!key) continue;
    const count = perSender.get(key) ?? 0;
    if (count >= MAIL_ANCHOR_PER_SENDER_LIMIT) continue;
    perSender.set(key, count + 1);
    samples.push(m);
    if (samples.length >= MAIL_ANCHOR_SAMPLE_LIMIT) break;
  }
  if (!samples.length) return '';

  const lines: string[] = [
    '- 最近邮箱里的邮件（**按发件人聚合**，请换主题/换发件人/换笔调，不要复读同一主题）：',
  ];
  for (const m of samples) {
    const fromName = m.from?.name?.trim() || m.from?.address?.trim() || '未知发件人';
    const fromAddr = m.from?.address?.trim() || '';
    const subject = sliceCodePoints(m.subject?.trim() || '（无主题）', MAIL_SUBJECT_SAMPLE_LENGTH);
    const opening = extractOpening(m.body || '');
    const openingPart = opening ? ` — ${opening}` : '';
    lines.push(`  · [${fromName}] <${fromAddr}> | ${subject}${openingPart}`);
  }
  return lines.join('\n');
}

/** 待比对的候选邮件最小形状。 */
export type MailDuplicateCandidate = {
  from: { address: string; name?: string };
  subject: string;
  body?: string;
};

export type MailDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'exact_dup'; entry: MailLike }
  | { kind: 'similar'; entry: MailLike; score: number; method: 'jaccard' | 'edit' };

/**
 * 后置去重决策：按发件人维度比对主题相似度。
 *
 * **按 `from.address.toLowerCase()` 分桶**——只与同一发件人的历史邮件比对，
 * 跨发件人不算重复（两家公司都发促销是正常的）。
 *
 * 命中规则（短路顺序，与 files-dedupe 同款阈值）：
 *   1. normalizeTitleForDedup(subject) 完全相等 → exact_dup
 *   2. Levenshtein 编辑距离 ≤ 2 且较短串 ≥ 3 字 → similar(method=edit)
 *   3. bigramJaccard(subject) ≥ 0.75 → similar(method=jaccard)
 *   4. 否则 unique
 *
 * candidate.from.address 空 → unique（缺关键键，没法分桶）。
 * candidate.subject 归一化后为空 → unique（主题都没有，没法比）。
 */
export function detectMailDuplicate(
  candidate: MailDuplicateCandidate,
  existingMessages: readonly MailLike[],
): MailDuplicateResult {
  const candKey = normalizeAddressKey(candidate.from?.address);
  if (!candKey) return { kind: 'unique' };
  const candSubject = normalizeTitleForDedup(candidate.subject);
  if (!candSubject) return { kind: 'unique' };

  let bestSimilar: { entry: MailLike; score: number; method: 'jaccard' | 'edit' } | null = null;
  for (const entry of existingMessages) {
    if (normalizeAddressKey(entry.from?.address) !== candKey) continue;
    const entrySubject = normalizeTitleForDedup(entry.subject);
    if (!entrySubject) continue;
    if (entrySubject === candSubject) {
      return { kind: 'exact_dup', entry };
    }
    const minLen = Math.min(entrySubject.length, candSubject.length);
    if (minLen >= FILES_DUPLICATE_MIN_LEN_FOR_EDIT) {
      const dist = levenshtein(entrySubject, candSubject);
      if (dist <= FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD) {
        const score = 1 - dist / Math.max(entrySubject.length, candSubject.length);
        if (!bestSimilar || score > bestSimilar.score) {
          bestSimilar = { entry, score, method: 'edit' };
        }
        continue;
      }
    }
    const jScore = bigramJaccard(entry.subject, candidate.subject);
    if (jScore >= FILES_DUPLICATE_JACCARD_THRESHOLD) {
      if (!bestSimilar || jScore > bestSimilar.score) {
        bestSimilar = { entry, score: jScore, method: 'jaccard' };
      }
    }
  }
  if (bestSimilar) return { kind: 'similar', ...bestSimilar };
  return { kind: 'unique' };
}

/**
 * 批量过滤：把候选 drafts 与 existing messages 比对，丢掉 exact_dup，保留 unique/similar。
 *
 * 输入数组顺序保留；丢弃的条目会记在 `dropped` 里供调用方日志/统计。
 *
 * 注意：**只丢 exact_dup**——similar 仍然保留。原因：mail init 是批量生成 6–9 封，
 * 如果把 similar 全丢光，剩下没几封了；anchor block 已经让模型在源头避开主题，
 * 这里只做"严格重复"的硬兜底。
 */
export function filterMailDraftsByDuplicates<T extends MailDuplicateCandidate>(
  drafts: readonly T[],
  existingMessages: readonly MailLike[],
): { kept: T[]; dropped: { draft: T; against: MailLike }[] } {
  const kept: T[] = [];
  const dropped: { draft: T; against: MailLike }[] = [];
  // 维护一个"已 keep 的草稿池"，让批内也防自重复（同次生成里两封同主题）。
  const sessionPool: MailLike[] = [];
  for (const d of drafts) {
    const result = detectMailDuplicate(d, [...existingMessages, ...sessionPool]);
    if (result.kind === 'exact_dup') {
      dropped.push({ draft: d, against: result.entry });
      continue;
    }
    kept.push(d);
    // 把刚 keep 的当作"批内已存在"，下一封比对时算上它
    sessionPool.push({
      from: {
        name: d.from?.name ?? '',
        address: d.from?.address ?? '',
        kind: 'system',
      } as MailLike['from'],
      subject: d.subject,
      body: d.body ?? '',
      createdAt: new Date(0).toISOString(),
    });
  }
  return { kept, dropped };
}
