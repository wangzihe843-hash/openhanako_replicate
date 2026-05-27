import { describe, expect, it } from 'vitest';
import {
  buildTopicsContinuityAnchorBlock,
  detectTopicDuplicate,
  TOPICS_ANCHOR_SAMPLE_LIMIT,
  TOPICS_DUPLICATE_WINDOW_DAYS,
  type ReadingBookLike,
} from './xingye-reading-topics-dedupe';

const FIXED_NOW = Date.parse('2026-05-27T12:00:00.000Z');

function isoDaysAgo(days: number): string {
  return new Date(FIXED_NOW - days * 24 * 60 * 60 * 1000).toISOString();
}

function book(partial: Partial<ReadingBookLike> & { title: string }): ReadingBookLike {
  return { ...partial };
}

describe('buildTopicsContinuityAnchorBlock', () => {
  it('空列表 → 空串', () => {
    expect(buildTopicsContinuityAnchorBlock([])).toBe('');
  });

  it('一本书 → 一行书架样本', () => {
    const out = buildTopicsContinuityAnchorBlock([
      book({ title: '百年孤独', authors: ['加西亚·马尔克斯'] }),
    ]);
    expect(out).toContain('书架上已经收过的书');
    expect(out).toContain('《百年孤独》');
    expect(out).toContain('加西亚·马尔克斯');
  });

  it('无作者也能渲染', () => {
    const out = buildTopicsContinuityAnchorBlock([book({ title: '某本无名书' })]);
    expect(out).toContain('《某本无名书》');
  });

  it('最多抽 8 条', () => {
    const list: ReadingBookLike[] = [];
    for (let i = 0; i < 15; i += 1) {
      list.push(book({ title: `书${i}` }));
    }
    const out = buildTopicsContinuityAnchorBlock(list);
    expect(out).toContain('《书0》');
    expect(out).toContain(`《书${TOPICS_ANCHOR_SAMPLE_LIMIT - 1}》`);
    expect(out).not.toContain(`《书${TOPICS_ANCHOR_SAMPLE_LIMIT}》`);
  });

  it('作者最多列 3 位', () => {
    const out = buildTopicsContinuityAnchorBlock([
      book({ title: '联合作品', authors: ['作者A', '作者B', '作者C', '作者D', '作者E'] }),
    ]);
    expect(out).toContain('作者A / 作者B / 作者C');
    expect(out).not.toContain('作者D');
  });
});

describe('detectTopicDuplicate', () => {
  const opts = { now: () => FIXED_NOW };

  it('candidate displayText 为空 → unique', () => {
    const existing = [book({ title: '百年孤独', createdAt: isoDaysAgo(1) })];
    expect(detectTopicDuplicate({ displayText: '' }, existing, opts).kind).toBe('unique');
  });

  it('existing 为空 → unique', () => {
    expect(detectTopicDuplicate({ displayText: '百年孤独' }, [], opts).kind).toBe('unique');
  });

  it('完全相同书名（窗口内）→ exact_dup', () => {
    const existing = [book({ title: '百年孤独', createdAt: isoDaysAgo(3) })];
    const result = detectTopicDuplicate({ displayText: '百年孤独' }, existing, opts);
    expect(result.kind).toBe('exact_dup');
    if (result.kind === 'exact_dup') {
      expect(result.book.title).toBe('百年孤独');
    }
  });

  it('书名相似（编辑距离 ≤ 2）→ similar', () => {
    const existing = [book({ title: '审判官的来访', createdAt: isoDaysAgo(2) })];
    const result = detectTopicDuplicate({ displayText: '审判官来访' }, existing, opts);
    expect(result.kind === 'similar' || result.kind === 'exact_dup').toBe(true);
  });

  it('窗口外的同书名 → unique（30 天前推过，今天再推算合理）', () => {
    const existing = [
      book({ title: '百年孤独', createdAt: isoDaysAgo(TOPICS_DUPLICATE_WINDOW_DAYS + 5) }),
    ];
    const result = detectTopicDuplicate({ displayText: '百年孤独' }, existing, opts);
    expect(result.kind).toBe('unique');
  });

  it('完全不同的书名 → unique', () => {
    const existing = [book({ title: '百年孤独', createdAt: isoDaysAgo(1) })];
    const result = detectTopicDuplicate({ displayText: '昆虫记' }, existing, opts);
    expect(result.kind).toBe('unique');
  });

  it('没有 createdAt 字段的书 → 保守拦截（视为在窗口内）', () => {
    const existing = [book({ title: '某书' })];
    const result = detectTopicDuplicate({ displayText: '某书' }, existing, opts);
    expect(result.kind).toBe('exact_dup');
  });

  it('归一化后大小写 / 包裹符号不影响比较', () => {
    const existing = [book({ title: 'My Book', createdAt: isoDaysAgo(1) })];
    const result = detectTopicDuplicate({ displayText: '《my book》' }, existing, opts);
    expect(result.kind).toBe('exact_dup');
  });
});
