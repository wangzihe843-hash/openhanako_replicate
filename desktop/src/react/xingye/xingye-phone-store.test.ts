import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import type { XingyeEvent, XingyeEventInput } from './xingye-event-log';

type AppendXingyeEventOnceCall = [
  string,
  Omit<XingyeEventInput, 'agentId'> & { agentId?: string },
  string,
];

const appendEventOnceMock = vi.hoisted(() =>
  vi.fn(async (
    _agentId: AppendXingyeEventOnceCall[0],
    _input: AppendXingyeEventOnceCall[1],
    _dedupeKey: AppendXingyeEventOnceCall[2],
  ): Promise<XingyeEvent> => ({
    id: 'event-1',
    agentId: 'hanako',
    type: 'phone.contact_changed',
    source: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    payload: {},
  })),
);

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
  applyContactProfileAiUpdate,
  approvePendingNewFriend,
  clearAiSmsHistory,
  clearAllVirtualContactsForOwner,
  getContactProfile,
  initializeContactProfile,
  ensureContactDistribution,
  ensureGeneratedVirtualContacts,
  getConfirmedVirtualContacts,
  getPendingNewContacts,
  getPhoneContactMeta,
  getPhoneContacts,
  getUnconsumedContactChangesForSms,
  getVirtualContacts,
  rejectPendingNewFriend,
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
    }, undefined, storage);

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

  describe('「新的朋友」审批门槛（pendingApproval）', () => {
    const baseContact = (displayName: string): XingyeAiGeneratedContact => ({
      targetType: 'virtual_contact',
      displayName,
      kind: 'friend',
      impression: '聊得来的新面孔',
      tags: ['同伴'],
      faction: '中立',
      status: 'active',
      generatedReason: 'test',
    });

    it('pending_approval：新建联系人先进队列，通过后才出现在通讯录', () => {
      const ownerAgentId = 'role-gate';
      const result = applyAiGeneratedContacts(ownerAgentId, [baseContact('待确认甲')], {
        storage,
        newContactGate: 'pending_approval',
      });
      expect(result.pendingCount).toBe(1);
      const vc = getVirtualContacts(ownerAgentId, storage)[0];
      expect(getPhoneContactMeta(ownerAgentId, 'virtual_contact', vc.id, storage)?.pendingApproval).toBe(true);

      // 默认视图不可见；显式 includePendingApproval 可见；队列可见；外部消费方列表不可见。
      const visible = getPhoneContacts(ownerAgentId, [], {}, { includeDeleted: true }, storage);
      expect(visible.find(c => c.targetId === vc.id)).toBeUndefined();
      const withPending = getPhoneContacts(ownerAgentId, [], {}, { includeDeleted: true, includePendingApproval: true }, storage);
      expect(withPending.find(c => c.targetId === vc.id)).toBeDefined();
      expect(getPendingNewContacts(ownerAgentId, [], {}, storage).map(c => c.targetId)).toEqual([vc.id]);
      expect(getConfirmedVirtualContacts(ownerAgentId, storage)).toHaveLength(0);

      approvePendingNewFriend(ownerAgentId, vc.id, storage);
      expect(getPendingNewContacts(ownerAgentId, [], {}, storage)).toHaveLength(0);
      expect(getPhoneContacts(ownerAgentId, [], {}, undefined, storage).find(c => c.targetId === vc.id)).toBeDefined();
      expect(getConfirmedVirtualContacts(ownerAgentId, storage)).toHaveLength(1);
    });

    it('born-blocked/deleted 的新联系人不走审批：直接落黑名单/已删除', () => {
      const ownerAgentId = 'role-born-nonactive';
      const result = applyAiGeneratedContacts(ownerAgentId, [
        { ...baseContact('生而拉黑'), status: 'blocked' },
        { ...baseContact('生而删除'), status: 'deleted' },
        baseContact('正常待确认'),
      ], { storage, newContactGate: 'pending_approval' });
      expect(result.createdCount).toBe(3);
      expect(result.pendingCount).toBe(1);

      // 队列里只有 active 那条；blocked/deleted 直接出现在对应分组，不需要通过。
      expect(getPendingNewContacts(ownerAgentId, [], {}, storage).map(c => c.remark)).toEqual(['正常待确认']);
      const all = getPhoneContacts(ownerAgentId, [], {}, { includeDeleted: true }, storage);
      expect(all.find(c => c.remark === '生而拉黑')?.status).toBe('blocked');
      expect(all.find(c => c.remark === '生而删除')?.status).toBe('deleted');
      const blockedVc = getVirtualContacts(ownerAgentId, storage).find(c => c.displayName === '生而拉黑')!;
      expect(getPhoneContactMeta(ownerAgentId, 'virtual_contact', blockedVc.id, storage)?.pendingApproval).toBeUndefined();

      // 增量 add 的 born-blocked 同样直进：add 计数有、pendingAdd 计数无。
      const counts = applyAiContactUpdates(ownerAgentId, [{
        action: 'add',
        targetType: 'virtual_contact',
        contact: { ...baseContact('增量拉黑'), status: 'blocked' },
        reason: '聊到一个 TA 早就拉黑的人',
      }], { storage });
      expect(counts.add).toBe(1);
      expect(counts.pendingAdd).toBe(0);
      expect(getPendingNewContacts(ownerAgentId, [], {}, storage).map(c => c.remark)).toEqual(['正常待确认']);
    });

    it('默认 direct（初始化/重新生成全部路径）：不打标记，直接入册', () => {
      const ownerAgentId = 'role-direct';
      applyAiGeneratedContacts(ownerAgentId, [baseContact('直进乙')], { storage });
      const vc = getVirtualContacts(ownerAgentId, storage)[0];
      expect(getPhoneContactMeta(ownerAgentId, 'virtual_contact', vc.id, storage)?.pendingApproval).toBeUndefined();
      expect(getPhoneContacts(ownerAgentId, [], {}, undefined, storage).find(c => c.targetId === vc.id)).toBeDefined();
      expect(getPendingNewContacts(ownerAgentId, [], {}, storage)).toHaveLength(0);
    });

    it('applyAiContactUpdates 的 add 默认走门槛，且 update patch 不能私改审批标记', () => {
      const ownerAgentId = 'role-inc-add';
      const counts = applyAiContactUpdates(ownerAgentId, [{
        action: 'add',
        targetType: 'virtual_contact',
        contact: baseContact('增量丙'),
        reason: '最近聊天里认识的',
      }], { storage });
      expect(counts.add).toBe(1);
      expect(counts.pendingAdd).toBe(1);
      const vc = getVirtualContacts(ownerAgentId, storage)[0];
      expect(getPendingNewContacts(ownerAgentId, [], {}, storage).map(c => c.targetId)).toEqual([vc.id]);

      // AI 的 update patch 即便带上 pendingApproval: false 也不能让候选绕过审批。
      applyAiContactUpdates(ownerAgentId, [{
        action: 'update',
        targetType: 'virtual_contact',
        targetId: vc.id,
        patch: { impression: '更熟了', pendingApproval: false },
        reason: 'x',
      }], { storage });
      expect(getPhoneContactMeta(ownerAgentId, 'virtual_contact', vc.id, storage)?.pendingApproval).toBe(true);
    });

    it('拒绝：整条移除待确认候选；已入册联系人不能从这里硬删', () => {
      const ownerAgentId = 'role-reject';
      applyAiGeneratedContacts(ownerAgentId, [baseContact('待拒丁')], { storage, newContactGate: 'pending_approval' });
      applyAiGeneratedContacts(ownerAgentId, [baseContact('已入册戊')], { storage });
      const all = getVirtualContacts(ownerAgentId, storage);
      const pendingVc = all.find(c => c.displayName === '待拒丁')!;
      const directVc = all.find(c => c.displayName === '已入册戊')!;

      expect(rejectPendingNewFriend(ownerAgentId, pendingVc.id, storage)).toBe(true);
      expect(getVirtualContacts(ownerAgentId, storage).map(c => c.id)).toEqual([directVc.id]);
      expect(getPhoneContactMeta(ownerAgentId, 'virtual_contact', pendingVc.id, storage)).toBeNull();

      expect(rejectPendingNewFriend(ownerAgentId, directVc.id, storage)).toBe(false);
      expect(getVirtualContacts(ownerAgentId, storage)).toHaveLength(1);
    });

    it('拒绝待确认候选时一并清掉其详情 profile', () => {
      const ownerAgentId = 'role-reject-profile';
      applyAiGeneratedContacts(ownerAgentId, [baseContact('带详情的候选')], { storage, newContactGate: 'pending_approval' });
      const vc = getVirtualContacts(ownerAgentId, storage)[0];
      initializeContactProfile(ownerAgentId, 'virtual_contact', vc.id, { accountId: 'acc-1' }, storage);
      expect(getContactProfile(ownerAgentId, 'virtual_contact', vc.id, storage)).not.toBeNull();
      expect(rejectPendingNewFriend(ownerAgentId, vc.id, storage)).toBe(true);
      expect(getContactProfile(ownerAgentId, 'virtual_contact', vc.id, storage)).toBeNull();
    });

    it('存量数据：旧的 pendingNewFriend 未读标记被忽略，既不挡通讯录也不进队列', () => {
      const ownerAgentId = 'role-legacy';
      applyAiGeneratedContacts(ownerAgentId, [baseContact('老联系人己')], { storage });
      const vc = getVirtualContacts(ownerAgentId, storage)[0];
      const metaMap = JSON.parse(storage.getItem(XINGYE_PHONE_CONTACTS_STORAGE_KEY) ?? '{}') as Record<string, Record<string, unknown>>;
      metaMap[`${ownerAgentId}::virtual_contact::${vc.id}`].pendingNewFriend = true;
      storage.setItem(XINGYE_PHONE_CONTACTS_STORAGE_KEY, JSON.stringify(metaMap));

      expect(getPhoneContacts(ownerAgentId, [], {}, undefined, storage).find(c => c.targetId === vc.id)).toBeDefined();
      expect(getPendingNewContacts(ownerAgentId, [], {}, storage)).toHaveLength(0);
    });
  });

  describe('联系人详情 profile（账号ID/IP/签名/印象历史/联系记录）', () => {
    const ownerAgentId = 'role-profile';
    const vcId = 'vc-profile-1';

    it('initializeContactProfile 幂等，且合并先行的印象历史骨架', () => {
      // 印象变更可能先于详情初始化发生——先落一笔印象历史骨架。
      savePhoneContactMeta(ownerAgentId, 'virtual_contact', vcId, { impression: '第一印象：话很少', source: 'manual' }, storage);
      savePhoneContactMeta(ownerAgentId, 'virtual_contact', vcId, { impression: '熟了之后挺啰嗦', source: 'manual' }, storage);
      const skeleton = getContactProfile(ownerAgentId, 'virtual_contact', vcId, storage);
      expect(skeleton?.initializedAt).toBeUndefined();
      expect(skeleton?.impressionHistory.map(i => i.value)).toEqual(['第一印象：话很少']);

      const created = initializeContactProfile(ownerAgentId, 'virtual_contact', vcId, {
        accountId: 'yexing_007',
        ipAddress: '雾隐城',
        signature: '夜里别来找我。',
        contactLog: [
          { channel: '灵鹤传书', direction: 'incoming', whenLabel: '昨夜', summary: '催还上次借走的罗盘' },
          // 近逐字重复（硬去重兜底层管这种；换措辞的语义重复靠 prompt 锚点防）→ 应被丢弃
          { channel: '符纸', direction: 'incoming', whenLabel: '三天前', summary: '催还上次借走的罗盘。' },
          { channel: '面谈', direction: 'mutual', whenLabel: '上月', summary: '在坊市碰头交换了消息' },
        ],
      }, storage);
      expect(created.initializedAt).toBeTruthy();
      expect(created.accountId).toBe('yexing_007');
      expect(created.impressionHistory.map(i => i.value)).toEqual(['第一印象：话很少']);
      expect(created.contactLog.map(e => e.summary)).toEqual(['催还上次借走的罗盘', '在坊市碰头交换了消息']);

      // 幂等：二次初始化不覆盖。
      const again = initializeContactProfile(ownerAgentId, 'virtual_contact', vcId, { accountId: 'OTHER' }, storage);
      expect(again.accountId).toBe('yexing_007');
    });

    it('applyContactProfileAiUpdate：新记录前插+硬去重；ip/签名变更旧值进 history', () => {
      // storage 每个用例重建，先把基线详情立起来。
      initializeContactProfile(ownerAgentId, 'virtual_contact', vcId, {
        accountId: 'yexing_007',
        ipAddress: '雾隐城',
        signature: '夜里别来找我。',
        contactLog: [
          { channel: '灵鹤传书', direction: 'incoming', whenLabel: '昨夜', summary: '催还上次借走的罗盘' },
          { channel: '面谈', direction: 'mutual', whenLabel: '上月', summary: '在坊市碰头交换了消息' },
        ],
      }, storage);
      const result = applyContactProfileAiUpdate(ownerAgentId, 'virtual_contact', vcId, {
        ipAddress: '落雁滩',
        signature: '罗盘已收回。',
        newContactLog: [
          { channel: '符纸', direction: 'outgoing', whenLabel: '今晨', summary: '约定下旬在渡口碰面' },
          { channel: '灵鹤传书', direction: 'incoming', whenLabel: '昨夜', summary: '催还上次借走的罗盘' }, // 与已有逐字重复 → 丢
        ],
        source: 'manual_update',
      }, storage);
      expect(result.appended).toBe(1);
      expect(result.droppedAsDuplicate).toBe(1);
      expect(result.ipChanged).toBe(true);
      expect(result.signatureChanged).toBe(true);

      const profile = getContactProfile(ownerAgentId, 'virtual_contact', vcId, storage)!;
      expect(profile.contactLog[0].summary).toBe('约定下旬在渡口碰面');
      expect(profile.contactLog[0].source).toBe('manual_update');
      expect(profile.ipAddress).toBe('落雁滩');
      expect(profile.ipHistory.map(i => i.value)).toEqual(['雾隐城']);
      expect(profile.signatureHistory.map(i => i.value)).toEqual(['夜里别来找我。']);
    });

    it('「一次往来」兜底：同批 channel+whenLabel 相同的多条只保留第一条，跨批不启用', () => {
      const tid = 'vc-slot-collapse';
      // 复刻真实翻车现场：模型把同一场「洗发水争执」的多轮短信拆成了三条「短信·上月」。
      const created = initializeContactProfile(ownerAgentId, 'virtual_contact', tid, {
        contactLog: [
          { channel: '短信', direction: 'incoming', whenLabel: '上月', summary: '他说洗发水用一下，明天买新的' },
          { channel: '短信', direction: 'outgoing', whenLabel: '上月', summary: '我回他：你上次也这么说' },
          { channel: '短信', direction: 'incoming', whenLabel: '上月', summary: '他反问：至于吗？一瓶洗发水' },
          { channel: '电话', direction: 'outgoing', whenLabel: '三个月前', summary: '我打过去质问卫生问题，吵了一架' },
        ],
      }, storage);
      expect(created.contactLog.map(e => e.summary)).toEqual([
        '他说洗发水用一下，明天买新的',
        '我打过去质问卫生问题，吵了一架',
      ]);
      // 跨批不启用：后续更新再出现「短信·上月」的新往来仍可入册（宽时间标签不该误伤）。
      const result = applyContactProfileAiUpdate(ownerAgentId, 'virtual_contact', tid, {
        newContactLog: [{ channel: '短信', direction: 'incoming', whenLabel: '上月', summary: '借厨房谈崩之后他来道歉' }],
        source: 'manual_update',
      }, storage);
      expect(result.appended).toBe(1);
    });

    it('印象历史去重：占位印象不记；高相似旧印象不重复入栈', () => {
      const tid = 'vc-impression-dedup';
      // 占位 → 实际印象：占位文案不进历史。
      savePhoneContactMeta(ownerAgentId, 'virtual_contact', tid, { impression: '还没有形成明确印象。', source: 'manual' }, storage);
      savePhoneContactMeta(ownerAgentId, 'virtual_contact', tid, { impression: '看着面善', source: 'manual' }, storage);
      expect(getContactProfile(ownerAgentId, 'virtual_contact', tid, storage)).toBeNull();
      // 真实变更 → 旧印象入栈一次。
      savePhoneContactMeta(ownerAgentId, 'virtual_contact', tid, { impression: '其实精得很', source: 'manual' }, storage);
      // 改回与历史最后一条几乎相同的文本 → 新旧交替但「看着面善」不再重复入栈。
      savePhoneContactMeta(ownerAgentId, 'virtual_contact', tid, { impression: '看着面善', source: 'manual' }, storage);
      const history = getContactProfile(ownerAgentId, 'virtual_contact', tid, storage)?.impressionHistory.map(i => i.value);
      expect(history).toEqual(['看着面善', '其实精得很']);
      savePhoneContactMeta(ownerAgentId, 'virtual_contact', tid, { impression: '其实精得很！', source: 'manual' }, storage);
      const history2 = getContactProfile(ownerAgentId, 'virtual_contact', tid, storage)?.impressionHistory.map(i => i.value);
      // 「看着面善」与历史最后一条「其实精得很」不相似 → 正常入栈；不会出现连续重复。
      expect(history2).toEqual(['看着面善', '其实精得很', '看着面善']);
    });

    it('clearAllVirtualContactsForOwner 连详情一起清（保留 manual 条目的详情）', () => {
      const owner = 'role-clear-profile';
      applyAiGeneratedContacts(owner, [
        { targetType: 'virtual_contact', displayName: 'AI生成者', kind: 'friend', impression: 'a', tags: [], status: 'active', generatedReason: 't' },
      ], { storage });
      const aiVc = getVirtualContacts(owner, storage)[0];
      savePhoneContactMeta(owner, 'virtual_contact', 'vc-manual-keep', { remark: '手动的', source: 'manual' }, storage, { markManualFields: true });
      initializeContactProfile(owner, 'virtual_contact', aiVc.id, { accountId: 'ai-acc' }, storage);
      initializeContactProfile(owner, 'virtual_contact', 'vc-manual-keep', { accountId: 'manual-acc' }, storage);

      clearAllVirtualContactsForOwner(owner, storage, { preserveManuallyEdited: true });
      expect(getContactProfile(owner, 'virtual_contact', aiVc.id, storage)).toBeNull();
      expect(getContactProfile(owner, 'virtual_contact', 'vc-manual-keep', storage)?.accountId).toBe('manual-acc');
    });
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
