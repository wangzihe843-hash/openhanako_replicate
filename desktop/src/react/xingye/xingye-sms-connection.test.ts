/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConnection } from '../services/server-connection';
import type { Agent } from '../types';
import {
  captureXingyePersistenceBinding, flushXingyePersistenceNow, getXingyePersistenceStorage,
  refreshXingyeAgentPersistence, resetXingyePersistenceForTests,
} from './xingye-persistence';
import { generateSmsHistoryWithAI } from './xingye-phone-ai';
import { getSmsHistoryGenerationState, getSmsThread, type XingyePhoneContactView } from './xingye-phone-store';

const state = vi.hoisted(() => ({
  connection: null as ServerConnection | null,
  listeners: new Set<() => void>(),
}));
vi.mock('../stores', () => ({ useStore: {
  getState: () => ({ activeServerConnection: state.connection }),
  subscribe: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
} }));
vi.mock('./xingye-event-log', () => ({ appendXingyeEventOnce: vi.fn(async () => ({})), appendXingyeEvent: vi.fn(async () => ({})) }));
vi.mock('./xingye-speaker-context', async original => ({
  ...await original<typeof import('./xingye-speaker-context')>(), resolveXingyeSpeakerUserName: async () => 'Synthetic user',
}));

const connection = (server: string): ServerConnection => ({
  connectionId: server, serverId: server, studioId: 'studio', kind: 'custom_remote', label: server,
  baseUrl: `https://${server}.invalid`, wsUrl: `wss://${server}.invalid`, token: `synthetic-${server}`,
  authState: 'paired', trustState: 'tunnel', credentialKind: 'device_credential', capabilities: ['chat'],
});
const files = new Map<string, unknown>();
type ApiBody = { action: string; agentId: string; relativePath: string; data: unknown; contacts: Array<{ targetType: string; targetId: string }> };
const calls: Array<{ server: string; path: string; body: ApiBody; auth: string | null }> = [];
const owner: Agent = { id: 'owner', name: 'Owner', yuan: 'hanako', isPrimary: false };
const targets = (count = 1): XingyePhoneContactView[] => Array.from({ length: count }, (_, i) => ({
  ownerAgentId: owner.id, targetType: 'agent', targetId: `peer-${i + 1}`, displayName: `Peer ${i + 1}`,
  originalName: `Peer ${i + 1}`, remark: '', impression: '', tags: [], status: 'active',
} as XingyePhoneContactView));
const key = (server: string, path: string, agentId = owner.id) => `${server}:${agentId}:${path}`;
const smsPath = 'phone/sms-threads.json';
const coveragePath = 'phone/sms-history-generation-state.json';
const generate = (count = 1) => generateSmsHistoryWithAI({ ownerAgent: owner, ownerProfile: null, contacts: targets(count), profileFingerprint: 'synthetic' });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
let beforeResponse: ((call: typeof calls[number]) => Promise<void>) | undefined;
let afterWrite: ((call: typeof calls[number]) => Promise<void>) | undefined;
let failWrite = false;
function select(next: ServerConnection | null) {
  state.connection = next;
  for (const listener of state.listeners) listener();
}
async function switchTo(server: string | null, agentId = owner.id) {
  select(server ? connection(server) : null);
  await refreshXingyeAgentPersistence(agentId);
}
async function reload(server: string, agentId = owner.id) {
  resetXingyePersistenceForTests(); select(connection(server)); await refreshXingyeAgentPersistence(agentId);
}
beforeEach(async () => {
  resetXingyePersistenceForTests(); files.clear(); calls.length = 0; beforeResponse = undefined; afterWrite = undefined; failWrite = false;
  select(connection('server-a'));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const server = new URL(url).hostname.split('.')[0];
    const path = new URL(url).pathname;
    const body: ApiBody = JSON.parse(String(init.body));
    const call = { server, path, body, auth: new Headers(init.headers).get('Authorization') };
    calls.push(call);
    if (beforeResponse) await beforeResponse(call);
    if (path === '/api/xingye/phone-generate') return new Response(JSON.stringify({ result: {
      contacts: body.contacts.map((t: { targetType: string; targetId: string }) => ({ ...t, messages: [{ from: 'owner', content: `${server} generated ${t.targetId}` }] })),
    } }));
    if (path !== '/api/xingye/storage') throw Error(`Unexpected synthetic route ${path}`);
    const fileKey = key(server, body.relativePath, body.agentId);
    if (body.action === 'readJson') return new Response(JSON.stringify({ data: files.get(fileKey) ?? null }));
    if (body.action === 'listJsonl') return new Response(JSON.stringify({ records: [] }));
    if (body.action === 'writeJson') {
      if (failWrite) throw Error('synthetic save unavailable');
      files.set(fileKey, structuredClone(body.data));
      if (afterWrite) await afterWrite(call);
      return new Response(JSON.stringify({ ok: true }));
    }
    throw Error(`Unexpected synthetic action ${body.action}`);
  }));
  await refreshXingyeAgentPersistence(owner.id);
});
afterEach(() => { resetXingyePersistenceForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('SMS connection ownership through real transport and persistence', () => {
  it('rejects an A model result after same-owner switch to B and makes a fresh B request', async () => {
    beforeResponse = async call => { if (call.path.includes('phone-generate')) { beforeResponse = undefined; await switchTo('server-b'); } };
    await expect(generate()).rejects.toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(files.has(key('server-b', smsPath))).toBe(false);
    await generate();
    expect(getSmsThread(owner.id, 'agent', 'peer-1')?.messages[0].content).toBe('server-b generated peer-1');
    expect(calls.filter(c => c.path.includes('phone-generate')).map(c => c.server)).toEqual(['server-a', 'server-b']);
  });
  it('rejects old A generation after A -> B -> A even without an intermediate refresh await', async () => {
    beforeResponse = async call => { if (call.path.includes('phone-generate')) { beforeResponse = undefined; select(connection('server-b')); select(connection('server-a')); await refreshXingyeAgentPersistence(owner.id); } };
    await expect(generate()).rejects.toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(files.has(key('server-a', smsPath))).toBe(false);
  });
  it('invalidates on offline -> reconnect to the same server', async () => {
    beforeResponse = async call => { if (call.path.includes('phone-generate')) { beforeResponse = undefined; select(null); select(connection('server-a')); await refreshXingyeAgentPersistence(owner.id); } };
    await expect(generate()).rejects.toMatchObject({ name: 'XingyePersistenceBindingError' });
  });
  it('invalidates owner X -> Y -> X on the same server before Y finishes loading', async () => {
    const binding = captureXingyePersistenceBinding(owner.id);
    const pending = refreshXingyeAgentPersistence('owner-y');
    await refreshXingyeAgentPersistence(owner.id); await pending;
    expect(() => binding.assertCurrent()).toThrowError(expect.objectContaining({ name: 'XingyePersistenceBindingError' }));
  });
  it('hides A ambient data immediately on B selection, even if A save is unavailable', async () => {
    const storage = getXingyePersistenceStorage()!;
    storage.setItem('xingye.phoneContacts', JSON.stringify({ note: 'A pending only' }));
    failWrite = true; vi.spyOn(console, 'warn').mockImplementation(() => {});
    await switchTo('server-b');
    expect(getXingyePersistenceStorage()).toBeNull();
    expect(storage.getItem('xingye.phoneContacts')).toBeNull();
    expect(files.has(key('server-b', 'phone/contacts.json'))).toBe(false);
    failWrite = false; await flushXingyePersistenceNow();
    expect(files.get(key('server-a', 'phone/contacts.json'))).toEqual({ note: 'A pending only' });
    expect(getXingyePersistenceStorage()?.getItem('xingye.phoneContacts')).toBeNull();
  });
  it('finishes an already-started multi-file save only on A, preserving success after B selection', async () => {
    const binding = captureXingyePersistenceBinding(owner.id);
    binding.storage.setItem('xingye.phoneContacts', JSON.stringify({ note: 'first A' }));
    binding.storage.setItem('xingye.phoneSmsHistoryGenerationState', JSON.stringify({ owner: { ownerAgentId: owner.id, marker: 'second A' } }));
    const gate = deferred(); const entered = deferred();
    afterWrite = async () => { afterWrite = undefined; entered.resolve(); await gate.promise; };
    const saving = binding.commit(); await entered.promise;
    select(connection('server-b')); const switched = refreshXingyeAgentPersistence(owner.id);
    gate.resolve(); await expect(saving).resolves.toBeUndefined(); await switched;
    expect(files.get(key('server-a', coveragePath))).toMatchObject({ owner: { marker: 'second A' } });
    expect([...files.keys()].some(k => k.startsWith('server-b:'))).toBe(false);
    expect(calls.filter(c => c.body.action === 'writeJson').every(c => c.server === 'server-a' && c.auth === 'Bearer synthetic-server-a')).toBe(true);
  });
  it('retains an A SMS receipt after ACK loss during switch and recovers only when A is reloaded', async () => {
    const gate = deferred(); const entered = deferred();
    afterWrite = async call => { if (call.body.relativePath === smsPath) { afterWrite = undefined; entered.resolve(); await gate.promise; throw Error('lost A SMS acknowledgement'); } };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = generate().catch(error => error); await entered.promise;
    select(connection('server-b')); const switched = refreshXingyeAgentPersistence(owner.id); gate.resolve();
    expect(await outcome).toMatchObject({ message: 'lost A SMS acknowledgement' }); await switched;
    expect(files.has(key('server-a', smsPath))).toBe(true);
    expect(files.has(key('server-b', smsPath))).toBe(false);
    await reload('server-b'); const before = calls.filter(c => c.path.includes('phone-generate')).length;
    await generate(); expect(calls.filter(c => c.path.includes('phone-generate'))).toHaveLength(before + 1);
    await reload('server-a'); const beforeA = calls.filter(c => c.path.includes('phone-generate')).length;
    await generate(); expect(calls.filter(c => c.path.includes('phone-generate'))).toHaveLength(beforeA);
    expect(getSmsHistoryGenerationState(owner.id)?.contactsIncluded).toEqual([{ targetType: 'agent', targetId: 'peer-1' }]);
    expect(getSmsThread(owner.id, 'agent', 'peer-1')?.messages).toHaveLength(1);
  });
  it('pins every read in a refresh and refuses to adopt a superseded server snapshot', async () => {
    files.set(key('server-b', 'phone/contacts.json'), { note: 'B contacts' });
    files.set(key('server-c', 'phone/contacts.json'), { note: 'C contacts' });
    const gate = deferred(); const entered = deferred();
    beforeResponse = async call => { if (call.server === 'server-b' && call.body.action === 'readJson') { beforeResponse = undefined; entered.resolve(); await gate.promise; } };
    select(connection('server-b')); const loadingB = refreshXingyeAgentPersistence(owner.id);
    await vi.waitFor(() => expect(calls.some(c => c.server === 'server-b' && c.body.action === 'readJson')).toBe(true));
    await entered.promise;
    await switchTo('server-c'); gate.resolve(); await loadingB;
    expect(getXingyePersistenceStorage()?.getItem('xingye.phoneContacts')).toContain('C contacts');
    expect(calls.filter(c => c.server === 'server-b' && c.body.action === 'readJson')).toHaveLength(14);
  });
  it('preserves completed targets on A if a later 12/1 batch is invalidated', async () => {
    let batches = 0;
    beforeResponse = async call => { if (call.path.includes('phone-generate') && ++batches === 2) { beforeResponse = undefined; await switchTo('server-b'); } };
    await expect(generate(13)).rejects.toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(files.has(key('server-b', smsPath))).toBe(false);
    await reload('server-a'); expect(getSmsHistoryGenerationState(owner.id)?.contactsIncluded).toHaveLength(12);
    await generate(13);
    const last = calls.filter(c => c.path.includes('phone-generate')).at(-1)!;
    expect(last.server).toBe('server-a'); expect(last.body.contacts.map((c: { targetId: string }) => c.targetId)).toEqual(['peer-13']);
    expect(getSmsHistoryGenerationState(owner.id)?.contactsIncluded).toHaveLength(13);
  });

  it('automatically loads B when an earlier store subscriber already observed the connection change', async () => {
    resetXingyePersistenceForTests();
    const early = () => { getXingyePersistenceStorage(); };
    state.listeners.add(early);
    try {
      await refreshXingyeAgentPersistence(owner.id);
      files.set(key('server-b', 'phone/contacts.json'), { note: 'B loaded automatically' });
      select(connection('server-b'));
      await vi.waitFor(() => expect(getXingyePersistenceStorage()?.getItem('xingye.phoneContacts')).toContain('B loaded automatically'));
    } finally { state.listeners.delete(early); }
  });
  it('retains the selected owner through offline failed-flush recovery and automatic reconnect', async () => {
    getXingyePersistenceStorage()!.setItem('xingye.phoneContacts', JSON.stringify({ note: 'offline pending' }));
    failWrite = true; vi.spyOn(console, 'warn').mockImplementation(() => {});
    await switchTo(null);
    expect(getXingyePersistenceStorage()).toBeNull();
    failWrite = false; await flushXingyePersistenceNow();
    select(connection('server-a'));
    await vi.waitFor(() => expect(getXingyePersistenceStorage()?.getItem('xingye.phoneContacts')).toContain('offline pending'));
  });
  it('stops continuity reads after a switch before fetching another contact or model', async () => {
    beforeResponse = async call => {
      if (call.body.action === 'listJsonl') { beforeResponse = undefined; await switchTo('server-b'); }
    };
    await expect(generate(2)).rejects.toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(calls.filter(c => c.body.action === 'listJsonl').map(c => c.server)).toEqual(['server-a']);
    expect(calls.some(c => c.path.includes('phone-generate'))).toBe(false);
  });
  it.each(['baseUrl', 'token', 'studioId', 'userId'] as const)('invalidates the generation when %s changes with the same server ID', async field => {
    const binding = captureXingyePersistenceBinding(owner.id);
    const next = { ...connection('server-a'), [field]: field === 'baseUrl' ? 'https://server-c.invalid' : 'changed-fixture' };
    select(next); await refreshXingyeAgentPersistence(owner.id);
    expect(binding.isCurrent()).toBe(false);
  });

  it('does not invalidate a logical operation for a same-connection same-owner refresh', async () => {
    const binding = captureXingyePersistenceBinding(owner.id);
    await refreshXingyeAgentPersistence(owner.id);
    expect(binding.isCurrent()).toBe(true); await generate();
    expect(getSmsHistoryGenerationState(owner.id)?.contactsIncluded).toHaveLength(1);
  });
});
