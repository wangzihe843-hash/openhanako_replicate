/**
 * 记账「批量生成」入库前的硬去重兜底。
 *
 * Pipeline 上下文（见 PhoneAccountingApp.runBulkGeneration）：
 *
 *   AI 返回 → distributeOccurredAtFallback（填日期空槽）
 *           → filterMonthlyDuplicates（月度类目按 (年-月) 唯一）
 *           → filterSameDayDuplicates（同天同质条目去重）
 *           → 落库
 *
 * Prompt 层已经把 monthlyCoverageBlock + recentTitlesBlock 喂给模型，让它**从源头
 * 避开**已记内容；本模块是入库前的最后兜底——模型仍可能忽视提示、或落到 prompt
 * 视野外的月份/日子，这里再过一遍才不会出现「一天两顿一模一样的午饭」这种事。
 *
 * 抽出来单独成模块的原因：纯函数、无 React 依赖、好单测。
 */

import type { LedgerEntry } from './xingye-accounting-ledger';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { isStrictMonthlyCategory, normalizeCategory } from './xingye-spending-categories';

/**
 * 一天三餐的固定 slot：早 / 午 / 晚。咖啡 / 下午茶 / 宵夜 / 零食不在此列
 * （独立频次，一天可以多次），所以不参与 slot 去重。
 */
export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner'] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

/**
 * 餐次关键词。在 title / content 任一里命中即归入对应 slot。
 *
 * 故意**不**写"早饭"对应"breakfast" 的英文 alias——agent 是中文角色，
 * imaginedAmount/title 都是中文。
 *
 * 注意「早午餐」brunch 的处理：单走 OR 表会被 lunch 的"午餐"先匹中，
 * 但现实里 brunch 一般是"晚起的人合并两餐"、本质替代早餐。我们在
 * detectMealSlot 里做特例前置，brunch / 早午餐 → breakfast。
 */
const MEAL_SLOT_PATTERNS: Record<MealSlot, RegExp> = {
  breakfast: /早饭|早餐|早点|早膳/,
  lunch: /午饭|午餐|午膳|中饭|中餐/,
  dinner: /晚饭|晚餐|晚膳/,
};

/** brunch 特例：早午餐 / brunch 归 breakfast（替代早餐，不是替代午餐）。 */
const BRUNCH_PATTERN = /早午餐|brunch/i;

/**
 * 从 title / content 里识别这是哪一餐。识别不出来 → null（咖啡 / 下午茶
 * / 宵夜 / 零食 / 水果都会落在这里，不参与 slot 去重）。
 *
 * 故意不读 category：分类大多写"餐饮"，区分不出来三餐；title 里通常会
 * 明示"午饭""巷口面摊午饭"。
 */
export function detectMealSlot(
  title: string | undefined,
  content: string | undefined,
): MealSlot | null {
  const text = `${title ?? ''}\n${content ?? ''}`;
  if (BRUNCH_PATTERN.test(text)) return 'breakfast';
  for (const slot of MEAL_SLOTS) {
    if (MEAL_SLOT_PATTERNS[slot].test(text)) return slot;
  }
  return null;
}

function ymOf(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ymdOf(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return (
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-`
    + `${String(d.getDate()).padStart(2, '0')}`
  );
}

/**
 * 「严格月度类目（房租 / 水电 / 通讯 / 保险 / 工资 …）一个月最多 1 条」的硬过滤。
 *
 *  - drafts：已经过 distributeOccurredAtFallback 兜底、保证有 occurredAt 的新草稿
 *  - existingEntries：当前账本里已实现的 entries（只看 source='accounting'，
 *    不看购物/二手投影——后者按 itemName 自然不会和"房租"类目冲突）
 *
 * 同时也对本批内部去重（模型一次返回 2 笔同月房租时，第二条被丢）。
 */
export function filterMonthlyDuplicates<T extends { category?: string; occurredAt?: string }>(
  drafts: T[],
  existingEntries: LedgerEntry[],
): T[] {
  const occupied = new Set<string>();
  for (const e of existingEntries) {
    if (e.source !== 'accounting') continue;
    const cat = normalizeCategory(e.category);
    if (!cat || !isStrictMonthlyCategory(cat)) continue;
    const ym = ymOf(e.occurredAt);
    if (!ym) continue;
    occupied.add(`${ym}::${cat}`);
  }
  const out: T[] = [];
  for (const d of drafts) {
    const cat = normalizeCategory(d.category);
    if (cat && isStrictMonthlyCategory(cat)) {
      const ym = ymOf(d.occurredAt);
      if (ym) {
        const key = `${ym}::${cat}`;
        if (occupied.has(key)) continue;
        occupied.add(key);
      }
    }
    out.push(d);
  }
  return out;
}

/**
 * 「同一天的同质条目」硬去重。
 *
 * 解决的具体场景：用户反复点「批量新增」，AI 在两次独立调用里各自生成了
 * `"巷口面摊午饭 / 餐饮 / ¥18 / 巷口面摊"`——同标题同金额，等于一天吃两顿
 * 一模一样的午饭，明显是重复。
 *
 * 比 filterMonthlyDuplicates 宽松（不是按类目周期硬限），但比"完全不去重"
 * 严格——一天能吃三顿饭、坐两次车，所以只在以下任一特征命中时才视为重复：
 *
 *   1. **同 YYYY-MM-DD + 同 title**（完全字符相等，去首尾空白）：
 *      "巷口面摊午饭" === "巷口面摊午饭" → 重复。
 *      "巷口面摊午饭" vs "巷口面摊晚饭" → 不算（title 不同）。
 *
 *   2. **同 YYYY-MM-DD + 同 normalized category + 同 counterparty + 同 amount**：
 *      "餐饮 + 巷口面摊 + ¥18 + 5/27" 出现两次 → 重复。
 *      这套四元组同时撞车的概率极低，撞了基本就是 AI 二次生成。
 *
 *   counterparty 缺 → 走 title 维度；title 缺 → 走四元组维度；
 *   两个都缺（极罕见）→ 该 draft 不参与去重（直接放过，源数据太薄不好判断）。
 *
 * 同样对本批内部去重（AI 一次返回多条相同条目时也能挡掉，第二条会被丢）。
 *
 * 类型约束：amount 允许 number | null（已实现的 ledger 行偶尔会有 null amount——
 * 购物/二手投影只写了氛围价格文本时；那些行不参与 four-tuple 维度判断，
 * 但仍可在 title 维度上参与判断）。
 */
export function filterSameDayDuplicates<T extends {
  title?: string;
  category?: string;
  counterparty?: string;
  amount: number;
  occurredAt?: string;
}>(
  drafts: T[],
  existingEntries: LedgerEntry[],
): T[] {
  const occupied = new Set<string>();
  const keysOf = (
    ymd: string,
    title: string | undefined,
    category: string | undefined,
    counterparty: string | undefined,
    amount: number | null,
  ): string[] => {
    const keys: string[] = [];
    const cleanTitle = (title ?? '').trim();
    if (cleanTitle) keys.push(`${ymd}::T::${cleanTitle}`);
    const cat = normalizeCategory(category) ?? '';
    const cp = (counterparty ?? '').trim();
    if (cat && cp && amount !== null) {
      keys.push(`${ymd}::Q::${cat}::${cp}::${amount}`);
    }
    return keys;
  };

  for (const e of existingEntries) {
    if (e.source !== 'accounting') continue;
    const ymd = ymdOf(e.occurredAt);
    if (!ymd) continue;
    for (const k of keysOf(ymd, e.title, e.category, e.counterparty, e.amount)) {
      occupied.add(k);
    }
  }
  const out: T[] = [];
  for (const d of drafts) {
    const ymd = ymdOf(d.occurredAt);
    if (!ymd) {
      out.push(d);
      continue;
    }
    const keys = keysOf(ymd, d.title, d.category, d.counterparty, d.amount);
    if (keys.length === 0) {
      out.push(d);
      continue;
    }
    if (keys.some((k) => occupied.has(k))) continue;
    for (const k of keys) occupied.add(k);
    out.push(d);
  }
  return out;
}

/**
 * 「一天最多一顿早饭 / 午饭 / 晚饭」的硬过滤。
 *
 * 与 filterSameDayDuplicates 是互补关系——后者按 title 字符串 / 四元组判重复，
 * 但挡不住"巷口面摊午饭 ¥18" + "卤肉饭午饭 ¥22" 这种**不同 title / 不同金额、
 * 本质都是同一餐**的情况。
 *
 * 检测逻辑：通过 detectMealSlot 在 title + content/note 文本里找早 / 午 / 晚
 * 餐关键词，命中的归入对应 slot；一天一个 slot 最多保留 1 条。
 *
 * 不参与 slot 去重的（独立频次、一天多次都合理）：
 *   - 咖啡 / 奶茶 / 饮料 / 下午茶 / 宵夜 / 零食 / 水果
 *   - 加餐 / 点心 / 甜品
 *   - 早咖啡 + 中咖啡 + 晚咖啡 → 都不在三餐 slot 内
 *
 * 这意味着"巷口面摊午饭"和"咖啡店自习"可以同一天共存（前者算 lunch、
 * 后者无 slot），但"卤肉饭午饭"会被"巷口面摊午饭"挡掉。
 */
export function filterSameDayMealSlotDuplicates<T extends {
  title?: string;
  content?: string;
  occurredAt?: string;
}>(
  drafts: T[],
  existingEntries: LedgerEntry[],
): T[] {
  const occupied = new Set<string>();
  for (const e of existingEntries) {
    if (e.source !== 'accounting') continue;
    const ymd = ymdOf(e.occurredAt);
    if (!ymd) continue;
    const slot = detectMealSlot(e.title, e.note);
    if (!slot) continue;
    occupied.add(`${ymd}::${slot}`);
  }
  const out: T[] = [];
  for (const d of drafts) {
    const ymd = ymdOf(d.occurredAt);
    if (!ymd) {
      out.push(d);
      continue;
    }
    const slot = detectMealSlot(d.title, d.content);
    if (!slot) {
      out.push(d);
      continue;
    }
    const key = `${ymd}::${slot}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    out.push(d);
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
   通勤 slot 去重：一天最多 1 次「去上班」+ 1 次「下班回家」
─────────────────────────────────────────────────────────────────────────── */

/**
 * 通勤 slot：去班 / 回家 各一次。
 *
 * 真实生活里大部分人一天只有两次通勤——早出晚归。AI 在反复批量生成时
 * 偶尔会塞「打车去上班 ¥35」+「骑共享单车去上班 ¥3」+「坐地铁去上班 ¥6」
 * 同一天里多种交通方式都"去上班"，明显是 LLM 没意识到自己已经写过一条
 * 通勤了。本 slot 把"去班 / 回家"各算一种独占资源，一天最多各 1 条。
 */
export const COMMUTE_SLOTS = ['to_work', 'from_work'] as const;
export type CommuteSlot = (typeof COMMUTE_SLOTS)[number];

/**
 * 去班 / 回家关键词。
 *
 * to_work = 朝向工作 / 学校 / 办公场所：去班、上班路上、通勤上班、赶班、
 *   早高峰、上学、去公司、去办公室、去工作室、去单位、赶早班。
 * from_work = 离开工作回家：下班、放学、收工、下班回家、回家路上、
 *   赶末班车回家、下班后。
 *
 * 注意陷阱词：
 *   - "回家"单独不够 → 可能是从朋友家 / 商场 / 旅行回来；要和「下班 / 放学 / 收工」
 *     上下文一起出现才算 from_work。这里用稍严的"下班回家 / 放学回家 / 收工回家 / 下班后回家"。
 *     但用户场景里更常见的就是"打车下班"、"地铁下班"，把"下班 / 放学 / 收工"独立
 *     作为充分条件已经能覆盖九成。
 *   - "上班" / "下班"已经足够强信号，不需要再要求"打车 / 地铁"陪绑。
 */
const COMMUTE_SLOT_PATTERNS: Record<CommuteSlot, RegExp> = {
  to_work: /上班|上学|去公司|去办公室|去工作室|去单位|去学校|赶早班|早高峰|通勤上班|去上班/,
  from_work: /下班|放学|收工|下班回家|放学回家|收工回家|下班后|晚高峰回家/,
};

/**
 * 从 title / content 里识别这是通勤的哪一段。识别不出来 → null。
 *
 * 故意不读 category——"交通"包含"上班通勤 + 出差 + 周末出游 + 接送朋友"
 * 多种用途，category 区分不出来；title / content 里通常会明示"打车去上班"。
 *
 * 如果一段文本同时命中 to_work 和 from_work（罕见：「下班后又赶回公司」），
 * 优先 to_work——多数情况是描述去班场景但顺带提了下班时间。
 */
export function detectCommuteSlot(
  title: string | undefined,
  content: string | undefined,
): CommuteSlot | null {
  const text = `${title ?? ''}\n${content ?? ''}`;
  if (COMMUTE_SLOT_PATTERNS.to_work.test(text)) return 'to_work';
  if (COMMUTE_SLOT_PATTERNS.from_work.test(text)) return 'from_work';
  return null;
}

/**
 * 兼职 / 多份工作关键词。命中任意 → 视为"一天可能多次通勤"，跳过通勤 slot 去重。
 *
 * 覆盖三类情形：
 *  1. 明示"兼职 / 副业 / 第二份工作"；
 *  2. 职业本身就是高频通勤——外卖员 / 配送员 / 快递员 / 网约车司机 /
 *     代驾 / 跑腿 / 走穴 / 接送等；
 *  3. 班制模式——倒班 / 三班倒 / 轮班 / 走班 / 串班。
 *
 * 用 profile 的所有文本字段 join 一起一次 regex 扫；命中即 true。
 * 找不到 profile → false（默认走单班制，启用通勤 slot 去重）。
 */
const MULTIPLE_JOBS_PATTERN = new RegExp(
  [
    '兼职', '副业', '第二份工作', '两份工', '多份工作', '打两份工',
    '外卖员', '送外卖', '配送员', '快递员', '送餐', '跑外卖', '跑单',
    '网约车', '滴滴司机', '出租车司机', '代驾', '跑腿', '骑手',
    '走穴', '赶场', '巡演',
    '倒班', '三班倒', '两班倒', '轮班', '走班', '串班', '上几个班',
    '日结', '小时工', '零工',
  ].join('|'),
);

export function hasMultipleJobsByProfile(
  profile: XingyeRoleProfile | null | undefined,
): boolean {
  if (!profile) return false;
  const text = [
    profile.shortBio,
    profile.identitySummary,
    profile.backgroundSummary,
    profile.personalitySummary,
    profile.behaviorLogic,
    profile.values,
    profile.taboos,
    profile.relationshipMode,
    profile.relationshipLabel,
    profile.speakingStyle,
  ]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('\n');
  if (!text) return false;
  return MULTIPLE_JOBS_PATTERN.test(text);
}

/**
 * 「一天最多 1 次去上班 + 1 次下班」的硬过滤。
 *
 * 与 filterSameDayMealSlotDuplicates 同思路——按"日内独占 slot"算重复，
 * 但用通勤而不是三餐。
 *
 * 解决场景：AI 反复批量生成时塞「打车去上班 ¥35」+「骑共享单车去上班 ¥3」+
 * 「地铁去上班 ¥6」同一天三条都"去上班"——只保留第一条 to_work，
 * 后两条丢。同理 from_work。
 *
 * 例外开关：`skipDedupe = true` 时直接返回原数组不去重，调用方用
 * hasMultipleJobsByProfile 判断 agent 是否有兼职 / 倒班 / 跑单——
 * 这些情况下一天多次通勤是合理的。
 */
export function filterSameDayCommuteSlotDuplicates<T extends {
  title?: string;
  content?: string;
  occurredAt?: string;
}>(
  drafts: T[],
  existingEntries: LedgerEntry[],
  options?: { skipDedupe?: boolean },
): T[] {
  if (options?.skipDedupe) return drafts;
  const occupied = new Set<string>();
  for (const e of existingEntries) {
    if (e.source !== 'accounting') continue;
    const ymd = ymdOf(e.occurredAt);
    if (!ymd) continue;
    const slot = detectCommuteSlot(e.title, e.note);
    if (!slot) continue;
    occupied.add(`${ymd}::${slot}`);
  }
  const out: T[] = [];
  for (const d of drafts) {
    const ymd = ymdOf(d.occurredAt);
    if (!ymd) {
      out.push(d);
      continue;
    }
    const slot = detectCommuteSlot(d.title, d.content);
    if (!slot) {
      out.push(d);
      continue;
    }
    const key = `${ymd}::${slot}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    out.push(d);
  }
  return out;
}
