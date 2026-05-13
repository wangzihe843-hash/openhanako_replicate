import { describe, expect, it, vi } from 'vitest';
import {
  createLocalStorageXingyeBackend,
  createMemoryXingyeStorageBackend,
  createAgentXingyeStorageBackend,
} from './xingye-storage-backend';

describe('xingye-storage-backend', () => {
  it('memory backend readJson writeJson appendJsonl listJsonl', async () => {
    const b = createMemoryXingyeStorageBackend();
    expect(await b.readJson<{ x: number }>('a1', 'profile.json')).toBeNull();
    await b.writeJson('a1', 'profile.json', { x: 1 });
    expect(await b.readJson<{ x: number }>('a1', 'profile.json')).toEqual({ x: 1 });
    await b.appendJsonl('a1', 'secret-space/dream.jsonl', { id: '1' });
    await b.appendJsonl('a1', 'secret-space/dream.jsonl', { id: '2' });
    expect(await b.listJsonl<{ id: string }>('a1', 'secret-space/dream.jsonl')).toEqual([{ id: '1' }, { id: '2' }]);
    expect(await b.listJsonl<{ id: string }>('a2', 'secret-space/dream.jsonl')).toEqual([]);
    expect(await b.deleteJsonlRecord('a1', 'secret-space/dream.jsonl', '1')).toBe(true);
    expect(await b.listJsonl<{ id: string }>('a1', 'secret-space/dream.jsonl')).toEqual([{ id: '2' }]);
    expect(await b.deleteJsonlRecord('a1', 'secret-space/dream.jsonl', 'ghost')).toBe(false);
  });

  it('memory backend deleteJsonlRecord matches synthetic draft_reply-1 when rows omit key/id', async () => {
    const b = createMemoryXingyeStorageBackend();
    await b.appendJsonl('a1', 'secret-space/draft_reply.jsonl', { body: 'a', summary: 'sa', kind: 'draft_reply' });
    await b.appendJsonl('a1', 'secret-space/draft_reply.jsonl', { body: 'b', summary: 'sb', kind: 'draft_reply' });
    expect(await b.deleteJsonlRecord('a1', 'secret-space/draft_reply.jsonl', 'draft_reply-1')).toBe(true);
    expect(await b.listJsonl('a1', 'secret-space/draft_reply.jsonl')).toEqual([
      { body: 'a', summary: 'sa', kind: 'draft_reply' },
    ]);
  });

  it('localStorage backend uses key mapper', async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
    };
    const b = createLocalStorageXingyeBackend(storage, (agentId, domain) => `k:${agentId}:${domain}`);
    await b.writeJson('x', 'profile.json', { hello: true });
    expect(mem.get('k:x:profile.json')).toContain('hello');
    expect(await b.readJson<{ hello: boolean }>('x', 'profile.json')).toEqual({ hello: true });
  });

  it('agent backend sends agentId and relativePath without adding a business prefix', async () => {
    const writes: Array<{ rel: string; content: string }> = [];
    const post = async (body: Record<string, unknown>) => {
      expect(body.agentId).toBe('ag');
      if (body.action === 'writeJson') {
        writes.push({ rel: String(body.relativePath), content: JSON.stringify(body.data) });
        return { ok: true };
      }
      if (body.action === 'readJson') {
        const hit = writes.find((w) => w.rel === body.relativePath);
        if (!hit) return { ok: true, missing: true, data: null };
        return { ok: true, data: JSON.parse(hit.content) };
      }
      if (body.action === 'appendJsonl') {
        const rel = String(body.relativePath);
        const prev = writes.find((w) => w.rel === rel);
        const next = (prev?.content ?? '') + `${JSON.stringify(body.data)}\n`;
        if (prev) writes.splice(writes.indexOf(prev), 1);
        writes.push({ rel, content: next });
        return { ok: true };
      }
      if (body.action === 'listJsonl') {
        const hit = writes.find((w) => w.rel === body.relativePath);
        if (!hit) return { ok: true, records: [] };
        return {
          ok: true,
          records: hit.content
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line)),
        };
      }
      return {};
    };
    const b = createAgentXingyeStorageBackend(post);
    await b.writeJson('ag', 'profile.json', { n: 3 });
    expect(writes[0].rel).toBe('profile.json');
    expect(await b.readJson<{ n: number }>('ag', 'profile.json')).toEqual({ n: 3 });
    await b.appendJsonl('ag', 'secret-space/dream.jsonl', { e: 1 });
    await b.appendJsonl('ag', 'secret-space/dream.jsonl', { e: 2 });
    const rows = await b.listJsonl<{ e: number }>('ag', 'secret-space/dream.jsonl');
    expect(rows).toEqual([{ e: 1 }, { e: 2 }]);
    expect(await b.deleteJsonlRecord('ag', 'secret-space/dream.jsonl', 'noop')).toBe(false);
  });

  it('agent backend forwards deleteJsonlRecord', async () => {
    const post = vi.fn(async (body: Record<string, unknown>) => {
      if (body.action === 'deleteJsonlRecord') {
        return { ok: true, deleted: body.recordId === 'hit' };
      }
      return {};
    });
    const b = createAgentXingyeStorageBackend(post);
    expect(await b.deleteJsonlRecord('ag', 'secret-space/draft_reply.jsonl', 'hit')).toBe(true);
    expect(await b.deleteJsonlRecord('ag', 'secret-space/draft_reply.jsonl', 'miss')).toBe(false);
  });
});
