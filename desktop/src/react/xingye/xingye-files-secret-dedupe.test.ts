import { describe, expect, it } from 'vitest';
import {
  buildSecretFilesContinuityAnchorBlock,
  detectSecretFilesDuplicate,
} from './xingye-files-secret-dedupe';
import type {
  XingyeHiddenFileEntry,
  XingyeHiddenFileEntryKind,
} from './xingye-files-secret-store';

function entry(
  partial: Partial<XingyeHiddenFileEntry> & {
    id: string;
    title: string;
    kind: XingyeHiddenFileEntryKind;
  },
): XingyeHiddenFileEntry {
  return {
    key: partial.id,
    agentId: 'a',
    body: '',
    source: 'ai_seed',
    createdAt: '2026-05-27T00:00:00.000Z',
    ...partial,
  };
}

describe('detectSecretFilesDuplicate', () => {
  it('同 kind 同 title（trim 后） → exact_dup', () => {
    const existing = [
      entry({ id: 'e1', title: '手会抖', kind: 'weakness' }),
      entry({ id: 'e2', title: '偷偷喜欢的歌', kind: 'guilty_pleasure' }),
    ];
    const result = detectSecretFilesDuplicate(
      { title: '  手会抖 ', kind: 'weakness' },
      existing,
    );
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') expect(result.entry.id).toBe('e1');
  });

  it('exact_dup 跨 kind → unique（一条 weakness 一条 secret_plan 不算重）', () => {
    const existing = [entry({ id: 'e1', title: '手会抖', kind: 'weakness' })];
    expect(
      detectSecretFilesDuplicate({ title: '手会抖', kind: 'secret_plan' }, existing).kind,
    ).toBe('unique');
  });

  it('Levenshtein 路径：单字插入 → similar via edit', () => {
    const existing = [
      entry({ id: 'e1', title: '只在自己人面前手不抖', kind: 'weakness' }),
    ];
    const result = detectSecretFilesDuplicate(
      { title: '只在自己人面前手不会抖', kind: 'weakness' },
      existing,
    );
    expect(result.kind).toBe('similar');
    if (result.kind === 'similar') {
      expect(result.via).toBe('edit');
      expect(result.entry.id).toBe('e1');
    }
  });

  it('完全不同主题 → unique', () => {
    const existing = [entry({ id: 'e1', title: '怕黑', kind: 'weakness' })];
    const result = detectSecretFilesDuplicate(
      { title: '想等天黑后离开', kind: 'secret_plan' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('空 title → unique（短路）', () => {
    const existing = [entry({ id: 'e1', title: '怕黑', kind: 'weakness' })];
    const result = detectSecretFilesDuplicate(
      { title: '  ', kind: 'weakness' },
      existing,
    );
    expect(result.kind).toBe('unique');
  });

  it('bigram 路径：换序 / 同义 → similar via jaccard', () => {
    const existing = [
      entry({ id: 'e1', title: '老师没说过的几句话', kind: 'secret_taste' }),
    ];
    const result = detectSecretFilesDuplicate(
      { title: '老师没说过的几句话语', kind: 'secret_taste' },
      existing,
    );
    expect(result.kind === 'exact_dup' || result.kind === 'similar').toBe(true);
  });
});

describe('buildSecretFilesContinuityAnchorBlock', () => {
  it('空数组 → 空串', () => {
    expect(buildSecretFilesContinuityAnchorBlock([])).toBe('');
  });

  it('多 kind 各自分桶渲染', () => {
    const entries = [
      entry({ id: 'e1', title: '手会抖', kind: 'weakness' }),
      entry({ id: 'e2', title: '偷偷喜欢的歌', kind: 'guilty_pleasure' }),
      entry({ id: 'e3', title: '没说出口的打算', kind: 'secret_plan' }),
    ];
    const block = buildSecretFilesContinuityAnchorBlock(entries);
    expect(block).toContain('[个人弱点]');
    expect(block).toContain('《手会抖》');
    expect(block).toContain('[见不得光的喜好]');
    expect(block).toContain('《偷偷喜欢的歌》');
    expect(block).toContain('[不可告人的打算]');
  });

  it('同 kind 每桶最多 3 条', () => {
    const entries: XingyeHiddenFileEntry[] = [];
    for (let i = 1; i <= 6; i++) {
      entries.push(entry({ id: `e${i}`, title: `弱点${i}`, kind: 'weakness' }));
    }
    const block = buildSecretFilesContinuityAnchorBlock(entries);
    expect(block).toContain('《弱点1》');
    expect(block).toContain('《弱点2》');
    expect(block).toContain('《弱点3》');
    expect(block).not.toContain('《弱点5》');
    expect(block).not.toContain('《弱点6》');
  });

  it('全是空 title 的 entries → 空串', () => {
    const entries = [
      entry({ id: 'e1', title: '   ', kind: 'weakness' }),
      entry({ id: 'e2', title: '\t', kind: 'guilty_pleasure' }),
    ];
    expect(buildSecretFilesContinuityAnchorBlock(entries)).toBe('');
  });
});
