import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createXingyeStorageRoute } from '../server/routes/xingye-storage.js';
import { withXingyeAgentEventLock } from '../lib/xingye/events.js';
import { createAgentXingyeStorageBackend, createLocalStorageXingyeBackend, createMemoryXingyeStorageBackend } from '../desktop/src/react/xingye/xingye-storage-backend';
import { createXingyeBookCatalogStore, readingBookCatalogPath, type BookSearchResult } from '../desktop/src/react/xingye/xingye-reading-book-catalog';

const roots: string[] = [];
const context = { reason: 'synthetic', interests: [] as string[] };
const book = (title: string): BookSearchResult => ({ title, key: '', authors: ['Synthetic'] });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reading-catalog-atomic-')));
  roots.push(root);
  const agentsDir = path.join(root, 'agents');
  const engine = { agentsDir, getAgent: (id: string) => ['owner-a', 'owner-b'].includes(id) ? { id } : null };
  let app = new Hono().route('/api', createXingyeStorageRoute(engine));
  const requests: Record<string, unknown>[] = [];
  let gate: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined;
  const request = (body: Record<string, unknown>) => app.request('/api/xingye/storage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const post = async (body: Record<string, unknown>) => {
    requests.push(structuredClone(body));
    // Also intercept the old snapshot write so the SAME regression asserts red on the base.
    if (gate && ['writeJsonl', 'mutateReadingBookCatalog'].includes(String(body.action))) {
      const pending = gate;
      gate = undefined;
      pending.entered.resolve();
      await pending.released.promise;
    }
    const response = await request(body);
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
  };
  const makeStore = () => createXingyeBookCatalogStore(createAgentXingyeStorageBackend(post));
  const diskPath = (owner = 'owner-a') => path.join(agentsDir, owner, 'xingye', readingBookCatalogPath());
  return {
    requests, request, makeStore, diskPath,
    restart: () => { app = new Hono().route('/api', createXingyeStorageRoute(engine)); },
    seed: (content: Buffer | string, owner = 'owner-a') => {
      fs.mkdirSync(path.dirname(diskPath(owner)), { recursive: true });
      fs.writeFileSync(diskPath(owner), content);
    },
    bytes: (owner = 'owner-a') => fs.readFileSync(diskPath(owner)),
    pause: () => {
      gate = { entered: deferred(), released: deferred() };
      return { entered: gate.entered.promise, release: gate.released.resolve };
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('reading catalog transactions through real Hono and temporary disk', () => {
  it.each([false, true])('keeps acknowledged imports with reverse completion=%s', async (reverse) => {
    const f = fixture(); const a = f.makeStore(); const b = f.makeStore();
    await a.importBooksForAgent('owner-a', [book('existing')], context);
    const titles = reverse ? ['manual', 'bootstrap'] : ['bootstrap', 'manual'];
    const gate = f.pause();
    const pending = a.importBooksForAgent('owner-a', [book(titles[0])], context);
    await gate.entered;
    const acknowledged = await b.importBooksForAgent('owner-a', [book(titles[1])], context);
    expect(f.bytes().toString()).toContain(titles[1]);
    gate.release(); await pending;
    f.restart();
    const stored = await f.makeStore().listBooksForAgent('owner-a');
    expect(stored.map((row) => row.title).sort()).toEqual(['bootstrap', 'existing', 'manual']);
    expect(stored.find((row) => row.title === titles[1])?.id).toBe(acknowledged[0].id);
  });

  it.each([false, true])('never resurrects acknowledged deletions with reverse completion=%s', async (reverse) => {
    const f = fixture(); const a = f.makeStore(); const b = f.makeStore();
    const rows = await a.importBooksForAgent('owner-a', [book('one'), book('two'), book('keep')], context);
    const [first, second] = reverse ? [rows[1], rows[0]] : rows;
    const gate = f.pause(); const pending = a.deleteBookForAgent('owner-a', first.id);
    await gate.entered;
    expect(await b.deleteBookForAgent('owner-a', second.id)).toBe(true);
    expect(f.bytes().toString()).not.toContain(second.id);
    gate.release(); expect(await pending).toBe(true);
    f.restart();
    expect((await f.makeStore().listBooksForAgent('owner-a')).map((row) => row.title)).toEqual(['keep']);
    expect(await b.deleteBookForAgent('owner-a', second.id)).toBe(false);
  });

  it.each(['import', 'delete'])('preserves mixed operations when %s completes last', async (last) => {
    const f = fixture(); const a = f.makeStore(); const b = f.makeStore();
    const [remove] = await a.importBooksForAgent('owner-a', [book('remove'), book('keep')], context);
    const gate = f.pause();
    const pending = last === 'import'
      ? a.importBooksForAgent('owner-a', [book('added')], context) : a.deleteBookForAgent('owner-a', remove.id);
    await gate.entered;
    if (last === 'import') {
      expect(await b.deleteBookForAgent('owner-a', remove.id)).toBe(true);
      expect(f.bytes().toString()).not.toContain(remove.id);
    } else {
      await b.importBooksForAgent('owner-a', [book('added')], context);
      expect(f.bytes().toString()).toContain('added');
    }
    gate.release(); await pending;
    expect((await a.listBooksForAgent('owner-a')).map((row) => row.title).sort()).toEqual(['added', 'keep']);
  });

  it.each([false, true])('merges concurrent same-book tags and preserves the winning ID, reversed=%s', async (reverse) => {
    const f = fixture(); const a = f.makeStore(); const b = f.makeStore();
    const tags = reverse ? ['second', 'first'] : ['first', 'second'];
    const gate = f.pause();
    const pending = a.importBooksForAgent('owner-a', [book('same')], { reason: tags[0], interests: ['x'] });
    await gate.entered;
    const [winner] = await b.importBooksForAgent('owner-a', [book('same')], { reason: tags[1], interests: ['y'] });
    gate.release(); const [merged] = await pending;
    expect(merged.id).toBe(winner.id);
    expect(merged.createdAt).toBe(winner.createdAt);
    const retry = await b.importBooksForAgent('owner-a', [book('same')], { reason: tags[1], interests: ['y'] });
    expect(retry[0].agentTags.map((tag) => tag.reason).sort()).toEqual(['first', 'second']);
    expect(await a.listBooksForAgent('owner-a')).toHaveLength(1);
  });

  it.each(['import', 'delete'])('same-book %s last has serial semantics without changing the old ID silently', async (last) => {
    const f = fixture(); const a = f.makeStore(); const b = f.makeStore();
    const [original] = await a.importBooksForAgent('owner-a', [book('same')], context);
    const gate = f.pause();
    const pending = last === 'import'
      ? a.importBooksForAgent('owner-a', [book('same')], context) : a.deleteBookForAgent('owner-a', original.id);
    await gate.entered;
    if (last === 'import') await b.deleteBookForAgent('owner-a', original.id);
    else expect((await b.importBooksForAgent('owner-a', [book('same')], context))[0].id).toBe(original.id);
    gate.release(); await pending;
    const rows = await a.listBooksForAgent('owner-a');
    if (last === 'import') { expect(rows).toHaveLength(1); expect(rows[0].id).not.toBe(original.id); }
    else expect(rows).toEqual([]);
  });

  it('reads under the existing owner lock while another owner commits independently', async () => {
    const f = fixture(); const entered = deferred(); const release = deferred();
    const locked = withXingyeAgentEventLock('owner-a', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let completed = false;
    const pending = f.makeStore().importBooksForAgent('owner-a', [book('A')], context).then((r) => { completed = true; return r; });
    try {
      const b = await f.makeStore().importBooksForAgent('owner-b', [book('B')], context);
      expect(b[0].agentTags[0].agentId).toBe('owner-b');
      expect(completed).toBe(false);
      expect(f.bytes('owner-b').toString()).toContain('B');
    } finally { release.resolve(); }
    await locked; await pending;
    expect((await f.makeStore().listBooksForAgent('owner-a')).map((r) => r.title)).toEqual(['A']);
    expect((await f.makeStore().listBooksForAgent('owner-b')).map((r) => r.title)).toEqual(['B']);
  });

  it.each(['import', 'delete'])('queues %s behind an unpublished import and reads its committed rows', async (operation) => {
    const f = fixture(); const a = f.makeStore(); const b = f.makeStore();
    const [remove] = await a.importBooksForAgent('owner-a', [book('remove')], context);
    const rename = fs.promises.rename.bind(fs.promises);
    const entered = deferred(); const release = deferred(); let first = true;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === f.diskPath() && first) { first = false; entered.resolve(); await release.promise; }
      return rename(from, to);
    });
    const pending = a.importBooksForAgent('owner-a', [book('first')], context);
    await entered.promise;
    const after = operation === 'import'
      ? b.importBooksForAgent('owner-a', [book('second')], context) : b.deleteBookForAgent('owner-a', remove.id);
    release.resolve(); await pending; await after;
    expect((await a.listBooksForAgent('owner-a')).map((r) => r.title).sort())
      .toEqual(operation === 'import' ? ['first', 'remove', 'second'] : ['first']);
  });

  it('preserves unknown rows, fields, tags and exact unmodified bytes across import, deletion and restart', async () => {
    const f = fixture(); const a = f.makeStore();
    const [original] = await a.importBooksForAgent('owner-a', [book('same')], context);
    const legacy = { ...original, future: { retained: true }, agentTags: [{ ...original.agentTags[0], futureTag: 42 }, { futureTagOnly: true }] };
    const prefix = Buffer.concat([Buffer.from(' \r\n{bad json}\r\n'), Buffer.from([0xff, 0x0a]), Buffer.from('{"futureSchema":42}\r\nnull\n')]);
    const suffix = Buffer.from('{"id":"unrelated","futureOnly":true}');
    f.seed(Buffer.concat([prefix, Buffer.from(JSON.stringify(legacy) + '\r\n'), suffix]));
    const [merged] = await a.importBooksForAgent('owner-a', [book('same')], { reason: 'new tag', interests: [] });
    expect(merged.id).toBe(original.id);
    let disk = f.bytes();
    expect(disk.subarray(0, prefix.length)).toEqual(prefix);
    expect(disk.subarray(-suffix.length)).toEqual(suffix);
    const row = JSON.parse(disk.subarray(prefix.length, -suffix.length).toString().trim());
    expect(row.future).toEqual({ retained: true });
    expect(row.agentTags).toEqual([...legacy.agentTags, expect.objectContaining({ reason: 'new tag' })]);
    f.restart(); expect((await f.makeStore().listBooksForAgent('owner-a'))[0].id).toBe(original.id);
    expect(await f.makeStore().deleteBookForAgent('owner-a', original.id)).toBe(true);
    disk = f.bytes(); expect(disk).toEqual(Buffer.concat([prefix, suffix]));
  });

  it('deletes by book ID rather than another book key, including corrupt UTF-8 lookalikes', async () => {
    const f = fixture(); const a = f.makeStore();
    const [target, keep] = await a.importBooksForAgent('owner-a', [book('target'), book('keep')], context);
    const lookalike = Buffer.from(JSON.stringify({ ...target, id: 'bad-\ufffd' }) + '\n');
    const corrupt = Buffer.concat([lookalike.subarray(0, lookalike.indexOf(Buffer.from('\ufffd'))), Buffer.from([0xff]), lookalike.subarray(lookalike.indexOf(Buffer.from('\ufffd')) + 3)]);
    const survivor = Buffer.from(JSON.stringify({ ...keep, key: target.id }) + '\r\n');
    f.seed(Buffer.concat([survivor, corrupt, Buffer.from(JSON.stringify(target))]));
    expect(await a.deleteBookForAgent('owner-a', 'bad-\ufffd')).toBe(false);
    expect(await a.deleteBookForAgent('owner-a', target.id)).toBe(true);
    expect(f.bytes()).toEqual(Buffer.concat([survivor, corrupt]));
  });

  it.each(['readFile', 'writeFile', 'rename'] as const)('propagates %s failure without changing acknowledged disk or falling back', async (method) => {
    const f = fixture(); const a = f.makeStore();
    const [existing] = await a.importBooksForAgent('owner-a', [book('existing')], context);
    const before = f.bytes();
    const spy = vi.spyOn(fs.promises, method).mockRejectedValue(new Error('synthetic I/O failure'));
    await expect(a.importBooksForAgent('owner-a', [book('failed')], context)).rejects.toThrow('synthetic I/O failure');
    await expect(a.deleteBookForAgent('owner-a', existing.id)).rejects.toThrow('synthetic I/O failure');
    expect(f.bytes()).toEqual(before);
    expect(fs.readdirSync(path.dirname(f.diskPath())).filter((name) => name.includes('.tmp.'))).toEqual([]);
    expect(f.requests.some((r) => r.action === 'writeJsonl')).toBe(false);
    spy.mockRestore();
    await a.importBooksForAgent('owner-a', [book('recovered')], context);
    expect((await a.listBooksForAgent('owner-a')).map((r) => r.title)).toEqual(['existing', 'recovered']);
  });

  it('rejects ID collisions atomically and keeps legacy generic APIs available', async () => {
    const f = fixture();
    const old = { ...book('old'), id: 'fixed', dedupeKey: 'legacy-key', agentTags: [{ agentId: 'owner-a', ...context, createdAt: '2000-01-01' }] };
    const response = await f.request({ action: 'writeJsonl', agentId: 'owner-a', relativePath: readingBookCatalogPath(), records: [old] });
    expect(response.status).toBe(200);
    const before = f.bytes();
    const backend = createAgentXingyeStorageBackend(async (body) => {
      const res = await f.request(body); const data = await res.json(); if (!res.ok) throw new Error(JSON.stringify(data)); return data;
    });
    const store = createXingyeBookCatalogStore(backend, { idFactory: () => 'fixed' });
    await expect(store.importBooksForAgent('owner-a', [book('different')], context)).rejects.toThrow('ID already exists');
    expect(f.bytes()).toEqual(before);
    expect((await store.listBooksForAgent('owner-a'))[0].createdAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('does not replay or undo a committed operation whose response was lost', async () => {
    const f = fixture();
    const post = vi.fn(async (body: Record<string, unknown>) => {
      const response = await f.request(body);
      expect(response.ok).toBe(true);
      throw new Error('response lost after commit');
    });
    const uncertain = createXingyeBookCatalogStore(createAgentXingyeStorageBackend(post));
    await expect(uncertain.importBooksForAgent('owner-a', [book('committed')], context)).rejects.toThrow('response lost');
    expect(post).toHaveBeenCalledTimes(1);
    const [stored] = await f.makeStore().listBooksForAgent('owner-a');
    expect(stored.title).toBe('committed');
    const [manualRetry] = await f.makeStore().importBooksForAgent('owner-a', [book('committed')], context);
    expect(manualRetry.id).toBe(stored.id); expect(manualRetry.agentTags).toHaveLength(1);
    await expect(uncertain.deleteBookForAgent('owner-a', stored.id)).rejects.toThrow('response lost');
    expect(post).toHaveBeenCalledTimes(2);
    expect(await f.makeStore().listBooksForAgent('owner-a')).toEqual([]);
  });

  it('validates catalog-only actions, owner tags and batch limits before mutation', async () => {
    const f = fixture();
    const [existing] = await f.makeStore().importBooksForAgent('owner-a', [book('existing')], context);
    const before = f.bytes();
    for (const patch of [
      { relativePath: 'apps/other.jsonl' },
      { mutation: { type: 'delete', bookId: '' } },
      { mutation: { type: 'import', entries: Array(21).fill(existing) } },
      { mutation: { type: 'import', entries: [{ ...existing, agentTags: [{ ...existing.agentTags[0], agentId: 'owner-b' }] }] } },
      { mutation: { type: 'import', entries: [null] } },
    ]) {
      const response = await f.request({ action: 'mutateReadingBookCatalog', agentId: 'owner-a', relativePath: readingBookCatalogPath(), mutation: { type: 'delete', bookId: existing.id }, ...patch });
      expect(response.status).toBe(400); expect(f.bytes()).toEqual(before);
    }
    expect(await f.makeStore().deleteBookForAgent('owner-b', existing.id)).toBe(false);
  });
});

describe('reading catalog backend compatibility', () => {
  it.each(['old server', 'transport failure', 'malformed receipt'])('never falls back or retries after %s', async (failure) => {
    const post = vi.fn(async (_body: Record<string, unknown>) => {
      if (failure === 'malformed receipt') return { ok: true, deleted: 'false', imported: [] };
      throw new Error(failure);
    });
    const store = createXingyeBookCatalogStore(createAgentXingyeStorageBackend(post));
    await expect(store.importBooksForAgent('owner-a', [book('test')], context)).rejects.toThrow();
    await expect(store.deleteBookForAgent('owner-a', 'book-1')).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.every(([body]) => body.action === 'mutateReadingBookCatalog')).toBe(true);
  });

  it('rejects incomplete and wrong-owner import receipts', async () => {
    for (const imported of [[], [null], [{ ...book('x'), id: 'x', dedupeKey: 'x', agentTags: [] }]]) {
      const post = vi.fn(async () => ({ ok: true, deleted: false, imported }));
      const store = createXingyeBookCatalogStore(createAgentXingyeStorageBackend(post));
      await expect(store.importBooksForAgent('owner-a', [book('test')], context)).rejects.toThrow('Invalid reading catalog');
      expect(post).toHaveBeenCalledTimes(1);
    }
  });

  it('fails explicitly for a legacy injected backend with no atomic capability', async () => {
    const backend = createMemoryXingyeStorageBackend();
    backend.mutateReadingBookCatalog = undefined;
    const write = vi.spyOn(backend, 'writeJsonl');
    const store = createXingyeBookCatalogStore(backend);
    await expect(store.importBooksForAgent('owner-a', [book('test')], context)).rejects.toThrow('upgrade');
    await expect(store.deleteBookForAgent('owner-a', 'book-1')).rejects.toThrow('upgrade');
    expect(write).not.toHaveBeenCalled();
  });

  it('uses synchronous shared localStorage transactions and propagates setItem failure', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const make = () => createXingyeBookCatalogStore(createLocalStorageXingyeBackend(storage, (aid, rel) => aid + '/' + rel));
    const a = make(); const b = make();
    const [[one], [two]] = await Promise.all([a.importBooksForAgent('owner-a', [book('one')], context), b.importBooksForAgent('owner-a', [book('two')], context)]);
    expect(await a.listBooksForAgent('owner-a')).toHaveLength(2);
    const before = [...data];
    const spy = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await expect(a.importBooksForAgent('owner-a', [book('failed')], context)).rejects.toThrow('quota');
    await expect(a.deleteBookForAgent('owner-a', one.id)).rejects.toThrow('quota');
    expect([...data]).toEqual(before); spy.mockRestore();
    await Promise.all([a.deleteBookForAgent('owner-a', one.id), b.deleteBookForAgent('owner-a', two.id)]);
    expect(await a.listBooksForAgent('owner-a')).toEqual([]);
  });
});
