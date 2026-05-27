/**
 * 健康模块「AI 反重复」纯函数模块。
 *
 * 健康记录的形态：一天一条 XingyeHealthDay（按 isoDate 主键），里面是
 * scenario + advice（title + body）。本身已经被 store 按 isoDate 去重；
 * 但 LLM 在写 advice 时容易反复落进同几个套话槽位——
 *
 *   - 「今天喝够 8 杯水了」（喝水槽）
 *   - 「昨晚睡了 7 小时，深睡比例不错」（睡眠槽）
 *   - 「今天跑步 30 分钟，状态很好」（运动槽）
 *   - 「步数达标」（步数槽）
 *   - 「压力偏高，建议放松」（压力槽）
 *
 * 真实用户每天都会"喝水/睡觉/走路"，但 advice 文本里**复读同一句话**就显得
 * 机械、像模板。本模块两件事：
 *
 *   1. detectHealthSlot(title, body) → 识别 advice 落在哪个 slot；
 *   2. filterSameDayHealthSlotDuplicates(drafts, existing) → 一天每个 slot
 *      最多 1 条（与 accounting MealSlot 模式一致；为未来若有「同一天多条
 *      health 记录」的形态预留兜底，今天 store 层 isoDate 去重已经把同日
 *      多条压成 1 条，filter 在这个形态下基本是 no-op，但保持 API 一致）；
 *   3. buildHealthContinuityAnchorBlock(records) → 抽最近 7 天 advice 的
 *      slot 命中 + 摘要文本，喂回 prompt，告诉 LLM「最近一周已经写过这些
 *      slot 的套话了，请换个角度」。这才是健康模块的主要 dedup 杠杆。
 *
 * 抽出来单独成模块的原因：纯函数、无 React / fs 依赖，好单测。
 */

import type { XingyeHealthDay } from './xingye-health-data';

/**
 * 健康"槽位"——LLM 在 advice 里容易反复落入的几种主题。
 *
 * 不覆盖所有健康概念（呼吸、心理、姿势…），只挑「真实生活里几乎每天都会
 * 触发、LLM 又最爱复读」的五类。识别不出来归 null（advice 是综合分析、
 * 落不到单一 slot）。
 */
export const HEALTH_SLOTS = ['sleep', 'water', 'exercise', 'steps', 'stress'] as const;
export type HealthSlot = (typeof HEALTH_SLOTS)[number];

/**
 * 各槽位关键词。任一在 title / body 命中即归入对应 slot。
 *
 * - sleep：睡 / 觉 / 夜 / 入睡 / 深睡 / 浅睡 / REM / 失眠 / 熬夜 / 安眠
 * - water：水 / 喝水 / 饮水 / 补水 / 脱水 / 杯水（注意「8 杯水」「多喝水」）
 * - exercise：跑步 / 锻炼 / 健身 / 训练 / 运动量 / 拉伸 / 瑜伽 / 散步 / 走路 /
 *             举铁 / 力量 / 有氧 / 出汗 / 配速 / 跑了
 *   ※ "运动"单独太泛（生活里随便提一句"运动后"），所以要前缀"运动量/做运动/
 *     一段运动"；这里用更具体的关键词避免泛滥。
 * - steps：步数 / 步行 / 走了 X 步 / 万步 / 步数目标 / 计步
 * - stress：压力 / 焦虑 / 紧绷 / 紧张 / 高压 / 减压 / 放松 / 情绪起伏 / 心烦
 *
 * regex 是「sloppy 但保守」：宁可漏判也不要误判——
 * 误判 → 真有差异的 advice 被当成重复，体验下降；
 * 漏判 → 该 slot 这次不参与去重，最坏退化成"无 dedup"，可接受。
 */
const HEALTH_SLOT_PATTERNS: Record<HealthSlot, RegExp> = {
  sleep: /睡眠|入睡|深睡|浅睡|REM|失眠|熬夜|安眠|睡得|睡了|夜里|睡前|早睡|晚睡|作息/i,
  water: /喝水|饮水|补水|脱水|杯水|多喝水|水分|喝够/,
  exercise: /跑步|跑了|锻炼|健身|训练|拉伸|瑜伽|散步|举铁|力量训练|有氧|配速|出汗|运动量|做运动|一段运动|运动后/,
  steps: /步数|步行|计步|万步|走了\s*\d|\d+\s*步|步数目标|步数达标/,
  stress: /压力|焦虑|紧绷|紧张|高压|减压|放松|情绪起伏|心烦|烦躁|疲惫感/,
};

/**
 * 从 title / body 里识别命中的所有健康 slot。一段 advice 可能同时谈"睡眠
 * + 压力"，故返回 Set 而非单值。
 *
 * 用 advice 而非 scenario 来判 slot 的理由：scenario 只有 3 种（calm /
 * high_stress / active），粒度太粗——同样是 calm，今天可能写"睡得很好"、
 * 明天写"步数充足"，应该算两类 slot 而非"两条 calm 重复"。
 */
export function detectHealthSlots(
  title: string | undefined,
  body: string | undefined,
): Set<HealthSlot> {
  const text = `${title ?? ''}\n${body ?? ''}`;
  const hits = new Set<HealthSlot>();
  if (!text.trim()) return hits;
  for (const slot of HEALTH_SLOTS) {
    if (HEALTH_SLOT_PATTERNS[slot].test(text)) hits.add(slot);
  }
  return hits;
}

/**
 * 「单一 slot」便捷函数：若 advice 只命中一个 slot 就返回它，否则 null。
 * 给 filter 用——多 slot 的 advice 算「综合性分析」，不参与单 slot 去重。
 */
export function detectHealthSlot(
  title: string | undefined,
  body: string | undefined,
): HealthSlot | null {
  const hits = detectHealthSlots(title, body);
  if (hits.size === 1) {
    const [only] = hits;
    return only;
  }
  return null;
}

/**
 * 「同日同 slot 最多 1 条」的硬过滤。
 *
 * 入参形态故意写得宽松（不和 XingyeHealthDay 紧绑）：只要 draft / existing
 * 有 `isoDate` + `title?` + `body?` 即可。这样未来若多条 health 形态出现
 * （例如分早 / 晚两次 advice），同一函数仍可复用。
 *
 * 在当前「一天一条 XingyeHealthDay」形态下，本 filter 基本是 no-op
 * （existing 里同一天最多一条；drafts 里通常也只有一条），但作为入库前
 * 兜底层保留，与 accounting / files 模块风格一致。
 *
 * 命中规则：同一 isoDate 下，若 existing 已有某 slot，drafts 中相同 slot
 * 的草稿被丢弃；本批内也去重（第二条相同 slot 被丢）。
 */
export function filterSameDayHealthSlotDuplicates<T extends {
  isoDate?: string;
  title?: string;
  body?: string;
}>(
  drafts: T[],
  existing: Array<{ isoDate: string; title?: string; body?: string }>,
): T[] {
  const occupied = new Set<string>();
  for (const e of existing) {
    const slot = detectHealthSlot(e.title, e.body);
    if (!slot) continue;
    occupied.add(`${e.isoDate}::${slot}`);
  }
  const out: T[] = [];
  for (const d of drafts) {
    const isoDate = (d.isoDate ?? '').trim();
    if (!isoDate) {
      out.push(d);
      continue;
    }
    const slot = detectHealthSlot(d.title, d.body);
    if (!slot) {
      out.push(d);
      continue;
    }
    const key = `${isoDate}::${slot}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    out.push(d);
  }
  return out;
}

/**
 * 「最近 N 天健康 advice 摘要」锚点块——拼进 prompt，告诉 LLM
 * 「最近一周你已经写过这几类内容，请换个角度，不要复读」。
 *
 * 抽取逻辑：
 *  - 入参为按 isoDate 倒序的最近若干天记录（store 已经倒序，调用方直接
 *    传 list 切片即可）；
 *  - 取最近 7 天有 advice 的记录；
 *  - 每条提取 (isoDate + 命中的 slot 集合 + title + body 前 40 字)；
 *  - 同时收集"过去一周已经覆盖过的 slot 集合"作为第二行——给 LLM 一个一目
 *    了然的避雷清单。
 *
 * 没有历史记录 → 返回空字符串，prompt 端会渲染「（无；这是 TA 第一次健康
 * 分析）」由调用方决定占位文本。
 */
export function buildHealthContinuityAnchorBlock(
  records: XingyeHealthDay[],
  options: { recentDays?: number } = {},
): string {
  const limit = Math.max(1, options.recentDays ?? 7);
  const recent = records.filter((r) => r.advice && r.advice.body.trim()).slice(0, limit);
  if (!recent.length) return '';

  const slotLabels: Record<HealthSlot, string> = {
    sleep: '睡眠',
    water: '喝水',
    exercise: '运动',
    steps: '步数',
    stress: '压力',
  };

  const coveredSlots = new Set<HealthSlot>();
  const lines: string[] = [];
  for (const day of recent) {
    if (!day.advice) continue;
    const hits = detectHealthSlots(day.advice.title, day.advice.body);
    for (const s of hits) coveredSlots.add(s);
    const slotPart = hits.size
      ? `[${[...hits].map((s) => slotLabels[s]).join(' / ')}]`
      : '[综合]';
    const opener = day.advice.body.replace(/\s+/g, ' ').slice(0, 40);
    lines.push(`  · ${day.isoDate} ${slotPart} ${day.advice.title}：${opener}…`);
  }

  const header = coveredSlots.size
    ? `- 最近 ${recent.length} 天 advice 已覆盖的话题槽：${[...coveredSlots].map((s) => slotLabels[s]).join('、')}（请换角度，不要复读同样的套话）`
    : `- 最近 ${recent.length} 天 advice 摘录（请换角度，不要复读）`;

  return [header, '- 最近 advice 摘录：', ...lines].join('\n');
}
