import { describe, expect, it } from 'vitest';
import {
  collectionKeywordSourceText,
  dedupeItemDrafts,
  extractCollectionKeywords,
  extractItemCoreType,
  isRepurchasableConsumable,
  itemMatchesCollection,
  normalizeItemNameForDedup,
} from './xingye-item-dedupe';

const NOW = Date.parse('2026-06-04T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('normalizeItemNameForDedup', () => {
  it('trims, strips spaces / punctuation / wrappers, lowercases ascii', () => {
    expect(normalizeItemNameForDedup('  胶片相机  ')).toBe('胶片相机');
    expect(normalizeItemNameForDedup('《旧·书架》')).toBe('旧书架');
    expect(normalizeItemNameForDedup('Film Camera')).toBe('filmcamera');
  });
  it('non-string / blank → empty', () => {
    expect(normalizeItemNameForDedup('')).toBe('');
    expect(normalizeItemNameForDedup(undefined as never)).toBe('');
  });
});

describe('extractItemCoreType', () => {
  it('strips leading color / material / size modifiers to a core noun', () => {
    expect(extractItemCoreType('黑色台灯')).toBe('台灯');
    expect(extractItemCoreType('白色台灯')).toBe('台灯');
    expect(extractItemCoreType('实木书架')).toBe('书架');
    expect(extractItemCoreType('大号帆布包')).toBe('包'); // 大号 + 帆布 都剥掉
  });
  it('leaves non-modifier names intact (不误伤词中的同形字)', () => {
    expect(extractItemCoreType('咖啡机')).toBe('咖啡机'); // 咖啡 不是修饰词
    expect(extractItemCoreType('台灯')).toBe('台灯');
    expect(extractItemCoreType('落地灯')).toBe('落地灯'); // 与「台灯」核心不同 → 不会折叠
  });
});

describe('isRepurchasableConsumable', () => {
  it('true for consumable buckets / consumable tags, false for durables', () => {
    expect(isRepurchasableConsumable('日用', undefined)).toBe(true);
    expect(isRepurchasableConsumable('餐饮', undefined)).toBe(true);
    expect(isRepurchasableConsumable('数码', ['日用品'])).toBe(true);
    expect(isRepurchasableConsumable('数码', undefined)).toBe(false);
    expect(isRepurchasableConsumable(undefined, ['实木'])).toBe(false);
  });
});

describe('extractCollectionKeywords / itemMatchesCollection', () => {
  it('pulls collected nouns from lore-ish text', () => {
    expect(extractCollectionKeywords('她平时喜欢收集老相机，攒了一柜子')).toContain('老相机');
    expect(extractCollectionKeywords('资深红酒收藏家')).toContain('红酒');
    expect(extractCollectionKeywords('手办控，房间里全是高达')).toContain('手办');
    expect(extractCollectionKeywords('一个普通的边境医生')).toEqual([]);
  });
  it('matches items by collection keyword containment', () => {
    expect(itemMatchesCollection('1982年红酒', ['红酒'])).toBe(true);
    expect(itemMatchesCollection('胶片相机', ['红酒'])).toBe(false);
    expect(itemMatchesCollection('任何东西', [])).toBe(false);
  });
});

describe('dedupeItemDrafts · variant collapse (核心品类)', () => {
  const mk = (itemName: string, extra: Partial<{ category: string; tags: string[]; occurredAt: string }> = {}) => ({
    itemName,
    ...extra,
  });

  it('collapses color/material variants of the same core (黑/白台灯算同一件)', () => {
    const { kept, dropped } = dedupeItemDrafts([mk('白色台灯')], [mk('黑色台灯')], { nowMs: NOW });
    expect(kept).toHaveLength(0);
    expect(dropped.map((d) => d.itemName)).toEqual(['白色台灯']);
  });

  it('keeps genuinely different cores (台灯 vs 落地灯)', () => {
    const { kept } = dedupeItemDrafts([mk('落地灯')], [mk('黑色台灯')], { nowMs: NOW });
    expect(kept).toHaveLength(1);
  });

  it('dedups within the same batch by core', () => {
    const { kept, dropped } = dedupeItemDrafts([mk('黑色台灯'), mk('白色台灯'), mk('书架')], [], { nowMs: NOW });
    expect(kept.map((k) => k.itemName)).toEqual(['黑色台灯', '书架']);
    expect(dropped.map((d) => d.itemName)).toEqual(['白色台灯']);
  });
});

describe('dedupeItemDrafts · secondhand (exemptConsumables=false)', () => {
  const mk = (itemName: string, category?: string) => ({ itemName, category, occurredAt: daysAgo(1) });

  it('consumables are NOT exempt — blanket no-dup', () => {
    const { kept, dropped } = dedupeItemDrafts([mk('过期奶粉', '日用')], [mk('过期奶粉', '日用')], {
      exemptConsumables: false,
      nowMs: NOW,
    });
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it('collection items bypass dedup even in secondhand', () => {
    const { kept } = dedupeItemDrafts(
      [{ itemName: '勃艮第红酒', occurredAt: daysAgo(1) }],
      [{ itemName: '波尔多红酒', occurredAt: daysAgo(2) }],
      { exemptConsumables: false, collectionKeywords: ['红酒'], nowMs: NOW },
    );
    expect(kept).toHaveLength(1);
  });
});

describe('dedupeItemDrafts · shopping consumable window (exemptConsumables=true)', () => {
  const consumable = (itemName: string, occurredAt: string) => ({ itemName, category: '日用', occurredAt });

  it('same consumable within window → dropped', () => {
    const { kept, dropped } = dedupeItemDrafts(
      [consumable('牙膏', daysAgo(0))],
      [consumable('牙膏', daysAgo(10))], // 10 天前买过，<30 天窗口
      { exemptConsumables: true, consumableWindowDays: 30, nowMs: NOW },
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it('same consumable beyond window → kept (允许隔段时间再买)', () => {
    const { kept } = dedupeItemDrafts(
      [consumable('牙膏', daysAgo(0))],
      [consumable('牙膏', daysAgo(40))], // 40 天前，超 30 天窗口
      { exemptConsumables: true, consumableWindowDays: 30, nowMs: NOW },
    );
    expect(kept).toHaveLength(1);
  });

  it('two identical consumables in one batch (same date) → second dropped (不许一周三管牙膏)', () => {
    const { kept, dropped } = dedupeItemDrafts(
      [consumable('牙膏', daysAgo(2)), consumable('牙膏', daysAgo(3))],
      [],
      { exemptConsumables: true, consumableWindowDays: 30, nowMs: NOW },
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });

  it('durable dup still blocked; collection item kept', () => {
    const { kept, dropped } = dedupeItemDrafts(
      [
        { itemName: '机械键盘', category: '数码', occurredAt: daysAgo(1) },
        { itemName: '2019红酒', category: '酒水', occurredAt: daysAgo(1) },
      ],
      [{ itemName: '机械键盘', category: '数码', occurredAt: daysAgo(200) }],
      { exemptConsumables: true, collectionKeywords: ['红酒'], consumableWindowDays: 30, nowMs: NOW },
    );
    expect(kept.map((k) => k.itemName)).toEqual(['2019红酒']); // 键盘 200 天前也照样去重；红酒是收藏品放行
    expect(dropped.map((d) => d.itemName)).toEqual(['机械键盘']);
  });

  it('同一核心品类被标成不同类目（耐用 vs 消耗）时按消耗品时间窗统一判重，窗口内真重复不漏', () => {
    // 牙膏曾被标「美容」(非消耗桶→旧实现进 durableSeen)，本批又被标「日用」(消耗)——
    // 旧实现两表互不可见会放过；修复后整个 core 统一走消耗品窗口，窗口内判为重复。
    const within = dedupeItemDrafts(
      [{ itemName: '牙膏', category: '日用', occurredAt: daysAgo(0) }],
      [{ itemName: '牙膏', category: '美容', occurredAt: daysAgo(5) }],
      { exemptConsumables: true, consumableWindowDays: 30, nowMs: NOW },
    );
    expect(within.kept).toHaveLength(0);
    expect(within.dropped.map((d) => d.itemName)).toEqual(['牙膏']);

    // 超窗口仍允许再买（消耗品窗口语义未被破坏）。
    const beyond = dedupeItemDrafts(
      [{ itemName: '牙膏', category: '日用', occurredAt: daysAgo(0) }],
      [{ itemName: '牙膏', category: '美容', occurredAt: daysAgo(40) }],
      { exemptConsumables: true, consumableWindowDays: 30, nowMs: NOW },
    );
    expect(beyond.kept).toHaveLength(1);
  });
});

describe('dedupeItemDrafts · treatReturnedAsUnowned (退货品不占判重槽位)', () => {
  it('returned-only durable core → re-buy kept (否则 prompt 劝再买被兜底丢弃)', () => {
    // 实木书架退过货，只有这一条 → 当前没拥有 → 再买同核心耐用品应放行。
    const { kept, dropped } = dedupeItemDrafts(
      [{ itemName: '白色书架', category: '家具', occurredAt: daysAgo(0) }],
      [{ itemName: '实木书架', category: '家具', occurredAt: daysAgo(5), status: 'returned' }],
      { exemptConsumables: true, treatReturnedAsUnowned: true, nowMs: NOW },
    );
    expect(kept.map((k) => k.itemName)).toEqual(['白色书架']);
    expect(dropped).toHaveLength(0);
  });

  it('without the flag, returned durable still占槽位 → 再买被丢弃（默认行为不变）', () => {
    const { kept, dropped } = dedupeItemDrafts(
      [{ itemName: '白色书架', category: '家具', occurredAt: daysAgo(0) }],
      [{ itemName: '实木书架', category: '家具', occurredAt: daysAgo(5), status: 'returned' }],
      { exemptConsumables: true, nowMs: NOW },
    );
    expect(kept).toHaveLength(0);
    expect(dropped.map((d) => d.itemName)).toEqual(['白色书架']);
  });

  it('core 还留着一件非退货条目 → 照常去重（仅"全退货"品类才豁免）', () => {
    // 一台还在用的书架(received) + 一台退掉的书架(returned)：仍拥有 → 再买算重复。
    const { kept, dropped } = dedupeItemDrafts(
      [{ itemName: '白色书架', category: '家具', occurredAt: daysAgo(0) }],
      [
        { itemName: '实木书架', category: '家具', occurredAt: daysAgo(20), status: 'received' },
        { itemName: '旧书架', category: '家具', occurredAt: daysAgo(5), status: 'returned' },
      ],
      { exemptConsumables: true, treatReturnedAsUnowned: true, nowMs: NOW },
    );
    expect(kept).toHaveLength(0);
    expect(dropped.map((d) => d.itemName)).toEqual(['白色书架']);
  });
});

describe('collectionKeywordSourceText', () => {
  it('pulls collection habits from behaviorLogic and taboos (两侧口径同源所需字段)', () => {
    expect(
      extractCollectionKeywords(collectionKeywordSourceText({ behaviorLogic: '习惯性收集老唱片，攒了一墙' })),
    ).toContain('老唱片');
    expect(
      extractCollectionKeywords(collectionKeywordSourceText({ taboos: '红酒收藏家，见到好年份就走不动' })),
    ).toContain('红酒');
  });

  it('null / 空 profile → 空串', () => {
    expect(collectionKeywordSourceText(null)).toBe('');
    expect(collectionKeywordSourceText({})).toBe('');
  });
});
