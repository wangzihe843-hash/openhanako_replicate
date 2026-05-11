import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import {
  XINGYE_PHONE_CONTACTS_STORAGE_KEY,
  XINGYE_PHONE_CONTACT_GENERATION_STATE_STORAGE_KEY,
  XINGYE_PHONE_SMS_THREADS_STORAGE_KEY,
  XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY,
  addMockSmsMessage,
  ensureGeneratedVirtualContacts,
  getPhoneContactMeta,
  getPhoneContacts,
  getVirtualContacts,
  shouldSkipFamilyContacts,
  getSmsThread,
  getSmsThreads,
  savePhoneContactMeta,
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
});
