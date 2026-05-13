import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const appendEventOnceMock = vi.hoisted(() => vi.fn(async () => ({ id: 'event-1' })));

vi.mock('./xingye-event-log', () => ({
  appendXingyeEventOnce: appendEventOnceMock,
}));

import {
  XINGYE_PHONE_CONTACTS_STORAGE_KEY,
  XINGYE_PHONE_CONTACT_CHANGE_LOG_STORAGE_KEY,
  XINGYE_PHONE_CONTACT_GENERATION_STATE_STORAGE_KEY,
  XINGYE_PHONE_SMS_THREADS_STORAGE_KEY,
  XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY,
  addMockSmsMessage,
  addSmsMessage,
  applyAiContactUpdates,
  applyAiGeneratedContacts,
  clearAiSmsHistory,
  ensureContactDistribution,
  ensureGeneratedVirtualContacts,
  getPhoneContactMeta,
  getPhoneContacts,
  getUnconsumedContactChangesForSms,
  getVirtualContacts,
  shouldSkipFamilyContacts,
  getSmsThread,
  getSmsThreads,
  phoneCompositeMapKey,
  savePhoneContactMeta,
  type XingyeAiGeneratedContact,
} from './xingye-phone-store';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const agents: Agent[] = [
  { id: 'hanako', name: 'Hanako', yuan: 'hanako', isPrimary: true },
  { id: 'test_01', name: 'test_01', yuan: 'test_01', isPrimary: false },
  { id: 'anzu', name: 'Anzu', yuan: 'anzu', isPrimary: false },
];

describe('xingye-phone-store', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    vi.useRealTimers();
    storage = new MemoryStorage();
    appendEventOnceMock.mockReset();
  });

  it('stores contact remark/impression by ownerAgentId + targetType + targetId', () => {
    savePhoneContactMeta('hanako', 'agent', 'test_01', {
      remark: '小测试',
      impression: '有点冒失，但很真诚。',
      source: 'manual',
    }, storage);
    savePhoneContactMeta('test_01', 'agent', 'hanako', {
      remark: '花子同学',
      impression: '看起来温柔，但不太好接近。',
      source: 'manual',
    }, storage);

    expect(getPhoneContactMeta('hanako', 'agent', 'test_01', storage)).toMatchObject({
      ownerAgentId: 'hanako',
      targetType: 'agent',
      targetId: 'test_01',
      remark: '小测试',
      impression: '有点冒失，但很真诚。',
      source: 'manual',
    });
    expect(getPhoneContactMeta('test_01', 'agent', 'hanako', storage)).toMatchObject({
      ownerAgentId: 'test_01',
      targetType: 'agent',
      targetId: 'hanako',
      remark: '花子同学',
      impression: '看起来温柔，但不太好接近。',
      source: 'manual',
    });
    expect(storage.getItem(XINGYE_PHONE_CONTACTS_STORAGE_KEY)).toContain('小测试');
  });

  it('falls back to xingye display name and default impression', () => {
    const contacts = getPhoneContacts('hanako', agents, {
      test_01: {
        agentId: 'test_01',
        displayName: '测试一号',
        updatedAt: '2026-05-11T00:00:00.000Z',
      },
    }, storage);

    const user = contacts.find(item => item.targetType === 'user');
    const anzu = contacts.find(item => item.targetType === 'agent' && item.targetId === 'anzu');
    const test01 = contacts.find(item => item.targetType === 'agent' && item.targetId === 'test_01');

    expect(user?.remark).toBe('你');
    expect(anzu).toMatchObject({
      targetType: 'agent',
      targetId: 'anzu',
      remark: 'Anzu',
      impression: '还没有形成明确印象。',
    });
    expect(test01).toMatchObject({
      targetType: 'agent',
      targetId: 'test_01',
      displayName: '测试一号',
      remark: '测试一号',
      impression: '还没有形成明确印象。',
    });
  });

  it('creates sms threads and messages with direction + source', () => {
    vi.setSystemTime(new Date('2026-05-11T01:00:00.000Z'));
    const first = addMockSmsMessage('hanako', 'agent', 'test_01', '今晚到吗？', 'outgoing', storage);
    vi.setSystemTime(new Date('2026-05-11T01:05:00.000Z'));
    const second = addMockSmsMessage('hanako', 'agent', 'test_01', '马上到。', 'incoming', storage);

    expect(first?.messages[0]).toMatchObject({
      fromAgentId: 'hanako',
      toAgentId: 'test_01',
      content: '今晚到吗？',
      source: 'mock',
    });
    expect(second?.messages[1]).toMatchObject({
      fromAgentId: 'test_01',
      toAgentId: 'hanako',
      content: '马上到。',
      source: 'mock',
    });
    expect(getSmsThread('hanako', 'agent', 'test_01', storage)?.messages).toHaveLength(2);
    expect(getSmsThreads('hanako', undefined, storage)[0]?.targetId).toBe('test_01');
    expect(storage.getItem(XINGYE_PHONE_SMS_THREADS_STORAGE_KEY)).toContain('今晚到吗');
  });

  it('generates virtual contacts once and skips unreasonable family contacts', () => {
    const generated = ensureGeneratedVirtualContacts(
      'hanako',
      agents[0],
      {
        agentId: 'hanako',
        shortBio: '父母双亡，边境医生，冷静克制，行动派',
        updatedAt: '2026-05-11T00:00:00.000Z',
      },
      agents,
      {},
      storage,
    );

    expect(generated.length).toBeGreaterThanOrEqual(3);
    expect(generated.some(item => /父|母|父母/.test(item.displayName))).toBe(false);
    expect(shouldSkipFamilyContacts('父母双亡，孤儿')).toBe(true);
    expect(getVirtualContacts('hanako', storage).length).toBe(generated.length);
    expect(storage.getItem(XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY)).toContain('generatedReason');
    expect(storage.getItem(XINGYE_PHONE_CONTACT_GENERATION_STATE_STORAGE_KEY)).toContain('profileFingerprint');

    const second = ensureGeneratedVirtualContacts('hanako', agents[0], {
      agentId: 'hanako',
      shortBio: '父母双亡，边境医生，冷静克制，行动派',
      updatedAt: '2026-05-11T00:00:00.000Z',
    }, agents, {}, storage);
    expect(second.length).toBe(generated.length);
  });

  it('applyAiContactUpdates with contactChangeSource records unconsumed change log for impression/tags', () => {
    const ownerAgentId = 'role-cc-log';
    const gen: XingyeAiGeneratedContact = {
      targetType: 'virtual_contact',
      displayName: '变更探针',
      kind: 'coworker',
      impression: '旧印象',
      tags: ['需要观察'],
      faction: '中立',
      status: 'active',
      generatedReason: 'test',
    };
    applyAiGeneratedContacts(ownerAgentId, [gen], { storage });
    const vc = getVirtualContacts(ownerAgentId, storage)[0];
    applyAiContactUpdates(
      ownerAgentId,
      [{
        action: 'update',
        targetType: 'virtual_contact',
        targetId: vc.id,
        patch: { impression: '聊天后起了疑心', tags: ['需要观察', '不可靠'] },
        reason: 'recent chat',
      }],
      { storage, contactChangeSource: 'contacts_incremental_update' },
    );
    const pending = getUnconsumedContactChangesForSms(ownerAgentId, storage);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0].changedFields).toContain('impression');
    expect(pending[0].changedFields).toContain('tags');
    expect(pending[0].source).toBe('contacts_incremental_update');
  });

  it('appends a phone.contact_changed event after a real contact change is saved', () => {
    savePhoneContactMeta('hanako', 'agent', 'test_01', {
      remark: 'event contact',
      source: 'manual',
    }, storage);

    expect(appendEventOnceMock).toHaveBeenCalledWith(
      'hanako',
      expect.objectContaining({
        type: 'phone.contact_changed',
        source: 'xingye-phone-store',
        subjectId: 'test_01',
        payload: expect.objectContaining({
          contactId: 'test_01',
          targetType: 'agent',
          changedFields: expect.arrayContaining(['remark']),
          changeLogId: expect.any(String),
          source: 'manual_edit',
        }),
      }),
      expect.stringMatching(/^phone\.contact_changed:hanako:cc-log-/),
    );
  });

  it('uses the same contact change log id as the event dedupe key', () => {
    savePhoneContactMeta('hanako', 'agent', 'test_01', {
      remark: 'first event contact',
      source: 'manual',
    }, storage);
    savePhoneContactMeta('hanako', 'agent', 'test_01', {
      remark: 'second event contact',
      source: 'manual',
    }, storage);

    const dedupeKeys = appendEventOnceMock.mock.calls
      .filter(call => call[1]?.type === 'phone.contact_changed')
      .map(call => call[2]);

    expect(new Set(dedupeKeys).size).toBe(dedupeKeys.length);
    for (const [agentId, input, dedupeKey] of appendEventOnceMock.mock.calls) {
      if (input?.type !== 'phone.contact_changed') continue;
      expect(dedupeKey).toBe(`phone.contact_changed:${agentId}:${input.payload.changeLogId}`);
    }
  });

  it('applyAiContactUpdates updates the existing user contact without duplicating it', () => {
    const ownerAgentId = 'agent-linwu';
    const existingUserTargetId = '__user__';
    savePhoneContactMeta(ownerAgentId, 'user', existingUserTargetId, {
      remark: '你',
      impression: '还没有形成明确印象。',
      tags: [],
      status: 'active',
      source: 'system',
    }, storage, { markManualFields: false });

    applyAiContactUpdates(
      ownerAgentId,
      [{
        action: 'update',
        targetType: 'user',
        targetId: existingUserTargetId,
        patch: {
          impression: '尊重边界，承诺受伤时主动说明情况并配合处理。',
          relationshipHint: '可逐步信任的亲近联系人',
          tags: ['尊重边界', '不逞强', '愿意配合'],
        },
        reason: 'recent chat showed user promised not to hide injuries',
      }],
      { storage, contactChangeSource: 'contacts_incremental_update' },
    );

    const user = getPhoneContacts(ownerAgentId, agents, {}, { includeDeleted: true }, storage)
      .filter(contact => contact.targetType === 'user');
    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({
      targetType: 'user',
      targetId: existingUserTargetId,
      impression: '尊重边界，承诺受伤时主动说明情况并配合处理。',
      relationshipHint: '可逐步信任的亲近联系人',
      tags: ['尊重边界', '不逞强', '愿意配合'],
    });

    const metaMap = JSON.parse(storage.getItem(XINGYE_PHONE_CONTACTS_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const userKeys = Object.keys(metaMap).filter(key => key.startsWith(`${ownerAgentId}::user::`));
    expect(userKeys).toEqual([`${ownerAgentId}::user::${existingUserTargetId}`]);

    const changeLog = JSON.parse(storage.getItem(XINGYE_PHONE_CONTACT_CHANGE_LOG_STORAGE_KEY) ?? '[]') as Array<{
      targetType?: string;
      targetId?: string;
      action?: string;
      changedFields?: string[];
    }>;
    expect(changeLog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetType: 'user',
        targetId: existingUserTargetId,
        action: 'update',
        changedFields: expect.arrayContaining(['impression', 'relationshipHint', 'tags']),
      }),
    ]));
  });

  it('applyAiContactUpdates without contactChangeSource does not write change log', () => {
    const ownerAgentId = 'role-no-log';
    applyAiGeneratedContacts(ownerAgentId, [{
      targetType: 'virtual_contact',
      displayName: '无日志',
      kind: 'friend',
      impression: 'a',
      tags: ['同伴'],
      faction: '自己人',
      status: 'active',
      generatedReason: 't',
    }], { storage });
    const vc = getVirtualContacts(ownerAgentId, storage)[0];
    applyAiContactUpdates(
      ownerAgentId,
      [{
        action: 'update',
        targetType: 'virtual_contact',
        targetId: vc.id,
        patch: { impression: 'b' },
        reason: 'x',
      }],
      { storage },
    );
    expect(getUnconsumedContactChangesForSms(ownerAgentId, storage)).toHaveLength(0);
  });

  it('appending a third mock SMS keeps earlier messages in order (incremental append)', () => {
    vi.setSystemTime(new Date('2026-05-11T03:00:00.000Z'));
    addMockSmsMessage('hanako', 'agent', 'test_01', '第一条', 'outgoing', storage);
    vi.setSystemTime(new Date('2026-05-11T03:01:00.000Z'));
    addMockSmsMessage('hanako', 'agent', 'test_01', '第二条', 'incoming', storage);
    vi.setSystemTime(new Date('2026-05-11T03:02:00.000Z'));
    addMockSmsMessage('hanako', 'agent', 'test_01', '第三条', 'outgoing', storage);
    const t = getSmsThread('hanako', 'agent', 'test_01', storage);
    expect(t?.messages.map(m => m.content)).toEqual(['第一条', '第二条', '第三条']);
  });

  it('appends a phone.sms_appended event after a new SMS is saved', () => {
    const thread = addSmsMessage({
      ownerAgentId: 'hanako',
      targetType: 'agent',
      targetId: 'test_01',
      content: 'event sms',
      direction: 'incoming',
      source: 'manual',
      createdAt: '2026-05-11T05:00:00.000Z',
    }, storage);

    const message = thread?.messages[0];
    expect(message).toBeTruthy();
    expect(appendEventOnceMock).toHaveBeenCalledWith(
      'hanako',
      expect.objectContaining({
        type: 'phone.sms_appended',
        source: 'xingye-phone-store',
        subjectId: thread?.id,
        payload: expect.objectContaining({
          threadId: thread?.id,
          contactId: 'test_01',
          messageId: message?.id,
          direction: 'incoming',
          createdAt: '2026-05-11T05:00:00.000Z',
          from: 'test_01',
          to: 'hanako',
        }),
      }),
      `phone.sms_appended:hanako:${message?.id}`,
    );
  });

  it('keeps phone flows working when event append fails and does not leak events across agents', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appendEventOnceMock.mockRejectedValueOnce(new Error('event write failed'));

    const meta = savePhoneContactMeta('agent-a', 'agent', 'peer-a', {
      remark: 'still saved',
      source: 'manual',
    }, storage);
    const thread = addSmsMessage({
      ownerAgentId: 'agent-b',
      targetType: 'agent',
      targetId: 'peer-b',
      content: 'still saved sms',
      direction: 'outgoing',
    }, storage);

    expect(meta.remark).toBe('still saved');
    expect(thread?.messages).toHaveLength(1);
    expect(getPhoneContactMeta('agent-a', 'agent', 'peer-a', storage)?.remark).toBe('still saved');
    expect(getPhoneContactMeta('agent-b', 'agent', 'peer-a', storage)).toBeNull();

    const contactEvent = appendEventOnceMock.mock.calls.find(call => call[1]?.type === 'phone.contact_changed');
    const smsEvent = appendEventOnceMock.mock.calls.find(call => call[1]?.type === 'phone.sms_appended');
    expect(contactEvent?.[0]).toBe('agent-a');
    expect(smsEvent?.[0]).toBe('agent-b');
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(
      '[xingye-phone-store] failed to append Xingye event:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('phoneCompositeMapKey is the single composite key shape for contacts and SMS threads', () => {
    expect(phoneCompositeMapKey('owner', 'agent', 'peer')).toBe('owner::agent::peer');
    expect(phoneCompositeMapKey('o', 'virtual_contact', 'vc1')).toBe('o::virtual_contact::vc1');
  });

  it('clearAiSmsHistory removes ai_generated messages but keeps mock and non-AI sources', () => {
    vi.setSystemTime(new Date('2026-05-11T04:00:00.000Z'));
    addSmsMessage({
      ownerAgentId: 'hanako',
      targetType: 'agent',
      targetId: 'test_01',
      content: 'AI短信',
      direction: 'outgoing',
      source: 'ai_generated',
    }, storage);
    vi.setSystemTime(new Date('2026-05-11T04:01:00.000Z'));
    addMockSmsMessage('hanako', 'agent', 'test_01', '手动mock', 'incoming', storage);
    vi.setSystemTime(new Date('2026-05-11T04:02:00.000Z'));
    addSmsMessage({
      ownerAgentId: 'hanako',
      targetType: 'agent',
      targetId: 'test_01',
      content: '非AI',
      direction: 'incoming',
      source: 'manual',
    }, storage);

    clearAiSmsHistory('hanako', storage);

    const t = getSmsThread('hanako', 'agent', 'test_01', storage);
    const contents = t?.messages.map(m => m.content) ?? [];
    expect(contents).toContain('手动mock');
    expect(contents).toContain('非AI');
    expect(contents).not.toContain('AI短信');
  });
});

describe('ensureContactDistribution', () => {
  const warmContact = (name: string): XingyeAiGeneratedContact => ({
    targetType: 'virtual_contact',
    displayName: name,
    kind: 'friend',
    tags: ['亲近的人'],
    faction: '自己人',
    status: 'active',
    generatedReason: 'test',
  });

  const edgyContact = (name: string, kind: XingyeAiGeneratedContact['kind']): XingyeAiGeneratedContact => ({
    targetType: 'virtual_contact',
    displayName: name,
    kind,
    tags: ['危险'],
    faction: '对立',
    status: 'active',
    generatedReason: 'test',
  });

  it('regenerate intent ensures at least one blocked or deleted when batch was all active', () => {
    const batch = [edgyContact('A', 'enemy'), edgyContact('B', 'rival'), warmContact('C')];
    const out = ensureContactDistribution(batch, { intent: 'regenerate' });
    expect(out.some(c => c.status === 'blocked' || c.status === 'deleted')).toBe(true);
  });

  it('regenerate intent flips at most one contact when batch had no blocked/deleted', () => {
    const batch = [edgyContact('A', 'enemy'), edgyContact('B', 'rival'), edgyContact('C', 'rival')];
    const out = ensureContactDistribution(batch, { intent: 'regenerate' });
    const nonActive = out.filter(c => c.status === 'blocked' || c.status === 'deleted');
    expect(nonActive.length).toBe(1);
  });

  it('initial intent does not promote statuses when all active', () => {
    const batch = [warmContact('A'), warmContact('B')];
    const out = ensureContactDistribution(batch, { intent: 'initial' });
    expect(out.every(c => c.status === 'active')).toBe(true);
  });
});
