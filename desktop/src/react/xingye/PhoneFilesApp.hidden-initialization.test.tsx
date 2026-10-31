/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../types';
import type { ServerConnection } from '../services/server-connection';
import type { XingyeHiddenFolderState } from './xingye-files-secret-store';

interface MockState {
  userName: string;
  stagedChatQuote: null;
  stageChatQuote: () => void;
  activeServerConnection: ServerConnection;
  activeServerConnectionId: string;
  serverConnections: Record<string, ServerConnection>;
}
interface Payload {
  action?: string;
  relativePath?: string;
  agentId: string;
  data?: XingyeHiddenFolderState;
}
interface Request { host: string; path: string; body: Payload; ordinal: number }
interface Gate {
  matches: (request: Request) => boolean;
  used: boolean;
  afterCommit: boolean;
  promise: Promise<void>;
  entered: Promise<void>;
  enter: () => void;
  release: () => void;
}
const h = vi.hoisted(() => ({
  state: null as unknown as MockState,
  listeners: new Set<(state: MockState, previous: MockState) => void>(),
  requests: [] as Request[],
  states: new Map<string, XingyeHiddenFolderState>(),
  readFailures: new Set<number>(),
  malformedReads: new Set<number>(),
  writeFailures: new Set<number>(),
  ackFailures: new Set<number>(),
  malformedAcks: new Set<number>(),
  gates: [] as Gate[],
}));
vi.mock('../stores', () => ({
  useStore: Object.assign(<T,>(select: (state: MockState) => T) => select(h.state), {
    getState: () => h.state,
    subscribe: (listener: (state: MockState, previous: MockState) => void) => {
      h.listeners.add(listener);
      return () => h.listeners.delete(listener);
    },
  }),
}));
vi.mock('./xingye-files-store', async original => ({
  ...await original<typeof import('./xingye-files-store')>(),
  listFileFolders: vi.fn(async (id: string) => [{ id: 'folder', agentId: id, name: '合成资料', description: '', order: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' }]),
  listFileEntries: vi.fn(async () => []),
  listFileDrafts: vi.fn(async () => []),
}));
vi.mock('./xingye-phone-store', () => ({ getConfirmedVirtualContacts: vi.fn(() => []) }));
vi.mock('./xingye-persistence', () => ({ getXingyePersistenceStorage: () => ({ getItem: () => null }) }));
import { PhoneFilesApp } from './PhoneFilesApp';

const a: Agent = { id: 'init-a', name: '合成人名甲', yuan: 'hanako', isPrimary: false, hasAvatar: false };
const b: Agent = { ...a, id: 'init-b', name: '合成人名乙' };
const connection = (id: string): ServerConnection => ({
  connectionId: id, kind: 'custom_remote', serverId: `synthetic-${id}`, studioId: `studio-${id}`,
  label: `Synthetic ${id}`, baseUrl: `https://hf04-${id}.invalid`, wsUrl: `wss://hf04-${id}.invalid`,
  token: null, authState: 'paired', trustState: 'tunnel', credentialKind: 'device_credential', capabilities: [],
});
const stateKey = (id = 'one', owner = a.id) => `hf04-${id}.invalid/${owner}/files/hidden.json`;
const saved = (owner = a.id): XingyeHiddenFolderState => ({
  agentId: owner, locked: false, passwordHash: 'HF04_SYNTHETIC_HASH', candidateLabel: 'HF04_SYNTHETIC_LABEL',
  seedGenerated: true, lockedAt: '2026-01-01T00:00:00Z', lastUnlockedAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z',
});
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
const writes = () => h.requests.filter(r => r.body.action === 'writeJson');
const reads = () => h.requests.filter(r => r.body.action === 'readJson');
const ui = (agent = a) => <PhoneFilesApp ownerAgent={agent} displayName={agent.name} onBack={() => {}} />;
const retry = () => fireEvent.click(screen.getByRole('button', { name: '重试读取抽屉' }));
const row = () => screen.getByTestId('phone-files-hidden-folder-row');
async function flush(action?: () => void) {
  await act(async () => { action?.(); for (let i = 0; i < 24; i += 1) await Promise.resolve(); });
}
async function hasError(text: string) {
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(text));
  expect(screen.getByRole('button', { name: '重试读取抽屉' })).toBeTruthy();
}
async function loaded() {
  await waitFor(() => expect(row().hasAttribute('disabled')).toBe(false));
  expect(screen.queryByRole('alert')).toBeNull();
}
function changeConnection(id: string) {
  const previous = h.state; const next = connection(id);
  h.state = { ...previous, activeServerConnection: next, activeServerConnectionId: id, serverConnections: { [id]: next } };
  for (const listener of [...h.listeners]) listener(h.state, previous);
}
function gate(matches: Gate['matches'], afterCommit = false) {
  let release!: () => void; let enter!: () => void;
  const result: Gate = { matches, used: false, afterCommit,
    promise: new Promise<void>(yes => { release = yes; }), entered: new Promise<void>(yes => { enter = yes; }),
    release: () => release(), enter: () => enter() };
  h.gates.push(result); return result;
}

beforeEach(() => {
  const one = connection('one');
  h.state = { userName: '合成用户名', stagedChatQuote: null, stageChatQuote: () => {},
    activeServerConnection: one, activeServerConnectionId: 'one', serverConnections: { one } };
  h.listeners.clear(); h.requests = []; h.states.clear(); h.gates = [];
  h.readFailures.clear(); h.malformedReads.clear(); h.writeFailures.clear(); h.ackFailures.clear(); h.malformedAcks.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    const parsed = new URL(url); const body = JSON.parse(String(options.body)) as Payload;
    const ordinal = h.requests.filter(r => r.body.action === body.action).length + 1;
    const request = { host: parsed.host, path: parsed.pathname, body, ordinal }; h.requests.push(request);
    if (parsed.pathname !== '/api/xingye/storage') throw Error(`Unexpected request ${parsed.pathname}`);
    const key = `${parsed.host}/${body.agentId}/${body.relativePath}`;
    const snapshot = structuredClone(h.states.get(key) ?? null);
    const pending = h.gates.find(g => !g.used && g.matches(request));
    if (pending && !pending.afterCommit) { pending.used = true; pending.enter(); await pending.promise; }
    let data: unknown;
    if (body.action === 'readJson') {
      if (h.readFailures.has(ordinal)) throw Error('HF04_READ_DENIED');
      data = h.malformedReads.has(ordinal) ? { ok: true, data: null } : { ok: true, missing: snapshot === null, data: snapshot };
    } else if (body.action === 'listJsonl') data = { ok: true, records: [] };
    else if (body.action === 'writeJson') {
      if (h.writeFailures.has(ordinal)) throw Error('HF04_WRITE_DENIED');
      h.states.set(key, structuredClone(body.data!));
      data = h.malformedAcks.has(ordinal) ? { ok: false } : { ok: true };
    } else throw Error(`Unexpected storage action ${body.action}`);
    if (pending?.afterCommit) { pending.used = true; pending.enter(); await pending.promise; }
    if (body.action === 'writeJson' && h.ackFailures.has(ordinal)) throw Error('HF04_ACK_LOST');
    return response(data);
  }));
});
afterEach(() => {
  expect(h.requests.filter(r => r.path === '/api/xingye/phone-generate' || r.body.action === 'appendJsonl')).toEqual([]);
  cleanup(); vi.unstubAllGlobals();
});

it('initializes a confirmed missing state once and preserves it on reload', async () => {
  const view = render(ui()); await loaded();
  const before = structuredClone(h.states.get(stateKey()));
  expect(before?.passwordHash).toBeTruthy(); expect(before?.locked).toBe(true); expect(writes()).toHaveLength(1);
  await flush(() => view.rerender(ui({ ...a }))); await loaded();
  expect(h.states.get(stateKey())).toEqual(before); expect(writes()).toHaveLength(1);
});

it.each(['read', 'write'] as const)('%s failure is visible and explicit retry succeeds once', async mode => {
  if (mode === 'read') h.readFailures.add(2); else h.writeFailures.add(1);
  render(ui()); await hasError(mode === 'read' ? 'HF04_READ_DENIED' : 'HF04_WRITE_DENIED');
  expect(h.states.size).toBe(0); expect(writes()).toHaveLength(mode === 'read' ? 0 : 1);
  h.readFailures.clear(); h.writeFailures.clear(); retry(); await loaded();
  expect(writes()).toHaveLength(mode === 'read' ? 1 : 2);
  expect(h.states.get(stateKey())?.passwordHash).toBeTruthy();
});

it.each(['lost', 'malformed'] as const)('%s write ACK stays visible and retry only confirms the saved lock', async mode => {
  if (mode === 'lost') h.ackFailures.add(1); else h.malformedAcks.add(1);
  render(ui()); await hasError(mode === 'lost' ? 'HF04_ACK_LOST' : '存储响应无效');
  const before = structuredClone(h.states.get(stateKey()));
  expect(before?.passwordHash).toBeTruthy(); expect(writes()).toHaveLength(1);
  retry(); await loaded();
  expect(writes()).toHaveLength(1); expect(h.states.get(stateKey())).toEqual(before); expect(reads()).toHaveLength(3);
});

it.each(['denied', 'malformed'] as const)('unknown ACK recovery with %s read never resets a password', async mode => {
  h.ackFailures.add(1); render(ui()); await hasError('HF04_ACK_LOST');
  const before = structuredClone(h.states.get(stateKey()));
  if (mode === 'denied') h.readFailures.add(3); else h.malformedReads.add(3);
  retry(); await hasError(mode === 'denied' ? 'HF04_READ_DENIED' : '读取不完整');
  expect(writes()).toHaveLength(1); expect(h.states.get(stateKey())).toEqual(before);
  h.readFailures.clear(); h.malformedReads.clear(); retry(); await loaded();
  expect(writes()).toHaveLength(1); expect(h.states.get(stateKey())).toEqual(before);
});

it('initial load parse failure is visible and never initializes', async () => {
  h.states.set(stateKey(), { ...saved(), locked: 'bad' as unknown as boolean });
  const before = structuredClone(h.states.get(stateKey()));
  render(ui()); await hasError('状态损坏'); expect(writes()).toHaveLength(0); expect(h.states.get(stateKey())).toEqual(before);
});

it('second read that discovers an existing lock preserves every field', async () => {
  const pending = gate(r => r.body.action === 'listJsonl');
  render(ui()); await pending.entered;
  const before = saved(); h.states.set(stateKey(), before);
  await flush(pending.release); await loaded();
  expect(reads()).toHaveLength(2); expect(writes()).toHaveLength(0); expect(h.states.get(stateKey())).toEqual(before);
  expect(row().getAttribute('data-locked')).toBe('false');
});

it.each(['owner', 'connection', 'unmount'] as const)('%s invalidation during second read prevents stale initialization', async mode => {
  const pending = gate(r => r.body.action === 'readJson' && r.ordinal === 2);
  const view = render(ui()); await pending.entered;
  if (mode === 'owner') { h.states.set(stateKey('one', b.id), saved(b.id)); await flush(() => view.rerender(ui(b))); }
  else if (mode === 'connection') { h.states.set(stateKey('two'), saved()); await flush(() => changeConnection('two')); }
  else await flush(() => view.unmount());
  if (mode !== 'unmount') await loaded();
  await flush(pending.release);
  expect(writes()).toHaveLength(0); expect(h.states.has(stateKey())).toBe(false);
  if (mode !== 'unmount') { expect(row().getAttribute('data-locked')).toBe('false'); expect(screen.queryByRole('alert')).toBeNull(); }
});

it('connection ABA during second read cannot revive a stale initialization', async () => {
  const pending = gate(r => r.body.action === 'readJson' && r.ordinal === 2);
  render(ui()); await pending.entered;
  const before = saved(); h.states.set(stateKey(), before);
  await flush(() => { changeConnection('two'); changeConnection('one'); });
  expect(writes()).toHaveLength(0);
  await flush(pending.release); await loaded();
  expect(writes()).toHaveLength(0); expect(h.states.get(stateKey())).toEqual(before);
  expect(row().getAttribute('data-locked')).toBe('false');
});

it.each(['owner', 'connection', 'unmount'] as const)('%s change after a write starts preserves its destination and ignores late ACK', async mode => {
  const pending = gate(r => r.body.action === 'writeJson');
  const view = render(ui()); await pending.entered;
  if (mode === 'owner') { h.states.set(stateKey('one', b.id), saved(b.id)); await flush(() => view.rerender(ui(b))); }
  else if (mode === 'connection') { h.states.set(stateKey('two'), saved()); await flush(() => changeConnection('two')); }
  else await flush(() => view.unmount());
  if (mode !== 'unmount') await loaded();
  await flush(pending.release);
  expect(writes()).toHaveLength(1); expect(writes()[0].body.agentId).toBe(a.id); expect(writes()[0].host).toBe('hf04-one.invalid');
  expect(h.states.get(stateKey())?.passwordHash).toBeTruthy();
  if (mode !== 'unmount') expect(row().getAttribute('data-locked')).toBe('false');
});

it('repeated retry clicks wait for one pending write and keep the error until success', async () => {
  h.writeFailures.add(1); render(ui()); await hasError('HF04_WRITE_DENIED'); h.writeFailures.clear();
  const pending = gate(r => r.body.action === 'writeJson');
  retry(); await pending.entered;
  expect(screen.getByRole('alert')).toBeTruthy();
  await flush(() => { retry(); retry(); });
  expect(writes()).toHaveLength(2);
  await flush(pending.release); await loaded(); expect(writes()).toHaveLength(2);
});

it('a dependency refresh during an unacknowledged write waits before reloading', async () => {
  const pending = gate(r => r.body.action === 'writeJson');
  const view = render(ui()); await pending.entered;
  await flush(() => view.rerender(ui({ ...a, name: '合成人名更新' })));
  expect(writes()).toHaveLength(1);
  await flush(pending.release); await loaded(); expect(writes()).toHaveLength(1);
});

it.each(['owner', 'connection', 'unmount'] as const)('%s invalidation during password hashing prevents initialization', async mode => {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(yes => { enter = yes; });
  const hashing = new Promise<void>(yes => { release = yes; });
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => { enter(); await hashing; return new Uint8Array([4, 2]).buffer; }) } });
  const view = render(ui()); await entered;
  if (mode === 'owner') { h.states.set(stateKey('one', b.id), saved(b.id)); await flush(() => view.rerender(ui(b))); }
  else if (mode === 'connection') { h.states.set(stateKey('two'), saved()); await flush(() => changeConnection('two')); }
  else await flush(() => view.unmount());
  if (mode !== 'unmount') await loaded();
  await flush(release); expect(writes()).toHaveLength(0); expect(h.states.has(stateKey())).toBe(false);
});

it('owner ABA during second read cannot revive a stale initialization', async () => {
  const pending = gate(r => r.body.action === 'readJson' && r.ordinal === 2);
  const view = render(ui()); await pending.entered;
  const before = saved(); h.states.set(stateKey(), before); h.states.set(stateKey('one', b.id), saved(b.id));
  await flush(() => view.rerender(ui(b))); await loaded();
  await flush(() => view.rerender(ui(a)));
  await flush(pending.release); await loaded();
  expect(writes()).toHaveLength(0); expect(h.states.get(stateKey())).toEqual(before);
  expect(row().getAttribute('data-locked')).toBe('false');
});
