/**
 * 购物 / 二手「批量生成」入库前的硬去重兜底（两模块共用——它们是镜像孪生）。
 *
 * 与 prompt 层的 `buildShopping/SecondhandRecentItemsBlock`（喂近期 itemName 让模型从源头避重）
 * 互补：本模块是最后一道兜底，模型忽视锚点时再过一遍。三条规则：
 *
 *  1. **变体折叠**：按"核心品类"判重，不按整名精确匹配——「黑色台灯」「白色台灯」都折成「台灯」算同一件。
 *     正常人不会反复买同一品类的不同变体（不同颜色/材质/尺寸的台灯）。
 *  2. **收藏豁免**：除非 lore 提到 TA 有收集癖好（如藏红酒、集手办）——命中收藏关键词的物件
 *     允许同品类多件并存（收藏家就是会攒不同款）。
 *  3. **消耗品按时间窗豁免**（仅购物）：日用 / 食饮 / 药品这类会反复买，但也不该一周买三管牙膏——
 *     只在 `consumableWindowDays`（默认 30 天）窗口内判重；超窗口的同品类消耗品允许再次购买。
 *
 * 二手不享受消耗品豁免（一件闲置只挂 / 卖一次），但同样折叠变体、同样尊重收藏豁免。
 * 纯函数、无 React / fs 依赖，好单测。
 */

import { normalizeCategory } from './xingye-spending-categories';

/**
 * itemName 归一化（去重比较用）：trim → 全角标点转半角 → 删空白与常见包裹/标点 → 英文小写。
 */
export function normalizeItemNameForDedup(name: string): string {
  if (typeof name !== 'string') return '';
  let s = name.trim();
  if (!s) return '';
  s = s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\s+/g, '');
  s = s.replace(/[，。、；：！？,.;:!?"'""''（）()【】[\]《》「」『』~·・—\-…]/g, '');
  s = s.toLowerCase();
  return s;
}

/**
 * 变体修饰词（颜色 / 尺寸 / 材质 / 风格）。只从**词首**反复剥离，剩下的是核心品类词。
 * 只剥前缀是有意的——中文里这些修饰词几乎总在前（黑色台灯 / 实木书架 / 大号背包），
 * 从词中乱删会误伤（"咖啡机"里的"咖啡"不是颜色）。按长度降序匹配，先剥「黑色」再剥「黑」。
 */
const VARIANT_MODIFIER_PREFIXES: readonly string[] = [
  // 颜色（双字优先）
  '黑色', '白色', '红色', '橙色', '黄色', '绿色', '蓝色', '紫色', '粉色', '灰色', '棕色',
  '金色', '银色', '米色', '深色', '浅色', '彩色', '藏青', '墨绿', '天蓝', '奶白', '酒红', '透明',
  '黑', '白', '红', '橙', '黄', '绿', '蓝', '紫', '粉', '灰', '棕',
  // 尺寸
  '大号', '中号', '小号', '迷你', '超大', '加大', '加长', '便携式', '便携', '标准', '均码',
  // 材质
  '实木', '原木', '木质', '不锈钢', '金属', '塑料', '玻璃', '陶瓷', '真皮', '人造革', '布艺',
  '帆布', '亚麻', '羊毛', '硅胶',
  // 风格 / 通用形容
  '新款', '复古', '经典', '简约', '北欧', '日式', '韩版', '网红', '限量', '基础款', '加厚', '轻薄',
].slice().sort((a, b) => b.length - a.length);

/**
 * 提取核心品类：归一后反复剥掉词首的变体修饰词。剥到只剩 ≤1 字或剥空就停（保底返回归一全名）。
 * 例：「黑色台灯」「白色台灯」→「台灯」；「实木书架」→「书架」；「咖啡机」→「咖啡机」（无前缀修饰）。
 */
export function extractItemCoreType(name: string): string {
  let s = normalizeItemNameForDedup(name);
  if (!s) return '';
  let changed = true;
  while (changed && s.length > 2) {
    changed = false;
    for (const tok of VARIANT_MODIFIER_PREFIXES) {
      if (s.length > tok.length && s.startsWith(tok)) {
        s = s.slice(tok.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

/** 会反复购买的消耗品桶（仅购物用）。 */
export const REPURCHASABLE_CONSUMABLE_BUCKETS: ReadonlySet<string> = new Set([
  '日用', '餐饮', '咖啡', '零食', '酒水', '药品',
]);

const CONSUMABLE_TAG_PATTERN = /日用|消耗|耗材|食|饮|零食|药/;

/** category 命中消耗品桶，或任一 tag 命中消耗品关键词 → 视为可反复购买的消耗品。 */
export function isRepurchasableConsumable(
  category: string | null | undefined,
  tags: readonly string[] | null | undefined,
): boolean {
  const cat = normalizeCategory(category);
  if (cat && REPURCHASABLE_CONSUMABLE_BUCKETS.has(cat)) return true;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (typeof t === 'string' && CONSUMABLE_TAG_PATTERN.test(t)) return true;
    }
  }
  return false;
}

/**
 * 从 profile / lore 文本里抽取「收藏癖好」关键词（启发式，宁缺毋滥）。
 * 命中如「收集老相机」「红酒收藏家」「集邮」「手办控」→ 返回 ['老相机','红酒','邮','手办'] 这类核心词。
 * 抽不出来 → []（即不开收藏豁免，退回正常变体折叠）。
 */
export function extractCollectionKeywords(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const k = normalizeItemNameForDedup(raw);
    if (!k || k.length < 2 || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  // 抽到的名词常带个形容词前缀（「资深红酒」「老相机」），再补一个去前缀的尾 2 字（「红酒」「相机」），
  // 让按 includes 匹配物件时更稳。
  const consider = (noun: string | undefined) => {
    push(noun);
    if (noun && noun.length > 2) push(noun.slice(-2));
  };
  // 「收集/收藏/珍藏/集藏/囤 + 名词」
  const after = /(?:收集|收藏|珍藏|集藏|囤)[了的过着]?([一-龥]{2,5})/g;
  // 「名词 + 收藏家/收藏者/发烧友/爱好者/控/迷」（不含裸「藏家」——它会让贪婪捕获多吞一个「收」字）
  const before = /([一-龥]{2,5})(?:收藏家|收藏者|发烧友|爱好者|控|迷)/g;
  for (const m of text.matchAll(after)) consider(m[1]);
  for (const m of text.matchAll(before)) consider(m[1]);
  return out.slice(0, 8);
}

/** 物件名是否属于某个收藏品类（名字包含任一收藏关键词）。 */
export function itemMatchesCollection(name: string, collectionKeywords: readonly string[]): boolean {
  if (!collectionKeywords.length) return false;
  const n = normalizeItemNameForDedup(name);
  if (!n) return false;
  return collectionKeywords.some((k) => k && n.includes(k));
}

/** 收藏关键词抽取的 profile 取字段最小形状（结构化、不绑死 XingyeRoleProfile）。 */
export type CollectionKeywordProfile = {
  displayName?: string | null;
  shortBio?: string | null;
  identitySummary?: string | null;
  backgroundSummary?: string | null;
  personalitySummary?: string | null;
  relationshipLabel?: string | null;
  values?: string | null;
  taboos?: string | null;
  relationshipMode?: string | null;
  behaviorLogic?: string | null;
};

/**
 * 收藏关键词的 profile 取字段**单一来源**：prompt 反锚点（buildShopping/SecondhandRecentItemsBlock）
 * 与入库前硬去重（dedupeItemDrafts 的 collectionKeywords）必须喂**同一组字段**，否则收藏豁免口径漂移，
 * 出现「prompt 劝模型别重复 ↔ 兜底却放行」打架。收藏癖好可能写在 behaviorLogic 也可能写在 taboos，
 * 故并集全部画像字段。
 */
export function collectionKeywordSourceText(profile: CollectionKeywordProfile | null | undefined): string {
  if (!profile) return '';
  return [
    profile.shortBio,
    profile.identitySummary,
    profile.backgroundSummary,
    profile.personalitySummary,
    profile.values,
    profile.behaviorLogic,
    profile.taboos,
    profile.relationshipLabel,
    profile.relationshipMode,
    profile.displayName,
  ]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join('\n');
}

export type ItemDedupEntry = {
  itemName: string;
  category?: string;
  tags?: string[];
  /** 发生时间 ISO（草稿用 occurredAt；已有 entry 用 metadata.occurredAt ?? createdAt）。 */
  occurredAt?: string;
};

const DAY_MS = 86_400_000;

function dateMsOf(iso: string | undefined, fallbackMs: number): number {
  if (!iso) return fallbackMs;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallbackMs;
}

/**
 * 过滤掉与已有条目（或本批更早草稿）重复的草稿。
 *
 * @param drafts    本批草稿（按原顺序处理，保留先到的）。
 * @param existing  已有 entries（带 category/tags/occurredAt，用于消耗品/收藏/窗口判定）。
 * @param options
 *   - exemptConsumables：true（购物）启用消耗品时间窗豁免；false（二手）所有非收藏品按核心品类一律去重。
 *   - collectionKeywords：lore 抽出的收藏关键词；命中的物件永远保留（收藏家会攒不同款）。
 *   - consumableWindowDays：消耗品判重窗口，默认 30 天。
 *   - nowMs：缺日期时的兜底参考时间，默认 Date.now()。
 * @returns kept = 保留；dropped = 判为重复丢弃（供调用方计数提示）。
 *
 * 判重键 = `extractItemCoreType(itemName)`（变体折叠）。去重作用于「草稿 vs 已有」和「草稿 vs 本批更早草稿」。
 */
export function dedupeItemDrafts<T extends ItemDedupEntry>(
  drafts: T[],
  existing: ReadonlyArray<ItemDedupEntry>,
  options?: {
    exemptConsumables?: boolean;
    collectionKeywords?: readonly string[];
    consumableWindowDays?: number;
    nowMs?: number;
  },
): { kept: T[]; dropped: T[] } {
  const exemptConsumables = options?.exemptConsumables ?? false;
  const collectionKeywords = (options?.collectionKeywords ?? [])
    .map((k) => normalizeItemNameForDedup(k))
    .filter(Boolean);
  const windowMs = Math.max(0, options?.consumableWindowDays ?? 30) * DAY_MS;
  const nowMs = options?.nowMs ?? Date.now();

  const durableSeen = new Set<string>(); // 非消耗品核心品类（全历史唯一）
  const consumableDates = new Map<string, number[]>(); // 消耗品核心 → 各次购买时间

  // 「核心品类按消耗品还是耐用品处理」必须对同一 core **全局一致**：否则同一件东西（如牙膏）
  // 被 LLM 在不同条目分别标成「日用(消耗)」与「美容(耐用)」时，会落进 consumableDates / durableSeen
  // 两张互不可见的表，真重复反而漏过。故先扫一遍 existing + drafts，只要某 core 出现过任一消耗品
  // 归类，就把整个 core 都按消耗品时间窗处理（耐用归类的那次也并入窗口播种）。
  const consumableCores = new Set<string>();
  if (exemptConsumables) {
    for (const e of [...existing, ...drafts]) {
      if (itemMatchesCollection(e.itemName, collectionKeywords)) continue;
      if (!isRepurchasableConsumable(e.category, e.tags)) continue;
      const core = extractItemCoreType(e.itemName);
      if (core) consumableCores.add(core);
    }
  }
  const coreIsConsumable = (core: string) => consumableCores.has(core);

  // 先用已有条目播种判重表（收藏品不占槽位）。
  for (const e of existing) {
    if (itemMatchesCollection(e.itemName, collectionKeywords)) continue;
    const core = extractItemCoreType(e.itemName);
    if (!core) continue;
    if (coreIsConsumable(core)) {
      const arr = consumableDates.get(core) ?? [];
      arr.push(dateMsOf(e.occurredAt, nowMs));
      consumableDates.set(core, arr);
    } else {
      durableSeen.add(core);
    }
  }

  const kept: T[] = [];
  const dropped: T[] = [];
  for (const d of drafts) {
    if (itemMatchesCollection(d.itemName, collectionKeywords)) {
      kept.push(d); // 收藏品永远保留，也不占槽位
      continue;
    }
    const core = extractItemCoreType(d.itemName);
    if (!core) {
      kept.push(d);
      continue;
    }
    if (coreIsConsumable(core)) {
      const dm = dateMsOf(d.occurredAt, nowMs);
      const arr = consumableDates.get(core) ?? [];
      if (arr.some((prev) => Math.abs(dm - prev) <= windowMs)) {
        dropped.push(d); // 窗口内同品类消耗品已买过
        continue;
      }
      arr.push(dm);
      consumableDates.set(core, arr);
      kept.push(d);
    } else {
      if (durableSeen.has(core)) {
        dropped.push(d);
        continue;
      }
      durableSeen.add(core);
      kept.push(d);
    }
  }
  return { kept, dropped };
}
