import { describe, expect, it } from 'vitest';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import {
  buildChannelMessageId,
  createXingyeGroupChatStateStore,
  makeGroupChatDedupeKey,
  XINGYE_GROUP_CHAT_RUNS_PATH,
  type XingyeGroupChatRun,
} from './xingye-group-chat-state-store';

function makeStore(seedTimes: string[] = [], seedIds: string[] = []) {
  const backend = createMemoryXingyeStorageBackend();
  const remainingTimes = [...seedTimes];
  const remainingIds = [...seedIds];
  const store = createXingyeGroupChatStateStore(backend, {
    idFactory: () => remainingIds.shift() ?? 'run-x',
    now: () => remainingTimes.shift() ?? '2026-05-15T08:00:00.000Z',
  });
  return { backend, store };
}

describe('xingye-group-chat-state-store', () => {
  it('uses agent-scoped path group-chat/runs.jsonl', () => {
    expect(XINGYE_GROUP_CHAT_RUNS_PATH).toBe('group-chat/runs.jsonl');
  });

  it('builds a stable dedupe key from agent + channel + latest message', () => {
    const key = makeGroupChatDedupeKey({
      agentId: 'agent-a',
      channelId: 'ch_crew',
      latestMessageId: 'user@2026-05-15 09:00',
    });
    expect(key).toBe('agent-a::ch_crew::user@2026-05-15 09:00');
  });

  it('rejects empty agentId or channelId for the dedupe key', () => {
    expect(() => makeGroupChatDedupeKey({ agentId: '', channelId: 'ch_a', latestMessageId: 'x' })).toThrow();
    expect(() => makeGroupChatDedupeKey({ agentId: 'a', channelId: '', latestMessageId: 'x' })).toThrow();
  });

  it('builds a stable channel message id from sender + timestamp', () => {
    expect(buildChannelMessageId({ sender: 'user', timestamp: '2026-05-15 09:00' }))
      .toBe('user@2026-05-15 09:00');
  });

  it('appends a replied run and persists it under the agent scope', async () => {
    const { backend, store } = makeStore(['2026-05-15T08:00:00.000Z'], ['run-1']);
    const run = await store.appendRun({
      agentId: 'agent-a',
      channelId: 'ch_crew',
      sourceMessageIds: ['user@2026-05-15 09:00', 'agent-b@2026-05-15 09:01'],
      latestMessageId: 'agent-b@2026-05-15 09:01',
      status: 'replied',
      replyMessageId: 'agent-a@2026-05-15 09:02',
      replyContent: '我在。',
      reason: '直接回应了 agent-b 的提问',
    });

    expect(run).toMatchObject({
      id: 'run-1',
      agentId: 'agent-a',
      channelId: 'ch_crew',
      latestMessageId: 'agent-b@2026-05-15 09:01',
      dedupeKey: 'agent-a::ch_crew::agent-b@2026-05-15 09:01',
      status: 'replied',
      replyMessageId: 'agent-a@2026-05-15 09:02',
      replyContent: '我在。',
      reason: '直接回应了 agent-b 的提问',
      createdAt: '2026-05-15T08:00:00.000Z',
    });

    const stored = await backend.listJsonl<XingyeGroupChatRun>('agent-a', XINGYE_GROUP_CHAT_RUNS_PATH);
    expect(stored).toHaveLength(1);
    expect(stored[0].dedupeKey).toBe('agent-a::ch_crew::agent-b@2026-05-15 09:01');
  });

  it('finds a previous run by dedupe key, allowing the caller to skip a duplicate trigger', async () => {
    const { store } = makeStore(['2026-05-15T08:00:00.000Z'], ['run-1']);
    await store.appendRun({
      agentId: 'agent-a',
      channelId: 'ch_crew',
      sourceMessageIds: ['user@2026-05-15 09:00'],
      latestMessageId: 'user@2026-05-15 09:00',
      status: 'replied',
      replyContent: '收到。',
    });

    const same = await store.findRunByDedupeKey('agent-a', 'agent-a::ch_crew::user@2026-05-15 09:00');
    expect(same?.status).toBe('replied');

    const other = await store.findRunByDedupeKey('agent-a', 'agent-a::ch_crew::user@2026-05-15 09:05');
    expect(other).toBeNull();
  });

  it('keeps state strictly per-agent so switching agents does not mix runs', async () => {
    const { backend, store } = makeStore(
      ['2026-05-15T08:00:00.000Z', '2026-05-15T08:00:05.000Z'],
      ['run-1', 'run-2'],
    );
    await store.appendRun({
      agentId: 'agent-a',
      channelId: 'ch_crew',
      sourceMessageIds: ['user@2026-05-15 09:00'],
      latestMessageId: 'user@2026-05-15 09:00',
      status: 'replied',
      replyContent: '我在。',
    });
    await store.appendRun({
      agentId: 'agent-b',
      channelId: 'ch_crew',
      sourceMessageIds: ['user@2026-05-15 09:00'],
      latestMessageId: 'user@2026-05-15 09:00',
      status: 'skipped',
      reason: 'agent-b 觉得不必发言',
    });

    await expect(store.listRuns('agent-a')).resolves.toHaveLength(1);
    await expect(store.listRuns('agent-b')).resolves.toHaveLength(1);

    const aRows = await backend.listJsonl<XingyeGroupChatRun>('agent-a', XINGYE_GROUP_CHAT_RUNS_PATH);
    const bRows = await backend.listJsonl<XingyeGroupChatRun>('agent-b', XINGYE_GROUP_CHAT_RUNS_PATH);
    expect(aRows.map((r) => r.status)).toEqual(['replied']);
    expect(bRows.map((r) => r.status)).toEqual(['skipped']);
  });

  it('lists runs for a single channel for the current agent', async () => {
    const { store } = makeStore(
      [
        '2026-05-15T08:00:00.000Z',
        '2026-05-15T08:00:10.000Z',
        '2026-05-15T08:00:20.000Z',
      ],
      ['run-1', 'run-2', 'run-3'],
    );
    await store.appendRun({
      agentId: 'agent-a', channelId: 'ch_crew', sourceMessageIds: ['user@t1'],
      latestMessageId: 'user@t1', status: 'replied', replyContent: 'a',
    });
    await store.appendRun({
      agentId: 'agent-a', channelId: 'ch_crew', sourceMessageIds: ['user@t2'],
      latestMessageId: 'user@t2', status: 'skipped', reason: '没有想说的',
    });
    await store.appendRun({
      agentId: 'agent-a', channelId: 'ch_other', sourceMessageIds: ['user@t3'],
      latestMessageId: 'user@t3', status: 'replied', replyContent: 'b',
    });

    await expect(store.listRunsForChannel('agent-a', 'ch_crew')).resolves.toMatchObject([
      { dedupeKey: 'agent-a::ch_crew::user@t1' },
      { dedupeKey: 'agent-a::ch_crew::user@t2' },
    ]);
  });
});
