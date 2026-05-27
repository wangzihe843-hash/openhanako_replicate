import { describe, expect, it } from 'vitest';
import {
  detectSmsDraftDuplicate,
  SMS_DUPLICATE_JACCARD_THRESHOLD,
} from './xingye-sms-dedupe';
import type { XingyePendingSmsDraft } from './xingye-sms-drafts';

function draft(
  partial: Partial<XingyePendingSmsDraft> & { id: string; content: string },
): XingyePendingSmsDraft {
  return {
    targetType: 'virtual_contact',
    targetId: 'vc-linwu',
    matchName: undefined,
    displayName: '林雾',
    source: 'test',
    createdAt: '2026-05-27T10:00:00.000Z',
    ...partial,
  };
}

const NOW = new Date('2026-05-27T12:00:00.000Z');

describe('detectSmsDraftDuplicate', () => {
  it('同对方 exact_dup → kind=exact_dup', () => {
    const existing = [draft({ id: 'd1', content: '在吗？' })];
    const r = detectSmsDraftDuplicate(
      { targetType: 'virtual_contact', targetId: 'vc-linwu', content: '在吗？' },
      existing,
      NOW,
    );
    expect(r.kind).toBe('exact_dup');
    if (r.kind === 'exact_dup') expect(r.draft.id).toBe('d1');
  });

  it('跨 targetId 不算重（一句"在吗"给不同对方各发一条）', () => {
    const existing = [draft({ id: 'd1', content: '在吗？', targetId: 'vc-linwu' })];
    const r = detectSmsDraftDuplicate(
      { targetType: 'virtual_contact', targetId: 'vc-master', content: '在吗？' },
      existing,
      NOW,
    );
    expect(r.kind).toBe('unique');
  });

  it('跨 targetType（agent vs virtual_contact）不算重', () => {
    const existing = [draft({ id: 'd1', content: '在吗？', targetType: 'virtual_contact', targetId: 'shared' })];
    const r = detectSmsDraftDuplicate(
      { targetType: 'agent', targetId: 'shared', content: '在吗？' },
      existing,
      NOW,
    );
    expect(r.kind).toBe('unique');
  });

  it('超过 24h 窗口 → 不算重', () => {
    const existing = [
      draft({ id: 'd1', content: '在吗？', createdAt: '2026-05-25T10:00:00.000Z' }),
    ];
    const r = detectSmsDraftDuplicate(
      { targetType: 'virtual_contact', targetId: 'vc-linwu', content: '在吗？' },
      existing,
      NOW,
    );
    expect(r.kind).toBe('unique');
  });

  it('matchName 维度也分桶（targetId 缺失时 fallback）', () => {
    const existing = [
      draft({ id: 'd1', content: '在吗？', targetId: undefined, matchName: '林雾' }),
    ];
    const r = detectSmsDraftDuplicate(
      { targetType: 'virtual_contact', matchName: '林雾', content: '在吗？' },
      existing,
      NOW,
    );
    expect(r.kind).toBe('exact_dup');
  });

  it('高度相似 → similar', () => {
    const existing = [draft({ id: 'd1', content: '今天的事我想再谢谢你一次，真的麻烦你了' })];
    const r = detectSmsDraftDuplicate(
      {
        targetType: 'virtual_contact',
        targetId: 'vc-linwu',
        content: '今天的事再谢谢你一次，真的麻烦你了',
      },
      existing,
      NOW,
    );
    expect(r.kind).toBe('similar');
    if (r.kind === 'similar') expect(r.score).toBeGreaterThanOrEqual(SMS_DUPLICATE_JACCARD_THRESHOLD);
  });

  it('空 content → unique（短路）', () => {
    const existing = [draft({ id: 'd1', content: '在吗？' })];
    const r = detectSmsDraftDuplicate(
      { targetType: 'virtual_contact', targetId: 'vc-linwu', content: '  ' },
      existing,
      NOW,
    );
    expect(r.kind).toBe('unique');
  });

  it('既无 targetId 又无 matchName → unique（让上层校验失败）', () => {
    const existing = [draft({ id: 'd1', content: '在吗？' })];
    const r = detectSmsDraftDuplicate(
      { targetType: 'virtual_contact', content: '在吗？' },
      existing,
      NOW,
    );
    expect(r.kind).toBe('unique');
  });
});

