import { describe, expect, it } from 'vitest';
import { resolveNewsEra } from './xingye-news-era-resolver';

describe('resolveNewsEra（报纸笔调 era 判定）', () => {
  it('空语料 → 默认 modern_or_future', () => {
    expect(resolveNewsEra(null).era).toBe('modern_or_future');
    expect(resolveNewsEra({}).era).toBe('modern_or_future');
  });

  it('古风/仙侠角色 → oriental_classical', () => {
    expect(
      resolveNewsEra({
        shortBio: '昆仑仙门的剑修',
        backgroundSummary: '宗门里靠灵石丹药修炼，往返于长安洛阳。',
      }).era,
    ).toBe('oriental_classical');
  });

  it('赛博/废土角色 → modern_or_future', () => {
    expect(
      resolveNewsEra({
        shortBio: '夜城的黑客',
        backgroundSummary: '装着义体，霓虹下用信用点交易。',
      }).era,
    ).toBe('modern_or_future');
  });

  // 回归：边境战乱军医（林雾）——童年信物只有「黄铜纽扣」，没有任何蒸汽朋克/奇幻锚点。
  // 门控后 黄铜 不计分，应落到兜底 modern_or_future（现代狗仔体），而非被拽进欧洲奇幻译体。
  it('边境战乱军医（无世界信号）→ modern_or_future，不被黄铜拉进西方奇幻', () => {
    const resolution = resolveNewsEra({
      shortBio: '冷静克制的边境医者',
      backgroundSummary:
        '幼年在战乱阴影下的边境小城长大，后来成为边境医者，熟悉创伤处理、感染控制、止血和药物配给。',
      lore: ['岑姨把一枚缺了角的黄铜纽扣塞进她手心，说"疼的时候就数它的边"。'],
    });
    expect(resolution.era).toBe('modern_or_future');
    expect(resolution.scores.western_fantasy).toBe(0);
  });

  it('黄铜单独不触发西方奇幻；有蒸汽朋克锚点同现才计分', () => {
    expect(resolveNewsEra({ backgroundSummary: '祖传的黄铜怀表和几枚齿轮。' }).era).toBe(
      'modern_or_future',
    );
    expect(
      resolveNewsEra({
        shortBio: '蒸汽朋克都市的发明家',
        backgroundSummary: '驾着飞艇穿梭，工坊里堆满黄铜与齿轮。',
      }).era,
    ).toBe('western_fantasy');
  });
});
