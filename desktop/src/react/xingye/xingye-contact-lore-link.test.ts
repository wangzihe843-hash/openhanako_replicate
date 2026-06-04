import { describe, expect, it } from 'vitest';
import {
  CONTACT_LORE_DEDUPE_INSTRUCTION,
  contactsHaveLoreAlias,
  formatContactLoreListingBlock,
  matchContactNamesToLore,
  type XingyeContactLoreHint,
} from './xingye-contact-lore-link';

type LoreLike = { title: string; keywords: string[] };

function lore(title: string, keywords: string[] = []): LoreLike {
  return { title, keywords };
}

describe('matchContactNamesToLore', () => {
  it('title 完全相等 → 命中', () => {
    expect(matchContactNamesToLore(['陈医生'], [lore('陈医生')])).toEqual(['陈医生']);
  });

  it('keyword 完全相等 → 命中（title 不同也算同一个人）', () => {
    expect(matchContactNamesToLore(['老周'], [lore('周律师', ['老周', '周哥'])])).toEqual([
      '周律师',
    ]);
  });

  it('title 含整段联系人名 → 命中（母亲 ↔《我与母亲的旧事》）', () => {
    expect(matchContactNamesToLore(['母亲'], [lore('我与母亲的旧事')])).toEqual([
      '我与母亲的旧事',
    ]);
  });

  it('归一化：全角 / 大小写 / 首尾标点 / 空白 都能对上', () => {
    expect(matchContactNamesToLore(['「Lily」'], [lore('lily')])).toEqual(['lily']);
    expect(matchContactNamesToLore(['　张三　'], [lore('张三')])).toEqual(['张三']);
  });

  it('单字 token 跳过，避免误配', () => {
    expect(matchContactNamesToLore(['晴'], [lore('晴川历历')])).toEqual([]);
  });

  it('无任何重合 → 空数组', () => {
    expect(matchContactNamesToLore(['夜班搭子'], [lore('诊所那条街'), lore('货币体系')])).toEqual(
      [],
    );
  });

  it('多名字 token（展示名 / 原名 / 备注名）任一命中即可', () => {
    // 展示名是备注「老妈」，原名「林秀英」——靠原名命中 lore
    const matched = matchContactNamesToLore(['老妈', '林秀英', '老妈'], [lore('林秀英')]);
    expect(matched).toEqual(['林秀英']);
  });

  it('去重并截断到 maxAliases', () => {
    const entries = [lore('阿哲'), lore('阿哲'), lore('我与阿哲'), lore('阿哲的旧事')];
    const matched = matchContactNamesToLore(['阿哲'], entries, 2);
    expect(matched).toHaveLength(2);
    expect(new Set(matched).size).toBe(matched.length); // 无重复
  });

  it('空 lore / 空名字 → 空数组（不抛错）', () => {
    expect(matchContactNamesToLore([], [lore('陈医生')])).toEqual([]);
    expect(matchContactNamesToLore([null, undefined, '  '], [lore('陈医生')])).toEqual([]);
    expect(matchContactNamesToLore(['陈医生'], [])).toEqual([]);
  });
});

describe('formatContactLoreListingBlock', () => {
  it('空列表 → （无）', () => {
    expect(formatContactLoreListingBlock([])).toBe('（无）');
  });

  it('渲染昵称 / 关系 / 备注 / 印象 / 简介', () => {
    const hints: XingyeContactLoreHint[] = [
      {
        id: 'vc-1',
        displayName: '老妈',
        kind: 'family',
        relationshipHint: '亲妈，每周催一次电话',
        impression: '嘴硬心软，怕我饿着',
        shortBio: '退休教师',
      },
    ];
    const block = formatContactLoreListingBlock(hints);
    expect(block).toContain('老妈');
    expect(block).toContain('关系：family');
    expect(block).toContain('备注：亲妈，每周催一次电话');
    expect(block).toContain('印象：嘴硬心软，怕我饿着');
    expect(block).toContain('简介：退休教师');
  });

  it('带 loreAliases 时追加「同一个人」对齐行', () => {
    const hints: XingyeContactLoreHint[] = [
      { id: 'vc-1', displayName: '老周', loreAliases: ['周律师'] },
    ];
    const block = formatContactLoreListingBlock(hints);
    expect(block).toContain('同一个人');
    expect(block).toContain('《周律师》');
  });

  it('无 loreAliases 时不出现对齐行', () => {
    const hints: XingyeContactLoreHint[] = [{ id: 'vc-1', displayName: '夜班搭子' }];
    expect(formatContactLoreListingBlock(hints)).not.toContain('同一个人');
  });
});

describe('contactsHaveLoreAlias', () => {
  it('任一联系人带非空 loreAliases → true', () => {
    expect(
      contactsHaveLoreAlias([
        { id: 'a', displayName: 'A' },
        { id: 'b', displayName: 'B', loreAliases: ['某条设定'] },
      ]),
    ).toBe(true);
  });

  it('全部无 loreAliases（含空数组）→ false', () => {
    expect(
      contactsHaveLoreAlias([
        { id: 'a', displayName: 'A' },
        { id: 'b', displayName: 'B', loreAliases: [] },
      ]),
    ).toBe(false);
  });

  it('去重指令文案非空（被 prompt 引用）', () => {
    expect(CONTACT_LORE_DEDUPE_INSTRUCTION).toContain('同一个人');
  });
});
