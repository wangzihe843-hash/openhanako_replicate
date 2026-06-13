/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendCpDrafts,
  appendCpPosts,
  deleteCpDraft,
  listCpDrafts,
  listCpPosts,
  markCpInitialized,
  readCpMeta,
  replaceCpPost,
  writeCpMeta,
} from './xingye-cp-store';
import { assembleCpPosts } from './xingye-cp-assemble';
import type { CpDraft } from './xingye-cp-types';

const NOW = Date.parse('2026-06-13T12:00:00.000Z');
const opts = { now: NOW, rand: () => 0.5 };

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

function draft(overrides: Partial<CpDraft> = {}): CpDraft {
  return {
    draftId: 'd1',
    kind: 'post',
    genre: 'fic',
    board: 'CP·糖',
    title: '想发的帖',
    body: '正文',
    sendReaction: '哎你',
    hesitation: '怂了',
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('xingye-cp-store round trip', () => {
  beforeEach(() => {
    postMock.mockReset();
    installMemoryBackend();
  });

  it('appends and lists posts newest-first', async () => {
    const posts = assembleCpPosts(
      [
        { genre: 'fic', board: 'b', title: '旧', body: 'x', authorName: 'n', comments: [] },
        { genre: 'squee', board: 'b', title: '新', body: 'y', authorName: 'n', comments: [] },
      ],
      'altU',
      { ...opts, spreadDays: 6 },
    );
    await appendCpPosts('agentA', posts);
    const list = await listCpPosts('agentA');
    expect(list.length).toBe(2);
    expect(Date.parse(list[0].postedAt)).toBeGreaterThanOrEqual(Date.parse(list[1].postedAt));
  });

  it('replaceCpPost updates an existing row and is a no-op when missing', async () => {
    const [post] = assembleCpPosts([{ genre: 'fic', board: 'b', title: 't', body: 'x', authorName: 'n', comments: [] }], 'altU', opts);
    await appendCpPosts('agentA', [post]);
    expect(await replaceCpPost('agentA', { ...post, title: '改过的' })).toBe(true);
    expect((await listCpPosts('agentA'))[0].title).toBe('改过的');
    expect(await replaceCpPost('agentA', { ...post, postId: 'nope' })).toBe(false);
  });

  it('appends, lists and deletes drafts', async () => {
    await appendCpDrafts('agentA', [draft({ draftId: 'd1' }), draft({ draftId: 'd2', kind: 'reply', targetPostId: 'p', targetPostTitle: 't', title: undefined, genre: undefined, board: undefined })]);
    let list = await listCpDrafts('agentA');
    expect(list.length).toBe(2);
    const reply = list.find((d) => d.draftId === 'd2');
    expect(reply?.kind).toBe('reply');
    expect(reply?.targetPostId).toBe('p');
    expect(await deleteCpDraft('agentA', 'd1')).toBe(true);
    list = await listCpDrafts('agentA');
    expect(list.length).toBe(1);
    expect(await deleteCpDraft('agentA', 'missing')).toBe(false);
  });

  it('merges meta and respects initialized idempotency', async () => {
    expect(await readCpMeta('agentA')).toBeNull();
    await writeCpMeta('agentA', { watermark: 'sig1', followed: true });
    let meta = await readCpMeta('agentA');
    expect(meta?.watermark).toBe('sig1');
    expect(meta?.followed).toBe(true);

    await markCpInitialized('agentA', new Date(NOW).toISOString());
    meta = await readCpMeta('agentA');
    expect(meta?.initializedAt).toBe(new Date(NOW).toISOString());
    // 二次 init 不覆写
    await markCpInitialized('agentA', '2030-01-01T00:00:00.000Z');
    meta = await readCpMeta('agentA');
    expect(meta?.initializedAt).toBe(new Date(NOW).toISOString());
    // 关注/水位线仍在
    expect(meta?.followed).toBe(true);
    expect(meta?.watermark).toBe('sig1');
  });

  it('persists the alt identity and the CP name', async () => {
    await writeCpMeta('agentA', {
      cpName: '博君一肖',
      alt: { accountId: 'calt1', username: '蹲墙根潜水', bio: 'b', themeLabel: '潜水', avatarSeed: '蹲墙根潜水', fromForum: false },
    });
    const meta = await readCpMeta('agentA');
    expect(meta?.cpName).toBe('博君一肖');
    expect(meta?.alt?.username).toBe('蹲墙根潜水');
    expect(meta?.alt?.fromForum).toBe(false);
  });
});
