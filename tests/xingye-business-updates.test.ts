import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createXingyeStorageRoute } from '../server/routes/xingye-storage.js';
import { updateMailMessage, XINGYE_MAIL_MESSAGES_JSONL } from '../desktop/src/react/xingye/xingye-mail-store';
import { updateScheduleEntryStatus, XINGYE_SCHEDULE_ENTRIES_JSONL } from '../desktop/src/react/xingye/xingye-schedule-store';
import { updateFileEntry, XINGYE_FILES_ENTRIES_JSONL } from '../desktop/src/react/xingye/xingye-files-store';
import { createXingyeMomentStore } from '../desktop/src/react/xingye/xingye-moments-store';
import { createAgentXingyeStorageBackend } from '../desktop/src/react/xingye/xingye-storage-backend';

const io = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../desktop/src/react/xingye/xingye-storage-api', () => ({ postXingyeStorage: (...args: unknown[]) => io.post(...args) }));
vi.mock('../desktop/src/react/xingye/xingye-event-log', () => ({ appendXingyeEvent: async () => ({}), appendXingyeEventOnce: async () => ({}) }));
let tempRoot: string;
let disk: (relative: string) => string;
beforeEach(() => {
  const parent = path.resolve('output/audit-fixes-2026-09-10/xingye/fixtures');
  fs.mkdirSync(parent, { recursive: true });
  tempRoot = fs.mkdtempSync(path.join(parent, 'business-'));
  const agentsDir = path.join(tempRoot, 'agents');
  fs.mkdirSync(path.join(agentsDir, 'a'), { recursive: true });
  disk = relative => path.join(agentsDir, 'a/xingye', relative);
  const app = new Hono();
  app.route('/api', createXingyeStorageRoute({ agentsDir, getAgent: (id: string) => id === 'a' ? { id } : null }));
  io.post.mockReset();
  io.post.mockImplementation(async body => {
    const response = await app.request('/api/xingye/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'a', ...body }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tempRoot, { recursive: true, force: true }); });

const time = '2026-09-10T00:00:00.000Z';
const common = { id: 'one', key: 'one', agentId: 'a', createdAt: time, updatedAt: time };
const cases = [
  { name: 'mail', relative: XINGYE_MAIL_MESSAGES_JSONL, row: { ...common, mailbox: 'inbox', from: { name: 'Peer', address: 'peer@example.com', kind: 'person' }, subject: 'old', body: 'original', isRead: false, isStarred: false, labels: [], to: [] }, change: () => updateMailMessage('a', 'one', { isRead: true }), expected: { isRead: true } },
  { name: 'schedule', relative: XINGYE_SCHEDULE_ENTRIES_JSONL, row: { ...common, title: 'old', dateLabel: 'today', content: 'original', status: 'pending', source: 'manual' }, change: () => updateScheduleEntryStatus('a', 'one', 'done'), expected: { status: 'done' } },
  { name: 'files', relative: XINGYE_FILES_ENTRIES_JSONL, row: { ...common, folderId: 'world', title: 'old', body: 'original', tags: [] }, change: () => updateFileEntry('a', 'one', { title: 'new' }), expected: { title: 'new' } },
];
describe('X3 actual business stores through HTTP', () => {
  it.each(cases)('$name update preserves the original on commit failure and can retry', async ({ relative, row, change, expected }) => {
    await io.post({ action: 'appendJsonl', relativePath: relative, data: row });
    const original = fs.readFileSync(disk(relative), 'utf8');
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === disk(relative)) throw new Error('injected commit failure');
      return rename(from, to);
    });
    await expect(change()).rejects.toThrow('injected commit failure');
    expect(fs.readFileSync(disk(relative), 'utf8')).toBe(original);
    expect(io.post.mock.calls.some(([body]) => body.action === 'deleteJsonlRecord')).toBe(false);
    vi.restoreAllMocks();
    expect(await change()).toMatchObject(expected);
    expect((await io.post({ action: 'listJsonl', relativePath: relative })).records).toEqual([expect.objectContaining(expected)]);
  });

  it.each(cases)('$name preserves mismatched-owner records and does not update them', async ({ relative, row, change }) => {
    await io.post({ action: 'appendJsonl', relativePath: relative, data: { ...row, agentId: 'other' } });
    const original = fs.readFileSync(disk(relative), 'utf8');
    expect(await change()).toBeNull();
    expect(fs.readFileSync(disk(relative), 'utf8')).toBe(original);
  });

  it('merges concurrent mail read/star updates on the same record', async () => {
    const mail = cases[0];
    await io.post({ action: 'appendJsonl', relativePath: mail.relative, data: mail.row });
    await Promise.all([updateMailMessage('a', 'one', { isRead: true }), updateMailMessage('a', 'one', { isStarred: true })]);
    expect((await io.post({ action: 'listJsonl', relativePath: mail.relative })).records).toEqual([expect.objectContaining({ isRead: true, isStarred: true })]);
  });
});

describe('X7 real moments store through HTTP', () => {
  it('retains concurrent likes, comments, and a new post across independent clients', async () => {
    const client = () => createXingyeMomentStore(createAgentXingyeStorageBackend(io.post));
    const first = client(); const second = client();
    await first.createPost({ id: 'one', authorAgentId: 'a', authorName: 'A', content: 'first' });
    await first.createPost({ id: 'two', authorAgentId: 'a', authorName: 'A', content: 'second' });
    const actor = { actorType: 'user' as const, actorId: 'reader', actorName: 'Reader' };
    await Promise.all([
      first.toggleLike('a', 'one', actor), second.toggleLike('a', 'two', actor),
      first.addComment('a', 'one', actor, 'comment one'), second.addComment('a', 'one', actor, 'comment two'),
      second.createPost({ id: 'three', authorAgentId: 'a', authorName: 'A', content: 'new' }),
    ]);
    const posts = await first.listPosts('a');
    expect(posts).toHaveLength(3);
    expect(posts.find(row => row.id === 'one')).toMatchObject({ likes: [expect.objectContaining({ actorId: 'reader' })], comments: expect.arrayContaining([expect.objectContaining({ body: 'comment one' }), expect.objectContaining({ body: 'comment two' })]) });
    expect(posts.find(row => row.id === 'one')?.comments).toHaveLength(2);
    expect(posts.find(row => row.id === 'two')?.likes).toHaveLength(1);
  });
});
