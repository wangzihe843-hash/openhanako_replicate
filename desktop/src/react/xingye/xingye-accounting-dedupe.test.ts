import { describe, expect, it } from 'vitest';
import {
  detectCommuteSlot,
  detectMealSlot,
  filterMonthlyDuplicates,
  filterSameDayCommuteSlotDuplicates,
  filterSameDayDuplicates,
  filterSameDayMealSlotDuplicates,
  hasMultipleJobsByProfile,
} from './xingye-accounting-dedupe';
import type { LedgerEntry } from './xingye-accounting-ledger';
import type { XingyeRoleProfile } from './xingye-profile-store';

function profile(partial: Partial<XingyeRoleProfile>): XingyeRoleProfile {
  return { agentId: 'a', updatedAt: '', ...partial };
}

function existing(partial: Partial<LedgerEntry> & { id: string }): LedgerEntry {
  return {
    source: 'accounting',
    origin: 'native',
    direction: 'expense',
    title: '',
    amount: 0,
    currency: '¥',
    realized: true,
    occurredAt: '2026-05-27T00:00:00.000Z',
    ...partial,
  };
}

describe('filterMonthlyDuplicates', () => {
  it('丢掉与已有 (年-月, 月度类目) 撞车的草稿', () => {
    const drafts = [
      { title: '这个月房租', category: '房租', occurredAt: '2026-05-15T00:00:00.000Z' },
      { title: '电话费', category: '通讯', occurredAt: '2026-05-10T00:00:00.000Z' },
    ];
    const result = filterMonthlyDuplicates(drafts, [
      existing({ id: 'e1', category: '房租', occurredAt: '2026-05-01T00:00:00.000Z' }),
    ]);
    expect(result.map((r) => r.title)).toEqual(['电话费']);
  });

  it('本批内同 (年-月, 月度类目) 也会去重（第二条丢）', () => {
    const drafts = [
      { title: '房租 A', category: '房租', occurredAt: '2026-05-01T00:00:00.000Z' },
      { title: '房租 B', category: '房租', occurredAt: '2026-05-30T00:00:00.000Z' },
    ];
    const result = filterMonthlyDuplicates(drafts, []);
    expect(result.map((r) => r.title)).toEqual(['房租 A']);
  });

  it('不同月的房租不去重', () => {
    const drafts = [
      { title: '4 月房租', category: '房租', occurredAt: '2026-04-10T00:00:00.000Z' },
      { title: '5 月房租', category: '房租', occurredAt: '2026-05-10T00:00:00.000Z' },
    ];
    const result = filterMonthlyDuplicates(drafts, []);
    expect(result).toHaveLength(2);
  });

  it('非月度类目（餐饮 / 交通 / 咖啡）一概不限', () => {
    const drafts = [
      { title: '午饭 1', category: '餐饮', occurredAt: '2026-05-10T00:00:00.000Z' },
      { title: '午饭 2', category: '餐饮', occurredAt: '2026-05-11T00:00:00.000Z' },
      { title: '午饭 3', category: '餐饮', occurredAt: '2026-05-12T00:00:00.000Z' },
    ];
    const result = filterMonthlyDuplicates(drafts, []);
    expect(result).toHaveLength(3);
  });

  it('购物 / 二手投影来的 entries 不参与 occupied 计算', () => {
    const drafts = [{ title: '房租', category: '房租', occurredAt: '2026-05-15T00:00:00.000Z' }];
    const result = filterMonthlyDuplicates(drafts, [
      existing({
        id: 's1',
        source: 'shopping',
        category: '房租',
        occurredAt: '2026-05-01T00:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1); // 购物的"房租"投影不阻塞记账的真房租
  });

  it('类目近义词（"通讯费" → "通讯"）也会被归一拦截', () => {
    const drafts = [
      { title: '电话费', category: '通讯费', occurredAt: '2026-05-15T00:00:00.000Z' },
    ];
    const result = filterMonthlyDuplicates(drafts, [
      existing({ id: 'e1', category: '通讯', occurredAt: '2026-05-01T00:00:00.000Z' }),
    ]);
    expect(result).toHaveLength(0);
  });
});

describe('filterSameDayDuplicates', () => {
  it('同天 + 完全相同 title → 第二条丢', () => {
    const drafts = [
      {
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T12:00:00.000Z',
      },
    ];
    const result = filterSameDayDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T11:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('同天 + 不同 title（午饭 / 晚饭）→ 保留', () => {
    const drafts = [
      {
        title: '巷口面摊晚饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 22,
        occurredAt: '2026-05-27T19:00:00.000Z',
      },
    ];
    const result = filterSameDayDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T12:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('同天 + 同四元组（cat+cp+amount，title 不同）→ 仍判重复', () => {
    const drafts = [
      {
        title: '面摊',  // 简写，但 cat+cp+amount 全撞
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T12:30:00.000Z',
      },
    ];
    const result = filterSameDayDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T11:30:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('一天两次打车（cat 同、counterparty 不同）→ 不去重', () => {
    const drafts = [
      {
        title: '打车去机场',
        category: '交通',
        counterparty: '滴滴',
        amount: 60,
        occurredAt: '2026-05-27T07:00:00.000Z',
      },
      {
        title: '打车回家',
        category: '交通',
        counterparty: '高德',
        amount: 35,
        occurredAt: '2026-05-27T22:00:00.000Z',
      },
    ];
    const result = filterSameDayDuplicates(drafts, []);
    expect(result).toHaveLength(2);
  });

  it('不同天的同质条目不去重（昨天 vs 今天的相同午饭都允许）', () => {
    const drafts = [
      {
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T12:00:00.000Z',
      },
    ];
    const result = filterSameDayDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-26T12:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('本批内同天同 title 也会去重（AI 一次返回 2 条相同）', () => {
    const drafts = [
      {
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T12:00:00.000Z',
      },
      {
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T13:00:00.000Z',
      },
    ];
    const result = filterSameDayDuplicates(drafts, []);
    expect(result).toHaveLength(1);
  });

  it('购物 / 二手投影来的 entries 不参与 occupied 计算', () => {
    // 购物模块可能记过"巷口面摊午饭"作为奇怪边缘 case；
    // 不应该阻断 accounting 自己的"巷口面摊午饭"。
    const drafts = [
      {
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T12:00:00.000Z',
      },
    ];
    const result = filterSameDayDuplicates(drafts, [
      existing({
        id: 'shop1',
        source: 'shopping',
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T11:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('没 occurredAt 的 draft 直接放过（不参与去重）', () => {
    const drafts = [
      {
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: undefined,
      },
    ];
    const result = filterSameDayDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '巷口面摊午饭',
        category: '餐饮',
        counterparty: '巷口面摊',
        amount: 18,
        occurredAt: '2026-05-27T12:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1);
  });
});

describe('detectMealSlot', () => {
  it('"巷口面摊午饭" → lunch', () => {
    expect(detectMealSlot('巷口面摊午饭', '')).toBe('lunch');
  });

  it('"清晨小笼包早点" → breakfast', () => {
    expect(detectMealSlot('清晨小笼包早点', undefined)).toBe('breakfast');
  });

  it('"夜市烤串晚餐" → dinner', () => {
    expect(detectMealSlot('夜市烤串晚餐', undefined)).toBe('dinner');
  });

  it('content 里的关键词也能命中', () => {
    expect(detectMealSlot('街角小馆', '今天的午饭')).toBe('lunch');
  });

  it('"咖啡店自习" → null（咖啡不算三餐）', () => {
    expect(detectMealSlot('咖啡店自习', '点了杯拿铁')).toBeNull();
  });

  it('"下午茶 + 蛋糕" → null', () => {
    expect(detectMealSlot('街角下午茶', '一块蛋糕一杯红茶')).toBeNull();
  });

  it('"宵夜烧烤" → null', () => {
    expect(detectMealSlot('宵夜烧烤', undefined)).toBeNull();
  });

  it('"零食 / 水果" → null', () => {
    expect(detectMealSlot('便利店零食', undefined)).toBeNull();
    expect(detectMealSlot('水果摊', undefined)).toBeNull();
  });

  it('空 title 和 content → null', () => {
    expect(detectMealSlot('', '')).toBeNull();
    expect(detectMealSlot(undefined, undefined)).toBeNull();
  });

  it('"早午餐 / brunch" → breakfast（替代早餐，不是替代午餐）', () => {
    expect(detectMealSlot('周末早午餐', undefined)).toBe('breakfast');
    expect(detectMealSlot('Sunday brunch', undefined)).toBe('breakfast');
  });
});

describe('filterSameDayMealSlotDuplicates', () => {
  it('同一天 "巷口面摊午饭" + "卤肉饭午饭" → 第二条被丢', () => {
    const drafts = [
      {
        title: '卤肉饭午饭',
        content: '换了家试试，22 元',
        occurredAt: '2026-05-27T13:00:00.000Z',
      },
    ];
    const result = filterSameDayMealSlotDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '巷口面摊午饭',
        occurredAt: '2026-05-27T12:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('同一天 早饭 + 午饭 + 晚饭 → 全保留', () => {
    const drafts = [
      { title: '小笼包早点', occurredAt: '2026-05-27T08:00:00.000Z' },
      { title: '面摊午饭', occurredAt: '2026-05-27T12:00:00.000Z' },
      { title: '烤串晚餐', occurredAt: '2026-05-27T19:00:00.000Z' },
    ];
    const result = filterSameDayMealSlotDuplicates(drafts, []);
    expect(result).toHaveLength(3);
  });

  it('同一天 午饭 + 咖啡 + 下午茶 + 宵夜 → 全保留（只有午饭占 slot）', () => {
    const drafts = [
      { title: '街角小馆午饭', occurredAt: '2026-05-27T12:00:00.000Z' },
      { title: '咖啡店拿铁', content: '点了杯咖啡', occurredAt: '2026-05-27T15:00:00.000Z' },
      { title: '下午茶', content: '蛋糕加红茶', occurredAt: '2026-05-27T16:00:00.000Z' },
      { title: '宵夜烧烤', occurredAt: '2026-05-27T23:00:00.000Z' },
    ];
    const result = filterSameDayMealSlotDuplicates(drafts, []);
    expect(result).toHaveLength(4);
  });

  it('本批内同一天两顿午饭 → 第二条丢', () => {
    const drafts = [
      { title: '面摊午饭', occurredAt: '2026-05-27T12:00:00.000Z' },
      { title: '盖饭午餐', occurredAt: '2026-05-27T13:00:00.000Z' },
    ];
    const result = filterSameDayMealSlotDuplicates(drafts, []);
    expect(result.map((r) => r.title)).toEqual(['面摊午饭']);
  });

  it('不同天的午饭可以都保留', () => {
    const drafts = [
      { title: '面摊午饭', occurredAt: '2026-05-26T12:00:00.000Z' },
      { title: '盖饭午餐', occurredAt: '2026-05-27T12:00:00.000Z' },
    ];
    const result = filterSameDayMealSlotDuplicates(drafts, []);
    expect(result).toHaveLength(2);
  });

  it('没 occurredAt 的 draft 放过', () => {
    const drafts = [
      { title: '某顿午饭', occurredAt: undefined },
    ];
    const result = filterSameDayMealSlotDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '已有的午饭',
        occurredAt: '2026-05-27T12:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('购物 / 二手投影来的 entries 不参与 slot 占用', () => {
    const drafts = [
      { title: '面摊午饭', occurredAt: '2026-05-27T12:00:00.000Z' },
    ];
    const result = filterSameDayMealSlotDuplicates(drafts, [
      existing({
        id: 'shop1',
        source: 'shopping',
        title: '便当午饭',
        occurredAt: '2026-05-27T11:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('识别不出 slot 的草稿（咖啡 / 零食）不参与去重', () => {
    const drafts = [
      { title: '咖啡店自习', content: '一杯拿铁', occurredAt: '2026-05-27T15:00:00.000Z' },
    ];
    const result = filterSameDayMealSlotDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '街角咖啡',
        occurredAt: '2026-05-27T10:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1); // 两条都不在 slot 里，互不阻塞
  });
});

describe('detectCommuteSlot', () => {
  it('识别"打车去上班" → to_work', () => {
    expect(detectCommuteSlot('打车去上班', undefined)).toBe('to_work');
  });

  it('识别"上学" / "去公司" / "去办公室" → to_work', () => {
    expect(detectCommuteSlot('地铁上学', undefined)).toBe('to_work');
    expect(detectCommuteSlot('共享单车去公司', undefined)).toBe('to_work');
    expect(detectCommuteSlot('打车去办公室', undefined)).toBe('to_work');
  });

  it('识别"下班 / 放学 / 收工" → from_work', () => {
    expect(detectCommuteSlot('打车下班', undefined)).toBe('from_work');
    expect(detectCommuteSlot('地铁放学回家', undefined)).toBe('from_work');
    expect(detectCommuteSlot('收工后买菜', undefined)).toBe('from_work');
  });

  it('"出差去机场" / "周末逛街" / "去医院" 不算通勤 → null', () => {
    expect(detectCommuteSlot('出差去机场', undefined)).toBeNull();
    expect(detectCommuteSlot('周末逛街打车', undefined)).toBeNull();
    expect(detectCommuteSlot('打车去医院', undefined)).toBeNull();
  });

  it('title 没线索时读 content', () => {
    expect(detectCommuteSlot('滴滴打车', '上班路上下雨')).toBe('to_work');
  });

  it('同文本里上下都出现 → 优先 to_work', () => {
    expect(detectCommuteSlot('上班打车', '下班还要再打一次')).toBe('to_work');
  });
});

describe('hasMultipleJobsByProfile', () => {
  it('明示兼职 → true', () => {
    expect(
      hasMultipleJobsByProfile(profile({ backgroundSummary: '上班族，下班后兼职做家教' })),
    ).toBe(true);
  });

  it('外卖员 / 网约车 / 代驾 / 跑腿 → true', () => {
    expect(hasMultipleJobsByProfile(profile({ identitySummary: '美团外卖员' }))).toBe(true);
    expect(hasMultipleJobsByProfile(profile({ identitySummary: '滴滴司机' }))).toBe(true);
    expect(hasMultipleJobsByProfile(profile({ identitySummary: '兼职代驾' }))).toBe(true);
    expect(hasMultipleJobsByProfile(profile({ identitySummary: '跑腿小哥' }))).toBe(true);
  });

  it('倒班 / 三班倒 / 轮班 → true', () => {
    expect(hasMultipleJobsByProfile(profile({ backgroundSummary: '医院护士，三班倒' }))).toBe(true);
    expect(hasMultipleJobsByProfile(profile({ backgroundSummary: '工厂轮班工人' }))).toBe(true);
  });

  it('普通上班族 → false', () => {
    expect(
      hasMultipleJobsByProfile(profile({ identitySummary: '一名普通的程序员' })),
    ).toBe(false);
  });

  it('null / 空 profile → false', () => {
    expect(hasMultipleJobsByProfile(null)).toBe(false);
    expect(hasMultipleJobsByProfile(undefined)).toBe(false);
    expect(hasMultipleJobsByProfile(profile({}))).toBe(false);
  });
});

describe('filterSameDayCommuteSlotDuplicates', () => {
  it('同一天三种交通方式都"去上班" → 只留 1 条', () => {
    const drafts = [
      { title: '打车去上班', occurredAt: '2026-05-27T08:00:00.000Z' },
      { title: '骑共享单车去上班', occurredAt: '2026-05-27T08:30:00.000Z' },
      { title: '地铁去上班', occurredAt: '2026-05-27T09:00:00.000Z' },
    ];
    const result = filterSameDayCommuteSlotDuplicates(drafts, []);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('打车去上班');
  });

  it('一天 1 次去上班 + 1 次下班 → 都保留', () => {
    const drafts = [
      { title: '打车去上班', occurredAt: '2026-05-27T08:00:00.000Z' },
      { title: '地铁下班', occurredAt: '2026-05-27T18:00:00.000Z' },
    ];
    const result = filterSameDayCommuteSlotDuplicates(drafts, []);
    expect(result).toHaveLength(2);
  });

  it('已有「打车去上班」时，新草稿同 slot 被丢', () => {
    const drafts = [{ title: '地铁去上班', occurredAt: '2026-05-27T09:00:00.000Z' }];
    const result = filterSameDayCommuteSlotDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '打车去上班',
        occurredAt: '2026-05-27T08:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('skipDedupe=true 时通通放过（兼职 / 跑单 agent）', () => {
    const drafts = [
      { title: '打车去上班', occurredAt: '2026-05-27T08:00:00.000Z' },
      { title: '骑车去送外卖', occurredAt: '2026-05-27T11:00:00.000Z' },
      { title: '地铁去公司', occurredAt: '2026-05-27T14:00:00.000Z' },
    ];
    const result = filterSameDayCommuteSlotDuplicates(drafts, [], { skipDedupe: true });
    expect(result).toHaveLength(3);
  });

  it('非通勤场景（出差 / 周末打车 / 接送朋友）不去重', () => {
    const drafts = [
      { title: '打车出差去机场', occurredAt: '2026-05-27T07:00:00.000Z' },
      { title: '周末打车逛街', occurredAt: '2026-05-27T15:00:00.000Z' },
      { title: '接送朋友去医院', occurredAt: '2026-05-27T20:00:00.000Z' },
    ];
    const result = filterSameDayCommuteSlotDuplicates(drafts, []);
    expect(result).toHaveLength(3);
  });

  it('不同天的"去上班"互不阻塞', () => {
    const drafts = [
      { title: '地铁去上班', occurredAt: '2026-05-27T09:00:00.000Z' },
    ];
    const result = filterSameDayCommuteSlotDuplicates(drafts, [
      existing({
        id: 'e1',
        title: '打车去上班',
        occurredAt: '2026-05-26T08:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('购物 / 二手投影来的 entries 不参与 occupied 计算', () => {
    const drafts = [{ title: '地铁去上班', occurredAt: '2026-05-27T09:00:00.000Z' }];
    const result = filterSameDayCommuteSlotDuplicates(drafts, [
      existing({
        id: 'shop1',
        source: 'shopping',
        title: '打车去上班',
        occurredAt: '2026-05-27T08:00:00.000Z',
      }),
    ]);
    expect(result).toHaveLength(1);
  });
});
