import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import { parseImaginedPriceToMoney } from './xingye-money';
import { parseChineseTimeHint } from './xingye-app-history-state';
import {
  buildShoppingDraftPrompt,
  buildShoppingPolishPrompt,
  SHOPPING_AI_PLATFORM_STYLES,
  SHOPPING_AI_STATUSES,
} from './xingye-shopping-prompts';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { listAppEntries } from './xingye-app-entry-store';
import { listAppReviews, reviewSentimentFromStars } from './xingye-app-review-store';
import {
  collectionKeywordSourceText,
  extractCollectionKeywords,
  extractItemCoreType,
  isRepurchasableConsumable,
  itemMatchesCollection,
} from './xingye-item-dedupe';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import {
  buildXingyeRecentChatExcerpts,
  formatXingyeRecentChatExcerptsForPrompt,
  resolveXingyeSpeakerUserName,
} from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { postXingyeStorage } from './xingye-storage-api';

export type XingyeShoppingAiStatus = (typeof SHOPPING_AI_STATUSES)[number];
export type XingyeShoppingAiPlatformStyle = (typeof SHOPPING_AI_PLATFORM_STYLES)[number];

export type XingyeShoppingAiDraft = {
  itemName: string;
  status: XingyeShoppingAiStatus;
  platformStyle: XingyeShoppingAiPlatformStyle;
  category?: string;
  imaginedPrice?: string;
  /**
   * 价格 delta 短语（"比想象便宜 220" / "凑得起" / "比预算高 60"），不带货币符号。
   * 见 xingye-shopping-prompts.ts 的 schema 说明。
   */
  delta?: string;
  /**
   * 卖家 / 店名（"光阴二手店" / "街口那家成衣"）。虚构小店口吻；非真实电商平台。
   */
  seller?: string;
  /**
   * 由 imaginedPrice 本地解析出的数值金额（见 parseImaginedPriceToMoney）。
   * LLM 只产 imaginedPrice 氛围文本，amount / currency 在 normalize 阶段本地确定性提取，
   * 让记账模块按币种求和无需回头再做映射。「约一杯奶茶钱」等 fallback 写法解析不出来 → undefined。
   */
  amount?: number;
  /** amount 配对的货币单位（¥ / $ / 两银子 / 金币 / 信用点 …）。 */
  currency?: string;
  reason?: string;
  tags?: string[];
  content: string;
  /** 历史批量模式才会回填：「N 天前」/「昨天」等自然语言时间感。 */
  occurredAtHint?: string;
  /** 由 occurredAtHint 解析得到的 ISO；不可解析时为 undefined。 */
  occurredAt?: string;
};

export type ShoppingHistoryMode = {
  kind: 'initial' | 'recent' | 'gap_fill';
  dayRangeHint: string;
  startDays: number;
  endDays: number;
};

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

async function readLoreMemoryMarkdown(agentId: string): Promise<string | null> {
  const aid = agentId.trim();
  if (!aid) return null;
  try {
    const data = (await postXingyeStorage({
      action: 'read',
      agentId: aid,
      relativePath: 'lore-memory.md',
      binary: false,
    })) as { missing?: boolean; content?: unknown };
    if (data?.missing || typeof data?.content !== 'string') return null;
    let text = data.content.trim();
    text = text.replace(/^<!--[\s\S]*?-->\s*/m, '').trim();
    return text || null;
  } catch {
    return null;
  }
}

function buildStableLoreFromAlwaysEntries(agentId: string, maxChars: number): string {
  try {
    const storage = getXingyePersistenceStorage();
    const entries = listLoreEntries(agentId, storage).filter(
      (e) => e.enabled && e.visibility === 'canonical' && e.insertionMode === 'always',
    );
    if (!entries.length) return '';
    const lines: string[] = [];
    let used = 0;
    for (const e of entries) {
      const label = XINGYE_LORE_CATEGORY_LABELS[e.category] ?? e.category;
      const block = `- 《${e.title}》（${label}）\n${e.content.trim()}`;
      if (used + block.length > maxChars && lines.length > 0) break;
      lines.push(block);
      used += block.length + 2;
      if (used >= maxChars) break;
    }
    return lines.join('\n\n');
  } catch {
    return '';
  }
}

async function buildStableLoreBlock(agentId: string): Promise<string> {
  const fromFile = await readLoreMemoryMarkdown(agentId);
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 3200);
  return buildStableLoreFromAlwaysEntries(agentId, 2800).trim();
}

/**
 * 读取当前 agent 已有的购物 entries，提取里面用过的 imaginedPrice / seller 样本，
 * 作为「货币 / 卖家锚点」喂回 prompt。让模型在仙侠 / 废土 / 未来这类世界观货币
 * 没有 lore 显式定义时**沿用历史已用过的单位**——避免今天写"灵石"明天写"金锭"。
 *
 * 三层兜底关系（prompt 端会严格执行）：
 *   1. lore 里显式定义的货币（用户在设定库里写过的）→ 绝对优先
 *   2. 本函数返回的历史锚点 → 已有 entries 用过什么单位就接着用
 *   3. 都没有 → 这是 TA 第一次写购物清单，按 prompt 指南候选集挑一个
 *
 * 采样策略：
 *   - listAppEntries 默认按 updatedAt 倒序；取前若干条
 *   - imaginedPrice 去重保留前 6 个、seller 去重保留前 4 个（频次隐式靠"最近优先"）
 *   - 完全没有 → 返回 ''；prompt 端会显示「（无；这是 TA 第一次写）」
 *
 * 失败（agentId 非法 / 读盘错）→ 返回 ''，generation 主流程不受影响。
 */
async function buildShoppingCurrencyAnchorBlock(agentId: string): Promise<string> {
  try {
    const rows = await listAppEntries(agentId, 'shopping');
    if (!rows.length) return '';
    const priceSamples: string[] = [];
    const sellerSamples: string[] = [];
    const priceSeen = new Set<string>();
    const sellerSeen = new Set<string>();
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const price = typeof meta.imaginedPrice === 'string' ? meta.imaginedPrice.trim() : '';
      const seller = typeof meta.seller === 'string' ? meta.seller.trim() : '';
      if (price && !priceSeen.has(price) && priceSamples.length < 6) {
        priceSeen.add(price);
        priceSamples.push(price);
      }
      if (seller && !sellerSeen.has(seller) && sellerSamples.length < 4) {
        sellerSeen.add(seller);
        sellerSamples.push(seller);
      }
      if (priceSamples.length >= 6 && sellerSamples.length >= 4) break;
    }
    if (!priceSamples.length && !sellerSamples.length) return '';
    const lines: string[] = [];
    if (priceSamples.length) {
      lines.push(`- 价格表达样本：${priceSamples.map((p) => `「${p}」`).join('、')}`);
    }
    if (sellerSamples.length) {
      lines.push(`- 卖家口吻样本：${sellerSamples.map((s) => `「${s}」`).join('、')}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** 「不要重复」名单取样上限：扁平去重列表，最近优先（按核心品类去重后最多喂这么多个不同品类）。 */
const SHOPPING_RECENT_ITEMS_LIMIT = 200;
/** 「周期补货」名单取样上限：到补货周期的消耗品最多喂这么多个（带卖家 + 评价，单条更贵，收紧些）。 */
const SHOPPING_PERIODIC_ITEMS_LIMIT = 40;
/**
 * 消耗品周期去重窗口。同一核心品类**最近一次**购买距今：
 *  - 在窗口内（默认 30 天）→ 仍按「不要重复」suppress（刚补过货、别又买，保留周期去重防模型反复买）；
 *  - 超过窗口             → 进入「周期补货」块（到点了、可再次购买，且按上次评价挑卖家）。
 * 与入库前 `dedupeItemDrafts` 的同名 30 天窗口对齐，避免「prompt 劝再买 ↔ 兜底却丢弃」打架。
 */
const SHOPPING_CONSUMABLE_WINDOW_DAYS = 30;

/**
 * 退货商品「这次从别家再买类似的」的默认中签概率。
 * 消耗品更高（退了还是会需要、马上换一家补上）；耐用品更低（退货后更可能就此作罢，不再折腾）。
 * 真随机用 Math.random（见 partition 的 rng 入参默认值），单测可注入确定性 rng。
 */
const REBUY_AFTER_RETURN_PROB_CONSUMABLE = 0.7;
const REBUY_AFTER_RETURN_PROB_DURABLE = 0.3;

/** 「退货重买」名单取样上限：退货品较少见，给个够用的小上限即可。 */
const SHOPPING_RETURNED_REBUY_LIMIT = 12;

/** 「周期补货」块里「上次评价」的中文标签。 */
const PERIODIC_REVIEW_NOTE_LABEL: Record<'good' | 'neutral' | 'bad', string> = {
  good: '好评',
  neutral: '中评',
  bad: '差评',
};

export type ShoppingPeriodicRestockItem = {
  /** 展示用商品名（已截断）。 */
  name: string;
  /** 上次卖家口吻；空字符串表示没记。 */
  seller: string;
  /** 上次评价归纳：好评 / 中评 / 差评 / 未评价（退货品已被分流到「退货重买」桶，不再出现在这里）。 */
  reviewNote: string;
};

export type ShoppingReturnedRebuyItem = {
  /** 展示用商品名（已截断）。 */
  name: string;
  /** 上次（退货那家）卖家口吻；空字符串表示没记。供 prompt 让模型避开这家。 */
  seller: string;
  /** 该品类是否消耗品（仅供排序 / 单测断言，prompt 不强依赖）。 */
  consumable: boolean;
};

export type ShoppingRecentPartition = {
  /** 「不要重复」名单：耐用品 + 仍在补货窗口内的消耗品 + 未中签的退货品。扁平 itemName。 */
  avoidNames: string[];
  /** 「周期补货」名单：到补货周期（超窗口）的消耗品，带上次卖家 + 上次评价。 */
  periodicItems: ShoppingPeriodicRestockItem[];
  /**
   * 「退货重买」名单：上次退货、这一轮中签「可以从别家再买类似的」的商品（消耗品 + 耐用品都可能），
   * 带上次退货那家卖家供模型避开。中签概率消耗品 > 耐用品（见 REBUY_AFTER_RETURN_PROB_*）。
   */
  returnedRebuyItems: ShoppingReturnedRebuyItem[];
};

type ShoppingRecentRow = {
  id: string;
  title: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

/**
 * 纯函数：把近期购物 entries 分成「不要重复」「周期补货」「退货重买」三桶（按核心品类去重，最近优先）。
 *
 *  - 收藏品（命中 collectionKeywords）：三桶都不进——TA 会继续攒不同款，既不算重复也不算补货。
 *  - 退货品（status='returned'）：**优先于补货窗口判定**——退货 ≠「用完补货」，是「这家不合意、可能换家再试」。
 *    掷骰子（消耗品概率 > 耐用品，见 REBUY_AFTER_RETURN_PROB_*）：
 *      · 中签 → 落「退货重买」（带上次退货那家卖家，供 prompt 让模型换一家买类似的）；
 *      · 未中签 → 落「不要重复」（这一轮先不重买）。
 *  - 消耗品（isRepurchasableConsumable，非退货）：看**最近一次**购买距今多久——
 *      · 窗口内（默认 30 天）→ 落「不要重复」（刚补过货、暂时别再买，保留周期去重防模型反复买）；
 *      · 超窗口            → 落「周期补货」（到点了、可再次购买；带上次卖家 + 上次评价供挑卖家）。
 *  - 其余耐用品（非退货）：落「不要重复」（同核心品类只记一次）。
 *
 * periodic reviewNote 取最近一次购买那条 entry 的评价：命中评价档位 → 好/中/差评；否则未评价。
 * 退货品已在上一档分流走，不会进 periodic（故 reviewNote 不再有「已退货」）。
 * 纯函数、唯一外部依赖是 rng（默认 Math.random，单测可注入），便于单测分桶 + 概率门。
 */
export function partitionShoppingRecentItems(params: {
  rows: ReadonlyArray<ShoppingRecentRow>;
  /** entryId → 该条 agent(买家) 侧评价档位（仅"作出过评价"的 entry 在表里）。 */
  reviewSentimentByEntryId?: ReadonlyMap<string, 'good' | 'neutral' | 'bad'>;
  collectionKeywords?: readonly string[];
  nowMs: number;
  windowDays?: number;
  avoidLimit?: number;
  periodicLimit?: number;
  returnedRebuyLimit?: number;
  /** 退货品「从别家再买」的中签概率。消耗品 > 耐用品。缺省走 REBUY_AFTER_RETURN_PROB_*。 */
  rebuyAfterReturnProbConsumable?: number;
  rebuyAfterReturnProbDurable?: number;
  /** 概率掷骰子源，默认 Math.random；单测注入确定性函数。返回 [0,1)。 */
  rng?: () => number;
}): ShoppingRecentPartition {
  const { rows, reviewSentimentByEntryId, collectionKeywords = [], nowMs } = params;
  const windowMs = Math.max(0, params.windowDays ?? SHOPPING_CONSUMABLE_WINDOW_DAYS) * 86_400_000;
  const avoidLimit = params.avoidLimit ?? SHOPPING_RECENT_ITEMS_LIMIT;
  const periodicLimit = params.periodicLimit ?? SHOPPING_PERIODIC_ITEMS_LIMIT;
  const returnedRebuyLimit = params.returnedRebuyLimit ?? SHOPPING_RETURNED_REBUY_LIMIT;
  const probConsumable = params.rebuyAfterReturnProbConsumable ?? REBUY_AFTER_RETURN_PROB_CONSUMABLE;
  const probDurable = params.rebuyAfterReturnProbDurable ?? REBUY_AFTER_RETURN_PROB_DURABLE;
  const rng = params.rng ?? Math.random;

  const avoidNames: string[] = [];
  const periodicItems: ShoppingPeriodicRestockItem[] = [];
  const returnedRebuyItems: ShoppingReturnedRebuyItem[] = [];
  const seenCore = new Set<string>();

  // listAppEntries 返回 jsonl 追加序（最旧在前）；反转成最新在前——截断到 LIMIT 时留下最近的品类，
  // 且每个核心品类首次遇到的就是**最近一次**购买（决定补货窗口判定 + 上次卖家 / 评价的取值）。
  for (const row of [...rows].reverse()) {
    if (
      avoidNames.length >= avoidLimit &&
      periodicItems.length >= periodicLimit &&
      returnedRebuyItems.length >= returnedRebuyLimit
    )
      break;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const raw =
      typeof meta.itemName === 'string' && meta.itemName.trim()
        ? meta.itemName.trim()
        : row.title.trim();
    if (!raw) continue;
    if (itemMatchesCollection(raw, collectionKeywords)) continue; // 收藏品三桶都不进
    const core = extractItemCoreType(raw);
    if (!core || seenCore.has(core)) continue; // 按核心品类去重，保留最近一次
    seenCore.add(core);

    const displayName = raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
    const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined;
    const category = typeof meta.category === 'string' ? meta.category : undefined;
    const status = typeof meta.status === 'string' ? meta.status : '';
    const consumable = isRepurchasableConsumable(category, tags);

    // 退货品优先分流（不看补货窗口）：掷骰子决定这一轮是否「从别家再买类似的」。
    if (status === 'returned') {
      const prob = consumable ? probConsumable : probDurable;
      if (rng() < prob) {
        if (returnedRebuyItems.length < returnedRebuyLimit) {
          const seller = typeof meta.seller === 'string' ? meta.seller.trim() : '';
          returnedRebuyItems.push({ name: displayName, seller, consumable });
        }
      } else if (avoidNames.length < avoidLimit) {
        avoidNames.push(displayName); // 未中签 → 这一轮先别重买
      }
      continue;
    }

    if (consumable) {
      const occurred = typeof meta.occurredAt === 'string' ? meta.occurredAt : row.createdAt;
      const t = Date.parse(occurred);
      const beyondWindow = Number.isFinite(t) && nowMs - t > windowMs;
      if (beyondWindow) {
        if (periodicItems.length < periodicLimit) {
          const seller = typeof meta.seller === 'string' ? meta.seller.trim() : '';
          const sentiment = reviewSentimentByEntryId?.get(row.id);
          const reviewNote = sentiment ? PERIODIC_REVIEW_NOTE_LABEL[sentiment] : '未评价';
          periodicItems.push({ name: displayName, seller, reviewNote });
        }
        continue;
      }
      // 窗口内消耗品 → 落「不要重复」（刚补过货、暂时别买）
    }
    if (avoidNames.length < avoidLimit) avoidNames.push(displayName);
  }

  return { avoidNames, periodicItems, returnedRebuyItems };
}

export type ShoppingRecentItemsBlocks = {
  /** 「不要重复」块（耐用品 + 窗口内消耗品 + 未中签退货品）；空 → ''。 */
  avoidBlock: string;
  /** 「周期补货」块（超窗口消耗品，带上次卖家 + 上次评价）；空 → ''。 */
  periodicBlock: string;
  /** 「退货重买」块（本轮中签的退货品，带上次退货那家卖家供避开）；空 → ''。 */
  returnedRebuyBlock: string;
};

/**
 * 读取已有购物 entries（+ 已生成的评价），分桶后渲染成 prompt 三块反/正锚点。
 *
 * 仿记账 `buildRecentTitlesBlock`：模型反复点「批量历史」/ 单条新增时跨次看不见上次生成了什么。
 *  - 「不要重复」块：让它从源头避开已记过的耐用品 / 刚补过货的消耗品 / 本轮没中签的退货品。
 *  - 「周期补货」块：把到补货周期的消耗品 + 上次卖家 + 上次评价喂回去，让它像真人一样
 *    （差评换家、好评 / 没评价沿用原店）决定再买的卖家。
 *  - 「退货重买」块：本轮中签的退货品（消耗品概率 > 耐用品），鼓励从**别家**再买类似的。
 *
 * 评价懒生成、很多 entry 没有 → 缺失按「未评价」处理（= 不换卖家那一档）。
 * 退货品的中签是随机的（每次生成结果可能不同），这是有意的——模拟真人「有时换家再买、有时就此作罢」。
 * 失败（agentId 非法 / 读盘错）→ 返回三个空块，generation 主流程不受影响。
 */
async function buildShoppingRecentItemsBlocks(
  agentId: string,
  options?: { collectionKeywords?: readonly string[] },
): Promise<ShoppingRecentItemsBlocks> {
  try {
    const rows = await listAppEntries(agentId, 'shopping');
    if (!rows.length) return { avoidBlock: '', periodicBlock: '', returnedRebuyBlock: '' };

    const reviewSentimentByEntryId = new Map<string, 'good' | 'neutral' | 'bad'>();
    try {
      const reviews = await listAppReviews(agentId, 'shopping');
      for (const rec of reviews) {
        const agentSide = rec.sides?.find((s) => s.by === 'agent');
        if (agentSide?.reviewed) {
          reviewSentimentByEntryId.set(rec.entryId, reviewSentimentFromStars(agentSide.stars));
        }
      }
    } catch {
      // 评价读失败 → 全部按「未评价」，不阻塞主流程
    }

    const { avoidNames, periodicItems, returnedRebuyItems } = partitionShoppingRecentItems({
      rows,
      reviewSentimentByEntryId,
      collectionKeywords: options?.collectionKeywords ?? [],
      nowMs: Date.now(),
    });

    const avoidBlock = avoidNames.length ? avoidNames.map((n) => `「${n}」`).join('、') : '';
    const periodicBlock = periodicItems.length
      ? periodicItems
          .map((it) => `「${it.name}」· 上次卖家：${it.seller || '没记'} · 上次评价：${it.reviewNote}`)
          .join('\n')
      : '';
    const returnedRebuyBlock = returnedRebuyItems.length
      ? returnedRebuyItems
          .map((it) => `「${it.name}」· 上次退货那家：${it.seller || '没记'}`)
          .join('\n')
      : '';
    return { avoidBlock, periodicBlock, returnedRebuyBlock };
  } catch {
    return { avoidBlock: '', periodicBlock: '', returnedRebuyBlock: '' };
  }
}

function formatRelationshipBlock(agentId: string): string {
  try {
    const storage = getXingyePersistenceStorage();
    const state = getRelationshipState(agentId, storage);
    if (!state) return '';
    return JSON.stringify(
      {
        mood: state.mood,
        relationshipLabel: state.relationshipLabel,
        stateSummary: state.stateSummary,
        lastReason: state.lastReason,
        affection: state.affection,
        trust: state.trust,
      },
      null,
      2,
    );
  } catch {
    return '';
  }
}

function profilePartsForQuery(profile: XingyeRoleProfile | null | undefined): string[] {
  if (!profile) return [];
  return [
    profile.displayName,
    profile.shortBio,
    profile.identitySummary,
    profile.backgroundSummary,
    profile.personalitySummary,
    profile.relationshipLabel,
    profile.values,
    profile.taboos,
    profile.relationshipMode,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
}

function normalizeOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return truncateChars(text, max);
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    out.push(t.slice(0, 24));
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}

function normalizeStatus(value: unknown): XingyeShoppingAiStatus {
  return (SHOPPING_AI_STATUSES as readonly string[]).includes(value as string)
    ? (value as XingyeShoppingAiStatus)
    : 'wanted';
}

function normalizePlatformStyle(value: unknown): XingyeShoppingAiPlatformStyle {
  return (SHOPPING_AI_PLATFORM_STYLES as readonly string[]).includes(value as string)
    ? (value as XingyeShoppingAiPlatformStyle)
    : 'generic';
}

/** 解析时间感自然语言 → ISO（支持中文数字与模糊词；见 parseChineseTimeHint）。 */
const parseOccurredAtHintShopping = parseChineseTimeHint;

export function normalizeShoppingDraftResult(raw: unknown): XingyeShoppingAiDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const itemName = typeof record.itemName === 'string' ? record.itemName.trim() : '';
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (!itemName) return null;
  const imaginedPrice = normalizeOptional(record.imaginedPrice, 60);
  const money = parseImaginedPriceToMoney(imaginedPrice);
  const occurredAtHint = normalizeOptional(record.occurredAtHint, 32);
  const occurredAt = parseOccurredAtHintShopping(occurredAtHint);
  return {
    itemName: truncateChars(itemName, 80),
    status: normalizeStatus(record.status),
    platformStyle: normalizePlatformStyle(record.platformStyle),
    category: normalizeOptional(record.category, 24),
    imaginedPrice,
    delta: normalizeOptional(record.delta, 32),
    seller: normalizeOptional(record.seller, 24),
    amount: money?.amount,
    currency: money?.currency,
    reason: normalizeOptional(record.reason, 200),
    tags: normalizeTags(record.tags),
    content: truncateChars(content, 600),
    occurredAtHint,
    occurredAt,
  };
}

/**
 * 解析 historyMode 下模型返回的 `{ drafts: [...] }` 包络结构。
 * 兼容裸数组兜底。无效项被丢弃；调用方拿空数组时再决定是否报错。
 */
export function normalizeShoppingDraftResults(raw: unknown): XingyeShoppingAiDraft[] {
  if (!raw) return [];
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'object') {
    const drafts = (raw as Record<string, unknown>).drafts;
    if (Array.isArray(drafts)) items = drafts;
  }
  const out: XingyeShoppingAiDraft[] = [];
  for (const item of items) {
    const normalized = normalizeShoppingDraftResult(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * 调 `POST /api/xingye/phone-generate`（kind: shopping_draft）。
 * 不写入购物存储，返回的草稿由调用方填到编辑框。
 *
 * 任意上下文（profile/lore/recent chat/heartbeat/relationship）缺失都优雅降级为「（无）」。
 */
export async function generateShoppingDraftWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userIntent?: string;
  userName?: string;
  timeoutMs?: number;
}): Promise<XingyeShoppingAiDraft> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const userIntent = params.userIntent?.trim() ?? '';
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const currencyAnchorBlock = await buildShoppingCurrencyAnchorBlock(agent.id);
  const collectionKeywords = extractCollectionKeywords(collectionKeywordSourceText(ownerProfile ?? null));
  const {
    avoidBlock: recentItemsBlock,
    periodicBlock: periodicRestockBlock,
    returnedRebuyBlock,
  } = await buildShoppingRecentItemsBlocks(agent.id, { collectionKeywords });

  let recentContext;
  try {
    recentContext = collectRecentContextForAgent({ agentId: agent.id });
  } catch {
    recentContext = { messages: [], summaryText: '' } as unknown as ReturnType<typeof collectRecentContextForAgent>;
  }

  let recentSceneBlock = '';
  try {
    const recentChatExcerpts = buildXingyeRecentChatExcerpts({
      context: recentContext,
      userName,
      agentName,
    });
    recentSceneBlock =
      formatXingyeRecentChatExcerptsForPrompt(recentChatExcerpts) ||
      describeRecentContextForPrompt(recentContext);
  } catch {
    try {
      recentSceneBlock = describeRecentContextForPrompt(recentContext);
    } catch {
      recentSceneBlock = '';
    }
  }

  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    userIntent,
    typeof recentContext.summaryText === 'string' ? recentContext.summaryText : '',
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
  ]);

  let keywordLoreBlock = '';
  try {
    const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
      purpose: 'generic',
      queryText,
      maxChars: 2000,
      includeAlways: false,
      includeKeyword: true,
    });
    keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);
  } catch {
    keywordLoreBlock = '';
  }

  const prompt = buildShoppingDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    userIntent,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    currencyAnchorBlock,
    recentItemsBlock,
    periodicRestockBlock,
    returnedRebuyBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'shopping_draft',
      ownerAgentId: agent.id,
      agentId: agent.id,
      prompt,
      timeoutMs,
    }),
  });

  let data: { ok?: boolean; error?: string; result?: unknown; details?: unknown };
  try {
    data = await response.json();
  } catch {
    throw new Error('解析服务器响应失败');
  }

  if (!response.ok || data?.ok === false || data?.error) {
    const details = Array.isArray(data?.details)
      ? `：${(data.details as { message?: string }[]).map((item) => item.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  const normalized = normalizeShoppingDraftResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 itemName 或 JSON 解析失败');
  }
  return normalized;
}

/**
 * 「批量历史生成」入口，返回多条 draft。
 *
 * 与 generateShoppingDraftWithAI 的区别：
 *  - prompt 强制 occurredAtHint 必填且分布在过去；
 *  - kind 用 'shopping_draft'，但 result 是 { drafts: [...] } 包络；
 *  - 单条解析失败不会让整批失败，只过滤掉无效条。
 */
export async function generateShoppingHistoryWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userIntent?: string;
  userName?: string;
  historyMode: ShoppingHistoryMode;
  desiredCount: number;
  timeoutMs?: number;
}): Promise<XingyeShoppingAiDraft[]> {
  const { agent, ownerProfile, historyMode } = params;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const userIntent = params.userIntent?.trim() ?? '';
  const desiredCount = Math.max(2, Math.min(10, Math.floor(params.desiredCount ?? 4)));
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const currencyAnchorBlock = await buildShoppingCurrencyAnchorBlock(agent.id);
  const collectionKeywords = extractCollectionKeywords(collectionKeywordSourceText(ownerProfile ?? null));
  const {
    avoidBlock: recentItemsBlock,
    periodicBlock: periodicRestockBlock,
    returnedRebuyBlock,
  } = await buildShoppingRecentItemsBlocks(agent.id, { collectionKeywords });

  let recentContext;
  try {
    recentContext = collectRecentContextForAgent({ agentId: agent.id });
  } catch {
    recentContext = { messages: [], summaryText: '' } as unknown as ReturnType<typeof collectRecentContextForAgent>;
  }

  let recentSceneBlock = '';
  try {
    const recentChatExcerpts = buildXingyeRecentChatExcerpts({
      context: recentContext,
      userName,
      agentName,
    });
    recentSceneBlock = formatXingyeRecentChatExcerptsForPrompt(recentChatExcerpts)
      || describeRecentContextForPrompt(recentContext);
  } catch {
    try {
      recentSceneBlock = describeRecentContextForPrompt(recentContext);
    } catch {
      recentSceneBlock = '';
    }
  }

  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    userIntent,
    typeof recentContext.summaryText === 'string' ? recentContext.summaryText : '',
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
  ]);

  let keywordLoreBlock = '';
  try {
    const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
      purpose: 'generic',
      queryText,
      maxChars: 2000,
      includeAlways: false,
      includeKeyword: true,
    });
    keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);
  } catch {
    keywordLoreBlock = '';
  }

  const prompt = buildShoppingDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    userIntent,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    currencyAnchorBlock,
    recentItemsBlock,
    periodicRestockBlock,
    returnedRebuyBlock,
    historyMode,
    desiredCount,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'shopping_draft',
      ownerAgentId: agent.id,
      agentId: agent.id,
      prompt,
      timeoutMs,
    }),
  });

  let data: { ok?: boolean; error?: string; result?: unknown; details?: unknown };
  try {
    data = await response.json();
  } catch {
    throw new Error('解析服务器响应失败');
  }

  if (!response.ok || data?.ok === false || data?.error) {
    const details = Array.isArray(data?.details)
      ? `：${(data.details as { message?: string }[]).map((item) => item.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  const drafts = normalizeShoppingDraftResults(data?.result);
  if (drafts.length === 0) {
    throw new Error('模型返回无效：未生成可用的购物记录草稿');
  }
  return drafts;
}

/**
 * 调用 polish prompt 返回的三字段子集。每个字段都可能为 undefined（模型留空字符串 → undefined）。
 * confirmShoppingDraft 的 edits 入参把 null 当"清空"、把 undefined 当"沿用 draft"，
 * 所以这里返回 undefined 而不是空串，调用方需要自己决定是否当成"沿用"还是"清空"。
 */
export type XingyeShoppingPolishResult = {
  imaginedPrice?: string;
  delta?: string;
  seller?: string;
  /** 由润色后的 imaginedPrice 本地解析出的数值金额（同 normalizeShoppingDraftResult）。 */
  amount?: number;
  /** amount 配对的货币单位。 */
  currency?: string;
};

function normalizeShoppingPolishResult(raw: unknown): XingyeShoppingPolishResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const imaginedPrice = normalizeOptional(record.imaginedPrice, 60);
  const money = parseImaginedPriceToMoney(imaginedPrice);
  return {
    imaginedPrice,
    delta: normalizeOptional(record.delta, 32),
    seller: normalizeOptional(record.seller, 24),
    amount: money?.amount,
    currency: money?.currency,
  };
}

/**
 * 「确认并润色价格」二段式流程的 AI 调用层。
 *
 * 与 generateShoppingDraftWithAI 的关键区别：
 *  - 输入是**已有的 draft 全字段**（含用户在草稿卡上的临时编辑）+ lore + 历史货币锚点；
 *    不需要 recent chat / relationship / heartbeat ——那些是"灵感来源"，润色不需要。
 *  - 输出只含 { imaginedPrice, delta, seller } 三个字段；itemName / content / 等
 *    由调用方在 confirmShoppingDraft 阶段 verbatim 锁回去，模型即使乱写也不会污染正文。
 *  - kind 标签用 'shopping_polish'，便于服务端 / 监控区分。
 */
export async function generateShoppingPolishWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  draft: {
    itemName: string;
    status: string;
    category?: string;
    content?: string;
    reason?: string;
    tags?: string[];
    imaginedPrice?: string;
    delta?: string;
    seller?: string;
  };
  userName?: string;
  timeoutMs?: number;
}): Promise<XingyeShoppingPolishResult> {
  const { agent, ownerProfile, draft } = params;
  const timeoutMs = params.timeoutMs ?? 60_000;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const currencyAnchorBlock = await buildShoppingCurrencyAnchorBlock(agent.id);

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    draft.itemName,
    draft.category ?? '',
    draft.content ?? '',
    draft.reason ?? '',
    stableLoreBlock.slice(0, 2000),
  ]);

  let keywordLoreBlock = '';
  try {
    const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
      purpose: 'generic',
      queryText,
      maxChars: 2000,
      includeAlways: false,
      includeKeyword: true,
    });
    keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);
  } catch {
    keywordLoreBlock = '';
  }

  const prompt = buildShoppingPolishPrompt({
    agent,
    userName,
    profile: ownerProfile,
    draft,
    stableLoreBlock,
    keywordLoreBlock,
    currencyAnchorBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'shopping_polish',
      ownerAgentId: agent.id,
      agentId: agent.id,
      prompt,
      timeoutMs,
    }),
  });

  let data: { ok?: boolean; error?: string; result?: unknown; details?: unknown };
  try {
    data = await response.json();
  } catch {
    throw new Error('解析服务器响应失败');
  }

  if (!response.ok || data?.ok === false || data?.error) {
    const details = Array.isArray(data?.details)
      ? `：${(data.details as { message?: string }[]).map((item) => item.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  const normalized = normalizeShoppingPolishResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：JSON 解析失败');
  }
  return normalized;
}
