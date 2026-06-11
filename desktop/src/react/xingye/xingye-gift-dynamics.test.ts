import { describe, expect, it } from 'vitest';
import {
  GIFT_CORRUPTION_DARK_TIER,
  resolveGiftFamiliarity,
  resolveGiftReaction,
} from './xingye-gift-dynamics';

describe('resolveGiftFamiliarity（认知矩阵）', () => {
  it('本世界观 → native', () => {
    expect(resolveGiftFamiliarity('modern', 'modern')).toBe('native');
    expect(resolveGiftFamiliarity('xianxia', 'xianxia')).toBe('native');
  });

  it('虚构集对其所含真实历史集 → mundane（武侠/仙侠→中国古代、西幻→中世纪）', () => {
    expect(resolveGiftFamiliarity('wuxia', 'cn_ancient')).toBe('mundane');
    expect(resolveGiftFamiliarity('xianxia', 'cn_ancient')).toBe('mundane');
    expect(resolveGiftFamiliarity('west_fantasy', 'west_medieval')).toBe('mundane');
  });

  it('真实历史集对时间线在其后的世界观 → historical', () => {
    expect(resolveGiftFamiliarity('modern', 'cn_ancient')).toBe('historical');
    expect(resolveGiftFamiliarity('modern', 'west_medieval')).toBe('historical');
    expect(resolveGiftFamiliarity('modern', 'republican')).toBe('historical');
    expect(resolveGiftFamiliarity('republican', 'cn_ancient')).toBe('historical');
    // 平行未来继承现代人的全部真实历史认知；现代本身对它们是「近过去/战前」
    expect(resolveGiftFamiliarity('cyberpunk', 'modern')).toBe('historical');
    expect(resolveGiftFamiliarity('wasteland', 'modern')).toBe('historical');
    expect(resolveGiftFamiliarity('space', 'cn_ancient')).toBe('historical');
    // 蒸汽朋克 ≈ 维多利亚：古代真实集是历史
    expect(resolveGiftFamiliarity('steampunk', 'west_medieval')).toBe('historical');
    expect(resolveGiftFamiliarity('steampunk', 'cn_ancient')).toBe('historical');
  });

  it('其余一切 → alien（过去对未来 / 同期异域 / 虚构集对外人 / 平行未来互相）', () => {
    expect(resolveGiftFamiliarity('cn_ancient', 'modern')).toBe('alien'); // 古代人没见过游戏机
    expect(resolveGiftFamiliarity('cn_ancient', 'west_medieval')).toBe('alien'); // 同期异域
    expect(resolveGiftFamiliarity('modern', 'wuxia')).toBe('alien'); // 现代人没见过灵石/秘籍这类虚构特有物
    expect(resolveGiftFamiliarity('modern', 'xianxia')).toBe('alien');
    expect(resolveGiftFamiliarity('modern', 'cyberpunk')).toBe('alien'); // 未来对现代也是未知
    expect(resolveGiftFamiliarity('cyberpunk', 'wasteland')).toBe('alien'); // 平行未来互相陌生
    expect(resolveGiftFamiliarity('wuxia', 'west_fantasy')).toBe('alien'); // 跨文明虚构
    expect(resolveGiftFamiliarity('steampunk', 'republican')).toBe('alien'); // 同期异域
    expect(resolveGiftFamiliarity('steampunk', 'modern')).toBe('alien'); // 未来对蒸汽朋克
  });
});

describe('resolveGiftReaction（送礼数值查表）', () => {
  const base = { temperament: 'gracious' as const, currentCorruption: 0 };

  it('命中最爱：大额正向；重复命中减半但特效保留', () => {
    const first = resolveGiftReaction({ ...base, familiarity: 'native', stance: 'loved', isFavorite: true });
    expect(first.tier).toBe('favorite');
    expect(first.impulse.affectionDelta).toBe(14);
    expect(first.impulse.trustDelta).toBe(4);

    const repeat = resolveGiftReaction({
      ...base, familiarity: 'native', stance: 'loved', isFavorite: true, favoriteHitBefore: true,
    });
    expect(repeat.tier).toBe('favorite');
    expect(repeat.impulse.affectionDelta).toBe(7);
  });

  it('native liked → pleased；volatile 放大', () => {
    const normal = resolveGiftReaction({ ...base, familiarity: 'native', stance: 'liked' });
    expect(normal.tier).toBe('pleased');
    expect(normal.impulse.affectionDelta).toBe(7);

    const volatile = resolveGiftReaction({
      familiarity: 'native', stance: 'liked', temperament: 'volatile', currentCorruption: 0,
    });
    expect(volatile.impulse.affectionDelta).toBeGreaterThan(normal.impulse.affectionDelta);
  });

  it('native neutral → flat；挑剔角色更不领情', () => {
    expect(resolveGiftReaction({ ...base, familiarity: 'native', stance: 'neutral' }).impulse.affectionDelta).toBe(3);
    expect(resolveGiftReaction({
      familiarity: 'native', stance: 'neutral', temperament: 'picky', currentCorruption: 0,
    }).impulse.affectionDelta).toBe(1);
  });

  it('native disliked：常态不翻脸；高黑化掉好感且黑化微涨（用户拍板的非通用设计）', () => {
    const calm = resolveGiftReaction({
      familiarity: 'native', stance: 'disliked', temperament: 'picky', currentCorruption: 0,
    });
    expect(calm.tier).toBe('displeased');
    expect(calm.impulse.affectionDelta).toBe(0);

    const dark = resolveGiftReaction({
      familiarity: 'native', stance: 'disliked', temperament: 'picky',
      currentCorruption: GIFT_CORRUPTION_DARK_TIER,
    });
    expect(dark.impulse.affectionDelta).toBeLessThan(0);
    expect(dark.impulse.corruptionDelta).toBeGreaterThan(0);

    // 宽和角色：高黑化的负反应减半；非黑化甚至小幅领情
    const graciousDark = resolveGiftReaction({
      familiarity: 'native', stance: 'disliked', temperament: 'gracious',
      currentCorruption: GIFT_CORRUPTION_DARK_TIER,
    });
    expect(graciousDark.impulse.affectionDelta).toBeGreaterThan(dark.impulse.affectionDelta);
    const graciousCalm = resolveGiftReaction({
      familiarity: 'native', stance: 'disliked', temperament: 'gracious', currentCorruption: 0,
    });
    expect(graciousCalm.impulse.affectionDelta).toBe(1);
  });

  it('mundane → flat 小额；historical → 古董有心，可观正向', () => {
    expect(resolveGiftReaction({ ...base, familiarity: 'mundane' }).tier).toBe('flat');
    const historical = resolveGiftReaction({ ...base, familiarity: 'historical' });
    expect(historical.tier).toBe('pleased');
    expect(historical.impulse.affectionDelta).toBe(5);
  });

  it('alien → curious；常态小正向（新奇），高黑化零增益（警惕）', () => {
    const calm = resolveGiftReaction({ ...base, familiarity: 'alien' });
    expect(calm.tier).toBe('curious');
    expect(calm.impulse.affectionDelta).toBe(2);

    const dark = resolveGiftReaction({
      familiarity: 'alien', temperament: 'gracious',
      currentCorruption: GIFT_CORRUPTION_DARK_TIER,
    });
    expect(dark.tier).toBe('curious');
    expect(dark.impulse.affectionDelta).toBe(0);
  });
});
