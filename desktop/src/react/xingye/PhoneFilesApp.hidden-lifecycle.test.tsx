/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../types';
import type { ServerConnection } from '../services/server-connection';
import type { XingyeLoreEntry } from './xingye-lore-store';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyeHiddenFileEntry, XingyeHiddenFolderState } from './xingye-files-secret-store';

interface MockState {
  userName: string;
  stagedChatQuote: null;
  stageChatQuote: () => void;
  activeServerConnection: ServerConnection;
  activeServerConnectionId: string;
  serverConnections: Record<string, ServerConnection>;
}
interface RequestPayload {
  action?: string;
  relativePath?: string;
  agentId: string;
  ownerAgentId?: string;
  prompt?: string;
  data?: Partial<XingyeHiddenFileEntry & XingyeHiddenFolderState>;
}
interface CapturedRequest { host: string; path: string; body: RequestPayload; settled: boolean }
interface ModelResult {
  ok: boolean;
  result: { entries: Array<{ kind: 'secret_plan'; title: string; body: string }> };
}
interface ModelPlan { promise: Promise<ModelResult>; release: () => void; fail: () => void }
interface StorageGate {
  matches: (request: CapturedRequest) => boolean;
  used: boolean;
  promise: Promise<void>;
  entered: Promise<void>;
  enter: () => void;
  release: () => void;
}
type LoreOptions = Parameters<typeof import('./xingye-lore-runtime-context').collectXingyeLoreRuntimeContext>[1];

// Real component, lore selection, secret AI, hidden store, backend and hanaFetch.
// The final fetch is an in-memory API; no listener, real provider or user data.
const h = vi.hoisted(() => ({
  state: null as unknown as MockState,
  listeners: new Set<(state: MockState, previous: MockState) => void>(),
  lore: new Map<string, Map<string, string>>(),
  requests: [] as CapturedRequest[],
  rows: new Map<string, XingyeHiddenFileEntry[]>(),
  states: new Map<string, XingyeHiddenFolderState>(),
  selectCalls: [] as Array<{ owner: string | null | undefined; options: LoreOptions }>,
  models: [] as ModelPlan[],
  gates: [] as StorageGate[],
}));
vi.mock('../stores', () => ({
  useStore: Object.assign(<T,>(selector: (state: MockState) => T) => selector(h.state), {
    getState: () => h.state,
    subscribe: (listener: (state: MockState, previous: MockState) => void) => {
      h.listeners.add(listener);
      return () => h.listeners.delete(listener);
    },
  }),
}));
vi.mock('./xingye-files-store', async original => ({
  ...await original<typeof import('./xingye-files-store')>(),
  listFileFolders: vi.fn(async (id: string) => [{
    id: 'folder', agentId: id, name: '资料', description: '', order: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }]),
  listFileEntries: vi.fn(async () => []),
  listFileDrafts: vi.fn(async () => []),
}));
vi.mock('./xingye-phone-store', () => ({ getConfirmedVirtualContacts: vi.fn(() => []) }));
vi.mock('./xingye-persistence', () => ({ getXingyePersistenceStorage: () => {
  const map = h.lore.get(h.state.activeServerConnection.connectionId)!;
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value) };
} }));
vi.mock('./xingye-lore-runtime-context', async original => {
  const real = await original<typeof import('./xingye-lore-runtime-context')>();
  return { ...real, collectXingyeLoreRuntimeContext: (...args: Parameters<typeof real.collectXingyeLoreRuntimeContext>) => {
    h.selectCalls.push({ owner: args[0], options: args[1] });
    return real.collectXingyeLoreRuntimeContext(...args);
  } };
});

import { PhoneFilesApp } from './PhoneFilesApp';
import { XINGYE_LORE_ENTRIES_STORAGE_KEY } from './xingye-lore-store';
import { buildFilesLoreCatalog } from './xingye-files-batch-ai';

const a: Agent = { id: 'owner-a', name: 'Agent A', yuan: 'hanako', isPrimary: false, hasAvatar: false };
const b: Agent = { ...a, id: 'owner-b', name: 'Agent B' };
const state = (id: string): XingyeHiddenFolderState => ({
  agentId: id, locked: false, passwordHash: 'synthetic', candidateLabel: 'synthetic',
  seedGenerated: false, updatedAt: '2026-01-01',
});
const connection = (id: string): ServerConnection => ({
  connectionId: id, kind: 'custom_remote', serverId: `synthetic-${id}`, studioId: `studio-${id}`,
  label: `Synthetic ${id}`, baseUrl: `https://hf02-${id}.invalid`, wsUrl: `wss://hf02-${id}.invalid`,
  token: null, authState: 'paired', trustState: 'tunnel', credentialKind: 'device_credential', capabilities: [],
});
const host = (id: string) => `hf02-${id}.invalid`;
const rowsKey = (id: string, agentId: string) => `${host(id)}/${agentId}/files/hidden-entries.jsonl`;
const stateKey = (id: string, agentId: string) => `${host(id)}/${agentId}/files/hidden.json`;
function storedEntry(agent: Agent, title: string): XingyeHiddenFileEntry {
  return { id: `stored-${title}`, key: `stored-${title}`, agentId: agent.id, kind: 'secret_plan', title,
    body: `BODY_${title}`, source: 'manual', createdAt: '2026-01-01' };
}
function entry(id: string, change: Partial<XingyeLoreEntry> = {}): XingyeLoreEntry {
  return { id, agentId: a.id, title: `TITLE_${id}_CANARY`, content: `BODY_${id}_CANARY`,
    keywords: [`KEYWORD_${id}_CANARY`], category: 'character', enabled: true, visibility: 'canonical',
    insertionMode: 'always', priority: 100, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...change };
}
function put(entries: XingyeLoreEntry[]) {
  h.lore.get(h.state.activeServerConnection.connectionId)!.set(XINGYE_LORE_ENTRIES_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(entries.map(e => [e.id, e]))));
}
function response<T>(data: T) { return { ok: true, status: 200, json: async () => data }; }
function modelResult(title = 'SEED_RESULT_CANARY', second?: string): ModelResult {
  return { ok: true, result: { entries: [title, ...(second ? [second] : [])].map(value => ({
    kind: 'secret_plan', title: value, body: `BODY_${value}`,
  })) } };
}
function deferModel(title: string, second?: string) {
  let resolve!: (value: ModelResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ModelResult>((yes, no) => { resolve = yes; reject = no; });
  const plan = { promise, release: () => resolve(modelResult(title, second)), fail: () => reject(new Error(`FAIL_${title}`)) };
  h.models.push(plan);
  return plan;
}
function deferStorage(matches: (request: CapturedRequest) => boolean) {
  let release!: () => void;
  let entered!: () => void;
  const gate = { matches, used: false, promise: new Promise<void>(yes => { release = yes; }),
    entered: new Promise<void>(yes => { entered = yes; }), enter: () => entered(), release: () => release() };
  h.gates.push(gate);
  return gate;
}
function changeConnection(id: string) {
  const previous = h.state;
  const next = connection(id);
  h.state = { ...previous, activeServerConnection: next, activeServerConnectionId: id, serverConnections: { [id]: next } };
  // Synchronous, sticky subscriptions observe even one -> two -> one in one act.
  for (const listener of [...h.listeners]) listener(h.state, previous);
}
async function flush(action?: () => void) {
  await act(async () => {
    action?.();
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
  });
}
const ui = (agent: Agent, ownerProfile?: XingyeRoleProfile) => <PhoneFilesApp ownerAgent={agent} ownerProfile={ownerProfile} displayName={agent.name} onBack={() => {}} />;
async function openDrawer() {
  if (!screen.queryByTestId('phone-files-hidden-view')) {
    const row = await screen.findByTestId('phone-files-hidden-folder-row');
    await waitFor(() => expect(row.getAttribute('data-locked')).toBe('false'));
    fireEvent.click(row);
  }
  return screen.findByTestId('phone-files-hidden-view');
}
async function open(agent = a) { const result = render(ui(agent)); await openDrawer(); return result; }
function clickSeed() { fireEvent.click(screen.getByTestId('phone-files-hidden-seed-button')); }
const modelRequests = () => h.requests.filter(r => r.path === '/api/xingye/phone-generate');
const appends = () => h.requests.filter(r => r.body.action === 'appendJsonl' && r.body.relativePath === 'files/hidden-entries.jsonl');
const marks = () => h.requests.filter(r => r.body.action === 'writeJson' && r.body.data?.seedGenerated === true);
async function waitModels(count: number) { await waitFor(() => expect(modelRequests()).toHaveLength(count)); }
async function complete(agent = a, conn = 'one') {
  await waitFor(() => expect(marks().some(r => r.body.agentId === agent.id && r.host === host(conn) && r.settled)).toBe(true));
  const request = modelRequests().at(-1);
  if (!request) throw Error('missing synthetic model request');
  return request;
}
function stable(prompt: string) { return prompt.split('── 稳定 lore ──\n')[1].split('\n\n── 周围')[0]; }
function promptOf(request: CapturedRequest) {
  const prompt = request.body.prompt;
  if (typeof prompt !== 'string') throw Error('missing synthetic prompt');
  return prompt;
}
function noWrongOwnerOrConnectionWrites() {
  for (const request of appends()) {
    expect(request.body.agentId).toBe(a.id);
    expect(request.host).toBe(host('one'));
  }
}

beforeEach(() => {
  h.listeners.clear();
  const one = connection('one');
  h.state = { userName: 'SYNTHETIC_USER', stagedChatQuote: null, stageChatQuote: () => {},
    activeServerConnection: one, activeServerConnectionId: 'one', serverConnections: { one } };
  h.lore = new Map([['one', new Map()], ['two', new Map()]]);
  h.requests = []; h.rows = new Map(); h.states = new Map(); h.selectCalls = []; h.models = []; h.gates = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    const parsed = new URL(url);
    const body = JSON.parse(String(options.body)) as RequestPayload;
    const request = { host: parsed.host, path: parsed.pathname, body, settled: false };
    h.requests.push(request);
    if (parsed.pathname === '/api/xingye/phone-generate') {
      const plan = h.models.shift();
      const data = plan ? await plan.promise : modelResult();
      request.settled = true;
      return response(data);
    }
    if (parsed.pathname !== '/api/xingye/storage') throw Error(`unexpected transport ${parsed.pathname}`);
    const key = `${parsed.host}/${body.agentId}/${body.relativePath}`;
    // A read observes its own original request snapshot even when its response is late.
    const snapshot = body.action === 'readJson' ? structuredClone(h.states.get(key) ?? state(body.agentId))
      : body.action === 'listJsonl' ? structuredClone(h.rows.get(key) ?? []) : null;
    const gate = h.gates.find(item => !item.used && item.matches(request));
    if (gate) { gate.used = true; gate.enter(); await gate.promise; }
    let data: unknown;
    if (body.action === 'readJson') data = { data: snapshot };
    else if (body.action === 'listJsonl') data = { records: snapshot };
    else if (body.action === 'appendJsonl') { h.rows.set(key, [...(h.rows.get(key) ?? []), body.data as XingyeHiddenFileEntry]); data = { ok: true }; }
    else if (body.action === 'writeJson') { h.states.set(key, structuredClone(body.data) as XingyeHiddenFolderState); data = { ok: true }; }
    else throw Error(`unexpected storage ${body.action}`);
    request.settled = true;
    return response(data);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Five retained HF01 controls; these use the same final transport as lifecycle cases.
it('control: empty lore remains a valid real UI request', async () => {
  await open(); clickSeed(); const request = await complete();
  expect(stable(promptOf(request))).toBe('（无）');
  expect(request.body.ownerAgentId).toBe(a.id);
  expect(h.selectCalls).toEqual([{ owner: a.id, options: { includeAlways: true, includeKeyword: false, maxChars: 2000 } }]);
});
it('control: forbidden lore title body and keyword canaries stay out of the complete request', async () => {
  const deny = [entry('private', { visibility: 'private' }), entry('draft', { visibility: 'draft' }),
    entry('manual', { insertionMode: 'manual' }), entry('keyword', { insertionMode: 'keyword', keywords: ['Agent A'] }),
    entry('disabled', { enabled: false }), entry('stale', { sourceStatus: 'stale' }),
    entry('derived-pending', { origin: 'derived', sourceStatus: 'pending' }), entry('other-owner', { agentId: b.id }),
    entry('scope-wrong-owner', { memoryScope: { version: 1, agentId: b.id, realm: 'legacy', knowledge: 'shared' } }),
    entry('author', { memoryScope: { version: 1, agentId: a.id, realm: 'legacy', knowledge: 'author' } }),
    entry('character', { memoryScope: { version: 1, agentId: a.id, realm: 'legacy', knowledge: 'character', characterId: 'character-a' } }),
    entry('story', { memoryScope: { version: 1, agentId: a.id, realm: 'story', knowledge: 'shared', worldId: 'w', branchId: 'b' } }),
    entry('reality', { memoryScope: { version: 1, agentId: a.id, realm: 'reality', knowledge: 'shared' } }),
    entry('bad-scope', { memoryScope: { realm: 'bad' } as unknown as XingyeLoreEntry['memoryScope'] })];
  const allow = [entry('active', { origin: 'derived', sourceStatus: 'active' }),
    entry('legacy', { origin: 'derived', memoryScope: { version: 1, agentId: a.id, realm: 'legacy', knowledge: 'shared' } }), entry('normal')];
  put([...deny, ...allow]); await open(); clickSeed(); const request = await complete();
  const all = JSON.stringify({ request: request.body, selection: h.selectCalls });
  for (const item of deny) for (const value of [item.title, item.content, ...(item.id === 'keyword' ? [] : item.keywords)]) expect(all, item.id).not.toContain(value);
  for (const item of allow) { expect(promptOf(request)).toContain(item.content); expect(promptOf(request)).toContain(item.title); }
});
it('control: bounded lore cannot leak oversized NPC titles or split a surrogate', async () => {
  put([entry('short', { content: 'SHORT_RULE_CANARY', category: 'rule' }),
    entry('long', { content: '😀'.repeat(4000) + 'UNBOUNDED_TAIL_CANARY', priority: 20 }),
    entry('huge-title', { title: 'OVERSIZE_TITLE_CANARY' + '长'.repeat(2300), content: 'HUGE_BODY_CANARY', priority: 10 })]);
  await open(); clickSeed(); const request = await complete(); const text = stable(promptOf(request));
  expect(text).toContain('SHORT_RULE_CANARY'); expect(text.length).toBeLessThanOrEqual(2000 + '【星野设定参考】\n'.length);
  expect(text).toContain('...'); expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  for (const value of ['UNBOUNDED_TAIL_CANARY', 'OVERSIZE_TITLE_CANARY', 'HUGE_BODY_CANARY']) expect(promptOf(request)).not.toContain(value);
});
it('control: the separate manual catalog keeps its explicit manual exception', () => {
  put([entry('manual', { insertionMode: 'manual' }), entry('private', { visibility: 'private' })]);
  expect(buildFilesLoreCatalog(a.id).map(item => item.id)).toEqual(['manual']);
});
it('control: a fresh request after owner and connection switch uses the new lore snapshot', async () => {
  put([entry('old')]); const mounted = await open();
  await flush(() => changeConnection('two')); put([entry('new', { agentId: b.id })]); mounted.rerender(ui(b));
  await openDrawer(); clickSeed(); const request = await complete(b, 'two');
  expect(request.host).toBe(host('two')); expect(request.body.ownerAgentId).toBe(b.id);
  expect(promptOf(request)).toContain('BODY_new_CANARY'); expect(promptOf(request)).not.toContain('BODY_old_CANARY');
});

it('late A generation cannot appear in B UI or overwrite B stored content', async () => {
  const old = deferModel('OLD_A_CANARY'); h.rows.set(rowsKey('one', b.id), [storedEntry(b, 'EXISTING_B_CANARY')]);
  const mounted = await open(); clickSeed(); await waitModels(1); mounted.rerender(ui(b)); await openDrawer();
  await waitFor(() => expect(screen.getByTestId('phone-files-hidden-view').textContent).toContain('EXISTING_B_CANARY'));
  await flush(old.release);
  expect(screen.getByTestId('phone-files-hidden-view').textContent).not.toContain('OLD_A_CANARY');
  expect(h.rows.get(rowsKey('one', b.id))?.map(item => item.title)).toEqual(['EXISTING_B_CANARY']);
  noWrongOwnerOrConnectionWrites();
});
it('late generation cannot append or mark through a newly active connection without a test rerender', async () => {
  const old = deferModel('OLD_CONNECTION_CANARY'); await open(); clickSeed(); await waitModels(1);
  await flush(() => changeConnection('two')); await flush(old.release);
  expect(appends().filter(request => request.host === host('two'))).toHaveLength(0);
  expect(marks().filter(request => request.host === host('two'))).toHaveLength(0);
  expect(modelRequests()[0].host).toBe(host('one'));
  expect(document.body.textContent).not.toContain('OLD_CONNECTION_CANARY'); noWrongOwnerOrConnectionWrites();
});
it('owner A B A keeps the old generation invalid and permits a fresh operation', async () => {
  const old = deferModel('OLD_OWNER_ABA_CANARY'); const fresh = deferModel('NEW_OWNER_ABA_CANARY');
  const mounted = await open(); clickSeed(); await waitModels(1);
  mounted.rerender(ui(b)); await openDrawer(); mounted.rerender(ui(a)); await openDrawer();
  await waitFor(() => expect(screen.getByTestId('phone-files-hidden-seed-button').hasAttribute('disabled')).toBe(false));
  clickSeed(); await waitModels(2); await flush(old.release);
  expect(document.body.textContent).not.toContain('OLD_OWNER_ABA_CANARY');
  expect(screen.getByTestId('phone-files-hidden-seed-busy')).toBeTruthy();
  expect(screen.queryByTestId('phone-files-hidden-seed-button')).toBeNull();
  await flush(fresh.release); await complete();
  expect(document.body.textContent).toContain('NEW_OWNER_ABA_CANARY');
  expect(appends().map(request => request.body.data?.title)).toEqual(['NEW_OWNER_ABA_CANARY']);
});
it('connection one two one is sticky even when both changes occur in the same act', async () => {
  const old = deferModel('OLD_CONNECTION_ABA_CANARY'); const fresh = deferModel('NEW_CONNECTION_ABA_CANARY');
  await open(); clickSeed(); await waitModels(1);
  await flush(() => { changeConnection('two'); changeConnection('one'); }); await openDrawer();
  await waitFor(() => expect(screen.getByTestId('phone-files-hidden-seed-button').hasAttribute('disabled')).toBe(false));
  clickSeed(); await waitModels(2); await flush(old.release);
  expect(document.body.textContent).not.toContain('OLD_CONNECTION_ABA_CANARY');
  expect(screen.getByTestId('phone-files-hidden-seed-busy')).toBeTruthy();
  expect(screen.queryByTestId('phone-files-hidden-seed-button')).toBeNull();
  await flush(fresh.release); await complete();
  expect(appends().map(request => request.body.data?.title)).toEqual(['NEW_CONNECTION_ABA_CANARY']);
});
it('unmount before generation returns cannot start storage writes', async () => {
  const old = deferModel('UNMOUNTED_CANARY'); const mounted = await open(); clickSeed(); await waitModels(1);
  mounted.unmount(); await flush(old.release);
  expect(appends()).toHaveLength(0); expect(marks()).toHaveLength(0);
});
it('current generation failure exposes an error and a retry can succeed', async () => {
  const failed = deferModel('CURRENT_FAILURE_CANARY'); const fresh = deferModel('RETRY_CANARY');
  await open(); clickSeed(); await waitModels(1); await flush(failed.fail);
  await screen.findByText(/FAIL_CURRENT_FAILURE_CANARY/);
  expect(screen.getByTestId('phone-files-hidden-seed-button').hasAttribute('disabled')).toBe(false);
  clickSeed(); await waitModels(2); await flush(fresh.release); await complete();
  expect(document.body.textContent).toContain('RETRY_CANARY'); expect(document.body.textContent).not.toContain('FAIL_CURRENT_FAILURE_CANARY');
});
it('old failure and finally cannot clear a newer owner operation busy state or set its error', async () => {
  const old = deferModel('OLD_FAILURE_CANARY'); const fresh = deferModel('B_SUCCESS_CANARY');
  const mounted = await open(); clickSeed(); await waitModels(1); mounted.rerender(ui(b)); await openDrawer();
  await waitFor(() => expect(screen.getByTestId('phone-files-hidden-seed-button').hasAttribute('disabled')).toBe(false));
  clickSeed(); await waitModels(2); await flush(old.fail);
  expect(screen.getByTestId('phone-files-hidden-seed-busy')).toBeTruthy();
  expect(screen.queryByTestId('phone-files-hidden-seed-button')).toBeNull();
  expect(document.body.textContent).not.toContain('FAIL_OLD_FAILURE_CANARY');
  await flush(fresh.release); await complete(b);
  expect(document.body.textContent).toContain('B_SUCCESS_CANARY');
});
it('an append already in flight remains saved for A while the next draft and stale UI stay stopped', async () => {
  const plan = deferModel('SAVED_A_CANARY', 'NOT_STARTED_A_CANARY');
  const pending = deferStorage(request => request.body.action === 'appendJsonl');
  const mounted = await open(); clickSeed(); await waitModels(1); await flush(plan.release); await pending.entered;
  mounted.rerender(ui(b)); await openDrawer(); await flush(pending.release);
  await waitFor(() => expect(h.rows.get(rowsKey('one', a.id))?.map(item => item.title)).toEqual(['SAVED_A_CANARY']));
  expect(appends()).toHaveLength(1); expect(appends()[0].body.agentId).toBe(a.id);
  expect(document.body.textContent).not.toContain('SAVED_A_CANARY'); expect(document.body.textContent).not.toContain('NOT_STARTED_A_CANARY');
  expect(h.rows.get(rowsKey('one', b.id)) ?? []).toEqual([]);
});
it('a successful append in flight across a connection change is acknowledged only at its original destination', async () => {
  const pending = deferStorage(request => request.body.action === 'appendJsonl');
  const plan = deferModel('PINNED_APPEND_CANARY', 'STOPPED_APPEND_CANARY');
  await open(); clickSeed(); await waitModels(1); await flush(plan.release); await pending.entered;
  await flush(() => changeConnection('two')); await flush(pending.release);
  expect(h.rows.get(rowsKey('one', a.id))?.map(item => item.title)).toEqual(['PINNED_APPEND_CANARY']);
  expect(h.rows.get(rowsKey('two', a.id)) ?? []).toEqual([]); expect(appends()).toHaveLength(1);
  expect(document.body.textContent).not.toContain('PINNED_APPEND_CANARY'); noWrongOwnerOrConnectionWrites();
});
it('unmount cannot erase an append that has already started and then succeeds', async () => {
  const pending = deferStorage(request => request.body.action === 'appendJsonl');
  const plan = deferModel('SAVED_AFTER_UNMOUNT_CANARY'); const mounted = await open();
  clickSeed(); await waitModels(1); await flush(plan.release); await pending.entered; mounted.unmount(); await flush(pending.release);
  expect(h.rows.get(rowsKey('one', a.id))?.map(item => item.title)).toEqual(['SAVED_AFTER_UNMOUNT_CANARY']);
  expect(appends()).toHaveLength(1); noWrongOwnerOrConnectionWrites();
});
it('mark read and write stay on their original connection when switching between the two awaits', async () => {
  const pending = deferStorage(request => request.body.action === 'readJson' && appends().length > 0);
  await open(); clickSeed(); await pending.entered;
  expect(appends()).toHaveLength(1); expect(appends()[0].settled).toBe(true);
  await flush(() => changeConnection('two')); await flush(pending.release);
  expect(marks().filter(request => request.host === host('two'))).toHaveLength(0);
  expect(h.rows.get(rowsKey('one', a.id))?.map(item => item.title)).toEqual(['SEED_RESULT_CANARY']);
  expect(h.states.get(stateKey('two', a.id))).toBeUndefined();
  // Once mark has started it may finish, but only for the original owner and destination.
  for (const request of marks()) { expect(request.host).toBe(host('one')); expect(request.body.agentId).toBe(a.id); }
  expect(document.body.textContent).not.toContain('SEED_RESULT_CANARY');
});
it('a late old owner reload cannot replace the current B drawer', async () => {
  h.rows.set(rowsKey('one', a.id), [storedEntry(a, 'LATE_RELOAD_A_CANARY')]);
  h.rows.set(rowsKey('one', b.id), [storedEntry(b, 'CURRENT_B_CANARY')]);
  const pending = deferStorage(request => request.body.action === 'listJsonl' && request.body.agentId === a.id);
  const mounted = render(ui(a)); await pending.entered; mounted.rerender(ui(b)); await openDrawer();
  await waitFor(() => expect(document.body.textContent).toContain('CURRENT_B_CANARY')); await flush(pending.release);
  expect(document.body.textContent).toContain('CURRENT_B_CANARY'); expect(document.body.textContent).not.toContain('LATE_RELOAD_A_CANARY');
});
it('starting a seed invalidates an older same-owner reload snapshot', async () => {
  const mounted = await open();
  const pending = deferStorage(request => request.body.action === 'listJsonl');
  mounted.rerender(ui(a, { agentId: a.id, updatedAt: '2026-01-01', displayName: 'Agent A synthetic profile refresh' })); await pending.entered;
  clickSeed(); await complete(); expect(document.body.textContent).toContain('SEED_RESULT_CANARY');
  await flush(pending.release);
  expect(document.body.textContent).toContain('SEED_RESULT_CANARY');
  expect(h.rows.get(rowsKey('one', a.id))?.map(item => item.title)).toEqual(['SEED_RESULT_CANARY']);
});

it('a profile refresh during generation cannot load an empty snapshot over its saved batch or reorder drafts', async () => {
  const plan = deferModel('FIRST_DAWN_PLAN_CANARY', 'SECOND_RIVER_SECRET_CANARY');
  const mounted = await open(); clickSeed(); await waitModels(1);
  const pending = deferStorage(request => request.body.action === 'listJsonl');
  mounted.rerender(ui(a, { agentId: a.id, updatedAt: '2026-02-01', displayName: 'Agent A updated profile' }));
  await flush(); await flush(plan.release); await complete(); await flush(pending.release);
  const titles = h.rows.get(rowsKey('one', a.id))?.map(item => item.title);
  expect(titles).toEqual(['FIRST_DAWN_PLAN_CANARY', 'SECOND_RIVER_SECRET_CANARY']);
  const text = screen.getByTestId('phone-files-hidden-view').textContent ?? '';
  expect(text).toContain('FIRST_DAWN_PLAN_CANARY'); expect(text).toContain('SECOND_RIVER_SECRET_CANARY');
  expect(text.indexOf('FIRST_DAWN_PLAN_CANARY')).toBeLessThan(text.indexOf('SECOND_RIVER_SECRET_CANARY'));
});
