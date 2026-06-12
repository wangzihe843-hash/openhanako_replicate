import { describe, expect, it } from 'vitest';
import { resolveGiftEra } from './xingye-gift-era-resolver';

describe('resolveGiftEra（归属礼物集判定）', () => {
  it('空语料 → 默认 modern', () => {
    expect(resolveGiftEra(null).setId).toBe('modern');
    expect(resolveGiftEra({}).setId).toBe('modern');
  });

  it('仙侠角色：同时命中大量古代词，靠专属词+特异优先级胜出', () => {
    const resolution = resolveGiftEra({
      shortBio: '昆仑仙门的剑修，筑基期修士',
      backgroundSummary: '自小在宗门长大，靠灵石与丹药修炼，立志飞升仙界。常着青衫，往返于长安与洛阳之间。',
    });
    expect(resolution.setId).toBe('xianxia');
  });

  it('武侠角色 → wuxia（不混入仙侠）', () => {
    const resolution = resolveGiftEra({
      shortBio: '江湖上有名的女侠，轻功了得',
      backgroundSummary: '出身镖局，内功修为深厚，与各门派掌门多有恩怨，常在客栈酒楼歇脚。',
    });
    expect(resolution.setId).toBe('wuxia');
  });

  it('通用古代宫廷角色（无武侠/仙侠专属词）→ cn_ancient', () => {
    const resolution = resolveGiftEra({
      shortBio: '唐朝的公主',
      backgroundSummary: '生于宫廷，深得皇上宠爱，与丞相之子有婚约，常乘马车出游长安街市。',
    });
    expect(resolution.setId).toBe('cn_ancient');
  });

  it('赛博朋克角色 → cyberpunk（不落入 modern）', () => {
    const resolution = resolveGiftEra({
      shortBio: '夜之城的黑客',
      backgroundSummary: '装着义体和神经接口，替巨型企业跑灰色差事，霓虹灯下用信用点结账。',
    });
    expect(resolution.setId).toBe('cyberpunk');
  });

  it('现代都市角色 → modern', () => {
    const resolution = resolveGiftEra({
      shortBio: '咖啡店打工的大学生',
      backgroundSummary: '每天挤地铁上学，朋友圈里晒猫，攒钱买游戏机。',
    });
    expect(resolution.setId).toBe('modern');
  });

  it('lore 数组语料参与判定', () => {
    const resolution = resolveGiftEra({
      shortBio: '沉默寡言的拾荒者',
      lore: ['核战后的废土，辐射尘飘在每一个聚落上空', '瓶盖是硬通货，净水比命贵'],
    });
    expect(resolution.setId).toBe('wasteland');
  });

  // 回归：边境战乱军医（林雾）——背景里只有「药物配给」、童年信物只有「黄铜纽扣」，
  // 没有任何真正的世界观锚点。门控后这两个通用词都不计分，应稳定落到兜底 modern，
  // 与购物/二手一致。修复前会被 黄铜(steampunk) + tie-break 误判成蒸汽朋克。
  it('边境战乱军医（无世界信号）→ modern，不被黄铜/配给拉进异世界', () => {
    const resolution = resolveGiftEra({
      shortBio: '冷静克制的边境医者',
      backgroundSummary:
        '幼年生活在战乱阴影下的边境小城，街道有临时哨卡、避难棚。后来成为边境医者，长期在资源不足、环境混乱的地方救治伤员，熟悉创伤处理、感染控制、基础外科缝合、止血、药物配给和紧急撤离判断。',
      lore: [
        '蓝线风铃事件\n岑姨为了哄她不哭，把一枚缺了角的黄铜纽扣塞进她手心，说"疼的时候就数它的边"。',
      ],
    });
    expect(resolution.setId).toBe('modern');
    expect(resolution.scores.steampunk).toBe(0);
    expect(resolution.scores.wasteland).toBe(0);
  });

  it('黄铜单独出现不触发蒸汽朋克；有蒸汽朋克锚点同现才计分', () => {
    expect(resolveGiftEra({ backgroundSummary: '祖传的黄铜怀表和几枚齿轮零件。' }).setId).toBe('modern');
    expect(
      resolveGiftEra({
        shortBio: '蒸汽朋克都市的发明家',
        backgroundSummary: '驾着飞艇穿梭，工坊里堆满黄铜与齿轮。',
      }).setId,
    ).toBe('steampunk');
  });

  it('「药物配给/净水」单独出现不触发废土；有废土锚点同现才计分', () => {
    expect(
      resolveGiftEra({ backgroundSummary: '医院后勤，负责药物配给和净水供应。' }).setId,
    ).toBe('modern');
    expect(
      resolveGiftEra({
        shortBio: '末日废土的幸存者',
        backgroundSummary: '核战之后靠配给和净水活着。',
      }).setId,
    ).toBe('wasteland');
  });

  // 回归：不相干家族撞车时取原始高分者，绝不让低分集凭全局优先级翻盘。
  // 废土(末日22+瓶盖16=38) > 蒸汽朋克(飞艇22+维多利亚12=34) 且差 ≤6——
  // 修复前 tie-break 会因 steampunk 全局优先级更高而错判成蒸汽朋克。
  it('废土与蒸汽朋克分数接近且废土更高 → 取废土（不翻盘成蒸汽朋克）', () => {
    const resolution = resolveGiftEra({
      backgroundSummary: '驾着飞艇穿行在末日废土，靠瓶盖交易，偶尔翻出维多利亚式的旧物。',
    });
    expect(resolution.scores.wasteland).toBeGreaterThan(resolution.scores.steampunk);
    expect(resolution.scores.steampunk).toBeGreaterThanOrEqual(14);
    expect(resolution.setId).toBe('wasteland');
  });
});
