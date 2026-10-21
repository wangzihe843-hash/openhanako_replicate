import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createXingyeStorageRoute } from '../server/routes/xingye-storage.js';
import { withXingyeAgentEventLock } from '../lib/xingye/events.js';

const { post, event, transport } = vi.hoisted(() => ({ post: vi.fn(), event: vi.fn(), transport: vi.fn() }));
vi.mock('../desktop/src/react/xingye/xingye-storage-api', () => ({ postXingyeStorage: post }));
vi.mock('../desktop/src/react/xingye/xingye-event-log', () => ({ appendXingyeEvent: event }));
vi.mock('../desktop/src/react/hooks/use-hana-fetch', () => ({ hanaFetch: transport }));
import { appendSecretSpaceRecord, deleteSecretSpaceRecord, listSecretSpaceRecords } from '../desktop/src/react/xingye/xingye-secret-space-store';
import { stableSecretSpaceRecordId } from '../desktop/src/react/xingye/xingye-secret-space-record-id';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
const aid = 'synthetic-secret-delete';
const rel = 'secret-space/dream.jsonl';
const row = (recordId: string) => ({ recordId, body: recordId });
const line = (value: unknown) => JSON.stringify(value) + '\n';
const isDeleteMutation = (body: Record<string, unknown>) => body.action === 'write' || body.action === 'deleteSecretSpaceRecord';

describe('secret space delete: real store, Hono and synthetic files', () => {
  let root: string;
  let file: string;
  let app: Hono;
  let route: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External network forbidden'); }));
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hana-secret-delete-')));
    file = path.join(root, 'agents', aid, 'xingye', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(root, 'agents', 'other-agent'), { recursive: true });
    app = new Hono().route('/api', createXingyeStorageRoute({
      agentsDir: path.join(root, 'agents'),
      getAgent: (id: string) => [aid, 'other-agent'].includes(id) ? { id } : null,
    }));
    route = async (body) => {
      const res = await app.request('/api/xingye/storage', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      return data;
    };
    post.mockReset().mockImplementation(route);
    event.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const remove = (id: string) => deleteSecretSpaceRecord(aid, 'dream', id);

  it('preserves an append committed while the delete mutation is waiting', async () => {
    fs.writeFileSync(file, line(row('remove')) + line(row('keep')));
    const entered = deferred(); const release = deferred();
    post.mockImplementation(async (body) => {
      if (isDeleteMutation(body)) { entered.resolve(); await release.promise; }
      return route(body);
    });
    const deletion = remove('remove');
    await entered.promise;
    try {
      await appendSecretSpaceRecord(aid, 'dream', row('fresh'));
      expect(fs.readFileSync(file, 'utf8')).toContain('fresh');
    } finally { release.resolve(); }
    expect(await deletion).toBe(true);
    const records = (await route({ action: 'listJsonl', agentId: aid, relativePath: rel })).records;
    expect((records as { recordId: string }[]).map((r) => r.recordId)).toEqual(['keep', 'fresh']);
  });

  it.each([false, true])('serializes independent deletes; same target = %s', async (sameTarget) => {
    fs.writeFileSync(file, line(row('first')) + line(row('second')));
    const entered = deferred(); const release = deferred(); let mutations = 0;
    post.mockImplementation(async (body) => {
      if (isDeleteMutation(body)) {
        if (++mutations === 2) entered.resolve();
        await release.promise;
      }
      return route(body);
    });
    const results = Promise.all([remove('first'), remove(sameTarget ? 'first' : 'second')]);
    await entered.promise; release.resolve();
    expect((await results).sort()).toEqual(sameTarget ? [false, true] : [true, true]);
    expect(fs.readFileSync(file, 'utf8')).toBe(sameTarget ? line(row('second')) : '');
    expect(event).toHaveBeenCalledTimes(sameTarget ? 1 : 2);
  });

  it('keeps the existing per-agent lock for delete and append, without blocking another agent', async () => {
    fs.writeFileSync(file, line(row('remove')));
    const entered = deferred(); const release = deferred();
    const held = withXingyeAgentEventLock(aid, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let deleteDone = false; let appendDone = false;
    const deletion = remove('remove').then((value) => { deleteDone = true; return value; });
    const append = appendSecretSpaceRecord(aid, 'dream', row('fresh')).then(() => { appendDone = true; });
    try {
      await route({ action: 'appendJsonl', agentId: 'other-agent', relativePath: rel, data: row('other') });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(deleteDone).toBe(false); expect(appendDone).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(line(row('remove')));
    } finally { release.resolve(); await held; await Promise.all([deletion, append]); }
    expect(await deletion).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('fresh');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('remove');
  });

  it('preserves an append that waits during atomic delete publication', async () => {
    fs.writeFileSync(file, line(row('remove')) + line(row('keep')));
    const entered = deferred(); const release = deferred();
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === file) { entered.resolve(); await release.promise; }
      return rename(from, to);
    });
    const deletion = remove('remove'); await entered.promise;
    const append = appendSecretSpaceRecord(aid, 'dream', row('fresh'));
    release.resolve();
    expect(await deletion).toBe(true); await append;
    const records = (await route({ action: 'listJsonl', agentId: aid, relativePath: rel })).records;
    expect((records as { recordId: string }[]).map((r) => r.recordId)).toEqual(['keep', 'fresh']);
  });

  it.each([
    [{ recordId: 'r', key: 'k', id: 'i', body: 'a' }, 'r'],
    [{ recordId: 0, key: 'k', id: 'i', body: 'a' }, '0'],
    [{ key: 'k', id: 'i', body: 'a' }, 'k'],
    [{ key: 42, id: 'i', body: 'a' }, '42'],
    [{ id: 'i', body: 'a' }, 'i'],
    [{ id: 7, body: 'a' }, '7'],
    [{ recordId: '', key: '', id: 0, body: 'a' }, '0'],
    [{ recordId: false, key: {}, id: [], body: 'legacy' }, null],
    [{ title: '旧记录🌙', content: 'legacy content', summary: '摘要', createdAt: '2020-01-01' }, null],
  ] as const)('deletes by the existing stable ID contract: %j', async (target, explicitId) => {
    const id = explicitId ?? stableSecretSpaceRecordId('dream', target);
    const suffix = '  {"body":"untouched legacy", "metadata":{"x":1}}\r\n';
    fs.writeFileSync(file, line(target) + suffix);
    expect(await remove(id)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(suffix);
    expect(await remove(id)).toBe(false);
  });

  it.each(['alias-key', 'alias-id', 'dream-0'])('does not delete by a lower-priority or positional alias: %s', async (id) => {
    const original = line({ recordId: 'real', key: 'alias-key', id: 'alias-id', body: 'target' });
    fs.writeFileSync(file, original);
    expect(await remove(id)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(event).not.toHaveBeenCalled();
  });

  it('removes only the first duplicate legacy digest and preserves all non-target bytes', async () => {
    const legacy = { body: 'duplicate 🌙', summary: 'old' };
    const prefix = Buffer.concat([Buffer.from(' \r\n{broken\r\nnull\n[]\n42\n'), Buffer.from([0xff, 0xfe, 0x0a])]);
    const duplicate = '  ' + JSON.stringify(legacy) + '\r\n';
    const suffix = Buffer.from(duplicate + '\n {"id":"keep", "body":"no final newline"}');
    fs.writeFileSync(file, Buffer.concat([prefix, Buffer.from(duplicate), suffix]));
    const id = stableSecretSpaceRecordId('dream', legacy);
    expect(await remove(id)).toBe(true);
    expect(fs.readFileSync(file)).toEqual(Buffer.concat([prefix, suffix]));
    expect(await remove(id)).toBe(true);
    expect(fs.readFileSync(file)).toEqual(Buffer.concat([prefix, Buffer.from('\n {"id":"keep", "body":"no final newline"}')]));
    expect(await remove(id)).toBe(false);
  });

  it.each(['', '\n', '\r\n'])('removes a final target with line ending %j without rewriting a prefix', async (ending) => {
    const prefix = '  {"body":"keep"}\r\n\n';
    fs.writeFileSync(file, prefix + JSON.stringify(row('last')) + ending);
    expect(await remove('last')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(prefix);
  });

  it('returns false for missing and empty files without creating or rewriting them', async () => {
    expect(await remove('missing')).toBe(false); expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, '');
    const rename = vi.spyOn(fs.promises, 'rename');
    expect(await remove('missing')).toBe(false); expect(rename).not.toHaveBeenCalled();
  });

  it.each(['readFile', 'rename'] as const)('propagates %s failure, preserves the file and permits a retry', async (operation) => {
    const original = line(row('remove')) + line(row('keep'));
    fs.writeFileSync(file, original);
    const error = Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
    const spy = vi.spyOn(fs.promises, operation).mockRejectedValueOnce(error);
    await expect(remove('remove')).rejects.toThrow('synthetic EIO');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(event).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.dirname(file))).toEqual(['dream.jsonl']);
    spy.mockRestore();
    expect(await remove('remove')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(line(row('keep')));
  });

  it('rejects an unsupported old server without reading or rewriting a snapshot', async () => {
    const original = line(row('keep')); fs.writeFileSync(file, original);
    post.mockImplementation(async (body) => {
      if (body.action === 'deleteSecretSpaceRecord') throw new Error('invalid action');
      return route(body);
    });
    await expect(remove('keep')).rejects.toThrow(/升级/);
    expect(post.mock.calls.map(([b]) => b.action)).toEqual(['deleteSecretSpaceRecord']);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('surfaces a lost response after commit and does not retry or resurrect the record', async () => {
    fs.writeFileSync(file, line(row('remove')) + line(row('keep')));
    post.mockImplementation(async (body) => {
      const result = await route(body);
      if (isDeleteMutation(body)) throw new DOMException('synthetic cancelled response', 'AbortError');
      return result;
    });
    await expect(remove('remove')).rejects.toThrow('synthetic cancelled response');
    expect(fs.readFileSync(file, 'utf8')).toBe(line(row('keep')));
    expect(event).not.toHaveBeenCalled();
    post.mockImplementation(route);
    expect(await remove('remove')).toBe(false);
  });

  it('keeps the old generic delete contract while the new action rejects non-category paths', async () => {
    const original = line({ key: 'k', id: 'i', body: 'old contract' }) + line({ body: 'anonymous' });
    fs.writeFileSync(file, original);
    expect(await route({ action: 'deleteJsonlRecord', agentId: aid, relativePath: rel, recordId: 'i' })).toMatchObject({ deleted: true });
    expect(await route({ action: 'deleteJsonlRecord', agentId: aid, relativePath: rel, recordId: 'dream-0' })).toMatchObject({ deleted: true });
    for (const relativePath of ['moments/posts.jsonl', '../dream.jsonl', 'secret-space/forum/posts.jsonl']) {
      await expect(route({ action: 'deleteSecretSpaceRecord', agentId: aid, relativePath, recordId: 'x' })).rejects.toThrow();
    }
  });
});

// The HTTP boundary is the only substitute here: real store -> real storage API
// -> Hono app.request -> temporary disk, including the real event append client.
// No listener, global server bootstrap, native app or user data is involved.
describe('secret space deletion category and byte boundaries through the real client', () => {
  const categories = ['state', 'draft_reply', 'dream', 'saved_item', 'unsent_moment', 'memory_fragment', 'interview'] as const;
  const outsideCategories = ['drafts', 'interview-drafts', 'unknown.confirmation', 'future_extension_2027'];
  let root: string;
  let file: string;
  let eventsFile: string;
  let app: Hono;
  const changed = vi.fn();
  const request = (body: Record<string, unknown>) => app.request('/api/xingye/storage', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const categoryFile = (category: string) => path.join(root, 'agents', aid, 'xingye', `secret-space/${category}.jsonl`);
  const remove = (category: string, id: string) => deleteSecretSpaceRecord(aid, category as Parameters<typeof deleteSecretSpaceRecord>[1], id);
  const actions = () => transport.mock.calls.map(([, init]) => JSON.parse(String(init.body)).action);
  const expectNoSuccess = () => {
    expect(event).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(fs.existsSync(eventsFile)).toBe(false);
  };
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hana-secret-delete-boundary-')));
    file = categoryFile('dream');
    eventsFile = path.join(root, 'agents', aid, 'xingye', 'events/log.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    app = new Hono().route('/api', createXingyeStorageRoute({
      agentsDir: path.join(root, 'agents'), getAgent: (id: string) => id === aid ? { id } : null,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External network forbidden'); }));
    changed.mockReset();
    vi.stubGlobal('window', { dispatchEvent: changed });
    transport.mockReset().mockImplementation((url, init) => app.request(url, init));
    const api = await vi.importActual<typeof import('../desktop/src/react/xingye/xingye-storage-api')>('../desktop/src/react/xingye/xingye-storage-api');
    const log = await vi.importActual<typeof import('../desktop/src/react/xingye/xingye-event-log')>('../desktop/src/react/xingye/xingye-event-log');
    post.mockReset().mockImplementation(api.postXingyeStorage);
    event.mockReset().mockImplementation(log.appendXingyeEvent);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(categories.flatMap(category => [true, false].map(present => ({ category, present }))))(
    'accepts official category $category, present=$present', async ({ category, present }) => {
      const target = categoryFile(category);
      if (present) fs.writeFileSync(target, line(row('r')));
      const publish = vi.spyOn(fs.promises, 'rename');
      const res = await request({ action: 'deleteSecretSpaceRecord', agentId: aid, relativePath: `secret-space/${category}.jsonl`, recordId: 'r' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, deleted: present });
      expect(fs.existsSync(target)).toBe(present);
      if (present) expect(fs.readFileSync(target)).toEqual(Buffer.alloc(0));
      expect(publish).toHaveBeenCalledTimes(present ? 1 : 0);
      expectNoSuccess(); // Direct route requests do not synthesize client events.
    },
  );

  it.each(outsideCategories.flatMap(category => [true, false].map(present => ({ category, present }))))(
    'rejects unregistered category $category without mutation or client success, present=$present', async ({ category, present }) => {
      const target = categoryFile(category);
      const original = Buffer.from(line({ recordId: 'r', key: 'r', body: 'synthetic pending or future row' }));
      if (present) fs.writeFileSync(target, original);
      const write = vi.spyOn(fs.promises, 'writeFile');
      const publish = vi.spyOn(fs.promises, 'rename');
      const res = await request({ action: 'deleteSecretSpaceRecord', agentId: aid, relativePath: `secret-space/${category}.jsonl`, recordId: 'r' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'recordId and secret-space category JSONL path required' });
      await expect(remove(category, 'r')).rejects.toThrow('secret-space category JSONL path required');
      expect(actions()).toEqual(['deleteSecretSpaceRecord']);
      expect(fs.existsSync(target)).toBe(present);
      if (present) expect(fs.readFileSync(target)).toEqual(original);
      expect(write).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expectNoSuccess();
    },
  );

  it.each(outsideCategories.flatMap(category => ['key', 'id', 'position'].map(selector => ({ category, selector }))))(
    'preserves old generic $selector deletion in $category', async ({ category, selector }) => {
      const target = categoryFile(category);
      const record = selector === 'position' ? { recordId: 'ignored-by-generic', body: 'anonymous' } : { recordId: 'ignored-by-generic', key: 'old-key', id: 'old-id', body: 'synthetic row' };
      fs.writeFileSync(target, line(record) + line({ key: 'keep', body: 'keep' }));
      const recordId = selector === 'position' ? `${category}-0` : `old-${selector}`;
      const res = await request({ action: 'deleteJsonlRecord', agentId: aid, relativePath: `secret-space/${category}.jsonl`, recordId });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, deleted: true });
      expect(fs.readFileSync(target, 'utf8').trim()).toBe(JSON.stringify({ key: 'keep', body: 'keep' }));
      expectNoSuccess();
    },
  );

  const invalidSequences = [
    { name: 'ff', bytes: [0xff], ending: '\r\n' },
    { name: 'lone continuation', bytes: [0x80], ending: '\n' },
    { name: 'overlong', bytes: [0xc0, 0xaf], ending: '' },
    { name: 'truncated multibyte', bytes: [0xe2, 0x82], ending: '\r\n' },
    { name: 'invalid continuation', bytes: [0xe2, 0x28, 0xa1], ending: '\n' },
    { name: 'surrogate', bytes: [0xed, 0xa0, 0x80], ending: '' },
    { name: 'above unicode maximum', bytes: [0xf4, 0x90, 0x80, 0x80], ending: '\r\n' },
    { name: 'invalid leading byte', bytes: [0xf5, 0x80, 0x80, 0x80], ending: '\n' },
  ];
  it.each(invalidSequences)('preserves a JSON-parseable $name row on repeated route and client deletion', async ({ bytes, ending }) => {
    const original = Buffer.concat([Buffer.from('{"recordId":"r","body":"'), Buffer.from(bytes), Buffer.from(`"}${ending}`)]);
    fs.writeFileSync(file, original);
    const write = vi.spyOn(fs.promises, 'writeFile');
    const publish = vi.spyOn(fs.promises, 'rename');
    const listed = await listSecretSpaceRecords(aid, 'dream');
    expect(listed).toHaveLength(1);
    expect(listed[0].recordId).toBe('r'); // The unchanged list API still uses replacement decoding.
    const res = await request({ action: 'deleteSecretSpaceRecord', agentId: aid, relativePath: rel, recordId: 'r' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: false });
    expect(await remove('dream', listed[0].recordId)).toBe(false);
    expect(await remove('dream', listed[0].recordId)).toBe(false);
    expect(actions()).toEqual(['listJsonl', 'deleteSecretSpaceRecord', 'deleteSecretSpaceRecord']);
    expect(fs.readFileSync(file)).toEqual(original);
    expect(write).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expectNoSuccess();
  });

  const corruptString = (prefix: string, suffix: string) => Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix + '\r\n')]);
  const collisions = [
    { name: 'body corruption with a stable recordId', bad: corruptString('{"recordId":"r","body":"', '"}'), good: { recordId: 'r', key: 'lower-key', id: 'lower-id', body: 'valid target' } },
    { name: 'replacement recordId', bad: corruptString('{"recordId":"', '","body":"bad id"}'), good: { recordId: '\ufffd', key: 'lower-key', id: 'lower-id', body: 'valid target' } },
    { name: 'replacement key', bad: corruptString('{"key":"', '","body":"bad key"}'), good: { key: '\ufffd', id: 'lower-id', body: 'valid target' } },
    { name: 'replacement id', bad: corruptString('{"id":"', '","body":"bad id"}'), good: { id: '\ufffd', body: 'valid target' } },
    { name: 'replacement legacy digest', bad: corruptString('{"body":"', '"}'), good: { body: '\ufffd' } },
  ];
  it.each(collisions.flatMap(vector => ['route', 'client'].map(via => ({ ...vector, via })) ))(
    'skips $name and lower-priority aliases, deleting only the first valid match via $via', async ({ bad, good, via }) => {
      const id = stableSecretSpaceRecordId('dream', good);
      const aliases = Buffer.from(line({ recordId: 'higher-record', key: id, id, body: 'keep recordId priority' }) + line({ key: 'higher-key', id, body: 'keep key priority' }));
      const prefix = Buffer.concat([Buffer.from('\r\n'), bad, aliases]);
      const duplicate = Buffer.from(JSON.stringify(good)); // Valid final duplicate has no final newline.
      fs.writeFileSync(file, Buffer.concat([prefix, Buffer.from(line(good)), duplicate]));
      const publish = vi.spyOn(fs.promises, 'rename');
      if (via === 'client') {
        const listed = await listSecretSpaceRecords(aid, 'dream');
        const selected = listed.find(record => record.recordId === id && record.body === good.body);
        expect(selected).toBeDefined();
        expect(await remove('dream', selected!.recordId)).toBe(true);
        expect(actions()).toEqual(['listJsonl', 'deleteSecretSpaceRecord', 'appendEventLog']);
        expect(event).toHaveBeenCalledTimes(1);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed.mock.calls[0][0]).toMatchObject({ type: 'xingye-secret-space-changed', detail: { agentId: aid, category: 'dream' } });
        expect(JSON.parse(fs.readFileSync(eventsFile, 'utf8')).events).toEqual([
          expect.objectContaining({ type: 'secret_space.record_deleted', payload: { category: 'dream', recordId: id } }),
        ]);
      } else {
        const res = await request({ action: 'deleteSecretSpaceRecord', agentId: aid, relativePath: rel, recordId: id });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, deleted: true });
        expectNoSuccess();
      }
      expect(publish.mock.calls.filter(([, to]) => String(to) === file)).toHaveLength(1);
      expect(fs.readFileSync(file)).toEqual(Buffer.concat([prefix, duplicate]));
    },
  );

  it.each([
    { name: 'literal replacement ID', raw: '{"recordId":"\ufffd","body":"valid"}', id: '\ufffd' },
    { name: 'literal replacement body', raw: '{"recordId":"r","body":"\ufffd"}', id: 'r' },
    { name: 'JSON-escaped replacement ID', raw: '{"recordId":"\\ufffd","body":"valid"}', id: '\ufffd' },
  ])('allows a valid $name through the client', async ({ raw, id }) => {
    fs.writeFileSync(file, raw);
    expect(await remove('dream', id)).toBe(true);
    expect(fs.readFileSync(file)).toEqual(Buffer.alloc(0));
    expect(actions()).toEqual(['deleteSecretSpaceRecord', 'appendEventLog']);
    expect(event).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(eventsFile, 'utf8')).events).toHaveLength(1);
  });

  it('keeps the existing JSON BOM boundary without normalizing its bytes', async () => {
    const original = Buffer.from('\ufeff' + line(row('r')));
    fs.writeFileSync(file, original);
    const publish = vi.spyOn(fs.promises, 'rename');
    expect(await remove('dream', 'r')).toBe(false);
    expect(fs.readFileSync(file)).toEqual(original);
    expect(publish).not.toHaveBeenCalled();
    expectNoSuccess();
  });
});
