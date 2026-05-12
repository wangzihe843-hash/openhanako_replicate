import { describe, expect, it } from 'vitest';
import {
  createLocalStorageXingyeBackend,
  createMemoryXingyeStorageBackend,
  createWorkspaceXingyeStorageBackend,
} from './xingye-storage-backend';

describe('xingye-storage-backend', () => {
  it('memory backend readJson writeJson appendRecord listRecords', async () => {
    const b = createMemoryXingyeStorageBackend();
    expect(await b.readJson<{ x: number }>('a1', 'profile')).toBeNull();
    await b.writeJson('a1', 'profile', { x: 1 });
    expect(await b.readJson<{ x: number }>('a1', 'profile')).toEqual({ x: 1 });
    await b.appendRecord('a1', 'log', { id: '1' });
    await b.appendRecord('a1', 'log', { id: '2' });
    expect(await b.listRecords<{ id: string }>('a1', 'log')).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('localStorage backend uses key mapper', async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
    };
    const b = createLocalStorageXingyeBackend(storage, (agentId, domain) => `k:${agentId}:${domain}`);
    await b.writeJson('x', 'profile', { hello: true });
    expect(mem.get('k:x:profile')).toContain('hello');
    expect(await b.readJson<{ hello: boolean }>('x', 'profile')).toEqual({ hello: true });
  });

  it('workspace backend uses post mock', async () => {
    const writes: Array<{ rel: string; content: string }> = [];
    const post = async (body: Record<string, unknown>) => {
      if (body.action === 'write') {
        writes.push({ rel: String(body.relativePath), content: String(body.content) });
        return { ok: true };
      }
      if (body.action === 'read') {
        const hit = writes.find((w) => w.rel === body.relativePath);
        if (!hit) return { ok: true, missing: true, content: null };
        return { ok: true, encoding: 'utf8', content: hit.content };
      }
      if (body.action === 'append') {
        const rel = String(body.relativePath);
        const prev = writes.find((w) => w.rel === rel);
        const next = (prev?.content ?? '') + String(body.content);
        if (prev) writes.splice(writes.indexOf(prev), 1);
        writes.push({ rel, content: next });
        return { ok: true };
      }
      return {};
    };
    const b = createWorkspaceXingyeStorageBackend(post);
    await b.writeJson('ag', 'profile', { n: 3 });
    expect(await b.readJson<{ n: number }>('ag', 'profile')).toEqual({ n: 3 });
    await b.appendRecord('ag', 'events', { e: 1 });
    await b.appendRecord('ag', 'events', { e: 2 });
    const rows = await b.listRecords<{ e: number }>('ag', 'events');
    expect(rows).toEqual([{ e: 1 }, { e: 2 }]);
  });
});
