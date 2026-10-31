/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import {
  addSmsMessage, getPhoneAiGenerationState, getPhoneContacts,
  getSmsHistoryGenerationState, getSmsThread, getSmsThreads,
  setSmsHistoryGenerationState, type XingyePhoneContactView,
} from './xingye-phone-store';
import { generateSmsHistoryWithAI } from './xingye-phone-ai';
import {
  flushXingyePersistenceNow, refreshXingyeAgentPersistence, resetXingyePersistenceForTests,
} from './xingye-persistence';
import { PhoneSmsApp } from './PhoneSmsApp';

const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(), fetch: vi.fn(), post: vi.fn(), failSmsWrite: false,
}));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: (...args: unknown[]) => state.post(...args) }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: (...args: unknown[]) => state.fetch(...args) }));
vi.mock('../stores', () => ({ useStore: { getState: () => ({ activeServerConnection: { serverId: 'synthetic', baseUrl: 'https://synthetic.invalid', authState: 'paired', trustState: 'local' } }) } }));
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
function seed(targetId: string, content = 'manual') {
  addSmsMessage({ ownerAgentId: owner.id, targetType: 'agent', targetId, content, direction: 'incoming', source: 'mock' });
}
beforeEach(async () => {
  state.files.clear(); state.failSmsWrite = false; state.fetch.mockReset(); state.post.mockReset();
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
afterEach(() => { cleanup(); resetXingyePersistenceForTests(); vi.restoreAllMocks(); });

describe('SMS history target selection and saved coverage', () => {
  it('real fill-empty UI sends the 13th card when the first 12 threads already exist', async () => {
    const agents = [owner, ...Array.from({ length: 13 }, (_, i) => peer(i + 1))];
    const contacts = getPhoneContacts(owner.id, agents, {}, { includeDeleted: true });
    expect(contacts.filter(c => c.targetType !== 'user').map(c => c.targetId)).toEqual(targets(13).map(c => c.targetId));
    targets(12).forEach(c => seed(c.targetId));
    const originals = structuredClone(getSmsThreads(owner.id));
    setSmsHistoryGenerationState(owner.id, { ownerAgentId: owner.id, generatedAt: '2026-01-01T00:00:00.000Z', profileFingerprint: 'seed', contactsIncluded: [], version: 1 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PhoneSmsApp ownerAgent={owner} agents={agents} profiles={{}} onBack={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新生成旧短信（仅空线程）' })); });
    await vi.waitFor(() => expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('success'));
    expect(cards(request()).map(t => t.targetId)).toEqual(['peer-13']);
    expect(request().contacts.map((t: Target) => t.targetId)).toEqual(['peer-13']);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(getSmsThread(owner.id, 'agent', 'peer-13')?.messages.map(m => m.content)).toEqual(['generated']);
    expect(getSmsThreads(owner.id).filter(t => t.targetId !== 'peer-13')).toEqual(originals);
    expect(included()).toEqual(['peer-13']);
  });

  it('bounds 25 empty targets to 12/12/1 full cards and saves each once', async () => {
    await generate(targets(25));
    expect(state.fetch).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map(i => cards(request(i)).length)).toEqual([12, 12, 1]);
    expect([0, 1, 2].flatMap(i => cards(request(i)).map(c => c.targetId))).toEqual(targets(25).map(c => c.targetId));
    expect(getSmsThreads(owner.id)).toHaveLength(25);
    expect(getSmsThreads(owner.id).every(t => t.messages.length === 1)).toBe(true);
    expect(included()).toEqual(targets(25).map(c => c.targetId));
  });

  it('preserves completed batch coverage after later transport failure and retries only empty targets', async () => {
    state.fetch.mockImplementationOnce(async (_url, init) => response(cards(JSON.parse(init.body)))).mockRejectedValueOnce(new Error('second batch failed'));
    await expect(generate(targets(13))).rejects.toThrow('second batch failed');
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
    expect(included()).toEqual(targets(12).map(c => c.targetId));
    await flushXingyePersistenceNow();
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    expect(included()).toEqual(targets(12).map(c => c.targetId));
    state.fetch.mockClear();
    await generate(targets(13));
    expect(cards(request()).map(c => c.targetId)).toEqual(['peer-13']);
    expect(getSmsThreads(owner.id).every(t => t.messages.length === 1)).toBe(true);
    expect(included()).toEqual(targets(13).map(c => c.targetId));
  });

  it('records only returned nonblank targets, reports incomplete generation, and retries the omissions', async () => {
    state.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ result: { contacts: [
      { targetType: 'agent', targetId: 'peer-01', messages: [{ from: 'owner', content: 'saved' }] },
      { targetType: 'agent', targetId: 'peer-02', messages: [{ from: 'owner', content: '   ' }] },
    ] } }) } as Response);
    await expect(generate(targets(3))).rejects.toThrow();
    expect(included()).toEqual(['peer-01']);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
    state.fetch.mockClear();
    await generate(targets(3));
    expect(cards(request()).map(c => c.targetId)).toEqual(['peer-02', 'peer-03']);
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages.map(m => m.content)).toEqual(['saved']);
    expect(included()).toEqual(['peer-01', 'peer-02', 'peer-03']);
  });

  it('does not accept batch-external, unknown, user, or wrongly typed targets', async () => {
    state.fetch.mockImplementationOnce(async (_url, init) => {
      const shown = cards(JSON.parse(init.body));
      return { ok: true, json: async () => ({ result: { contacts: [
        ...shown.map(t => ({ ...t, messages: [{ from: 'owner', content: 'shown' }] })),
        ...[
          { targetType: 'agent', targetId: 'peer-13' }, { targetType: 'agent', targetId: 'unknown' },
          { targetType: 'user', targetId: '__user__' }, { targetType: 'virtual_contact', targetId: 'peer-01' },
        ].map(t => ({ ...t, messages: [{ from: 'owner', content: 'injected' }] })),
      ] } }) } as Response;
    });
    await generate(targets(13));
    expect(getSmsThreads(owner.id)).toHaveLength(13);
    expect(getSmsThreads(owner.id).flatMap(t => t.messages).some(m => m.content === 'injected')).toBe(false);
    expect(cards(request(1)).map(c => c.targetId)).toEqual(['peer-13']);
  });

  it.each([{ contacts: [] }, { contacts: targets(3) }])('does not request or fabricate success when there are no empty targets: %j', async ({ contacts }) => {
    contacts.forEach(c => seed(c.targetId));
    await generate(contacts);
    expect(state.fetch).not.toHaveBeenCalled();
    expect(getSmsHistoryGenerationState(owner.id)).toBeNull();
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).not.toBe('success');
  });

  it('does not claim coverage or success for an empty allowed blocked/deleted result', async () => {
    const contacts = targets(2).map((c, i) => ({ ...c, status: i ? 'deleted' as const : 'blocked' as const }));
    state.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ result: { contacts: contacts.map(c => ({ targetType: c.targetType, targetId: c.targetId, messages: [] })) } }) } as Response);
    await expect(generate(contacts)).rejects.toThrow();
    expect(included()).toEqual([]);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
    expect(request().prompt).toContain('0–3 条');
  });

  it('retains an in-flight manual thread and excludes it from generated coverage', async () => {
    state.fetch.mockImplementationOnce(async (_url, init) => { seed('peer-01', 'arrived during request'); return response(cards(JSON.parse(init.body))); });
    await expect(generate(targets(1))).rejects.toThrow();
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages.map(m => m.content)).toEqual(['arrived during request']);
    expect(included()).toEqual([]);
  });

  it('a failed durable SMS write cannot produce success metadata', async () => {
    state.failSmsWrite = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(generate(targets(1))).rejects.toThrow('synthetic sms save failed');
    expect(included()).toEqual([]);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('failed');
    expect(state.files.has('owner:phone/sms-history-generation-state.json')).toBe(false);
    state.failSmsWrite = false;
    await generate(targets(1));
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(getPhoneAiGenerationState(owner.id, 'sms_history')?.status).toBe('success');
    expect(included()).toEqual(['peer-01']);
    resetXingyePersistenceForTests(); await refreshXingyeAgentPersistence(owner.id);
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages.map(m => m.content)).toEqual(['generated']);
    expect(included()).toEqual(['peer-01']);
    warn.mockRestore();
  });

  it.each([false, true])('rejects a late first batch after owner switch, including A→B→A=%s', async returnToA => {
    state.fetch.mockImplementationOnce(async (_url, init) => {
      await refreshXingyeAgentPersistence('other');
      if (returnToA) await refreshXingyeAgentPersistence(owner.id);
      return response(cards(JSON.parse(init.body)));
    });
    await expect(generate(targets(13))).rejects.toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(getSmsThreads(owner.id)).toEqual([]);
  });

  it('retains the saved first batch but rejects the second batch after A→B→A', async () => {
    let resolve!: (value: Response) => void;
    state.fetch.mockImplementationOnce(async (_url, init) => response(cards(JSON.parse(init.body))))
      .mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const operation = generate(targets(13));
    const settled = operation.catch(error => error);
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(2));
    expect(included()).toEqual(targets(12).map(c => c.targetId));
    await refreshXingyeAgentPersistence('other'); await refreshXingyeAgentPersistence(owner.id);
    resolve(response([{ targetType: 'agent', targetId: 'peer-13' }]));
    expect(await settled).toMatchObject({ name: 'XingyePersistenceBindingError' });
    expect(getSmsThreads(owner.id)).toHaveLength(12);
    expect(getSmsThread(owner.id, 'agent', 'peer-13')).toBeNull();
    expect(included()).toEqual(targets(12).map(c => c.targetId));
  });

  it('drops old claimed coverage backed only by manual messages when adding a real result', async () => {
    seed('peer-01');
    setSmsHistoryGenerationState(owner.id, { ownerAgentId: owner.id, generatedAt: '2026-01-01T00:00:00.000Z', profileFingerprint: 'old', contactsIncluded: [{ targetType: 'agent', targetId: 'peer-01' }], version: 1 });
    await generate(targets(2));
    expect(included()).toEqual(['peer-02']);
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages.map(m => m.content)).toEqual(['manual']);
  });

  it('replace_ai keeps the 12-card batch bound and the existing 10-message cap', async () => {
    seed('peer-01');
    state.fetch.mockImplementation(async (_url, init) => ({ ok: true, json: async () => ({ result: { contacts: cards(JSON.parse(init.body)).map(c => ({ ...c, messages: Array.from({ length: 15 }, (_, i) => ({ from: 'owner', content: `new-${i}` })) })) } }) } as Response));
    await generate(targets(13), 'replace_ai');
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(getSmsThread(owner.id, 'agent', 'peer-01')?.messages).toHaveLength(11);
    expect(getSmsThread(owner.id, 'agent', 'peer-13')?.messages).toHaveLength(10);
  });
});
