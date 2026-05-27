import { describe, expect, it } from 'vitest';
import {
  FILES_DUPLICATE_EDIT_DISTANCE_THRESHOLD,
  FILES_DUPLICATE_JACCARD_THRESHOLD,
  bigramJaccard,
  detectFilesDuplicate,
  levenshtein,
  normalizeTitleForDedup,
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
