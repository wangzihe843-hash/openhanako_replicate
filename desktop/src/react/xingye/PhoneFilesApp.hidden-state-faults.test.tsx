/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../types';
import type { ServerConnection } from '../services/server-connection';
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
  afterCommit?: boolean;
  fail?: boolean;
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
  const gate: StorageGate = { matches, used: false, promise: new Promise<void>(yes => { release = yes; }),
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
    if (gate && !gate.afterCommit) { gate.used = true; gate.enter(); await gate.promise; if (gate.fail) throw Error('SYNTHETIC_STORAGE_FAILURE'); }
    let data: unknown;
    if (body.action === 'readJson') data = { ok: true, data: snapshot };
    else if (body.action === 'listJsonl') data = { ok: true, records: snapshot };
    else if (body.action === 'appendJsonl') { h.rows.set(key, [...(h.rows.get(key) ?? []), body.data as XingyeHiddenFileEntry]); data = { ok: true }; }
    else if (body.action === 'writeJson') { h.states.set(key, structuredClone(body.data) as XingyeHiddenFolderState); data = { ok: true }; }
    else throw Error(`unexpected storage ${body.action}`);
    if (gate?.afterCommit) { gate.used = true; gate.enter(); await gate.promise; if (gate.fail) throw Error('SYNTHETIC_STORAGE_FAILURE'); }
    request.settled = true;
    return response(data);
  }));
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
});



const original = () => ({ ...state(a.id), passwordHash: 'CONFIRMED_HASH', candidateLabel: 'CONFIRMED_LABEL',
  lastUnlockedAt: '2026-10-30T10:00:00.000Z', lockedAt: '2026-10-29T10:00:00.000Z' });
const retry = () => fireEvent.click(screen.getByTestId('phone-files-hidden-seed-retry'));
async function settled() {
  await waitFor(() => expect(screen.queryByTestId('phone-files-hidden-seed-busy')).toBeNull());
}

it('read failure preserves the entire original state; visible retry only records saved seeds', async () => {
  const before = original(); h.states.set(stateKey('one', a.id), structuredClone(before));
  const failure = deferStorage(x => x.body.action === 'readJson' && appends().length > 0); failure.fail = true;
  await open(); clickSeed(); await failure.entered; await flush(failure.release); await settled();
  expect(h.states.get(stateKey('one', a.id))).toEqual(before);
  expect(marks()).toHaveLength(0);
  expect(h.rows.get(rowsKey('one', a.id))?.map(x => x.title)).toEqual(['SEED_RESULT_CANARY']);
  expect(screen.getByRole('alert').textContent).toContain('SYNTHETIC_STORAGE_FAILURE');
  retry(); await settled();
  expect(h.states.get(stateKey('one', a.id))).toMatchObject({ ...before, seedGenerated: true, updatedAt: expect.any(String) });
  expect(appends()).toHaveLength(1); expect(modelRequests()).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull(); noWrongOwnerOrConnectionWrites();
});

it.each([false, true])('failed mark write (committed=%s) verifies state before retry without new entries', async afterCommit => {
  const before = original(); h.states.set(stateKey('one', a.id), structuredClone(before));
  const failure = deferStorage(x => x.body.action === 'writeJson' && x.body.data?.seedGenerated === true);
  failure.fail = true; failure.afterCommit = afterCommit;
  await open(); clickSeed(); await failure.entered; await flush(failure.release); await settled();
  expect(h.states.get(stateKey('one', a.id))).toMatchObject({ ...before, seedGenerated: afterCommit, updatedAt: expect.any(String) });
  expect(screen.getByRole('alert').textContent).toContain('SYNTHETIC_STORAGE_FAILURE');
  const writeCount = marks().length; retry(); await settled();
  expect(marks()).toHaveLength(writeCount + (afterCommit ? 0 : 1));
  expect(appends()).toHaveLength(1); expect(modelRequests()).toHaveLength(1);
  expect(h.states.get(stateKey('one', a.id))).toMatchObject({ passwordHash: before.passwordHash,
    candidateLabel: before.candidateLabel, lastUnlockedAt: before.lastUnlockedAt, seedGenerated: true });
});

it('owner switch while mark read is pending prevents the not-yet-started write; reopening can record saved rows', async () => {
  const before = original(); h.states.set(stateKey('one', a.id), structuredClone(before));
  const pending = deferStorage(x => x.body.action === 'readJson' && appends().length > 0);
  const view = await open(); clickSeed(); await pending.entered;
  await flush(() => view.rerender(ui(b))); await flush(pending.release);
  expect(marks()).toHaveLength(0); expect(h.states.get(stateKey('one', a.id))).toEqual(before);
  await flush(() => view.rerender(ui(a))); await openDrawer();
  await screen.findByTestId('phone-files-hidden-seed-retry'); retry(); await settled();
  expect(marks()).toHaveLength(1); expect(modelRequests()).toHaveLength(1); expect(appends()).toHaveLength(1);
  noWrongOwnerOrConnectionWrites();
});

it('connection ABA while mark read is pending cannot revive a write', async () => {
  const before = original(); h.states.set(stateKey('one', a.id), structuredClone(before));
  const pending = deferStorage(x => x.body.action === 'readJson' && appends().length > 0);
  const view = await open(); clickSeed(); await pending.entered;
  await flush(() => { changeConnection('two'); changeConnection('one'); view.rerender(ui(a)); });
  await flush(pending.release);
  expect(marks()).toHaveLength(0); expect(h.states.get(stateKey('one', a.id))).toEqual(before);
  expect(appends()).toHaveLength(1); expect(modelRequests()).toHaveLength(1);
});

it.each([false, true])('partial append failure (committed=%s) only recovers confirmed rows', async afterCommit => {
  const before = original(); h.states.set(stateKey('one', a.id), structuredClone(before));
  const model = deferModel('FIRST_SAVED', 'SECOND_MAYBE_SAVED');
  const failure = deferStorage(x => x.body.action === 'appendJsonl' && appends().length === 2);
  failure.fail = true; failure.afterCommit = afterCommit;
  await open(); clickSeed(); await flush(model.release); await failure.entered; await flush(failure.release); await settled();
  expect(marks()).toHaveLength(0); expect(h.states.get(stateKey('one', a.id))).toEqual(before);
  expect(screen.getByRole('alert').textContent).toContain('SYNTHETIC_STORAGE_FAILURE');
  retry(); await settled();
  expect(h.rows.get(rowsKey('one', a.id))?.map(x => x.title)).toEqual(afterCommit ? ['FIRST_SAVED', 'SECOND_MAYBE_SAVED'] : ['FIRST_SAVED']);
  expect(modelRequests()).toHaveLength(1); expect(appends()).toHaveLength(2); expect(marks()).toHaveLength(1);
  noWrongOwnerOrConnectionWrites();
});

it('a failed read-only recovery leaves the result uncertain and performs no new write or generation', async () => {
  const before = original(); h.states.set(stateKey('one', a.id), structuredClone(before));
  const failure = deferStorage(x => x.body.action === 'readJson' && appends().length > 0); failure.fail = true;
  await open(); clickSeed(); await failure.entered; await flush(failure.release); await settled();
  expect(h.states.get(stateKey('one', a.id))).toEqual(before);
  const readFailure = deferStorage(x => x.body.action === 'listJsonl'); readFailure.fail = true;
  retry(); await readFailure.entered; await flush(readFailure.release); await settled();
  expect(marks()).toHaveLength(0); expect(h.states.get(stateKey('one', a.id))).toEqual(before);
  expect(screen.getByRole('alert').textContent).toContain('SYNTHETIC_STORAGE_FAILURE');
  expect(modelRequests()).toHaveLength(1); expect(appends()).toHaveLength(1);
  retry(); await settled(); expect(marks()).toHaveLength(1);
});

it('an empty snapshot after an uncertain append never triggers another generation or mark', async () => {
  const before = original(); h.states.set(stateKey('one', a.id), structuredClone(before));
  const failure = deferStorage(x => x.body.action === 'appendJsonl'); failure.fail = true;
  await open(); clickSeed(); await failure.entered; await flush(failure.release); await settled();
  expect(h.rows.get(rowsKey('one', a.id)) ?? []).toEqual([]);
  retry(); await settled();
  expect(screen.getByRole('alert').textContent).toContain('尚未确认保存结果');
  expect(appends()).toHaveLength(1); expect(modelRequests()).toHaveLength(1); expect(marks()).toHaveLength(0);
  // The original remote append may commit after the empty read snapshot.
  h.rows.set(rowsKey('one', a.id), [structuredClone(appends()[0].body.data) as XingyeHiddenFileEntry]);
  retry(); await settled();
  expect(appends()).toHaveLength(1); expect(modelRequests()).toHaveLength(1); expect(marks()).toHaveLength(1);
  expect(h.rows.get(rowsKey('one', a.id))).toHaveLength(1);
});

it('failed reload is visible and cannot present saved seeds as an empty drawer', async () => {
  const before = original(); h.states.set(stateKey('one', a.id), structuredClone(before));
  h.rows.set(rowsKey('one', a.id), [{ id: 'confirmed', key: 'confirmed', agentId: a.id,
    kind: 'secret_plan', title: 'ALREADY_SAVED', body: 'SYNTHETIC', source: 'ai_seed', createdAt: '2026-01-01' }]);
  const failure = deferStorage(x => x.body.action === 'listJsonl'); failure.fail = true;
  render(ui(a)); await failure.entered; await flush(failure.release);
  expect((await screen.findByTestId('phone-files-hidden-load-error')).textContent).toContain('SYNTHETIC_STORAGE_FAILURE');
  expect(screen.queryByTestId('phone-files-hidden-folder-row')).toBeNull();
  expect(modelRequests()).toHaveLength(0); expect(appends()).toHaveLength(0); expect(marks()).toHaveLength(0);
  fireEvent.click(screen.getByText('重试读取抽屉')); await openDrawer();
  expect(document.body.textContent).toContain('ALREADY_SAVED');
  retry(); await settled();
  expect(modelRequests()).toHaveLength(0); expect(appends()).toHaveLength(0); expect(marks()).toHaveLength(1);
});

it('profile refresh cannot discard an uncertain append guard after an empty read snapshot', async () => {
  h.states.set(stateKey('one', a.id), original());
  const failure = deferStorage(x => x.body.action === 'appendJsonl'); failure.fail = true;
  const view = await open(); clickSeed(); await failure.entered; await flush(failure.release); await settled();
  const reads = h.requests.filter(x => x.body.action === 'listJsonl').length;
  await flush(() => view.rerender(ui({ ...a })));
  await waitFor(() => expect(h.requests.filter(x => x.body.action === 'listJsonl').length).toBeGreaterThan(reads));
  await flush();
  expect(screen.queryByTestId('phone-files-hidden-seed-button')).toBeNull();
  expect(screen.getByTestId('phone-files-hidden-seed-retry')).toBeTruthy();
  expect(modelRequests()).toHaveLength(1); expect(appends()).toHaveLength(1); expect(marks()).toHaveLength(0);
});
