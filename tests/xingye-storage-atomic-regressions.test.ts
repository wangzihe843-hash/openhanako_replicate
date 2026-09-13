import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createXingyeStorageRoute } from '../server/routes/xingye-storage.js';
import { createAgentXingyeStorageBackend } from '../desktop/src/react/xingye/xingye-storage-backend';
import { createXingyeStore } from '../desktop/src/react/xingye/xingye-store-utils';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = path.resolve('output/audit-fixes-2026-09-10/xingye/fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'storage-'));
  roots.push(root);
  const agentsDir = path.join(root, 'agents');
  fs.mkdirSync(path.join(agentsDir, 'a'), { recursive: true });
  const app = new Hono();
  app.route('/api', createXingyeStorageRoute({ agentsDir, getAgent: (id: string) => id === 'a' ? { id } : null }));
  const request = (body: Record<string, unknown>) => app.request('/api/xingye/storage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'a', ...body }),
  });
  const post = async (body: Record<string, unknown>) => {
    const response = await request(body);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };
  return { root, request, post, disk: (relative: string) => path.join(agentsDir, 'a/xingye', relative) };
}

describe('X3/X7 storage row updates against the real HTTP route', () => {
  it('retains independent concurrent changes, including two changes on one row and an append', async () => {
    const { post } = fixture();
    const store = createXingyeStore(createAgentXingyeStorageBackend(post));
    const rel = 'apps/moments/posts.jsonl';
    await store.appendJsonl('a', rel, { id: 'one', count: 0 });
    await store.appendJsonl('a', rel, { id: 'two', count: 0 });
    const increment = (id: string) => store.updateJsonlRecord<{ id: string; count: number }>('a', rel, id, row => ({ ...row, count: row.count + 1 }));
    await Promise.all([increment('one'), increment('two'), increment('one'), store.appendJsonl('a', rel, { id: 'three', count: 0 })]);
    expect(await store.listJsonl('a', rel)).toEqual([{ id: 'one', count: 2 }, { id: 'two', count: 1 }, { id: 'three', count: 0 }]);
  });

  it('rejects a stale replacement, preserves malformed lines, and retains the original on rename failure', async () => {
    const { post, request, disk } = fixture();
    const relativePath = 'apps/mail/messages.jsonl';
    const row = { id: 'one', isRead: false };
    await post({ action: 'appendJsonl', relativePath, data: row });
    fs.appendFileSync(disk(relativePath), '{broken\n');
    const original = fs.readFileSync(disk(relativePath), 'utf8');
    const update = { action: 'compareAndSwapJsonlRecord', relativePath, recordId: 'one', expected: row, data: { ...row, isRead: true } };
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === disk(relativePath)) throw new Error('injected rename failure');
      return realRename(from, to);
    });
    expect((await request(update)).status).toBe(500);
    expect(fs.readFileSync(disk(relativePath), 'utf8')).toBe(original);
    vi.restoreAllMocks();
    expect(await post(update)).toMatchObject({ updated: true });
    expect(await post(update)).toMatchObject({ updated: false, record: { id: 'one', isRead: true } });
    expect(fs.readFileSync(disk(relativePath), 'utf8')).toContain('{broken\n');
    expect((await request({ ...update, relativePath: '../outside.jsonl' })).status).toBe(400);
  });
});

describe('B07 stable lore sync failures', () => {
  it.each(['add', 'update', 'delete'] as const)('reports %s failure, preserves both files, and can retry', async (action) => {
    const { post, request, disk } = fixture();
    const entry = { id: 'one', agentId: 'a', title: 'stable', content: 'old lore', enabled: true, insertionMode: 'always', category: 'background', visibility: 'canonical', updatedAt: '2026-09-10T00:00:00.000Z' };
    const initial = action === 'add' ? {} : { one: entry };
    await post({ action: 'writeJson', relativePath: 'lore/entries.json', data: initial });
    const canonical = fs.readFileSync(disk('lore/entries.json'), 'utf8');
    const derived = fs.readFileSync(disk('lore-memory.md'), 'utf8');
    const data = action === 'delete' ? null : { one: { ...entry, content: 'new lore' } };
    const realWrite = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, ...args) => {
      if (String(file).includes('lore-memory.md')) throw new Error('injected derived failure');
      return (realWrite as any)(file, ...args);
    });
    expect((await request({ action: 'writeJson', relativePath: 'lore/entries.json', data })).status).toBe(500);
    expect(fs.readFileSync(disk('lore/entries.json'), 'utf8')).toBe(canonical);
    expect(fs.readFileSync(disk('lore-memory.md'), 'utf8')).toBe(derived);
    vi.restoreAllMocks();
    await post({ action: 'writeJson', relativePath: 'lore/entries.json', data });
    expect(JSON.parse(fs.readFileSync(disk('lore/entries.json'), 'utf8'))).toEqual(data);
    if (action === 'delete') expect(fs.readFileSync(disk('lore-memory.md'), 'utf8')).not.toContain('old lore');
    else expect(fs.readFileSync(disk('lore-memory.md'), 'utf8')).toContain('new lore');
  });
});
