/**
 * SMS 反重复连续性锚点测试。
 *
 * 主要验证：
 *   - 无 thread 历史 + 无 pending drafts → 空字符串
 *   - 有 thread 消息：抽出 owner/target 标记 + 内容首段
 *   - 有 pending drafts：以 [草稿待发] 标签出现
 *   - **关键：跨 targetId 隔离**——给 A 的内容不污染给 B 的 anchor
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSmsThreadMock = vi.hoisted(() => vi.fn());
const listSmsDraftsMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-phone-store', async () => {
  const actual: object = await vi.importActual('./xingye-phone-store');
  return {
    ...actual,
    getSmsThread: (...args: unknown[]) => getSmsThreadMock(...args),
  };
});

vi.mock('./xingye-sms-drafts', async () => {
  const actual: object = await vi.importActual('./xingye-sms-drafts');
  return {
    ...actual,
    listSmsDrafts: (...args: unknown[]) => listSmsDraftsMock(...args),
  };
});

import { buildSmsContinuityAnchorBlock } from './xingye-phone-ai';

const AGENT = 'hanako';

function makeMsg(opts: { id: string; from: 'owner' | 'target'; content: string; createdAt: string }) {
  return {
    id: opts.id,
    threadId: 'tx',
    fromAgentId: opts.from === 'owner' ? AGENT : 'someone-else',
    toAgentId: opts.from === 'owner' ? 'someone-else' : AGENT,
    content: opts.content,
    createdAt: opts.createdAt,
  };
}

describe('buildSmsContinuityAnchorBlock', () => {
  beforeEach(() => {
    getSmsThreadMock.mockReset();
    listSmsDraftsMock.mockReset();
    listSmsDraftsMock.mockResolvedValue([]);
  });

  it('无 thread 历史 + 无 pending drafts → 空字符串', async () => {
    getSmsThreadMock.mockReturnValue(null);
    listSmsDraftsMock.mockResolvedValue([]);
    const block = await buildSmsContinuityAnchorBlock(AGENT, { targetType: 'virtual_contact', targetId: 'vc-1' });
    expect(block).toBe('');
  });

  it('thread 历史按 createdAt 倒序取 6 条，标 [己发]/[对方]，content 截至 30 字', async () => {
    getSmsThreadMock.mockReturnValue({
      id: 't1',
      ownerAgentId: AGENT,
      targetType: 'virtual_contact',
      targetId: 'vc-1',
      messages: [
        makeMsg({ id: 'm1', from: 'owner', content: '在吗？最近怎么样了', createdAt: '2026-05-01T10:00:00.000Z' }),
        makeMsg({ id: 'm2', from: 'target', content: '我还好你呢', createdAt: '2026-05-02T10:00:00.000Z' }),
        makeMsg({ id: 'm3', from: 'owner', content: '下次约饭', createdAt: '2026-05-03T10:00:00.000Z' }),
      ],
      updatedAt: '2026-05-03T10:00:00.000Z',
    });
    const block = await buildSmsContinuityAnchorBlock(AGENT, { targetType: 'virtual_contact', targetId: 'vc-1' });
    expect(block).toContain('请避免重复');
    // 倒序：最新「下次约饭」在最上
    const idxLatest = block.indexOf('下次约饭');
    const idxEarliest = block.indexOf('在吗？最近怎么样了');
    expect(idxLatest).toBeGreaterThan(-1);
    expect(idxEarliest).toBeGreaterThan(-1);
    expect(idxLatest).toBeLessThan(idxEarliest);
    expect(block).toContain('[己发]');
    expect(block).toContain('[对方]');
  });

  it('pending drafts 以 [草稿待发] 出现，且与 thread 消息同列', async () => {
    getSmsThreadMock.mockReturnValue({
      id: 't1',
      ownerAgentId: AGENT,
      targetType: 'virtual_contact',
      targetId: 'vc-1',
      messages: [makeMsg({ id: 'm1', from: 'owner', content: '已发的话', createdAt: '2026-05-01T10:00:00.000Z' })],
      updatedAt: '2026-05-01T10:00:00.000Z',
    });
    listSmsDraftsMock.mockResolvedValue([
      { id: 'sms-1', targetType: 'virtual_contact', targetId: 'vc-1', content: '还没发的草稿', createdAt: '2026-05-04T10:00:00.000Z', source: 'heartbeat' },
    ]);
    const block = await buildSmsContinuityAnchorBlock(AGENT, { targetType: 'virtual_contact', targetId: 'vc-1' });
    expect(block).toContain('[草稿待发] 还没发的草稿');
    expect(block).toContain('[己发] 已发的话');
  });

  it('**跨 targetId 隔离**：A 给 B 的内容不会出现在 A 给 C 的 anchor 里', async () => {
    // mock getSmsThread 按 (agent, targetType, targetId) 区分返回
    getSmsThreadMock.mockImplementation((agentId: string, _targetType: string, targetId: string) => {
      if (agentId !== AGENT) return null;
      if (targetId === 'vc-B') {
        return {
          id: 't-B',
          ownerAgentId: AGENT,
          targetType: 'virtual_contact',
          targetId: 'vc-B',
          messages: [makeMsg({ id: 'mB1', from: 'owner', content: '只给B说的悄悄话', createdAt: '2026-05-01T10:00:00.000Z' })],
          updatedAt: '2026-05-01T10:00:00.000Z',
        };
      }
      if (targetId === 'vc-C') {
        return {
          id: 't-C',
          ownerAgentId: AGENT,
          targetType: 'virtual_contact',
          targetId: 'vc-C',
          messages: [makeMsg({ id: 'mC1', from: 'owner', content: '只给C说的工作消息', createdAt: '2026-05-02T10:00:00.000Z' })],
          updatedAt: '2026-05-02T10:00:00.000Z',
        };
      }
      return null;
    });
    // drafts 也要按 target 过滤——返回包含 B 和 C 各一条
    listSmsDraftsMock.mockResolvedValue([
      { id: 'sms-B', targetType: 'virtual_contact', targetId: 'vc-B', content: 'B 草稿', createdAt: '2026-05-03T10:00:00.000Z', source: 'heartbeat' },
      { id: 'sms-C', targetType: 'virtual_contact', targetId: 'vc-C', content: 'C 草稿', createdAt: '2026-05-03T11:00:00.000Z', source: 'heartbeat' },
    ]);

    const blockForC = await buildSmsContinuityAnchorBlock(AGENT, { targetType: 'virtual_contact', targetId: 'vc-C' });
    expect(blockForC).toContain('只给C说的工作消息');
    expect(blockForC).toContain('C 草稿');
    // 关键断言：B 的内容不应该出现
    expect(blockForC).not.toContain('只给B说的悄悄话');
    expect(blockForC).not.toContain('B 草稿');
  });

  it('agentId / targetId 为空 → 直接返回空字符串（不查任何东西）', async () => {
    const blockA = await buildSmsContinuityAnchorBlock('', { targetType: 'virtual_contact', targetId: 'vc-1' });
    const blockB = await buildSmsContinuityAnchorBlock(AGENT, { targetType: 'virtual_contact', targetId: '' });
    expect(blockA).toBe('');
    expect(blockB).toBe('');
  });
});
