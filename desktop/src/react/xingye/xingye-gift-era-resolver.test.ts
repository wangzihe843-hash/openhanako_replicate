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
});
