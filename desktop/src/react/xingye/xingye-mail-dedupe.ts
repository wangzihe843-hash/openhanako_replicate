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

export type MailDuplicateOptions = {
  /**
   * true：忽略发件人分桶，跨发件人按主题比对。
   *
   * 给推广 / 垃圾（promotions / spam）用——模型每次都给这类邮件**编一个新的虚构发件地址**，
   * 按发件人分桶会让「中奖 / 限时优惠」这类换汤不换药的内容永远落进不同桶、判不出重复。
   * 私人邮件（inbox/sent/drafts）保持默认 false：同一联系人才比，跨联系人主题相近是正常的。
   */
  crossSender?: boolean;
};

/**
 * 后置去重决策：默认按发件人维度比对主题相似度。
 *
 * **默认按 `from.address.toLowerCase()` 分桶**——只与同一发件人的历史邮件比对，
 * 跨发件人不算重复（两家公司都发促销是正常的）。传 `{ crossSender: true }` 时
 * 跳过分桶，与所有历史邮件比对（推广 / 垃圾段专用）。
 *
 * 命中规则（短路顺序，与 files-dedupe 同款阈值）：
 *   1. normalizeTitleForDedup(subject) 完全相等 → exact_dup
 *   2. Levenshtein 编辑距离 ≤ 2 且较短串 ≥ 3 字 → similar(method=edit)
 *   3. bigramJaccard(subject) ≥ 0.75 → similar(method=jaccard)
 *   4. 否则 unique
 *
 * candidate.from.address 空 → 仅在非 crossSender 时判 unique（缺分桶键）；crossSender 模式
 * 不依赖发件地址，照常比主题。
 * candidate.subject 归一化后为空 → unique（主题都没有，没法比）。
 */
export function detectMailDuplicate(
  candidate: MailDuplicateCandidate,
  existingMessages: readonly MailLike[],
  options: MailDuplicateOptions = {},
): MailDuplicateResult {
  const crossSender = options.crossSender === true;
  const candKey = normalizeAddressKey(candidate.from?.address);
  if (!crossSender && !candKey) return { kind: 'unique' };
  const candSubject = normalizeTitleForDedup(candidate.subject);
  if (!candSubject) return { kind: 'unique' };

  let bestSimilar: { entry: MailLike; score: number; method: 'jaccard' | 'edit' } | null = null;
  for (const entry of existingMessages) {
    if (!crossSender && normalizeAddressKey(entry.from?.address) !== candKey) continue;
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
 * 推广 / 垃圾邮件的「套路主题签名」。
 *
 * 跨发件人主题去重（crossSender）能抓住「中奖」复读「中奖」，但抓不到换了词的同套路
 * （「恭喜您被抽中」vs「您的账户有一笔待领奖金」——bigram 重叠低，却是同一种中奖骗局）。
 * 这里用一组粗粒度关键词把常见垃圾 / 推广套路归到有限几个 bucket：同一 bucket 在一个邮箱里
 * 留 1 封就够了，再生成同套路就丢。命中不了任何 bucket → 返回 null（按主题维度照常判重，
 * 绝不因为「没归类」就误杀，避免把真正新颖的内容一并拦掉）。
 *
 * 顺序敏感：靠前的 bucket 优先（account-phish 比 payment 先判，避免「账户欠费」被吃进 payment）。
 */
const BULK_THEME_PATTERNS: ReadonlyArray<{ key: string; re: RegExp }> = [
  { key: 'lottery', re: /中奖|抽中|抽奖|大奖|奖品|幸运(用户|观众|抽)|恭喜[您你].{0,6}(获|中|领)|领取.{0,4}奖/ },
  { key: 'account-phish', re: /账户|账号|登录(异常|提醒|地点)|异地登录|冻结|封停|验证(身份|码)?|安全(提醒|警告|中心)|密码.{0,4}(过期|重置|泄露)/ },
  { key: 'payment', re: /账单|欠费|逾期|退款|到账|发票|扣费|缴费|余额不足|待支付/ },
  { key: 'package', re: /包裹|快递|物流|签收|配送|取件|运单|派送/ },
  { key: 'sale', re: /折扣|优惠|促销|限时|清仓|秒杀|满减|特价|大促|低至|甩卖|福利价/ },
  { key: 'newsletter', re: /精选|专题|周报|月刊|月报|简报|速递|资讯|订阅|专栏|本周看点/ },
  { key: 'event', re: /活动|讲座|沙龙|展览|展会|报名|预约|招募|邀请函|见面会|发布会/ },
  { key: 'membership', re: /会员|积分|续费|权益|开通.{0,4}(会员|套餐|服务)|升级.{0,4}(会员|套餐)/ },
];

/**
 * 给一封推广 / 垃圾邮件归出套路主题 key；归不出 → null。
 * 仅看 subject + body 文本，纯函数。
 */
export function bulkMailThemeKey(subject: string, body?: string): string | null {
  const text = `${subject ?? ''} ${body ?? ''}`;
  if (!text.trim()) return null;
  for (const { key, re } of BULK_THEME_PATTERNS) {
    if (re.test(text)) return key;
  }
  return null;
}

export type MailDuplicateFilterOptions = {
  /** 跨发件人比主题（透传给 detectMailDuplicate）。默认 false。 */
  crossSender?: boolean;
  /** true：连 similar 也丢（近似主题即视为重复）。默认 false——只丢 exact_dup。 */
  dropSimilar?: boolean;
  /**
   * true：额外用 bulkMailThemeKey 做「套路主题」去重——一个邮箱里同套路（中奖/钓鱼/折扣…）
   * 留 1 封，再生成同套路就丢。专给推广 / 垃圾用，私人邮件不要开。默认 false。
   */
  useThemeSignature?: boolean;
};

/**
 * 批量过滤：把候选 drafts 与 existing messages 比对，丢掉重复，返回 kept / dropped。
 *
 * 输入数组顺序保留；丢弃的条目会记在 `dropped` 里供调用方日志/统计。
 *
 * 默认（私人邮件）：按发件人分桶，**只丢 exact_dup**，保留 similar（同一联系人主题相近正常，
 * 且 init 一次只生成几封，全丢 similar 会剩不下几封）。
 *
 * 推广 / 垃圾（传 `{ crossSender, dropSimilar, useThemeSignature }`）：跨发件人比主题、similar
 * 也丢、再叠一层套路主题签名——这才能压住「每次都生成一封换汤不换药的中奖 / 限时优惠」。
 */
export function filterMailDraftsByDuplicates<T extends MailDuplicateCandidate>(
  drafts: readonly T[],
  existingMessages: readonly MailLike[],
  options: MailDuplicateFilterOptions = {},
): { kept: T[]; dropped: { draft: T; against: MailLike }[] } {
  const { crossSender = false, dropSimilar = false, useThemeSignature = false } = options;
  const kept: T[] = [];
  const dropped: { draft: T; against: MailLike }[] = [];
  // 维护一个"已 keep 的草稿池"，让批内也防自重复（同次生成里两封同主题/同套路）。
  const sessionPool: MailLike[] = [];
  // 套路主题去重：先把已有邮件的主题签名喂进去（一个 bucket 留 1 封）。
  const seenThemes = new Map<string, MailLike>();
  if (useThemeSignature) {
    for (const m of existingMessages) {
      const key = bulkMailThemeKey(m.subject, m.body);
      if (key && !seenThemes.has(key)) seenThemes.set(key, m);
    }
  }
  for (const d of drafts) {
    const result = detectMailDuplicate(d, [...existingMessages, ...sessionPool], { crossSender });
    if (result.kind === 'exact_dup') {
      dropped.push({ draft: d, against: result.entry });
      continue;
    }
    if (dropSimilar && result.kind === 'similar') {
      dropped.push({ draft: d, against: result.entry });
      continue;
    }
    if (useThemeSignature) {
      const themeKey = bulkMailThemeKey(d.subject, d.body);
      const themeHit = themeKey ? seenThemes.get(themeKey) : undefined;
      if (themeKey && themeHit) {
        dropped.push({ draft: d, against: themeHit });
        continue;
      }
    }
    kept.push(d);
    const poolEntry: MailLike = {
      from: {
        name: d.from?.name ?? '',
        address: d.from?.address ?? '',
        kind: 'system',
      } as MailLike['from'],
      subject: d.subject,
      body: d.body ?? '',
      createdAt: new Date(0).toISOString(),
    };
    // 把刚 keep 的当作"批内已存在"，下一封比对时算上它（主题 + 套路两层都登记）。
    sessionPool.push(poolEntry);
    if (useThemeSignature) {
      const themeKey = bulkMailThemeKey(d.subject, d.body);
      if (themeKey && !seenThemes.has(themeKey)) seenThemes.set(themeKey, poolEntry);
    }
  }
  return { kept, dropped };
}
