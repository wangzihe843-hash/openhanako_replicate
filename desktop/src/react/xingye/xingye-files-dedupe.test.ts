import { describe, expect, it } from 'vitest';
import {
  FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD,
  FILES_DUPLICATE_JACCARD_THRESHOLD,
  bigramJaccard,
  bodyBigramJaccard,
  detectCrossFolderDuplicate,
  detectFilesDuplicate,
  levenshtein,
  normalizeBodyForDedup,
  normalizeTitleForDedup,
  titleSimilarity,
  toBigramSet,
} from './xingye-files-dedupe';
import type { XingyeFileEntry } from './xingye-files-store';

function entry(partial: Partial<XingyeFileEntry> & { id: string; title: string; folderId: string }): XingyeFileEntry {
  return {
    key: partial.id,
    agentId: 'a',
    body: '',
    createdAt: '2026-05-27T00:00:00.000Z',
    ...partial,
  };
}

describe('normalizeTitleForDedup', () => {
  it('trim 首尾空白', () => {
    expect(normalizeTitleForDedup('  师父的话  ')).toBe('师父的话');
  });

  it('全角标点转半角', () => {
    expect(normalizeTitleForDedup('师父：箴言')).toBe(normalizeTitleForDedup('师父:箴言'));
  });

  it('去掉中英文包裹符号《》「」"…"', () => {
    expect(normalizeTitleForDedup('《师父的话》')).toBe('师父的话');
    expect(normalizeTitleForDedup('「师父的话」')).toBe('师父的话');
    expect(normalizeTitleForDedup('"my notes"')).toBe('my notes');
  });

  it('多空白收紧 + 英文小写', () => {
    expect(normalizeTitleForDedup('My   Notes')).toBe('my notes');
  });

  it('非字符串返回空串', () => {
    expect(normalizeTitleForDedup(null as unknown as string)).toBe('');
  });
});

describe('toBigramSet & bigramJaccard', () => {
  it('短串走单元素集合', () => {
    expect(toBigramSet('师')).toEqual(new Set(['师']));
  });

  it('师父的话 bigram 包含 师父/父的/的话', () => {
    const set = toBigramSet('师父的话');
    expect(set.has('师父')).toBe(true);
    expect(set.has('父的')).toBe(true);
    expect(set.has('的话')).toBe(true);
    expect(set.size).toBe(3);
  });

  it('完全相同串 Jaccard = 1', () => {
    expect(bigramJaccard('师父说过的话', '师父说过的话')).toBe(1);
  });

  it('完全无重叠 Jaccard = 0', () => {
    expect(bigramJaccard('天气真好', '考试题目')).toBe(0);
  });

  it('"师父说过的几句话" vs "师父说的几句话" 在 bigram 路径上偏低（删字 case），需 Levenshtein 兜底', () => {
    // 记录这个事实：bigram 算出来只有 0.625——刚过 0.6 阈值但偏低；这就是为什么要加 Levenshtein 路径
    const score = bigramJaccard('师父说过的几句话', '师父说的几句话');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.75);
  });

  it('归一化生效：《X》 和 X 算 Jaccard = 1', () => {
    expect(bigramJaccard('《师父的话》', '师父的话')).toBe(1);
  });
});

describe('levenshtein', () => {
  it('完全相同 → 0', () => {
    expect(levenshtein('师父的话', '师父的话')).toBe(0);
  });

  it('删 1 字 → 1', () => {
    expect(levenshtein('师父说过的几句话', '师父说的几句话')).toBe(1);
  });

  it('改 1 字 → 1', () => {
    expect(levenshtein('师父的话', '师母的话')).toBe(1);
  });

  it('插 + 改 → 2', () => {
    expect(levenshtein('师父的话', '师母的话语')).toBe(2);
  });

  it('归一化前后等价：《X》 vs X → 0', () => {
    expect(levenshtein('《师父的话》', '师父的话')).toBe(0);
  });

  it('一端为空 → 另一端长度', () => {
    expect(levenshtein('', '师父')).toBe(2);
    expect(levenshtein('师父', '')).toBe(2);
  });
});

describe('detectFilesDuplicate', () => {
  it('同 folder 同 title（trim 后） → exact_dup', () => {
    const existing = [
      entry({ id: 'e1', title: '师父的话', folderId: 'f1' }),
      entry({ id: 'e2', title: '另一条', folderId: 'f1' }),
    ];
    const result = detectFilesDuplicate({ title: '  师父的话 ', folderId: 'f1' }, existing);
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') expect(result.entry.id).toBe('e1');
  });

  it('exact_dup 跨 folder → unique', () => {
    const existing = [entry({ id: 'e1', title: '师父的话', folderId: 'f1' })];
    expect(detectFilesDuplicate({ title: '师父的话', folderId: 'f2' }, existing).kind).toBe('unique');
  });

  it('similar via=edit：删 1 字（"师父说过的几句话" vs "师父说的几句话"）', () => {
    const existing = [entry({ id: 'e1', title: '师父说过的几句话', folderId: 'f1' })];
    const result = detectFilesDuplicate({ title: '师父说的几句话', folderId: 'f1' }, existing);
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') {
      expect(result.entry.id).toBe('e1');
      expect(result.via).toBe('edit');
    }
  });

  it('similar via=edit：改 1 字', () => {
    const existing = [entry({ id: 'e1', title: '师父的处方', folderId: 'f1' })];
    const result = detectFilesDuplicate({ title: '师母的处方', folderId: 'f1' }, existing);
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') expect(result.via).toBe('edit');
  });

  it('Levenshtein 不命中短串：较短串 < 3 字时不走编辑距离路径', () => {
    const existing = [entry({ id: 'e1', title: '师父的话', folderId: 'f1' })];
    expect(detectFilesDuplicate({ title: '师父', folderId: 'f1' }, existing).kind).toBe('unique');
  });

  it('similar：长度差 > 2 + 编辑距离 > 2 → unique', () => {
    const existing = [entry({ id: 'e1', title: '师父说过的几句话以及我的理解', folderId: 'f1' })];
    expect(detectFilesDuplicate({ title: '师父', folderId: 'f1' }, existing).kind).toBe('unique');
  });

  it('similar via=jaccard：换序 / 重排（编辑距离大但 bigram 重叠多）', () => {
    const existing = [entry({ id: 'e1', title: '关于诊所那条街的笔记', folderId: 'f1' })];
    const result = detectFilesDuplicate({ title: '关于诊所那条街的备注', folderId: 'f1' }, existing);
    // 这俩编辑距离 = 2（笔记 → 备注 两字都改），应被 Levenshtein 优先命中
    expect(result.kind).toBe('similar');
  });

  it('全角差异等于 exact_dup（《X》 vs X）', () => {
    const existing = [entry({ id: 'e1', title: '《师父的话》', folderId: 'f1' })];
    expect(detectFilesDuplicate({ title: '师父的话', folderId: 'f1' }, existing).kind).toBe('exact_dup');
  });

  it('candidate.title 归一化后为空 → unique', () => {
    const existing = [entry({ id: 'e1', title: '师父的话', folderId: 'f1' })];
    expect(detectFilesDuplicate({ title: '   ', folderId: 'f1' }, existing).kind).toBe('unique');
  });

  it('candidate.folderId 空 → unique', () => {
    const existing = [entry({ id: 'e1', title: '师父的话', folderId: 'f1' })];
    expect(detectFilesDuplicate({ title: '师父的话', folderId: '' }, existing).kind).toBe('unique');
  });

  it('existingEntries 为空 → unique', () => {
    expect(detectFilesDuplicate({ title: '随便写', folderId: 'f1' }, []).kind).toBe('unique');
  });

  it('多条命中：exact_dup 短路优先于 similar', () => {
    const existing = [
      entry({ id: 'e1', title: '师父说过的几句话', folderId: 'f1' }),
      entry({ id: 'e2', title: '师父说的几句话', folderId: 'f1' }),
    ];
    const result = detectFilesDuplicate({ title: '师父说的几句话', folderId: 'f1' }, existing);
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') expect(result.entry.id).toBe('e2');
  });

  it('阈值常量曝光给调用方', () => {
    expect(FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD).toBe(2);
    expect(FILES_DUPLICATE_JACCARD_THRESHOLD).toBe(0.75);
  });
});

describe('normalizeBodyForDedup', () => {
  it('去掉换行 / 空白 / 标点，只留内容字', () => {
    expect(normalizeBodyForDedup('  红盐码头，\n我十七岁待过的走私港。 ')).toBe('红盐码头我十七岁待过的走私港');
  });
  it('全角标点归一后被删', () => {
    expect(normalizeBodyForDedup('账房先生（粮铺）说……')).toBe('账房先生粮铺说');
  });
  it('非字符串 / 空白 → 空串', () => {
    expect(normalizeBodyForDedup('')).toBe('');
    expect(normalizeBodyForDedup('   \n ')).toBe('');
    expect(normalizeBodyForDedup(undefined as never)).toBe('');
  });
});

describe('bodyBigramJaccard / titleSimilarity', () => {
  it('几乎一字不差的正文 → 高分；完全不相干 → 0 附近', () => {
    const a = '莉莉丝今天说以后受伤不会瞒着我，她语气很认真，我记下来。';
    const aReworded = '莉莉丝今天说，以后受伤不会瞒着我；她语气很认真，我记下来！';
    expect(bodyBigramJaccard(a, aReworded)).toBeGreaterThan(0.8);
    expect(bodyBigramJaccard(a, '今天去码头收了三箱货，账房先生不在。')).toBeLessThan(0.2);
  });
  it('titleSimilarity：近乎同名高、无关低', () => {
    expect(titleSimilarity('师父说过的几句话', '师父说的几句话')).toBeGreaterThan(0.7);
    expect(titleSimilarity('红盐码头', '蓝线风铃')).toBeLessThan(0.3);
  });
});

describe('detectCrossFolderDuplicate', () => {
  it('正文几乎一样、但在不同文件夹 → cross_dup（via=body，哪怕标题被改写）', () => {
    const existing = [
      entry({
        id: 'e-user',
        title: '莉莉丝承诺不再瞒伤',
        folderId: 'f-user',
        body: '今天莉莉丝主动跟我说，以后受伤不会瞒着我。她讲这话时语气很认真，没有躲闪。',
      }),
    ];
    const result = detectCrossFolderDuplicate(
      {
        title: '莉莉丝主动承诺不隐瞒伤势', // 改写过的标题
        folderId: 'f-clue', // 不同文件夹
        body: '今天莉莉丝主动跟我说，以后受伤不会瞒着我。她讲这话时语气很认真，没有躲闪。',
      },
      existing,
    );
    expect(result.kind).toBe('cross_dup');
    if (result.kind === 'cross_dup') {
      expect(result.entry.id).toBe('e-user');
      expect(result.via).toBe('body');
    }
  });

  it('同一文件夹里的雷同条目不算跨夹重复（那是 detectFilesDuplicate 的活）', () => {
    const existing = [
      entry({ id: 'e1', title: 'A', folderId: 'f-user', body: '完全一样的内容拿来比对一下你看看。' }),
    ];
    const result = detectCrossFolderDuplicate(
      { title: 'B', folderId: 'f-user', body: '完全一样的内容拿来比对一下你看看。' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('不同文件夹但内容确实不同 → unique（不误杀）', () => {
    const existing = [
      entry({ id: 'e1', title: '红盐码头与七月不渡', folderId: 'f-world', body: '红盐码头是个走私港，当地七月不出海。' }),
    ];
    const result = detectCrossFolderDuplicate(
      { title: '账房先生提的岑姨', folderId: 'f-clue', body: '账房先生说岑姨以前在北门诊所干过，后来不知去向。' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('标题和正文都为空 → unique', () => {
    const existing = [entry({ id: 'e1', title: '随便', folderId: 'f-a', body: '随便写点东西。' })];
    expect(detectCrossFolderDuplicate({ title: '', folderId: 'f-b', body: '' }, existing).kind).toBe('unique');
  });

  it('取相似度最高的那条作为命中', () => {
    const existing = [
      entry({ id: 'e-lo', title: '别的事', folderId: 'f-a', body: '完全不相关的另一段内容写在这里。' }),
      entry({ id: 'e-hi', title: '莉莉丝承诺不再瞒伤', folderId: 'f-a', body: '今天莉莉丝主动跟我说，以后受伤不会瞒着我。' }),
    ];
    const result = detectCrossFolderDuplicate(
      { title: '莉莉丝承诺不再瞒伤', folderId: 'f-b', body: '今天莉莉丝主动跟我说，以后受伤不会瞒着我。' },
      existing,
    );
    expect(result.kind).toBe('cross_dup');
    if (result.kind === 'cross_dup') expect(result.entry.id).toBe('e-hi');
  });
});
