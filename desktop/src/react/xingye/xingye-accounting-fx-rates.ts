/**
 * 跨币种折算配置：让账本「最后总和」能用同一种货币显示，
 * 而不是 ¥ 一组、$ 一组、两银子又一组三条并列。
 *
 * 设计取舍：
 *  - 一笔账本身仍按**原币种**存（`metadata.currency` + `metadata.amount` 都不动），
 *    这层只在**展示汇总**时做折算，源数据零侵入。
 *  - 速率全部锚定到 ¥（rates['¥'] === 1 是不变量），切换 displayCurrency 不重写速率表，
 *    只在折算时做一次「先到 ¥ 再到 displayCurrency」的两段除法。
 *  - 落盘到 `apps/accounting/fx-rates.json`，与 entries.jsonl 同目录、按 agent 隔离。
 *
 * 速率不是「真实汇率」——尤其现实货币部分，是 2025–2026 年量级的近似值，
 * 用户可以在 UI 里改。古代 / 民国 / 西幻 / 仙侠 / 未来 / 末日 这些虚构币种本身就
 * 没有"真实汇率"，给一个**与世界观量级一致**的默认值（清中后期 1 两 ≈ ¥250、
 * 1934 上海 1 大洋 ≈ ¥300、西幻 1 金币 ≈ ¥1000、仙侠 1 灵石 ≈ ¥500）就够用。
 *
 * 不能折算的币种（速率表里查不到、用户也没自定义）→ 在 UI 里作为 unconvertible
 * 单独列出，不强行用 1:1 蒙混过关；这是「老老实实承认信息不全」而不是骗用户。
 */

import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import type { XingyeRoleProfile } from './xingye-profile-store';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

export const FX_RATES_PATH = 'apps/accounting/fx-rates.json';

/** ¥ 的标准写法。所有内部计算都先把 amount 折到 ¥，再折到 displayCurrency。 */
export const FX_ANCHOR_CURRENCY = '¥';

export type XingyeFxConfig = {
  version: 1;
  /** 汇总展示用的目标货币。空 → 视为未设置，由 pickDisplayCurrency 兜底。 */
  displayCurrency: string;
  /**
   * 速率表：`rates[ccy]` = 1 单位 ccy 相当于多少 ¥。
   * 不变量：rates['¥'] === 1。
   */
  rates: Record<string, number>;
};

/**
 * 默认速率表（锚定 ¥）。
 *
 * 现实货币：2025–2026 量级的近似中间汇率，用户可以在 UI 里改。
 * 虚构货币：和"一份月房租"对得上的量级（不要求精确，要求口径稳定）。
 *
 * 别名（"两"="两银子"、"金"="金币" 等）在表里各塞一份，免得用户输入「三两」
 * 而 LLM 输出「两银子」时被分裂成两份。统一在折算时按 currency 字符串查表，
 * 没命中再走 fallback。
 */
export const DEFAULT_FX_RATES: Readonly<Record<string, number>> = Object.freeze({
  // ── 现实货币（锚 ¥ = 1） ──
  '¥': 1,
  '￥': 1,
  CNY: 1,
  RMB: 1,
  '元': 1,
  '块': 1,
  '块钱': 1,

  // 美元（约 7.2 ¥ / 1 $）
  '$': 7.2,
  '＄': 7.2,
  USD: 7.2,
  美元: 7.2,

  // 欧元
  '€': 7.8,
  EUR: 7.8,
  欧元: 7.8,

  // 英镑
  '£': 9.1,
  GBP: 9.1,
  英镑: 9.1,

  // 日元（1 円 ≈ ¥0.047）
  '円': 0.047,
  '¥(JPY)': 0.047,
  JPY: 0.047,
  日元: 0.047,

  // 韩元
  '₩': 0.0053,
  KRW: 0.0053,
  韩元: 0.0053,

  // 卢布、卢比、雷亚尔
  '₽': 0.075,
  RUB: 0.075,
  '₹': 0.087,
  INR: 0.087,
  'R$': 1.3,
  BRL: 1.3,

  // ── 中国古代（清中后期：1 两 ≈ ¥250；1 两 = 10 钱 = 1000 文） ──
  两银子: 250,
  两白银: 250,
  '两': 250,
  钱: 25,
  '文': 0.25,
  铜钱: 0.25,

  // ── 民国（1934 上海：1 大洋 ≈ ¥300；1 大洋 = 10 角 = 100 分） ──
  // 注：「分」在民国语境是 0.01 大洋，在现代语境是 0.01 元，语义冲突——
  // 这里偏向民国（更常出现在角色背景里）。需要现代「分」时用户自己改。
  银元: 300,
  大洋: 300,
  法币: 300,
  角: 30,

  // ── 西幻 / 中世纪 / D&D（1 金币 ≈ 一周工匠工资 ≈ ¥1000） ──
  金币: 1000,
  '金': 1000,
  银币: 100,
  '银': 100,
  铜板: 10,
  铜币: 10,
  '铜': 10,

  // ── 仙侠 / 修真 ──
  下品灵石: 50,
  灵石: 500,
  中品灵石: 5000,
  上品灵石: 50000,
  金锭: 800,

  // ── 未来 / 赛博朋克 / 太空歌剧 ──
  信用点: 1,
  星币: 1,
  联邦币: 1,
  Eddies: 0.5,
  eddies: 0.5,
  ED: 0.5,
  能量配给: 30,
  配给券: 50,

  // ── 末日 / 废土 ──
  瓶盖: 5,
  子弹: 10,
  物资点: 1,
  水票: 20,
});

/**
 * 用于在 UI 里给用户「常见币种快捷新增」的分组。和 DEFAULT_FX_RATES 同源——
 * 一旦在那里加了新币种，记得在这里挑一组放进去。
 */
export const FX_CURRENCY_GROUPS: ReadonlyArray<{
  label: string;
  currencies: ReadonlyArray<string>;
}> = [
  { label: '现实', currencies: ['¥', '$', '€', '£', '円', '₩'] },
  { label: '古代 / 民国', currencies: ['两银子', '钱', '文', '银元', '大洋', '角'] },
  { label: '西幻 / 中世纪', currencies: ['金币', '银币', '铜板'] },
  { label: '仙侠 / 修真', currencies: ['灵石', '下品灵石', '中品灵石', '金锭'] },
  { label: '未来', currencies: ['信用点', '星币', '联邦币', 'Eddies'] },
  { label: '末日', currencies: ['瓶盖', '子弹', '物资点', '水票'] },
];

/**
 * Lore 关键词 → 推荐 displayCurrency。
 * 用户没在配置里指定、账本也是空的时候，从角色 profile 文本里嗅探世界观。
 * 多个命中 → 取第一个匹配的（顺序按"特异度"排，越特殊的越靠前）。
 */
const LORE_CURRENCY_HINTS: ReadonlyArray<{ patterns: RegExp; currency: string }> = [
  { patterns: /(修真|仙侠|筑基|金丹|元婴|灵根|散修|宗门)/, currency: '灵石' },
  { patterns: /(赛博朋克|cyberpunk|义体|公司战|夜之城|网客)/i, currency: 'Eddies' },
  { patterns: /(末日|废土|fallout|辐射|避难所|聚落|尘世)/i, currency: '瓶盖' },
  { patterns: /(未来|星际|联邦|太空|银河|殖民地|空间站|赛博)/, currency: '信用点' },
  { patterns: /(中世纪|西幻|魔法|龙与地下城|d&d|精灵|矮人|骑士|魔法师|法师)/i, currency: '金币' },
  { patterns: /(民国|大洋|银元|上海滩|租界|军阀|北洋|抗战前)/, currency: '银元' },
  { patterns: /(古代|武侠|江湖|侠客|朝廷|清朝|明朝|宋朝|唐朝|大理寺|镖局)/, currency: '两银子' },
  { patterns: /(日本|东京|大阪|京都|円|和服|町|tokyo|osaka)/i, currency: '円' },
  { patterns: /(美国|纽约|洛杉矶|旧金山|美元|usd|new york|los angeles|us\b)/i, currency: '$' },
  { patterns: /(欧洲|巴黎|柏林|伦敦|欧元|英镑|paris|berlin|london|gbp|eur)/i, currency: '€' },
];

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 把外来 JSON 收敛成合法 fx config；非法值丢弃。 */
function normalizeFxConfig(raw: unknown): XingyeFxConfig {
  const fallback: XingyeFxConfig = {
    version: 1,
    displayCurrency: '',
    rates: {},
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const r = raw as Record<string, unknown>;
  const displayCurrency =
    typeof r.displayCurrency === 'string' ? r.displayCurrency.trim().slice(0, 32) : '';
  const ratesRaw = (r.rates && typeof r.rates === 'object' && !Array.isArray(r.rates))
    ? (r.rates as Record<string, unknown>)
    : {};
  const rates: Record<string, number> = {};
  for (const [ccy, v] of Object.entries(ratesRaw)) {
    const ccyKey = typeof ccy === 'string' ? ccy.trim().slice(0, 32) : '';
    if (!ccyKey) continue;
    if (!isFinitePositive(v)) continue;
    rates[ccyKey] = v;
  }
  return { version: 1, displayCurrency, rates };
}

/**
 * 把用户配置和默认表合并。用户表覆盖默认（包括关闭某币种——传 0 也会被
 * normalizeFxConfig 丢掉，这是有意的：禁用一个默认币种应该在 UI 里"清空"它，
 * 不允许存 0 速率，否则除法会炸）。
 *
 * 不变量：返回的 rates 一定包含 FX_ANCHOR_CURRENCY，且值为 1（用户改不了 ¥ 自身的锚位）。
 */
export function mergeWithDefaults(config: XingyeFxConfig): Record<string, number> {
  const merged: Record<string, number> = { ...DEFAULT_FX_RATES, ...config.rates };
  merged[FX_ANCHOR_CURRENCY] = 1;
  return merged;
}

/**
 * 把 `amount @ fromCurrency` 折算到 `toCurrency`，全程通过 ¥ 锚做两段除法。
 *  - fromCurrency 速率缺失 → ok=false（调用方应把这笔归到 unconvertible 桶）。
 *  - toCurrency 速率缺失 → ok=false（同上）。
 *  - 同币种 → ok=true，amount 原样返回。
 */
export function convertCurrency(
  amount: number,
  fromCurrency: string | null | undefined,
  toCurrency: string,
  rates: Record<string, number>,
): { ok: true; amount: number } | { ok: false } {
  const from = (fromCurrency ?? '').trim();
  const to = toCurrency.trim();
  if (!to) return { ok: false };
  if (!from || from === to) {
    // 没标币种 / 同币种 → 假定就是目标币种，原样返回。
    return { ok: true, amount };
  }
  const fromRate = rates[from];
  const toRate = rates[to];
  if (!isFinitePositive(fromRate) || !isFinitePositive(toRate)) {
    return { ok: false };
  }
  return { ok: true, amount: (amount * fromRate) / toRate };
}

/**
 * 决定汇总卡上的「主显示货币」。
 *
 * 优先级（高 → 低）：
 *   1. 用户已显式保存的 displayCurrency（在 fx-rates.json 里）；
 *   2. 账本里出现得最频繁的币种（按 realized 笔数）——至少 1 笔；
 *   3. 从 lore（profile 文本）里嗅探出的世界观货币；
 *   4. 兜底 `¥`。
 *
 * 这套优先级让首次打开就有合理默认（lore），有数据后跟随实际记录（最常用），
 * 用户手动设置后永远尊重设置（saved）。
 */
export function pickDisplayCurrency(args: {
  saved?: string;
  ledgerCurrencyCounts?: Record<string, number>;
  profile?: XingyeRoleProfile | null;
}): string {
  const saved = args.saved?.trim();
  if (saved) return saved;

  const counts = args.ledgerCurrencyCounts ?? {};
  let bestCcy = '';
  let bestCount = 0;
  for (const [ccy, count] of Object.entries(counts)) {
    if (ccy && count > bestCount) {
      bestCcy = ccy;
      bestCount = count;
    }
  }
  if (bestCcy) return bestCcy;

  const inferred = inferDisplayCurrencyFromProfile(args.profile);
  if (inferred) return inferred;

  return FX_ANCHOR_CURRENCY;
}

/**
 * 从角色 profile 文本里嗅探 displayCurrency。
 * 把所有相关字段拼起来一次 regex 扫，命中第一条规则就返回。
 * 没线索 → 返回空串（让上层走 ¥ 兜底）。
 */
export function inferDisplayCurrencyFromProfile(
  profile: XingyeRoleProfile | null | undefined,
): string {
  if (!profile) return '';
  const text = [
    profile.shortBio,
    profile.identitySummary,
    profile.backgroundSummary,
    profile.personalitySummary,
    profile.values,
    profile.taboos,
    profile.relationshipMode,
    profile.relationshipLabel,
    profile.speakingStyle,
  ]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('\n');
  if (!text) return '';
  for (const hint of LORE_CURRENCY_HINTS) {
    if (hint.patterns.test(text)) return hint.currency;
  }
  return '';
}

export async function loadFxConfig(agentId: string): Promise<XingyeFxConfig> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return { version: 1, displayCurrency: '', rates: {} };
  try {
    const raw = await backend.readJson<unknown>(aid, FX_RATES_PATH);
    return normalizeFxConfig(raw);
  } catch {
    return { version: 1, displayCurrency: '', rates: {} };
  }
}

export async function saveFxConfig(
  agentId: string,
  patch: Partial<Omit<XingyeFxConfig, 'version'>>,
): Promise<XingyeFxConfig> {
  const aid = String(agentId ?? '').trim();
  if (!aid) throw new Error('saveFxConfig: agentId is required');
  const current = await loadFxConfig(aid);
  const next: XingyeFxConfig = {
    version: 1,
    displayCurrency:
      patch.displayCurrency !== undefined
        ? String(patch.displayCurrency).trim().slice(0, 32)
        : current.displayCurrency,
    rates:
      patch.rates !== undefined
        ? Object.fromEntries(
            Object.entries(patch.rates).filter(
              ([k, v]) => typeof k === 'string' && k.trim() !== '' && isFinitePositive(v),
            ),
          )
        : current.rates,
  };
  await backend.writeJson(aid, FX_RATES_PATH, next);
  return next;
}

/**
 * 给 UI / 测试用的一站式：load + merge + pick display + return effective state。
 * 返回 displayCurrency 和 effectiveRates 都是「能直接传给 convertCurrency / summarize」的形式。
 */
export type EffectiveFxState = {
  displayCurrency: string;
  /** DEFAULT_FX_RATES ∪ user.rates，并强制 rates['¥'] === 1。 */
  effectiveRates: Record<string, number>;
  /** 用户原始持久化 config，UI 上用于"是否被用户覆盖"判断。 */
  raw: XingyeFxConfig;
};

export function resolveFxState(args: {
  config: XingyeFxConfig;
  ledgerCurrencyCounts?: Record<string, number>;
  profile?: XingyeRoleProfile | null;
}): EffectiveFxState {
  const effectiveRates = mergeWithDefaults(args.config);
  const displayCurrency = pickDisplayCurrency({
    saved: args.config.displayCurrency,
    ledgerCurrencyCounts: args.ledgerCurrencyCounts,
    profile: args.profile,
  });
  return { displayCurrency, effectiveRates, raw: args.config };
}
