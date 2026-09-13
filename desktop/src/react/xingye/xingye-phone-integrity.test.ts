/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getContactProfile, getSmsThreads } from './xingye-phone-store';
import { confirmSmsDraft, XINGYE_SMS_DRAFTS_JSONL } from './xingye-sms-drafts';
import { generateSmsHistoryWithAI } from './xingye-phone-ai';
import { ensureContactProfileInitializedWithAI } from './xingye-contact-profile-ai';
import { refreshXingyeAgentPersistence, resetXingyePersistenceForTests, flushXingyePersistenceNow, getXingyePersistenceStorage } from './xingye-persistence';
import type { Agent } from '../types';
import type { XingyePhoneContactView } from './xingye-phone-store';

const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(), drafts: [] as any[], post: vi.fn(), fetch: vi.fn(), failSmsWrite: false,
}));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: (...args: unknown[]) => state.post(...args) }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: (...args: unknown[]) => state.fetch(...args) }));
vi.mock('../stores', () => ({ useStore: { getState: () => ({ activeServerConnection: { serverId: 'local', baseUrl: 'http://localhost', authState: 'paired', trustState: 'local' } }) } }));
vi.mock('./xingye-event-log', () => ({ appendXingyeEvent: vi.fn(async () => ({})), appendXingyeEventOnce: vi.fn(async () => ({})) }));
vi.mock('./xingye-speaker-context', async importOriginal => ({
  ...await importOriginal<typeof import('./xingye-speaker-context')>(), resolveXingyeSpeakerUserName: async () => 'User',
}));
vi.mock('./xingye-recent-context', () => ({ collectRecentContextForAgent: () => ({ agentId: 'a', messages: [], summaryText: '', sourceNotes: [] }) }));
vi.mock('./xingye-profile-store', () => ({ readXingyeRoleProfile: async () => null }));
vi.mock('./xingye-mail-store', () => ({ listMailMessages: async () => [] }));

const owner: Agent = { id: 'a', name: 'A', yuan: 'hanako', isPrimary: false };
const contact = { ownerAgentId: 'a', targetType: 'agent', targetId: 'peer', displayName: 'Peer', originalName: 'Peer', remark: 'Peer', impression: '', tags: [], status: 'active', kind: 'friend' } as XingyePhoneContactView;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { resolve, promise };
}
beforeEach(async () => {
  state.files.clear(); state.drafts = []; state.failSmsWrite = false;
  state.fetch.mockReset(); state.post.mockReset();
  resetXingyePersistenceForTests();
  state.post.mockImplementation(async (body: Record<string, any>) => {
    const key = `${body.agentId}:${body.relativePath}`;
    if (body.action === 'readJson') return { data: state.files.get(key) ?? null };
    if (body.action === 'writeJson') {
      if (body.relativePath === 'phone/sms-threads.json' && state.failSmsWrite) throw new Error('sms commit failed');
      state.files.set(key, structuredClone(body.data)); return { ok: true };
    }
    if (body.action === 'listJsonl') return { records: structuredClone(state.drafts) };
    if (body.action === 'deleteJsonlRecord') { state.drafts = state.drafts.filter(row => row.id !== body.recordId); return { deleted: true }; }
    return { ok: true };
  });
  await refreshXingyeAgentPersistence('a');
});
afterEach(() => resetXingyePersistenceForTests());

describe('X4 SMS confirmation durability', () => {
  it('retains a draft on failed commit; retry and fresh reload yield exactly one message', async () => {
    state.drafts = [{ id: 'draft', targetType: 'agent', targetId: 'peer', content: 'hello', source: 'test', createdAt: new Date().toISOString() }];
    state.failSmsWrite = true;
    await expect(confirmSmsDraft('a', 'draft')).rejects.toThrow('sms commit failed');
    expect(state.drafts).toHaveLength(1);
    expect(state.post.mock.calls.some(([body]) => body.action === 'deleteJsonlRecord')).toBe(false);
    state.failSmsWrite = false;
    await confirmSmsDraft('a', 'draft');
    expect(state.drafts).toHaveLength(0);
    resetXingyePersistenceForTests();
    await refreshXingyeAgentPersistence('a');
    expect(getSmsThreads('a')[0].messages.map(row => row.id)).toEqual(['from-draft-draft']);
    await confirmSmsDraft('a', 'draft');
    expect(getSmsThreads('a')[0].messages).toHaveLength(1);
  });
});

describe('X5 logical operation owner binding', () => {
  it.each([false, true])('late SMS generation is cancelled after switch, return to A=%s', async (returnToA) => {
    const response = deferred<Response>(); state.fetch.mockReturnValue(response.promise);
    const operation = generateSmsHistoryWithAI({ ownerAgent: owner, ownerProfile: null, contacts: [contact], profileFingerprint: 'test' });
    const settled = operation.then(() => null, error => error);
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledOnce()).catch(async () => { throw await settled; });
    await refreshXingyeAgentPersistence('b');
    if (returnToA) await refreshXingyeAgentPersistence('a');
    response.resolve({ ok: true, json: async () => ({ result: { contacts: [{ targetType: 'agent', targetId: 'peer', messages: [{ from: 'owner', content: 'late A' }] }] } }) } as Response);
    expect(await settled).toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(getSmsThreads('a')).toHaveLength(0);
    expect(getXingyePersistenceStorage()?.getItem('xingye.phoneSmsThreads')).toBeNull();
    await flushXingyePersistenceNow();
    expect(state.files.get('b:phone/sms-threads.json')).toBeUndefined();
  });

  it('late contact initialization cannot write into B', async () => {
    const response = deferred<Response>(); state.fetch.mockReturnValue(response.promise);
    const operation = ensureContactProfileInitializedWithAI({ ownerAgent: owner, ownerProfile: null, contact });
    const settled = operation.then(() => null, error => error);
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledOnce());
    await refreshXingyeAgentPersistence('b');
    response.resolve({ ok: true, json: async () => ({ result: { signature: 'late A', accountId: 'peer' } }) } as Response);
    expect(await settled).toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(getContactProfile('a', 'agent', 'peer')).toBeNull();
    expect(getXingyePersistenceStorage()?.getItem('xingye.phoneContactProfiles')).toBeNull();
  });

  it('confirmation waiting for a draft read cannot adopt B storage or delete the draft', async () => {
    const read = deferred<any>();
    state.post.mockImplementationOnce(() => read.promise);
    const operation = confirmSmsDraft('a', 'draft');
    const settled = operation.then(() => null, error => error);
    await vi.waitFor(() => expect(state.post).toHaveBeenCalledWith(expect.objectContaining({ action: 'listJsonl', relativePath: XINGYE_SMS_DRAFTS_JSONL })));
    await refreshXingyeAgentPersistence('b');
    read.resolve({ records: [{ id: 'draft', targetType: 'agent', targetId: 'peer', content: 'hello', source: 'test', createdAt: new Date().toISOString() }] });
    expect(await settled).toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(getXingyePersistenceStorage()?.getItem('xingye.phoneSmsThreads')).toBeNull();
    expect(state.post.mock.calls.some(([body]) => body.action === 'deleteJsonlRecord')).toBe(false);
  });
});
