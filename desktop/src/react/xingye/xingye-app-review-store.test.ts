/**
 * @vitest-environment node
 *
 * 评价存储层（购物 1 条 / 二手 2 条互评）的 CRUD + upsert 语义。
 * 用内存后端替换模块级 createXingyeStore；各用例用不同 agentId 互相隔离，免清理。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./xingye-store-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-store-utils')>();
  const { createMemoryXingyeStorageBackend } = await import('./xingye-storage-backend');
  const backend = createMemoryXingyeStorageBackend();
  return { ...actual, createXingyeStore: () => actual.createXingyeStore(backend) };
});

import {
  deleteAppReview,
  listAppReviews,
  readAppReview,
  reviewSentimentFromStars,
  saveAppReview,
  type AppReviewRecord,
} from './xingye-app-review-store';

function record(entryId: string, overrides: Partial<AppReviewRecord> = {}): AppReviewRecord {
  return {
    entryId,
    itemName: '旧台灯',
    itemStatus: 'received',
    sides: [{ by: 'agent', reviewed: true, stars: 5, text: '很好用' }],
    generatedAt: '2026-06-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('reviewSentimentFromStars', () => {
  it('1–2 星 = 差评，3 星 = 中评，4–5 星 = 好评', () => {
    expect(reviewSentimentFromStars(1)).toBe('bad');
    expect(reviewSentimentFromStars(2)).toBe('bad');
    expect(reviewSentimentFromStars(3)).toBe('neutral');
    expect(reviewSentimentFromStars(4)).toBe('good');
    expect(reviewSentimentFromStars(5)).toBe('good');
  });
});

describe('xingye-app-review-store CRUD', () => {
  it('缺文件时 listAppReviews 返回空数组', async () => {
    await expect(listAppReviews('agent-empty', 'shopping')).resolves.toEqual([]);
  });

  it('save + list + read 往返', async () => {
    const aid = 'agent-rw';
    await saveAppReview(aid, 'shopping', record('e-1'));
    await expect(listAppReviews(aid, 'shopping')).resolves.toHaveLength(1);
    await expect(readAppReview(aid, 'shopping', 'e-1')).resolves.toMatchObject({
      entryId: 'e-1',
      itemName: '旧台灯',
    });
    await expect(readAppReview(aid, 'shopping', 'missing')).resolves.toBeNull();
  });

  it('同 entryId upsert 覆盖、不产生重复', async () => {
    const aid = 'agent-upsert';
    await saveAppReview(aid, 'shopping', record('e-1', { itemName: '台灯 v1' }));
    await saveAppReview(aid, 'shopping', record('e-1', { itemName: '台灯 v2' }));
    const list = await listAppReviews(aid, 'shopping');
    expect(list).toHaveLength(1);
    expect(list[0].itemName).toBe('台灯 v2');
  });

  it('按 appId 分文件隔离（shopping vs secondhand 互不影响）', async () => {
    const aid = 'agent-scope';
    await saveAppReview(aid, 'shopping', record('e-1'));
    await expect(listAppReviews(aid, 'secondhand')).resolves.toEqual([]);
  });

  it('delete 命中返回 true、未命中返回 false', async () => {
    const aid = 'agent-del';
    await saveAppReview(aid, 'shopping', record('e-1'));
    await expect(deleteAppReview(aid, 'shopping', 'e-1')).resolves.toBe(true);
    await expect(listAppReviews(aid, 'shopping')).resolves.toEqual([]);
    await expect(deleteAppReview(aid, 'shopping', 'e-1')).resolves.toBe(false);
  });

  it('saveAppReview 缺 entryId 抛错', async () => {
    await expect(saveAppReview('agent-x', 'shopping', record(''))).rejects.toThrow('entryId is required');
  });
});
