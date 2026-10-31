/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import {
  addSmsMessage, getPhoneAiGenerationState,
  getSmsHistoryGenerationState, getSmsThread, getSmsThreads,
  appendContactChangeLogItem, type XingyePhoneContactView,
} from './xingye-phone-store';
import { generateSmsHistoryWithAI, generateSmsUpdatesForChangedContactsWithAI } from './xingye-phone-ai';
import {
  flushXingyePersistenceNow, refreshXingyeAgentPersistence, resetXingyePersistenceForTests,
} from './xingye-persistence';
import { confirmSmsDraft } from './xingye-sms-drafts';

const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(), fetch: vi.fn(), post: vi.fn(), failSmsWrite: false, connected: true,
}));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: (...args: unknown[]) => state.post(...args) }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: (...args: unknown[]) => state.fetch(...args) }));
vi.mock('../stores', () => ({ useStore: { getState: () => ({ activeServerConnection: state.connected ? { serverId: 'synthetic', baseUrl: 'https://synthetic.invalid', authState: 'paired', trustState: 'local' } : null }) } }));
vi.mock('./xingye-event-log', () => ({ appendXingyeEvent: vi.fn(async () => ({})), appendXingyeEventOnce: vi.fn(async () => ({})) }));
vi.mock('./xingye-speaker-context', async importOriginal => ({
  ...await importOriginal<typeof import('./xingye-speaker-context')>(), resolveXingyeSpeakerUserName: async () => 'User',
}));
vi.mock('./xingye-profile-store', () => ({ useXingyeRoleProfile: () => null, readXingyeRoleProfile: async () => null }));
vi.mock('./XingyeAgentAvatar', () => ({ XingyeAgentAvatar: () => null }));

const owner: Agent = { id: 'owner', name: 'Owner', yuan: 'hanako', isPrimary: false };
const peer = (i: number): Agent => ({ ...owner, id: `peer-${String(i).padStart(2, '0')}`, name: `C${String(i).padStart(2, '0')}` });
const targets = (count: number) => Array.from({ length: count }, (_, i) => ({
  ownerAgentId: owner.id, targetType: 'agent', targetId: peer(i + 1).id,
  displayName: peer(i + 1).name, originalName: peer(i + 1).name, remark: `card-${i + 1}`,
  impression: `profile-${i + 1}`, tags: [], status: 'active',
} as XingyePhoneContactView));
type Target = { targetType: string; targetId: string };
function cards(body: { prompt: string }): Target[] {
  const json = body.prompt.split('联系人列表:\n')[1];
  return JSON.parse(json.slice(0, json.indexOf('\n]') + 2));
}
function request(index = 0) { return JSON.parse(state.fetch.mock.calls[index][1].body); }
function response(contacts: Target[], content = 'generated') {
  return { ok: true, json: async () => ({ result: { contacts: contacts.map(t => ({ ...t, messages: [{ from: 'owner', content }] })) } }) } as Response;
}
function generate(contacts: XingyePhoneContactView[], mode: 'empty_only' | 'replace_ai' = 'empty_only') {
  return generateSmsHistoryWithAI({ ownerAgent: owner, ownerProfile: null, contacts, profileFingerprint: 'fixture', mode });
}
function included() { return getSmsHistoryGenerationState(owner.id)?.contactsIncluded.map(t => t.targetId) ?? []; }
beforeEach(async () => {
  state.files.clear(); state.failSmsWrite = false; state.connected = true; state.fetch.mockReset(); state.post.mockReset();
  resetXingyePersistenceForTests();
  state.post.mockImplementation(async (body: Record<string, unknown>) => {
    const key = `${body.agentId}:${body.relativePath}`;
    if (body.action === 'readJson') return { data: structuredClone(state.files.get(key) ?? null) };
    if (body.action === 'writeJson') {
      if (body.relativePath === 'phone/sms-threads.json' && state.failSmsWrite) throw new Error('synthetic sms save failed');
      state.files.set(key, structuredClone(body.data)); return { ok: true };
    }
    if (body.action === 'listJsonl') return { records: [] };
    return { ok: true };
  });
  state.fetch.mockImplementation(async (_url, init) => response(cards(JSON.parse(init.body))));
  await refreshXingyeAgentPersistence(owner.id);
});
afterEach(() => { resetXingyePersistenceForTests(); vi.restoreAllMocks(); });

async function incremental(targetId: string) {
  appendContactChangeLogItem({ ownerAgentId: owner.id, targetType: 'agent', targetId, action: 'update', changedFields: ['remark'], reason: 'independent change', source: 'manual_edit' });
  state.fetch.mockImplementationOnce(async (_url, init) => response(JSON.parse(init.body).contacts, 'incremental-only'));
  const result = await generateSmsUpdatesForChangedContactsWithAI({ ownerAgent: owner, ownerProfile: null, contacts: targets(2), agents: [owner, peer(1), peer(2)], profiles: {} });
  expect(result).toMatchObject({ ok: true, appended: 1 });
  await flushXingyePersistenceNow();
}

describe('Independent SMS01 fault and identity probes', () => {
  it('does not adopt a prior unrelated incremental SMS as successful historical generation after model failure', async () => {
    await incremental('peer-01');
    expect(getSmsHistoryGenerationState(owner.id)).toBeNull();
    state.fetch.mockRejectedValueOnce(new Error('history transport failed'));
    await expect(generate(targets(2))).rejects.toThrow('history transport failed');
    expect(included()).toEqual([]);
    await flushXingyePersistenceNow();
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    state.fetch.mockClear();
    await generate(targets(2));
    expect(cards(request()).map(t => t.targetId)).toEqual(['peer-02']);
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages.map(m => m.content)).toEqual(['incremental-only']);
    // Cumulative historical coverage may keep previous history receipts, but this
    // contact has never had a historical-generation request or receipt at all.
    expect(included()).toEqual(['peer-02']);
  });

  it('does not turn a failed historical operation into success using only a later unrelated incremental SMS', async () => {
    state.fetch.mockRejectedValueOnce(new Error('history failed before generating anything'));
    await expect(generate(targets(1))).rejects.toThrow();
    await incremental('peer-01');
    expect(included()).toEqual([]);
    state.fetch.mockClear();
    await generate(targets(1));
    expect(state.fetch).not.toHaveBeenCalled();
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages.map(m => m.content)).toEqual(['incremental-only']);
    expect.soft(included()).toEqual([]);
    expect.soft(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).not.toBe('success');
  });

  it('keeps distinct IDs and types despite identical display names, rejects user input and duplicate returned targets', async () => {
    const contacts = [...targets(2).map(c => ({ ...c, displayName: 'Same name' })), { ...targets(1)[0], targetType: 'virtual_contact' as const, displayName: 'Same name' }, { ...targets(1)[0], targetType: 'user' as const, targetId: '__user__' }];
    state.fetch.mockImplementationOnce(async (_url, init) => {
      const shown = cards(JSON.parse(init.body));
      return { ok: true, json: async () => ({ result: { contacts: [...shown, shown[0]].map(t => ({ ...t, messages: [{ from: 'owner', content: t.targetType + ':' + t.targetId }] })) } }) } as Response;
    });
    await generate(contacts);
    expect(cards(request()).map(t => t.targetType + ':' + t.targetId)).toEqual(['agent:peer-01','agent:peer-02','virtual_contact:peer-01']);
    expect(getSmsThreads(owner.id)).toHaveLength(3);
    expect(getSmsThreads(owner.id).every(t => t.messages.length === 1)).toBe(true);
    expect(getSmsHistoryGenerationState(owner.id)?.contactsIncluded).toHaveLength(3);
  });

  it('recovers a persisted SMS whose write acknowledgement was lost without generating or saving a duplicate', async () => {
    const original = state.post.getMockImplementation()!;
    let lose = true;
    state.post.mockImplementation(async (body: Record<string, unknown>) => {
      const result = await original(body);
      if (lose && body.action === 'writeJson' && body.relativePath === 'phone/sms-threads.json') { lose=false; throw new Error('ACK lost after write'); }
      return result;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(generate(targets(1))).rejects.toThrow('ACK lost after write');
    expect(state.files.has('owner:phone/sms-threads.json')).toBe(true);
    expect(included()).toEqual([]);
    await generate(targets(1));
    expect(state.fetch).toHaveBeenCalledTimes(1);
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    expect(getSmsThread(owner.id,'agent','peer-01')?.messages.map(m => m.content)).toEqual(['generated']);
    expect(included()).toEqual(['peer-01']);
    warn.mockRestore();
  });

  it('recovers the single remaining target after a later per-target save failure and restart', async () => {
    const original = state.post.getMockImplementation()!;
    let failSecondTarget = true;
    state.post.mockImplementation(async (body: Record<string, unknown>) => {
      if (failSecondTarget && body.action === 'writeJson' && body.relativePath === 'phone/sms-threads.json' && JSON.stringify(body.data).includes('peer-02')) { failSecondTarget=false; throw new Error('second target save failed'); }
      return original(body);
    });
    const warn = vi.spyOn(console,'warn').mockImplementation(() => {});
    await expect(generate(targets(3))).rejects.toThrow('second target save failed');
    expect(included()).toEqual(['peer-01']);
    expect(getSmsThread(owner.id,'agent','peer-02')?.messages).toHaveLength(1);
    expect(JSON.stringify(state.files.get('owner:phone/sms-threads.json'))).not.toContain('peer-02');
    await flushXingyePersistenceNow();
    expect(JSON.stringify(state.files.get('owner:phone/sms-threads.json'))).toContain('peer-02');
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    state.fetch.mockClear();
    await generate(targets(3));
    expect(cards(request()).map(t => t.targetId)).toEqual(['peer-03']);
    expect(getSmsThreads(owner.id).every(t => t.messages.length === 1)).toBe(true);
    expect(included()).toEqual(['peer-01','peer-02','peer-03']);
    warn.mockRestore();
  });

  it('does not regenerate messages when the coverage save fails after SMS was durably saved', async () => {
    const original = state.post.getMockImplementation()!;
    let fail = true;
    state.post.mockImplementation(async (body: Record<string, unknown>) => {
      if (fail && body.action === 'writeJson' && body.relativePath === 'phone/sms-history-generation-state.json') { fail=false; throw new Error('coverage save failed'); }
      return original(body);
    });
    const warn = vi.spyOn(console,'warn').mockImplementation(() => {});
    await expect(generate(targets(1))).rejects.toThrow('coverage save failed');
    expect(state.files.has('owner:phone/sms-threads.json')).toBe(true);
    await generate(targets(1));
    expect(state.fetch).toHaveBeenCalledTimes(1);
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    expect(included()).toEqual(['peer-01']);
    expect(getSmsThread(owner.id,'agent','peer-01')?.messages).toHaveLength(1);
    warn.mockRestore();
  });
});


describe('Independent confirmed-draft provenance', () => {
  it('does not adopt a confirmed draft as completed historical generation during failed-state recovery', async () => {
    state.fetch.mockRejectedValueOnce(new Error('history never generated'));
    await expect(generate(targets(1))).rejects.toThrow('history never generated');
    const original = state.post.getMockImplementation()!;
    const draft = { id: 'independent-draft', targetType: 'agent', targetId: 'peer-01', content: 'draft-only', source: 'synthetic', createdAt: '2026-10-31T01:00:00.000Z' };
    state.post.mockImplementation(async (body: Record<string, unknown>) => {
      if (body.action === 'listJsonl' && body.relativePath === 'apps/sms/drafts.jsonl') return { records: [draft] };
      return original(body);
    });
    await expect(confirmSmsDraft(owner.id, draft.id)).resolves.toMatchObject({ targetId: 'peer-01' });
    expect(getSmsThread(owner.id,'agent','peer-01')?.messages).toMatchObject([{ content: 'draft-only', source: 'ai_generated' }]);
    expect(included()).toEqual([]);
    state.fetch.mockClear();
    await generate(targets(1));
    expect(state.fetch).not.toHaveBeenCalled();
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    expect(getSmsThread(owner.id,'agent','peer-01')?.messages).toMatchObject([{ content: 'draft-only', source: 'ai_generated' }]);
    expect.soft(included()).toEqual([]);
    expect.soft(getPhoneAiGenerationState(owner.id,'sms_history')?.status).not.toBe('success');
  });
});


describe('Historical SMS operation provenance controls', () => {
  it('keeps unknown legacy AI messages unchanged and unclaimed after a failed request', async () => {
    state.fetch.mockRejectedValueOnce(new Error('no history output'));
    await expect(generate(targets(1))).rejects.toThrow('no history output');
    addSmsMessage({ ownerAgentId: owner.id, targetType: 'agent', targetId: 'peer-01', content: 'unknown legacy origin', direction: 'incoming', source: 'ai_generated', messageId: 'sms-message-legacy' });
    const original = structuredClone(getSmsThread(owner.id, 'agent', 'peer-01'));
    await flushXingyePersistenceNow();
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    state.fetch.mockClear();
    await generate(targets(1));
    expect(state.fetch).not.toHaveBeenCalled();
    expect(getSmsThread(owner.id, 'agent', 'peer-01')).toEqual(original);
    expect(included()).toEqual([]);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
  });

  it('confirms the same historical messages after a lost ACK and reload without a second model call', async () => {
    const original = state.post.getMockImplementation()!;
    let lose = true;
    state.post.mockImplementation(async (body: Record<string, unknown>) => {
      const result = await original(body);
      if (lose && body.action === 'writeJson' && body.relativePath === 'phone/sms-threads.json') { lose = false; throw new Error('lost SMS ACK'); }
      return result;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(generate(targets(1))).rejects.toThrow('lost SMS ACK');
    const originalMessages = structuredClone(getSmsThread(owner.id, 'agent', 'peer-01')?.messages);
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    expect(included()).toEqual([]);
    await generate(targets(1));
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages).toEqual(originalMessages);
    expect(included()).toEqual(['peer-01']);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('success');
  });

  it('does not adopt an incremental operation that fills the target while history is in flight', async () => {
    let resolve!: (value: Response) => void;
    state.fetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const pending = generate(targets(1));
    const settled = pending.catch(error => error);
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(1));
    await incremental('peer-01');
    resolve(response([{ targetType: 'agent', targetId: 'peer-01' }], 'late history'));
    expect(await settled).toBeInstanceOf(Error);
    await generate(targets(1));
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages.map(m => m.content)).toEqual(['incremental-only']);
    expect(included()).toEqual([]);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps another completed historical operation without duplicating its messages', async () => {
    let resolve!: (value: Response) => void;
    state.fetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const pending = generate(targets(1));
    const settled = pending.catch(error => error);
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(1));
    await generate(targets(1));
    const saved = structuredClone(getSmsThread(owner.id, 'agent', 'peer-01')?.messages);
    resolve(response([{ targetType: 'agent', targetId: 'peer-01' }], 'late history'));
    expect(await settled).toBeInstanceOf(Error);
    await generate(targets(1));
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages).toEqual(saved);
    expect(included()).toEqual(['peer-01']);
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
  });

  it('does not manufacture history receipts for an empty response', async () => {
    state.fetch.mockResolvedValueOnce(response([]));
    await expect(generate(targets(1))).rejects.toThrow();
    expect(getSmsThreads(owner.id)).toEqual([]);
    expect(included()).toEqual([]);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
    await generate(targets(1));
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(included()).toEqual(['peer-01']);
  });

  it('does not persist output after transport cancellation', async () => {
    state.fetch.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(generate(targets(1))).rejects.toMatchObject({ name: 'AbortError' });
    expect(getSmsThreads(owner.id)).toEqual([]);
    expect(included()).toEqual([]);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
  });

  it('rejects a late response after disconnect and reconnect to the same owner', async () => {
    state.fetch.mockImplementationOnce(async (_url, init) => {
      state.connected = false; await refreshXingyeAgentPersistence(owner.id);
      state.connected = true; await refreshXingyeAgentPersistence(owner.id);
      return response(cards(JSON.parse(init.body)));
    });
    await expect(generate(targets(1))).rejects.toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(getSmsThreads(owner.id)).toEqual([]);
    expect(included()).toEqual([]);
  });
});


describe('Historical SMS cumulative receipts', () => {
  it('merges confirmed targets when separate historical operations finish out of order', async () => {
    let resolve!: (value: Response) => void;
    state.fetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const pending = generate(targets(1));
    const settled = pending.catch(error => error);
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(1));
    await generate(targets(2).slice(1));
    expect(included()).toEqual(['peer-02']);
    resolve(response([{ targetType: 'agent', targetId: 'peer-01' }]));
    await settled;
    expect(included().sort()).toEqual(['peer-01', 'peer-02']);
    expect(getSmsThreads(owner.id)).toHaveLength(2);
    expect(getSmsThreads(owner.id).every(t => t.messages.length === 1)).toBe(true);
  });

  it('does not turn a failed new target into success using an already-confirmed historical receipt', async () => {
    await generate(targets(1));
    state.fetch.mockRejectedValueOnce(new Error('new target history failed'));
    await expect(generate(targets(2))).rejects.toThrow('new target history failed');
    await incremental('peer-02');
    state.fetch.mockClear();
    await generate(targets(2));
    expect(state.fetch).not.toHaveBeenCalled();
    expect(included()).toEqual(['peer-01']);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
  });
});


describe('Historical SMS receipt target binding', () => {
  it.each([
    { targetType: 'agent' as const, targetId: 'peer-02' },
    { targetType: 'virtual_contact' as const, targetId: 'peer-01' },
  ])('does not adopt a historical message ID copied into a different thread: %j', async target => {
    await generate(targets(1));
    const messageId = getSmsThread(owner.id, 'agent', 'peer-01')!.messages[0].id;
    const contact = { ...targets(1)[0], ...target };
    state.fetch.mockRejectedValueOnce(new Error('different target failed'));
    await expect(generate([contact])).rejects.toThrow('different target failed');
    addSmsMessage({ ownerAgentId: owner.id, ...target, content: 'copied id, unknown origin', direction: 'incoming', source: 'ai_generated', messageId });
    const original = structuredClone(getSmsThread(owner.id, target.targetType, target.targetId));
    state.fetch.mockClear();
    await generate([contact]);
    expect(state.fetch).not.toHaveBeenCalled();
    expect(getSmsThread(owner.id, target.targetType, target.targetId)).toEqual(original);
    expect(included()).toEqual(['peer-01']);
    expect(getSmsHistoryGenerationState(owner.id)?.contactsIncluded).toEqual([{ targetType: 'agent', targetId: 'peer-01' }]);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
  });
});


describe('Historical SMS repeated receipt failure', () => {
  it('keeps the same operation recoverable when coverage acknowledgement fails repeatedly', async () => {
    const original = state.post.getMockImplementation()!;
    let failures = 2;
    state.post.mockImplementation(async (body: Record<string, unknown>) => {
      if (body.action === 'writeJson' && body.relativePath === 'phone/sms-history-generation-state.json' && failures-- > 0) throw new Error('repeated coverage failure');
      return original(body);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(generate(targets(1))).rejects.toThrow('repeated coverage failure');
    const startedAt = getPhoneAiGenerationState(owner.id, 'sms_history')?.startedAt;
    const originalMessages = structuredClone(getSmsThread(owner.id, 'agent', 'peer-01')?.messages);
    await expect(generate(targets(1))).rejects.toThrow('repeated coverage failure');
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.startedAt).toBe(startedAt);
    await generate(targets(1));
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('success');
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    expect(included()).toEqual(['peer-01']);
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages).toEqual(originalMessages);
  });
});
