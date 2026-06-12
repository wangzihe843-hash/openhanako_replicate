import { beforeEach, describe, expect, it, vi } from 'vitest';

/** buildContactDetailPromptHints 内部经 listLoreEntries 拉身份对齐候选；这里 mock 成可控数据。 */
const listLoreEntriesMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => [] as unknown[]));
vi.mock('./xingye-lore-store', async () => {
  const actual: object = await vi.importActual('./xingye-lore-store');
  return {
    ...actual,
    listLoreEntries: (...args: unknown[]) => listLoreEntriesMock(...args),
  };
});

import {
  CONTACT_LORE_DEDUPE_INSTRUCTION,
  buildContactDetailPromptHints,
  buildContactProfileDetailHint,
  contactsHaveLoreAlias,
  formatContactDetailPromptBlock,
  formatContactLoreListingBlock,
  matchContactNamesToLore,
  type XingyeContactDetailPromptHint,
  type XingyeContactLoreHint,
} from './xingye-contact-lore-link';
import {
  initializeContactProfile,
  XINGYE_PHONE_CONTACT_PROFILES_STORAGE_KEY,
} from './xingye-phone-store';

type LoreLike = { title: string; keywords: string[] };

function lore(title: string, keywords: string[] = []): LoreLike {
  return { title, keywords };
}

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
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

describe('formatContactLoreListingBlock — profileDetail（详情页反哺）', () => {
  it('带 profileDetail 时追加「详情页」行（签名 / IP属地 / 近期往来 + 勿照搬提示）', () => {
    const hints: XingyeContactLoreHint[] = [
      {
        id: 'vc-1',
        displayName: '老妈',
        profileDetail: {
          signature: '岁月静好',
          ipAddress: '江南小城',
          recentLog: ['电话｜昨夜｜叮嘱按时吃饭', '面谈｜上周｜一起包了饺子'],
        },
      },
    ];
    const block = formatContactLoreListingBlock(hints);
    expect(block).toContain('详情页');
    expect(block).toContain('个性签名「岁月静好」');
    expect(block).toContain('IP属地：江南小城');
    expect(block).toContain('电话｜昨夜｜叮嘱按时吃饭');
    expect(block).toContain('勿原样照搬');
  });

  it('无 profileDetail 时不出现「详情页」行（详情未初始化 → 输出与从前一致）', () => {
    const hints: XingyeContactLoreHint[] = [{ id: 'vc-1', displayName: '夜班搭子' }];
    expect(formatContactLoreListingBlock(hints)).not.toContain('详情页');
  });

  it('loreAliases 与 profileDetail 同时存在时两行都渲染（同一人对齐不被详情挤掉）', () => {
    const hints: XingyeContactLoreHint[] = [
      {
        id: 'vc-1',
        displayName: '老周',
        loreAliases: ['周律师'],
        profileDetail: { signature: '行至水穷处' },
      },
    ];
    const block = formatContactLoreListingBlock(hints);
    expect(block).toContain('同一个人');
    expect(block).toContain('《周律师》');
    expect(block).toContain('个性签名「行至水穷处」');
  });
});

describe('buildContactProfileDetailHint', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('已初始化详情 → 返回签名 / IP / 近期往来（新→旧，最多 3 条）', () => {
    initializeContactProfile('hanako', 'virtual_contact', 'vc-1', {
      accountId: 'acc-001',
      ipAddress: '临安',
      signature: '心如止水',
      contactLog: [
        { channel: '电话', direction: 'incoming', whenLabel: '昨夜', summary: '约了复诊时间' },
        { channel: '面谈', direction: 'mutual', whenLabel: '三天前', summary: '一起吃了顿饭' },
        { channel: '短信', direction: 'outgoing', whenLabel: '上周', summary: '问药材到货没有' },
        { channel: '符纸', direction: 'outgoing', whenLabel: '上月', summary: '远行前报平安' },
      ],
    }, storage);
    const hint = buildContactProfileDetailHint('hanako', 'virtual_contact', 'vc-1', storage);
    expect(hint).not.toBeNull();
    expect(hint?.signature).toBe('心如止水');
    expect(hint?.ipAddress).toBe('临安');
    expect(hint?.recentLog).toHaveLength(3);
    expect(hint?.recentLog?.[0]).toBe('电话｜昨夜｜约了复诊时间');
    expect(hint?.recentLog?.join('')).not.toContain('符纸');
  });

  it('无 profile / 仅骨架（无 initializedAt）→ null', () => {
    expect(buildContactProfileDetailHint('hanako', 'virtual_contact', 'vc-none', storage)).toBeNull();
    // 骨架：印象历史等早于详情初始化时的形态——只有 map 条目、没有 initializedAt。
    storage.setItem(
      XINGYE_PHONE_CONTACT_PROFILES_STORAGE_KEY,
      JSON.stringify({
        'hanako::virtual_contact::vc-skeleton': {
          ownerAgentId: 'hanako',
          targetType: 'virtual_contact',
          targetId: 'vc-skeleton',
          ipHistory: [],
          signatureHistory: [],
          impressionHistory: [{ value: '旧印象', recordedAt: '2026-01-01T00:00:00.000Z' }],
          contactLog: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    expect(buildContactProfileDetailHint('hanako', 'virtual_contact', 'vc-skeleton', storage)).toBeNull();
  });

  it('详情已初始化但签名/IP/记录全空 → null（没东西可反哺）', () => {
    initializeContactProfile('hanako', 'virtual_contact', 'vc-2', { accountId: 'only-acc' }, storage);
    expect(buildContactProfileDetailHint('hanako', 'virtual_contact', 'vc-2', storage)).toBeNull();
  });
});

describe('buildContactDetailPromptHints（SMS 详情/对齐通道）', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    listLoreEntriesMock.mockReset();
    listLoreEntriesMock.mockReturnValue([]);
  });

  it('user 一律跳过；无详情且无对齐的联系人不出现', () => {
    initializeContactProfile('hanako', 'virtual_contact', 'vc-1', { signature: '签名一' }, storage);
    const hints = buildContactDetailPromptHints('hanako', [
      { targetType: 'user', targetId: '__user__', displayName: '用户' },
      { targetType: 'virtual_contact', targetId: 'vc-1', displayName: '老周' },
      { targetType: 'virtual_contact', targetId: 'vc-bare', displayName: '路人' },
    ], { storage });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ targetType: 'virtual_contact', targetId: 'vc-1' });
    expect(hints[0]?.profileDetail?.signature).toBe('签名一');
  });

  it('agent 联系人同样可带详情（短信名单里有其他角色）', () => {
    initializeContactProfile('hanako', 'agent', 'agent-2', { ipAddress: '北境' }, storage);
    const hints = buildContactDetailPromptHints('hanako', [
      { targetType: 'agent', targetId: 'agent-2', displayName: '阿澈' },
    ], { storage });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.profileDetail?.ipAddress).toBe('北境');
  });

  it('名字命中 relationship/character 类 lore → 带 loreAliases（详情缺失也保留对齐）', () => {
    listLoreEntriesMock.mockReturnValue([
      { title: '周律师', keywords: ['老周'], enabled: true, category: 'relationship', content: '' },
      { title: '货币体系', keywords: [], enabled: true, category: 'worldview', content: '' },
    ]);
    const hints = buildContactDetailPromptHints('hanako', [
      { targetType: 'virtual_contact', targetId: 'vc-1', displayName: '老周' },
    ], { storage });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.loreAliases).toEqual(['周律师']);
    expect(hints[0]?.profileDetail).toBeUndefined();
  });

  it('disabled / 非身份类 lore 不参与对齐', () => {
    listLoreEntriesMock.mockReturnValue([
      { title: '老周', keywords: [], enabled: false, category: 'relationship', content: '' },
    ]);
    const hints = buildContactDetailPromptHints('hanako', [
      { targetType: 'virtual_contact', targetId: 'vc-1', displayName: '老周' },
    ], { storage });
    expect(hints).toHaveLength(0);
  });
});

describe('formatContactDetailPromptBlock', () => {
  it('空列表 → （无）', () => {
    expect(formatContactDetailPromptBlock([])).toBe('（无）');
  });

  it('渲染 targetType:targetId 标头 + 详情行 + 同一人对齐行', () => {
    const hints: XingyeContactDetailPromptHint[] = [
      {
        targetType: 'virtual_contact',
        targetId: 'vc-1',
        displayName: '老周',
        profileDetail: { signature: '行至水穷处', recentLog: ['电话｜昨夜｜聊了案子进展'] },
        loreAliases: ['周律师'],
      },
    ];
    const block = formatContactDetailPromptBlock(hints);
    expect(block).toContain('老周［virtual_contact:vc-1］');
    expect(block).toContain('个性签名「行至水穷处」');
    expect(block).toContain('电话｜昨夜｜聊了案子进展');
    expect(block).toContain('同一个人');
    expect(block).toContain('《周律师》');
    expect(block).toContain('不要拆成两个角色');
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
