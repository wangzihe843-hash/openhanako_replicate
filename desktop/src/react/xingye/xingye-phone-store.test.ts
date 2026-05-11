import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import {
  XINGYE_PHONE_CONTACTS_STORAGE_KEY,
  XINGYE_PHONE_SMS_THREADS_STORAGE_KEY,
  addMockSmsMessage,
  getPhoneContactMeta,
  getPhoneContacts,
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

  it('stores contact remark/impression by ownerAgentId + targetAgentId', () => {
    savePhoneContactMeta('hanako', 'test_01', {
      remark: '小测试',
      impression: '有点冒失，但很真诚。',
      source: 'manual',
    }, storage);
    savePhoneContactMeta('test_01', 'hanako', {
      remark: '花子同学',
      impression: '看起来温柔，但不太好接近。',
      source: 'manual',
    }, storage);

    expect(getPhoneContactMeta('hanako', 'test_01', storage)).toMatchObject({
      ownerAgentId: 'hanako',
      targetAgentId: 'test_01',
      remark: '小测试',
      impression: '有点冒失，但很真诚。',
      source: 'manual',
    });
    expect(getPhoneContactMeta('test_01', 'hanako', storage)).toMatchObject({
      ownerAgentId: 'test_01',
      targetAgentId: 'hanako',
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

    const anzu = contacts.find(item => item.targetAgentId === 'anzu');
    const test01 = contacts.find(item => item.targetAgentId === 'test_01');

    expect(anzu).toMatchObject({
      targetAgentId: 'anzu',
      remark: 'Anzu',
      impression: '还没有形成明确印象。',
    });
    expect(test01).toMatchObject({
      targetAgentId: 'test_01',
      targetDisplayName: '测试一号',
      remark: '测试一号',
      impression: '还没有形成明确印象。',
    });
  });

  it('creates sms threads and messages with direction + source', () => {
    vi.setSystemTime(new Date('2026-05-11T01:00:00.000Z'));
    const first = addMockSmsMessage('hanako', 'test_01', '今晚到吗？', 'outgoing', storage);
    vi.setSystemTime(new Date('2026-05-11T01:05:00.000Z'));
    const second = addMockSmsMessage('hanako', 'test_01', '马上到。', 'incoming', storage);

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
    expect(getSmsThread('hanako', 'test_01', storage)?.messages).toHaveLength(2);
    expect(getSmsThreads('hanako', storage)[0]?.targetAgentId).toBe('test_01');
    expect(storage.getItem(XINGYE_PHONE_SMS_THREADS_STORAGE_KEY)).toContain('今晚到吗');
  });
});
