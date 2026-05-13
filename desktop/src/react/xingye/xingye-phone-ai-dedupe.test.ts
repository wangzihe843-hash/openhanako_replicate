import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./xingye-event-log', () => ({
  appendXingyeEventOnce: vi.fn(async () => ({ id: 'event-1' })),
}));

import {
  applyAiGeneratedContacts,
  findVirtualContactByName,
  getContactDedupeKey,
  getPhoneContactMeta,
  getVirtualContacts,
  normalizeContactNameForDedupe,
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

function makeContact(partial: Partial<XingyeAiGeneratedContact> & { displayName: string }): XingyeAiGeneratedContact {
  return {
    targetType: 'virtual_contact',
    displayName: partial.displayName,
    kind: partial.kind ?? 'friend',
    shortBio: partial.shortBio,
    remark: partial.remark,
    impression: partial.impression ?? '还没有形成明确印象。',
    relationshipHint: partial.relationshipHint,
    tags: partial.tags ?? ['同伴'],
    faction: partial.faction ?? '自己人',
    status: partial.status ?? 'active',
    generatedReason: partial.generatedReason ?? 'test',
  };
}

describe('normalizeContactNameForDedupe', () => {
  it('lowercases, trims, collapses whitespace and strips edge punctuation', () => {
    expect(normalizeContactNameForDedupe('  Hello   World  ')).toBe('hello world');
    expect(normalizeContactNameForDedupe('"老王"')).toBe('老王');
    expect(normalizeContactNameForDedupe('【危险人物】')).toBe('危险人物');
    expect(normalizeContactNameForDedupe('·黑蛇·')).toBe('黑蛇');
  });

  it('normalizes fullwidth to halfwidth and treats them as equal', () => {
    expect(normalizeContactNameForDedupe('ＡＢＣ１')).toBe('abc1');
    expect(normalizeContactNameForDedupe('夜班同事 ')).toBe(normalizeContactNameForDedupe('夜班同事'));
    expect(normalizeContactNameForDedupe('黑　蛇')).toBe(normalizeContactNameForDedupe('黑 蛇'));
  });

  it('returns empty string for non-string and empty input', () => {
    expect(normalizeContactNameForDedupe(undefined)).toBe('');
    expect(normalizeContactNameForDedupe(null)).toBe('');
    expect(normalizeContactNameForDedupe('')).toBe('');
    expect(normalizeContactNameForDedupe('   ')).toBe('');
  });
});

describe('getContactDedupeKey', () => {
  it('returns agent:<id> when linkedAgentId is present', () => {
    expect(getContactDedupeKey({ targetType: 'virtual_contact', linkedAgentId: 'agent-7', displayName: '小明' }))
      .toBe('agent:agent-7');
  });

  it('falls back to normalized displayName', () => {
    expect(getContactDedupeKey({ targetType: 'virtual_contact', displayName: '  老王 ' }))
      .toBe('name:老王');
  });

  it('falls back to normalized remark when no displayName', () => {
    expect(getContactDedupeKey({ targetType: 'virtual_contact', displayName: '', remark: '夜班同事' }))
      .toBe('remark:夜班同事');
  });

  it('returns empty string when targetType is user (user does not participate in dedupe)', () => {
    expect(getContactDedupeKey({ targetType: 'user', displayName: '你' })).toBe('');
  });

  it('returns empty string when no usable name', () => {
    expect(getContactDedupeKey({ targetType: 'virtual_contact' })).toBe('');
  });
});

describe('applyAiGeneratedContacts dedupe', () => {
  let storage: MemoryStorage;
  const ownerAgentId = 'role-1';

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('drops empty / placeholder displayName candidates', () => {
    const result = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '' }),
      makeContact({ displayName: '未命名联系人' }),
      makeContact({ displayName: '正常人' }),
    ], { storage });
    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBeGreaterThanOrEqual(2);
    expect(getVirtualContacts(ownerAgentId, storage)).toHaveLength(1);
  });

  it('returns 3-8 candidates dedupe path: 8 returned, 3 already exist → only 5 newly created', () => {
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '老王' }),
      makeContact({ displayName: '小张' }),
      makeContact({ displayName: '李医生' }),
    ], { storage });

    const second = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '老王' }),
      makeContact({ displayName: '小张' }),
      makeContact({ displayName: '李医生' }),
      makeContact({ displayName: '新邻居' }),
      makeContact({ displayName: '物业王姐' }),
      makeContact({ displayName: '陌生号码' }),
      makeContact({ displayName: '夜班同事' }),
      makeContact({ displayName: '老患者' }),
    ], { storage });

    expect(second.createdCount).toBe(5);
    expect(second.mergedCount).toBe(3);
    expect(getVirtualContacts(ownerAgentId, storage)).toHaveLength(8);
  });

  it('collapses multiple same-name blocked candidates from one AI batch into one entry', () => {
    const result = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '黑蛇', status: 'blocked', impression: '危险' }),
      makeContact({ displayName: '黑蛇', status: 'blocked', impression: '盯人' }),
      makeContact({ displayName: '黑蛇', status: 'blocked', impression: '勒索' }),
    ], { storage });
    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBeGreaterThanOrEqual(2);
    expect(getVirtualContacts(ownerAgentId, storage)).toHaveLength(1);
  });

  it('collapses multiple same-name deleted candidates into one entry', () => {
    const result = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '方老师', status: 'deleted' }),
      makeContact({ displayName: '方老师', status: 'deleted' }),
    ], { storage });
    expect(result.createdCount).toBe(1);
    expect(getVirtualContacts(ownerAgentId, storage)).toHaveLength(1);
  });

  it('does not create a duplicate of an existing blocked contact, even when AI returns same name as active', () => {
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '黑蛇', status: 'blocked' }),
    ], { storage });

    const second = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '黑蛇', status: 'active', impression: 'AI 想恢复' }),
    ], { storage });

    expect(second.createdCount).toBe(0);
    expect(second.mergedCount).toBe(1);
    const all = getVirtualContacts(ownerAgentId, storage);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('blocked');
    const meta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', all[0].id, storage);
    expect(meta?.status).toBe('blocked');
  });

  it('does not create a duplicate of an existing deleted contact, even when AI returns same name as active', () => {
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '方老师', status: 'deleted' }),
    ], { storage });

    const second = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '方老师', status: 'active' }),
    ], { storage });

    expect(second.createdCount).toBe(0);
    expect(second.mergedCount).toBe(1);
    const all = getVirtualContacts(ownerAgentId, storage);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('deleted');
  });

  it('preserves manually-edited blocked/deleted fields when AI returns a same-name patch', () => {
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '老王', impression: 'AI 写的初版印象' }),
    ], { storage });
    const existing = findVirtualContactByName(ownerAgentId, '老王', storage);
    expect(existing).not.toBeNull();
    savePhoneContactMeta(ownerAgentId, 'virtual_contact', existing!.id, {
      status: 'blocked',
      impression: '我手动写的：他烦人。',
      source: 'manual',
    }, storage, { markManualFields: true });

    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '老王', status: 'active', impression: 'AI 想改的内容' }),
    ], { storage });

    const meta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', existing!.id, storage);
    expect(meta?.status).toBe('blocked');
    expect(meta?.impression).toBe('我手动写的：他烦人。');
  });

  it('does not generate targetType=user when AI tries to emit user-like contacts', () => {
    const result = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '你' }),
      makeContact({ displayName: '我' }),
      makeContact({ displayName: '本人' }),
    ], { storage });
    const virtuals = getVirtualContacts(ownerAgentId, storage);
    for (const v of virtuals) {
      expect(['agent', 'virtual_contact']).toContain('virtual_contact');
      expect(v.displayName).not.toBe('');
    }
    expect(virtuals.every(v => v.displayName.length > 0)).toBe(true);
    expect(result.skippedCount + result.createdCount).toBe(3);
  });

  it('clicking AI generate twice does not duplicate same-name contacts', () => {
    const candidates: XingyeAiGeneratedContact[] = [
      makeContact({ displayName: '老王' }),
      makeContact({ displayName: '黑蛇', status: 'blocked' }),
      makeContact({ displayName: '方老师', status: 'deleted' }),
    ];
    applyAiGeneratedContacts(ownerAgentId, candidates, { storage });
    applyAiGeneratedContacts(ownerAgentId, candidates, { storage });
    applyAiGeneratedContacts(ownerAgentId, candidates, { storage });

    expect(getVirtualContacts(ownerAgentId, storage)).toHaveLength(3);
  });

  it('when all candidates are duplicates, createdCount is 0', () => {
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '老王' }),
      makeContact({ displayName: '小张' }),
    ], { storage });
    const second = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '老王' }),
      makeContact({ displayName: '小张' }),
    ], { storage });
    expect(second.createdCount).toBe(0);
    expect(second.mergedCount).toBe(2);
  });

  it('"never" mode skips entirely when same-name contact already exists', () => {
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '黑蛇', status: 'blocked' }),
    ], { storage });
    const before = getVirtualContacts(ownerAgentId, storage);
    const result = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '黑蛇' }),
    ], { storage, mergeMatchingDisplayName: 'never' });
    expect(result.createdCount).toBe(0);
    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(getVirtualContacts(ownerAgentId, storage)).toHaveLength(before.length);
  });

  it('normalizes name variations (fullwidth, casing, punctuation) so duplicates collapse', () => {
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '老王' }),
    ], { storage });
    const second = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '"老王"' }),
      makeContact({ displayName: '  老王 ' }),
      makeContact({ displayName: '【老王】' }),
    ], { storage });
    expect(second.createdCount).toBe(0);
    expect(getVirtualContacts(ownerAgentId, storage)).toHaveLength(1);
  });

  it('regenerate mode preserves manual blocked/deleted status while merging fields', () => {
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '方老师', status: 'deleted' }),
    ], { storage });
    const existing = findVirtualContactByName(ownerAgentId, '方老师', storage)!;
    savePhoneContactMeta(ownerAgentId, 'virtual_contact', existing.id, {
      status: 'deleted',
      source: 'manual',
    }, storage, { markManualFields: true });

    const result = applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '方老师', status: 'active', impression: '新印象' }),
    ], { storage, mergeMatchingDisplayName: 'regenerate' });

    expect(result.createdCount).toBe(0);
    expect(result.mergedCount).toBe(1);
    const meta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', existing.id, storage);
    expect(meta?.status).toBe('deleted');
  });
});

describe('applyAiContactUpdates add-action dedupe boundary', () => {
  let storage: MemoryStorage;
  const ownerAgentId = 'role-1';

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('mentioning a blocked contact via add action does not create a duplicate', async () => {
    const { applyAiContactUpdates } = await import('./xingye-phone-store');
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '黑蛇', status: 'blocked' }),
    ], { storage });

    applyAiContactUpdates(ownerAgentId, [
      {
        action: 'add',
        targetType: 'virtual_contact',
        contact: makeContact({ displayName: '黑蛇', status: 'active', impression: 'AI 想说他回来了' }),
        reason: 'mention in chat',
      },
    ], { storage });

    const all = getVirtualContacts(ownerAgentId, storage);
    expect(all).toHaveLength(1);
    const meta = getPhoneContactMeta(ownerAgentId, 'virtual_contact', all[0].id, storage);
    expect(meta?.status).toBe('blocked');
  });

  it('mentioning a deleted contact via add action does not create a duplicate', async () => {
    const { applyAiContactUpdates } = await import('./xingye-phone-store');
    applyAiGeneratedContacts(ownerAgentId, [
      makeContact({ displayName: '方老师', status: 'deleted' }),
    ], { storage });

    applyAiContactUpdates(ownerAgentId, [
      {
        action: 'add',
        targetType: 'virtual_contact',
        contact: makeContact({ displayName: '方老师', status: 'active' }),
        reason: 'mention in chat',
      },
    ], { storage });

    const all = getVirtualContacts(ownerAgentId, storage);
    expect(all).toHaveLength(1);
  });
});
