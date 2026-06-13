/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendForumAccount,
  appendForumPosts,
  deleteForumPost,
  listForumAccounts,
  listForumPosts,
  markForumInitialized,
  readForumMeta,
  replaceForumPost,
} from './xingye-forum-store';
import { assembleAccount, assemblePosts } from './xingye-forum-assemble';

const NOW = Date.parse('2026-06-13T12:00:00.000Z');

/** 内存版后端：实现 createAgentXingyeStorageBackend 用到的全部 action。 */
function installMemoryBackend() {
  const jsonl = new Map<string, Record<string, unknown>[]>();
  const json = new Map<string, unknown>();
  const idOf = (r: Record<string, unknown>) => String(r.key ?? r.id ?? '');
  postMock.mockImplementation(async (body: Record<string, unknown>) => {
    const path = String(body.relativePath);
    switch (body.action) {
      case 'appendJsonl':
        jsonl.set(path, [...(jsonl.get(path) ?? []), body.data as Record<string, unknown>]);
        return { ok: true };
      case 'listJsonl':
        return { ok: true, records: jsonl.get(path) ?? [] };
      case 'writeJsonl':
        jsonl.set(path, (body.records as Record<string, unknown>[]) ?? []);
        return { ok: true };
      case 'deleteJsonlRecord': {
        const rows = jsonl.get(path) ?? [];
        const next = rows.filter((r) => idOf(r) !== String(body.recordId));
        const deleted = next.length !== rows.length;
        jsonl.set(path, next);
        return { ok: true, deleted };
      }
      case 'readJson':
        return json.has(path) ? { ok: true, data: json.get(path) } : { ok: true, missing: true };
      case 'writeJson':
        json.set(path, body.data);
        return { ok: true };
      default:
        throw new Error(`unexpected action ${String(body.action)}`);
    }
  });
}

describe('xingye-forum-store round trip', () => {
  beforeEach(() => {
    postMock.mockReset();
    installMemoryBackend();
  });

  it('appends and lists accounts', async () => {
    const acc = assembleAccount({ username: 'u', bio: 'b', themeLabel: 't', themeKeywords: [] }, { now: NOW, rand: () => 0.5 });
    await appendForumAccount('agentA', acc);
    const list = await listForumAccounts('agentA');
    expect(list.length).toBe(1);
    expect(list[0].username).toBe('u');
  });

  it('appends posts and returns them newest-first', async () => {
    const acc = assembleAccount({ username: 'u', bio: 'b', themeLabel: 't', themeKeywords: [] }, { now: NOW, rand: () => 0.5 });
    const posts = assemblePosts(
      [
        { relation: 'authored', board: 'b', title: '旧', body: 'x', comments: [{ authorName: 'n', authorIsAgent: false, body: 'c', replies: [] }] },
        { relation: 'authored', board: 'b', title: '新', body: 'y', comments: [{ authorName: 'n', authorIsAgent: false, body: 'c', replies: [] }] },
      ],
      acc,
      { now: NOW, rand: () => 0.5, spreadDays: 10 },
    );
    await appendForumPosts('agentA', posts);
    const list = await listForumPosts('agentA');
    expect(list.length).toBe(2);
    // 倒序：postedAt 较新的在前
    expect(Date.parse(list[0].postedAt)).toBeGreaterThanOrEqual(Date.parse(list[1].postedAt));
  });

  it('replaceForumPost updates an existing row and is a no-op when missing', async () => {
    const acc = assembleAccount({ username: 'u', bio: 'b', themeLabel: 't', themeKeywords: [] }, { now: NOW, rand: () => 0.5 });
    const [post] = assemblePosts(
      [{ relation: 'authored', board: 'b', title: 't', body: 'x', comments: [{ authorName: 'n', authorIsAgent: false, body: 'c', replies: [] }] }],
      acc,
      { now: NOW, rand: () => 0.5 },
    );
    await appendForumPosts('agentA', [post]);

    const updated = { ...post, title: '改过的标题' };
    expect(await replaceForumPost('agentA', updated)).toBe(true);
    const list = await listForumPosts('agentA');
    expect(list[0].title).toBe('改过的标题');

    expect(await replaceForumPost('agentA', { ...post, postId: 'nope' })).toBe(false);
  });

  it('deleteForumPost removes by id', async () => {
    const acc = assembleAccount({ username: 'u', bio: 'b', themeLabel: 't', themeKeywords: [] }, { now: NOW, rand: () => 0.5 });
    const [post] = assemblePosts(
      [{ relation: 'authored', board: 'b', title: 't', body: 'x', comments: [{ authorName: 'n', authorIsAgent: false, body: 'c', replies: [] }] }],
      acc,
      { now: NOW, rand: () => 0.5 },
    );
    await appendForumPosts('agentA', [post]);
    expect(await deleteForumPost('agentA', post.postId)).toBe(true);
    expect((await listForumPosts('agentA')).length).toBe(0);
  });

  it('persists the initialized marker', async () => {
    expect(await readForumMeta('agentA')).toBeNull();
    await markForumInitialized('agentA', new Date(NOW).toISOString());
    const meta = await readForumMeta('agentA');
    expect(meta?.initializedAt).toBe(new Date(NOW).toISOString());
  });
});
