import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writePinnedMemoryItems } from '../lib/memory/pinned-memory-store.ts';
import { runXingyeHeartbeatConsumer } from '../lib/xingye/heartbeat-consumer.js';
import {
  addRealityTopicCandidate,
  addSharedMemoryTopicCandidate,
  listTopicCandidates,
  offerTopicCandidates,
  setTopicCandidateStatus,
  settleTopicOffers,
} from '../lib/xingye/topic-candidates.js';

const agentId = 'topic-agent';
const at = (day) => new Date(`2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`);
const roots = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingye-topics-'));
  roots.push(dir);
  return path.join(dir, 'agents', agentId);
}
function event(id, type, payload, day = 20, subjectId = id) {
  return { id, agentId, type, source: 'test', subjectId, payload,
    createdAt: at(day).toISOString() };
}
function writeEvents(agentDir, events) {
  const file = path.join(agentDir, 'xingye', 'events', 'log.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, events, dedupeKeys: {} }));
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('Xingye proactive topic candidates', () => {
  it('offers only user-selected confirmed memory and fictional news, never arbitrary pins or drafts', async () => {
    const agentDir = fixture();
    writePinnedMemoryItems(agentDir, [
      { id: 'private-pin', content: '用户私人工作地址' },
      { id: 'shared-pin', content: '上次一起看过日落' },
    ]);
    writeEvents(agentDir, [
      event('draft', 'memory_candidate.draft_proposed', { topicText: '草稿不应出现' }),
      event('memory', 'memory_candidate.written', { topicText: '用户私人工作地址' }),
      event('news', 'news.entry_appended', { title: '城中举行灯会' }),
    ]);
    await expect(addSharedMemoryTopicCandidate({ agentDir, agentId, pinContent: '未确认记忆',
      reason: '用户选择', expiresAt: at(23).toISOString(), now: at(21) })).rejects.toThrow('not found');
    await addSharedMemoryTopicCandidate({ agentDir, agentId, pinContent: '上次一起看过日落',
      reason: '用户选择作为共同经历', expiresAt: at(23).toISOString(), now: at(21) });
    const first = await runXingyeHeartbeatConsumer({ agentDir, agentId, now: () => at(21) });
    expect(first.topicCandidates.map((row) => row.title)).toEqual(['城中举行灯会', '上次一起看过日落']);
    expect(first.topicCandidates.map((row) => row.sourceType)).toEqual(['world_event', 'shared_memory']);
    expect(first.topicCandidates[1].source.pinId).toBe('shared-pin');
    const second = await runXingyeHeartbeatConsumer({ agentDir, agentId, now: () => at(21) });
    expect(second.topicCandidates).toEqual([]);
    expect((await listTopicCandidates({ agentDir, agentId, now: at(21) })).filter(row => row.status === 'offered')).toHaveLength(2);
  });

  it('invalidates an explicitly selected memory after its pinned source changes', async () => {
    const agentDir = fixture();
    writePinnedMemoryItems(agentDir, [{ id: 'shared', content: '一起走过老桥' }]);
    await addSharedMemoryTopicCandidate({ agentDir, agentId, pinContent: '一起走过老桥',
      reason: '用户选择', expiresAt: at(23).toISOString(), now: at(20) });
    expect(await offerTopicCandidates({ agentDir, agentId, events: [
      event('pin-change', 'pinned_memory.changed', {}, 21),
    ], now: at(21) })).toEqual([]);
    expect((await listTopicCandidates({ agentDir, agentId, now: at(21) }))[0].status).toBe('invalidated');
  });

  it('does not offer a selected pin after an out-of-band Markdown edit without an event', async () => {
    const agentDir = fixture();
    writePinnedMemoryItems(agentDir, [{ id: 'shared', content: '一起走过老桥' }]);
    await addSharedMemoryTopicCandidate({ agentDir, agentId, pinContent: '一起走过老桥',
      reason: '用户选择', expiresAt: at(23).toISOString(), now: at(20) });
    const markdown = path.join(agentDir, 'pinned.md');
    fs.writeFileSync(markdown, '- 已改为另一段经历\n');
    const newer = new Date(Date.now() + 5000);
    fs.utimesSync(markdown, newer, newer);
    expect(await offerTopicCandidates({ agentDir, agentId, now: at(21) })).toEqual([]);
    expect((await listTopicCandidates({ agentDir, agentId, now: at(21) }))[0].status).toBe('invalidated');
  });

  it('requires a user-selected real source and records usage across restart', async () => {
    const agentDir = fixture();
    await expect(addRealityTopicCandidate({ agentDir, agentId, title: '文章', reason: '合适',
      sourceUrl: 'file:///private/data', expiresAt: at(23).toISOString(), now: at(21) })).rejects.toThrow('sourceUrl');
    const added = await addRealityTopicCandidate({ agentDir, agentId, title: '展览', reason: '用户想了解',
      sourceUrl: 'https://example.org/exhibit', expiresAt: at(23).toISOString(), now: at(21) });
    const offered = await offerTopicCandidates({ agentDir, agentId, now: at(21) });
    expect(offered).toMatchObject([{ id: added.id, sourceType: 'reality_source' }]);
    const used = await setTopicCandidateStatus({ agentDir, agentId, id: added.id, status: 'used', now: at(21) });
    expect(used.lastUsedAt).toBe(at(21).toISOString());
    expect(await offerTopicCandidates({ agentDir, agentId, now: at(21) })).toEqual([]);
    expect((await listTopicCandidates({ agentDir, agentId, now: at(22) }))[0].status).toBe('used');
  });

  it('deduplicates repeated selections while active and permits a new selection after use', async () => {
    const agentDir = fixture();
    writePinnedMemoryItems(agentDir, [{ id: 'shared', content: '一起走过老桥' }]);
    const real = { agentDir, agentId, title: '展览', reason: '用户选择',
      sourceUrl: 'https://example.org/exhibit', expiresAt: at(23).toISOString(), now: at(21) };
    const shared = { agentDir, agentId, pinContent: '一起走过老桥',
      reason: '用户选择', expiresAt: at(23).toISOString(), now: at(21) };
    const firstReal = await addRealityTopicCandidate(real);
    const firstShared = await addSharedMemoryTopicCandidate(shared);
    expect((await addRealityTopicCandidate(real)).id).toBe(firstReal.id);
    expect((await addRealityTopicCandidate({ ...real, title: '同一网址的新标题' })).id).toBe(firstReal.id);
    expect((await addSharedMemoryTopicCandidate(shared)).id).toBe(firstShared.id);
    expect(await offerTopicCandidates({ agentDir, agentId, now: at(21) })).toHaveLength(2);
    expect((await addRealityTopicCandidate(real)).id).toBe(firstReal.id);
    await setTopicCandidateStatus({ agentDir, agentId, id: firstReal.id, status: 'used', now: at(21) });
    expect((await addRealityTopicCandidate(real)).id).not.toBe(firstReal.id);
  });

  it('expires old candidates and invalidates a deleted world source before delivery', async () => {
    const agentDir = fixture();
    const rows = await offerTopicCandidates({ agentDir, agentId, now: at(21), events: [
      event('old-news', 'news.entry_appended', { title: '旧报纸' }, 17),
      event('new-news', 'news.entry_appended', { title: '新报纸' }, 20, 'issue-2'),
      event('deleted', 'news.entry_deleted', {}, 21, 'issue-2'),
    ] });
    expect(rows).toEqual([]);
    expect((await listTopicCandidates({ agentDir, agentId, now: at(21) })).map(row => row.status)).toEqual(['expired', 'invalidated']);
  });

  it('does not offer a scene-specific candidate without the matching scene', async () => {
    const agentDir = fixture();
    const file = path.join(agentDir, 'xingye', 'heartbeat', 'topic-candidates.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, agentId, candidates: [{
      id: 'scene-1', agentId, sceneId: 'scene-a', sourceType: 'world_event',
      source: { eventId: 'event-a' }, title: '某世界秘密', reason: '剧情内',
      createdAt: at(20).toISOString(), expiresAt: at(23).toISOString(),
      status: 'pending', offeredAt: null, lastUsedAt: null, updatedAt: at(20).toISOString(),
    }] }));
    expect(await offerTopicCandidates({ agentDir, agentId, now: at(21) })).toEqual([]);
    expect((await offerTopicCandidates({ agentDir, agentId, sceneId: 'scene-a', now: at(21) })).map(row => row.id)).toEqual(['scene-1']);
  });

  it('releases an unstarted offer but holds an uncertain started offer for user review', async () => {
    const agentDir = fixture();
    const row = await addRealityTopicCandidate({ agentDir, agentId, title: '展览', reason: '用户选择',
      sourceUrl: 'https://example.org/exhibit', expiresAt: at(23).toISOString(), now: at(21) });
    expect(await offerTopicCandidates({ agentDir, agentId, now: at(21) })).toHaveLength(1);
    await settleTopicOffers({ agentDir, agentId, ids: [row.id], status: 'pending', now: at(21) });
    expect(await offerTopicCandidates({ agentDir, agentId, now: at(21) })).toHaveLength(1);
    await settleTopicOffers({ agentDir, agentId, ids: [row.id], status: 'indeterminate', now: at(21) });
    expect(await offerTopicCandidates({ agentDir, agentId, now: at(21) })).toEqual([]);
    expect((await listTopicCandidates({ agentDir, agentId, now: at(21) }))[0].status).toBe('indeterminate');
    await setTopicCandidateStatus({ agentDir, agentId, id: row.id, status: 'pending', now: at(21) });
    expect(await offerTopicCandidates({ agentDir, agentId, now: at(21) })).toHaveLength(1);
  });
});
