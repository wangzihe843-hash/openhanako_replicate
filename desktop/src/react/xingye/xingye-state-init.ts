/**
 * 关系状态「初始化播种」（纯本地确定性）。
 *
 * 以前初始化只从关系标签推 affection，trust/loyalty/jealousy/corruption 全写死 0——
 * 一个设定为「恋人」的角色，好感起步 90，却 0 信任 0 忠诚，黑化系角色也是 0 黑化。
 * 这里按各数值的性质分治播种：
 *
 *  - 信任 / 忠诚：跟关系深浅走 → **机械**从当前 affection 推一个基线（恋人比陌生人更信你 /
 *    更专一）。信任可为负（仇敌 = distrust）；忠诚不为负（陌生人 = 0，而非「负忠诚」）。
 *  - 醋意 jealousy：是「当下情绪态」不是性格特质，初始化时「没有正在吃醋」→ 保持 0
 *    （吃醋的*能力*由忠诚 gate 表达，见 xingye-state-curve）。本模块不播种它。
 *  - 黑化 corruption：和 affection 正交（深爱的人可以很纯也可以病娇），机械推不出来，
 *    只能从设定信号来 → 「LLM 定性档位优先（profile.corruptionTendency）+ 本地关键词
 *    扫描 profile/lore 兜底」。而且必须在初始化设基线——不能指望靠之后的 delta 慢慢爬
 *    （曲线让黑化「几乎只进难退」，靠单次互动累积既慢又不可靠）。
 *
 * 常量（比例 / 档位基线 / 关键词表）全部导出，跑起来不对味直接调。
 */

import type { XingyeCorruptionTendency } from './xingye-profile-store';

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

// ───────────────────────── 信任 / 忠诚：机械从好感推 ─────────────────────────

/** 信任 ≈ 好感 × 此比例（信任略滞后于好感：喜欢得多≠完全信任）。可调。 */
export const INIT_TRUST_FROM_AFFECTION_RATIO = 0.5;
/** 忠诚 ≈ 好感 × 此比例（更滞后；专一是慢慢攒出来的）。可调。 */
export const INIT_LOYALTY_FROM_AFFECTION_RATIO = 0.35;

export function deriveInitialTrustFromAffection(affection: number): number {
  // 跟关系深浅走；负好感 = 不信任（可为负）。
  return clampInt(affection * INIT_TRUST_FROM_AFFECTION_RATIO, -100, 100);
}

export function deriveInitialLoyaltyFromAffection(affection: number): number {
  // 同样跟深浅走，但不为负——陌生人 / 仇敌是「0 忠诚」，不是「负忠诚（主动背叛）」。
  return clampInt(Math.max(0, affection * INIT_LOYALTY_FROM_AFFECTION_RATIO), 0, 100);
}

// ───────────────────────── 黑化：定性档位 + 关键词兜底 ─────────────────────────

/** 档位 → 黑化初值基线（corruption 0..100）。可调。 */
export const CORRUPTION_SEED_BY_TENDENCY: Record<XingyeCorruptionTendency, number> = {
  none: 0,
  latent: 12, // 潜藏：一点阴影，留足上升空间
  marked: 28, // 明显：病娇/重占有预设，已带底色，但还没「碎」
};

export function corruptionSeedFromTendency(tendency: XingyeCorruptionTendency): number {
  return CORRUPTION_SEED_BY_TENDENCY[tendency] ?? 0;
}

/**
 * 「明显」级关键词：清晰的病娇 / 极端占有 / 控制信号。命中即 marked。
 * 列表刻意收窄，避免日常词误判；细腻语义交给 LLM 档位覆盖。
 */
export const CORRUPTION_MARKED_KEYWORDS: readonly string[] = [
  '病娇',
  '黑化',
  'yandere',
  '疯批',
  '偏执狂',
  '占有欲极强',
  '占有欲很强',
  '极端占有',
  '独占欲',
  '控制欲极强',
  '掌控欲极强',
  '不择手段',
  '囚禁',
  '监禁',
  '跟踪狂',
  '疯狂占有',
  '同归于尽',
  '毁掉你',
  '只能属于',
  '不许离开',
];

/**
 * 「潜藏」级关键词：偏占有 / 不安 / 善妒等较轻信号。命中（且无 marked 命中）即 latent。
 */
export const CORRUPTION_LATENT_KEYWORDS: readonly string[] = [
  '占有欲',
  '控制欲',
  '掌控欲',
  '善妒',
  '善嫉',
  '吃醋',
  '醋意',
  '猜忌',
  '多疑',
  '缺乏安全感',
  '没有安全感',
  '不安全感',
  '患得患失',
  '黏人',
  '依赖性强',
  '排他',
  '独占',
  '强势',
  '阴郁',
  '阴沉',
  '偏执',
];

/**
 * 扫描自由文本（profile 摘要 + 启用 lore 内容）判定黑化档位。
 * 先查 marked 再查 latent（marked 词可能包含 latent 子串，顺序保证「极强」走 marked）。
 */
export function detectCorruptionTendencyFromText(text: string): XingyeCorruptionTendency {
  const haystack = (text || '').toLowerCase();
  if (!haystack.trim()) return 'none';
  if (CORRUPTION_MARKED_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()))) return 'marked';
  if (CORRUPTION_LATENT_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()))) return 'latent';
  return 'none';
}

/**
 * 解析黑化初值：
 *  - explicitTendency 有值（含 'none'）→ 用它（LLM / 用户的权威判断，'none' 会压过关键词误命中）。
 *  - 否则 → 关键词扫 scanText 兜底。
 */
export function resolveInitialCorruption(
  explicitTendency: XingyeCorruptionTendency | undefined,
  scanText: string,
): number {
  const tendency = explicitTendency ?? detectCorruptionTendencyFromText(scanText);
  return corruptionSeedFromTendency(tendency);
}
