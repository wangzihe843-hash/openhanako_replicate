/**
 * @vitest-environment node
 *
 * 二手「与买家聊天」存储层的 CRUD + upsert 语义。
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
  deleteSecondhandBuyerChat,
  listSecondhandBuyerChats,
  readSecondhandBuyerChat,
  saveSecondhandBuyerChat,
  type SecondhandBuyerChat,
} from './xingye-secondhand-buyer-chat-store';

function chat(entryId: string, overrides: Partial<SecondhandBuyerChat> = {}): SecondhandBuyerChat {
  return {
    entryId,
    buyerName: '小鱼',
    itemName: '九成新机械键盘',
    itemStatus: 'negotiating',
    messages: [
      { id: 'm1', role: 'buyer', text: '还在吗？', at: '2026-06-05T01:00:00.000Z' },
      { id: 'm2', role: 'seller', text: '在的', at: '2026-06-05T01:01:00.000Z' },
    ],
    generatedAt: '2026-06-05T01:02:00.000Z',
    ...overrides,
  };
}

describe('xingye-secondhand-buyer-chat-store', () => {
  it('缺文件时返回空数组', async () => {
    await expect(listSecondhandBuyerChats('agent-empty')).resolves.toEqual([]);
  });

  it('save + list + read 往返', async () => {
    const aid = 'agent-rw';
    await saveSecondhandBuyerChat(aid, chat('e-1'));
    await expect(listSecondhandBuyerChats(aid)).resolves.toHaveLength(1);
    await expect(readSecondhandBuyerChat(aid, 'e-1')).resolves.toMatchObject({
      entryId: 'e-1',
      buyerName: '小鱼',
    });
    await expect(readSecondhandBuyerChat(aid, 'missing')).resolves.toBeNull();
  });

  it('同 entryId upsert 覆盖、不产生重复', async () => {
    const aid = 'agent-upsert';
    await saveSecondhandBuyerChat(aid, chat('e-1', { itemStatus: 'negotiating' }));
    await saveSecondhandBuyerChat(aid, chat('e-1', { itemStatus: 'sold' }));
    const list = await listSecondhandBuyerChats(aid);
    expect(list).toHaveLength(1);
    expect(list[0].itemStatus).toBe('sold');
  });

  it('delete 命中返回 true、未命中返回 false', async () => {
    const aid = 'agent-del';
    await saveSecondhandBuyerChat(aid, chat('e-1'));
    await expect(deleteSecondhandBuyerChat(aid, 'e-1')).resolves.toBe(true);
    await expect(listSecondhandBuyerChats(aid)).resolves.toEqual([]);
    await expect(deleteSecondhandBuyerChat(aid, 'e-1')).resolves.toBe(false);
  });

  it('saveSecondhandBuyerChat 缺 entryId 抛错', async () => {
    await expect(saveSecondhandBuyerChat('agent-x', chat(''))).rejects.toThrow('entryId is required');
  });
});
