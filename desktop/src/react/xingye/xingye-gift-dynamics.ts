/**
 * 赠礼系统的「认知矩阵 + 送礼数值查表」——纯函数、零 I/O、零 LLM。
 *
 * 两层分治（与关系数值动力学同款哲学，见 xingye-state-curve.ts 顶部注释）：
 *  - Init 静态层（LLM 定性，存 gifts/state.json）：最爱礼物、native 集逐件 stance、
 *    礼物反应气质（temperament）—— 一次性冻结，体现人设的稳定倾向。
 *  - 送礼时动态层（本模块）：delta = 查表(认知层级/stance × 气质 × **当前**黑化档位)，
 *    黑化是动态数值，必须读送礼瞬间的实时值而非冻结在 init —— 「高黑化角色收到
 *    不喜欢的礼物会掉好感」是用户拍板的核心非通用设计。
 *
 * 本模块产出的是「原始情绪冲量」，真正落库走 updateRelationshipState →
 * scaleRelationshipDeltas 按关系阶段重塑，这里不做阶段缩放。
 */

import { XINGYE_GIFT_SETS, type XingyeGiftSetId } from './xingye-gift-catalog';

// ── 认知矩阵 ─────────────────────────────────────────────────────

export type GiftFamiliarity = 'native' | 'mundane' | 'historical' | 'alien';

/**
 * 虚构集 → 它「日常包含」的真实历史集（视作寻常物，而非古董/奇物）。
 * 武侠/仙侠角色看通用中国古代礼物 = 比较普通的日常东西；西幻同构于中世纪。
 * 蒸汽朋克刻意不在此表：维多利亚式架空对中世纪是「历史」不是「日常」。
 */
const MUNDANE_ANCHOR: Partial<Record<XingyeGiftSetId, XingyeGiftSetId>> = {
  wuxia: 'cn_ancient',
  xianxia: 'cn_ancient',
  west_fantasy: 'west_medieval',
};

/**
 * 各世界观在「真实时间线」上的有效位置，用于史书认知判定：
 * agent 的有效时间线晚于某 real 集 → 该集对 TA 是「历史书上见过」。
 * 平行虚构未来（赛博朋克/废土/太空）继承现代人全部真实历史认知，记 4；
 * 蒸汽朋克 ≈ 维多利亚（近代），记 2；东方/西方古代虚构记 1。
 */
const EFFECTIVE_TIMELINE: Record<XingyeGiftSetId, number> = {
  cn_ancient: 1,
  west_medieval: 1,
  wuxia: 1,
  xianxia: 1,
  west_fantasy: 1,
  republican: 2,
  steampunk: 2,
  modern: 3,
  cyberpunk: 4,
  wasteland: 4,
  space: 4,
};

const REAL_TIMELINE = new Map<XingyeGiftSetId, number>(
  XINGYE_GIFT_SETS.filter((set) => set.kind === 'real' && set.timeline)
    .map((set) => [set.id, set.timeline as number]),
);

/**
 * 认知层级判定：
 *  - native：本世界观，走 stance 反应（最爱只可能在这里）
 *  - mundane：虚构集对其所含真实历史集 ——「哦，挺常见的东西」
 *  - historical：真实历史集对时间线在其后的世界观 ——「这是古董/史书上见过」
 *    （废土收到现代礼物 = 战前遗物，同理）
 *  - alien：其余一切 —— 虚构特有集对所有外人、过去对未来、同期异域、平行未来互相
 */
export function resolveGiftFamiliarity(
  agentSetId: XingyeGiftSetId,
  giftSetId: XingyeGiftSetId,
): GiftFamiliarity {
  if (agentSetId === giftSetId) return 'native';
  if (MUNDANE_ANCHOR[agentSetId] === giftSetId) return 'mundane';
  const giftTimeline = REAL_TIMELINE.get(giftSetId);
  if (giftTimeline !== undefined && EFFECTIVE_TIMELINE[agentSetId] > giftTimeline) {
    return 'historical';
  }
  return 'alien';
}

// ── stance / 气质 ────────────────────────────────────────────────

/** native 集内每件礼物的态度（init 时 LLM 按人设定性，最爱必为 loved 且全集唯一）。 */
export type GiftStance = 'loved' | 'liked' | 'neutral' | 'disliked';

export const GIFT_STANCES: readonly GiftStance[] = ['loved', 'liked', 'neutral', 'disliked'];

/**
 * 礼物反应气质：人设层面的稳定倾向，init 一次性定。
 *  - gracious 宽和：不喜欢也领情，负反应减半
 *  - picky 挑剔：无感≈不领情，不喜欢的惩罚加重
 *  - volatile 喜怒无常：喜恶都放大
 */
export type GiftTemperament = 'gracious' | 'picky' | 'volatile';

export const GIFT_TEMPERAMENTS: readonly GiftTemperament[] = ['gracious', 'picky', 'volatile'];

export const GIFT_TEMPERAMENT_LABELS: Record<GiftTemperament, string> = {
  gracious: '宽和',
  picky: '挑剔',
  volatile: '喜怒无常',
};

// ── 送礼数值查表 ─────────────────────────────────────────────────

/** 黑化进入「阴暗反应」的档位：≥ 此值时不喜欢的礼物会掉好感、陌生异物引发警惕。 */
export const GIFT_CORRUPTION_DARK_TIER = 50;

export type GiftImpulse = {
  affectionDelta: number;
  trustDelta: number;
  loyaltyDelta: number;
  jealousyDelta: number;
  corruptionDelta: number;
};

export type GiftReactionTier =
  | 'favorite' // 命中最爱：特效 + 特殊回复
  | 'pleased' // 正向（liked / historical 古董惊喜）
  | 'flat' // 平淡（neutral / mundane）
  | 'displeased' // 负向（disliked，高黑化下加重）
  | 'curious'; // 跨世界观完全陌生：好奇/疑惑

export type GiftReactionInput = {
  familiarity: GiftFamiliarity;
  /** familiarity === 'native' 时必传；其余忽略。 */
  stance?: GiftStance;
  isFavorite?: boolean;
  /** 此前是否已命中过最爱（防刷：重复命中冲量减半，特效保留）。 */
  favoriteHitBefore?: boolean;
  temperament: GiftTemperament;
  /** 送礼瞬间的实时黑化值（0..100）。 */
  currentCorruption: number;
};

export type GiftReaction = {
  tier: GiftReactionTier;
  impulse: GiftImpulse;
};

const ZERO_IMPULSE: GiftImpulse = {
  affectionDelta: 0,
  trustDelta: 0,
  loyaltyDelta: 0,
  jealousyDelta: 0,
  corruptionDelta: 0,
};

function impulse(partial: Partial<GiftImpulse>): GiftImpulse {
  return { ...ZERO_IMPULSE, ...partial };
}

function scaleImpulse(base: GiftImpulse, factor: number): GiftImpulse {
  return {
    affectionDelta: Math.round(base.affectionDelta * factor),
    trustDelta: Math.round(base.trustDelta * factor),
    loyaltyDelta: Math.round(base.loyaltyDelta * factor),
    jealousyDelta: Math.round(base.jealousyDelta * factor),
    corruptionDelta: Math.round(base.corruptionDelta * factor),
  };
}

/**
 * 送礼反应查表。返回的冲量是 LLM 量纲的「原始情绪冲量」（日常事件 ±1~5、
 * 大事件 ±8~14），交给 updateRelationshipState 做阶段重塑。
 */
export function resolveGiftReaction(input: GiftReactionInput): GiftReaction {
  const dark = input.currentCorruption >= GIFT_CORRUPTION_DARK_TIER;
  const temperament = input.temperament;

  // 命中最爱：与认知层级无关（最爱只存在于 native 集，调用方保证）
  if (input.isFavorite) {
    const base = impulse({ affectionDelta: 14, trustDelta: 4, loyaltyDelta: 3 });
    return {
      tier: 'favorite',
      impulse: input.favoriteHitBefore ? scaleImpulse(base, 0.5) : base,
    };
  }

  if (input.familiarity === 'native') {
    const stance = input.stance ?? 'neutral';
    if (stance === 'loved' || stance === 'liked') {
      const base = impulse({ affectionDelta: 7, trustDelta: 2 });
      const factor = temperament === 'volatile' ? 1.4 : 1;
      return { tier: 'pleased', impulse: scaleImpulse(base, factor) };
    }
    if (stance === 'neutral') {
      const affection = temperament === 'picky' ? 1 : 3;
      return { tier: 'flat', impulse: impulse({ affectionDelta: affection }) };
    }
    // disliked：常态是「不太领情但不翻脸」；高黑化时变成真实的负反应。
    let base: GiftImpulse;
    if (dark) {
      base = impulse({ affectionDelta: -6, trustDelta: -1, corruptionDelta: 1 });
    } else {
      base = impulse({ affectionDelta: 0, trustDelta: 0 });
    }
    let factor = 1;
    if (temperament === 'gracious') factor = 0.5;
    if (temperament === 'picky' || temperament === 'volatile') factor = 1.5;
    const scaled = scaleImpulse(base, factor);
    // 宽和角色非黑化时甚至小幅领情
    if (!dark && temperament === 'gracious') scaled.affectionDelta = 1;
    return { tier: 'displeased', impulse: scaled };
  }

  if (input.familiarity === 'mundane') {
    const affection = temperament === 'gracious' ? 3 : 2;
    return { tier: 'flat', impulse: impulse({ affectionDelta: affection }) };
  }

  if (input.familiarity === 'historical') {
    // 「送古董/战前遗物」是有心的：可观正向。
    const base = impulse({ affectionDelta: 5, trustDelta: 1 });
    const factor = temperament === 'volatile' ? 1.4 : 1;
    return { tier: 'pleased', impulse: scaleImpulse(base, factor) };
  }

  // alien：好奇/疑惑。常态小正向（新奇感）；高黑化 = 对来历不明之物的警惕，零增益。
  if (dark) {
    return { tier: 'curious', impulse: impulse({ affectionDelta: 0 }) };
  }
  return { tier: 'curious', impulse: impulse({ affectionDelta: 2 }) };
}
