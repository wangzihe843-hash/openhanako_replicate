/**
 * 关系数值变化曲线（纯本地确定性）。
 *
 * 背景：以前 LLM 直接给「最终 delta」、本地无脑累加，结果是「不管萍水相逢还是
 * 朝夕相许，同一件事给同样的分」。现在改成——
 *
 *   LLM 只给「原始情绪冲量」（这次互动本身的强度+方向，按中等熟悉度时该有的反应来给，
 *   **不替关系阶段做加减**），本模块按【当前关系阶段 / 方向 / 哪条轴】把它重塑成实际 delta。
 *
 * 这条曲线是整套数值「智能」的唯一所在，接在 updateRelationshipState 累加之前
 * （手动接受 / 心跳草稿确认两条入口共用同一终点），UI 预览也复用本函数 →
 * 所见即所得、可单测、每次稳定。常量表全部导出，跑起来不对味直接调。
 *
 * 五条轴的形态（贴现实人类社交，刻意「不镜像」）：
 *  - 好感：早期涨得快(≈1.25×)、后期放缓(≈0.32×)；负向不镜像——早期跌得慢，
 *          深关系日常小摩擦被信任垫底缓冲、但重大背叛被放大（按事件大小分流）。
 *  - 信任：慢涨快跌（易建难守）；信任越高，一次背叛跌得越狠。
 *  - 忠诚：黏——涨跌都被钝化、越高越不为小事动摇；但会被黑化值侵蚀（黑化越高，
 *          抗下跌的护垫被削掉）。
 *  - 醋意：绑「忠诚（占有/专一）」而非好感。低忠诚几乎吃不起醋、且留不住散得快；
 *          高忠诚易燃、又钻牛角尖难哄。"不吃朋友的醋"由此自动成立（朋友阶段忠诚天然低）。
 *  - 黑化：几乎只进难退——滋生得顺，洗白重度钝化，且越黑越难回头（趋近不可逆）。
 */

import type { XingyeRelationshipStatePatch } from './xingye-state-store';

/** 计算缩放时只需要这五个当前值（不依赖 mood / 历史等）。 */
export interface RelationshipCurveState {
  affection: number;
  trust: number;
  loyalty: number;
  jealousy: number;
  corruption: number;
}

export type RelationshipDeltaPatch = Pick<
  XingyeRelationshipStatePatch,
  'affectionDelta' | 'trustDelta' | 'loyaltyDelta' | 'jealousyDelta' | 'corruptionDelta'
>;

export interface ScaledRelationshipDeltas {
  affectionDelta: number;
  trustDelta: number;
  loyaltyDelta: number;
  jealousyDelta: number;
  corruptionDelta: number;
}

// ───────────────────────── 小工具 ─────────────────────────

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 对称取整：±0.5 一律往远离 0 的方向走（Math.round 对负数不对称，会吞掉小冲量）。 */
function roundAwayFromZero(value: number): number {
  return value >= 0 ? Math.round(value) : -Math.round(-value);
}

/** 把进来的冲量规整成有限整数；非数 / NaN → 0。 */
function asImpulse(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** 折线插值：anchors 必须按 x 升序；超出两端取端点值（不外推）。 */
export function interpolateAnchors(
  anchors: ReadonlyArray<{ x: number; m: number }>,
  x: number,
): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (x <= first.x) return first.m;
  if (x >= last.x) return last.m;
  for (let i = 1; i < anchors.length; i += 1) {
    const a = anchors[i - 1];
    const b = anchors[i];
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return a.m + t * (b.m - a.m);
    }
  }
  return last.m;
}

// ───────────────────────── ① 好感 ─────────────────────────

/** 正向乘子（按当前好感插值）：萍水→朋友最快(1.25×)，往上逐级放缓，负好感段也压低（挽回慢）。 */
export const AFFECTION_GAIN_ANCHORS = [
  { x: -100, m: 0.6 }, // 水火不容：从厌恶里挽回很慢（负性偏差）
  { x: -20, m: 0.9 }, // 心有芥蒂：解冻中，仍谨慎
  { x: 19, m: 1.25 }, // 萍水相逢→君子之交：最快，新鲜好感
  { x: 49, m: 1.0 }, // 君子之交
  { x: 79, m: 0.65 }, // 知己相照
  { x: 119, m: 0.45 }, // 情愫暗生
  { x: 150, m: 0.32 }, // 朝夕相许：饱和
] as const;

/** 负向「阶段基线」：早期跌得慢，越投入越刺痛，深关系日常有信任垫底。 */
export const AFFECTION_LOSS_STAGE_ANCHORS = [
  { x: -100, m: 0.35 },
  { x: -20, m: 0.45 },
  { x: 19, m: 0.5 }, // 萍水相逢：小事不至于深恶痛绝，跌得慢
  { x: 49, m: 0.7 }, // 君子之交：开始刺痛
  { x: 79, m: 0.8 }, // 知己相照：投入了，摩擦看得见
  { x: 119, m: 0.75 }, // 情愫暗生：基线高，但小事有缓冲
  { x: 150, m: 0.7 }, // 朝夕相许
] as const;

/** 「按事件大小分流」参数：只在知己以上的深关系激活。 */
export const AFFECTION_LOSS_SMALL = 3; // |冲量| ≤ 此值视作日常小摩擦
export const AFFECTION_LOSS_BIG = 9; // |冲量| ≥ 此值视作重大背叛
export const AFFECTION_LOSS_AMP_MAX = 0.9; // 深关系·重大背叛：在阶段基线上再 +90%
export const AFFECTION_LOSS_BUFFER_MAX = 0.4; // 深关系·小摩擦：在阶段基线上再 −40%
export const AFFECTION_DEPTH_START = 49; // 进入「分流」的好感起点（知己门槛）
export const AFFECTION_DEPTH_FULL = 150; // 分流强度拉满的好感

function affectionLossMultiplier(affection: number, magnitude: number): number {
  const stage = interpolateAnchors(AFFECTION_LOSS_STAGE_ANCHORS, affection);
  const depth = clamp01((affection - AFFECTION_DEPTH_START) / (AFFECTION_DEPTH_FULL - AFFECTION_DEPTH_START));
  const severity = clamp01((magnitude - AFFECTION_LOSS_SMALL) / (AFFECTION_LOSS_BIG - AFFECTION_LOSS_SMALL));
  // 深关系里：大背叛放大、小摩擦再缓冲；浅关系 depth≈0 → 不分流，回到阶段基线。
  const severityAmp = 1 + depth * (severity * AFFECTION_LOSS_AMP_MAX - (1 - severity) * AFFECTION_LOSS_BUFFER_MAX);
  return stage * severityAmp;
}

export function scaleAffectionDelta(affection: number, raw: number): number {
  if (raw === 0) return 0;
  if (raw > 0) return raw * interpolateAnchors(AFFECTION_GAIN_ANCHORS, affection);
  return raw * affectionLossMultiplier(affection, Math.abs(raw));
}

// ───────────────────────── ② 信任 ─────────────────────────

export const TRUST_GAIN_LOW = 0.65; // 慢涨：永远 <1
export const TRUST_GAIN_HIGH = 0.8;
export const TRUST_LOSS_LOW = 1.2; // 快跌：永远 >1
export const TRUST_LOSS_HIGH = 1.6; // 信任越高跌越狠（曾经信，现在碎）

export function scaleTrustDelta(trust: number, raw: number): number {
  if (raw === 0) return 0;
  const t = clamp01((trust + 100) / 200); // −100..100 → 0..1
  if (raw > 0) return raw * (TRUST_GAIN_LOW + (TRUST_GAIN_HIGH - TRUST_GAIN_LOW) * t);
  return raw * (TRUST_LOSS_LOW + (TRUST_LOSS_HIGH - TRUST_LOSS_LOW) * t);
}

// ───────────────────────── ③ 忠诚 ─────────────────────────

export const LOYALTY_GAIN_BASE = 0.7;
export const LOYALTY_GAIN_STICKY = 0.3; // 忠诚越高，涨得越钝（黏）
export const LOYALTY_GAIN_CORRUPTION_DRAG = 0.4; // 黑化拖累忠诚增长
export const LOYALTY_LOSS_BASE = 0.55; // 黏：天然抗下跌
export const LOYALTY_LOSS_CORRUPTION_EROSION = 0.8; // 黑化侵蚀：削掉抗跌护垫

export function scaleLoyaltyDelta(loyalty: number, corruption: number, raw: number): number {
  if (raw === 0) return 0;
  const high = clamp01(loyalty / 100); // 只在正向忠诚累积黏性
  const corrupt = clamp01(corruption / 100);
  if (raw > 0) {
    return raw * (LOYALTY_GAIN_BASE - LOYALTY_GAIN_STICKY * high) * (1 - LOYALTY_GAIN_CORRUPTION_DRAG * corrupt);
  }
  return raw * LOYALTY_LOSS_BASE * (1 + LOYALTY_LOSS_CORRUPTION_EROSION * corrupt);
}

// ───────────────────────── ④ 醋意（绑忠诚） ─────────────────────────

export const JEALOUSY_RISE_FLOOR = 0.2; // 低忠诚：没"claim"几乎吃不起醋
export const JEALOUSY_RISE_CEIL = 1.3; // 高忠诚：占有欲、易燃
export const JEALOUSY_DECAY_FAST = 1.3; // 低忠诚：醋意留不住，散得快
export const JEALOUSY_DECAY_SLOW = 0.6; // 高忠诚：钻牛角尖、难哄
export const JEALOUSY_LOYALTY_LOW = 10; // 忠诚 gate 起点
export const JEALOUSY_LOYALTY_HIGH = 80; // 忠诚 gate 满点

export function scaleJealousyDelta(loyalty: number, raw: number): number {
  if (raw === 0) return 0;
  const devotion = clamp01((loyalty - JEALOUSY_LOYALTY_LOW) / (JEALOUSY_LOYALTY_HIGH - JEALOUSY_LOYALTY_LOW));
  if (raw > 0) return raw * (JEALOUSY_RISE_FLOOR + (JEALOUSY_RISE_CEIL - JEALOUSY_RISE_FLOOR) * devotion);
  return raw * (JEALOUSY_DECAY_FAST - (JEALOUSY_DECAY_FAST - JEALOUSY_DECAY_SLOW) * devotion);
}

// ───────────────────────── ⑤ 黑化 ─────────────────────────

export const CORRUPTION_RISE = 1.1; // 阴暗面滋生得顺、黏
export const CORRUPTION_HEAL_BASE = 0.35; // 洗白本就难
export const CORRUPTION_HEAL_LOCKIN = 0.5; // 越黑越难回头（趋近不可逆）

export function scaleCorruptionDelta(corruption: number, raw: number): number {
  if (raw === 0) return 0;
  if (raw > 0) return raw * CORRUPTION_RISE;
  const corrupt = clamp01(corruption / 100);
  return raw * CORRUPTION_HEAL_BASE * (1 - CORRUPTION_HEAL_LOCKIN * corrupt);
}

// ───────────────────────── 总入口 ─────────────────────────

/**
 * 把 LLM 给的「原始情绪冲量」按当前状态重塑成实际 delta。
 *
 * 五条轴都读**同一份 pre-update 快照**（一次事件的所有变化都参照事件开始时的状态——
 * 例如醋意读的是这次累加前的忠诚，而非加完 loyaltyDelta 之后的）。返回整数 delta；
 * 不在这里做绝对上下限钳制——那交给下游 clampRelationshipState（保留极值事件能把
 * 数值推到边界的语义）。
 */
export function scaleRelationshipDeltas(
  current: RelationshipCurveState,
  patch: RelationshipDeltaPatch,
): ScaledRelationshipDeltas {
  return {
    affectionDelta: roundAwayFromZero(scaleAffectionDelta(current.affection, asImpulse(patch.affectionDelta))),
    trustDelta: roundAwayFromZero(scaleTrustDelta(current.trust, asImpulse(patch.trustDelta))),
    loyaltyDelta: roundAwayFromZero(
      scaleLoyaltyDelta(current.loyalty, current.corruption, asImpulse(patch.loyaltyDelta)),
    ),
    jealousyDelta: roundAwayFromZero(scaleJealousyDelta(current.loyalty, asImpulse(patch.jealousyDelta))),
    corruptionDelta: roundAwayFromZero(scaleCorruptionDelta(current.corruption, asImpulse(patch.corruptionDelta))),
  };
}
