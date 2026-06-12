/**
 * 联系人详情 LLM 管线测试：
 *  - 解析/钳制（normalize*）
 *  - 素材采集的「只喂相关」过滤与优雅降级
 *  - prompt 锚点（已有联系记录防重复、accountId 不可变、载体按世界观）
 *  - 懒初始化幂等短路、手动更新走 manual_update、心跳低频追加走 heartbeat
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import type { XingyeContactProfile, XingyePhoneContactView } from './xingye-phone-store';

const phoneAiMock = vi.hoisted(() => ({
  requestPhoneAi: vi.fn(),
  buildLoreContextForPhone: vi.fn(() => '【星野核心设定摘录】（无）'),
}));
vi.mock('./xingye-phone-ai', () => phoneAiMock);

const phoneStoreMock = vi.hoisted(() => ({
  applyContactProfileAiUpdate: vi.fn(),
  getContactProfile: vi.fn((..._args: unknown[]): unknown => null),
  getPhoneContacts: vi.fn((..._args: unknown[]): unknown[] => []),
  getSmsThread: vi.fn((..._args: unknown[]): unknown => null),
  initializeContactProfile: vi.fn(),
  /** xingye-contact-lore-link（真模块）从 phone-store 取的导出，防 missing-export 报错。 */
  getConfirmedVirtualContacts: vi.fn(() => []),
  getVirtualContacts: vi.fn(() => []),
  resolveContactDisplayName: vi.fn(),
  getPhoneContactMeta: vi.fn(() => null),
  /** matchContactNamesToLore 的归一化依赖：测试给个行为等价的极简实现。 */
  normalizeContactNameForDedupe: vi.fn((name: string) => (name ?? '').trim().toLowerCase()),
}));
vi.mock('./xingye-phone-store', () => phoneStoreMock);

const loreStoreMock = vi.hoisted(() => ({
  listLoreEntries: vi.fn(() => [] as unknown[]),
}));
vi.mock('./xingye-lore-store', () => loreStoreMock);

const recentContextMock = vi.hoisted(() => ({
  collectRecentContextForAgent: vi.fn(() => ({
    agentId: 'linwu',
    messages: [] as Array<{ role: string; content: string; source: string }>,
    summaryText: '',
    sourceNotes: [] as string[],
    hasOpenHanakoMessages: false,
  })),
}));
vi.mock('./xingye-recent-context', () => recentContextMock);

const speakerMock = vi.hoisted(() => ({
  resolveXingyeSpeakerUserName: vi.fn(async () => 'Margaret'),
}));
vi.mock('./xingye-speaker-context', () => speakerMock);

const mailStoreMock = vi.hoisted(() => ({
  listMailMessages: vi.fn(async () => [] as unknown[]),
}));
vi.mock('./xingye-mail-store', () => mailStoreMock);

const profileStoreMock = vi.hoisted(() => ({
  readXingyeRoleProfile: vi.fn(async () => null),
}));
vi.mock('./xingye-profile-store', () => profileStoreMock);

import {
  batchInitializeContactProfilesWithAI,
  buildContactProfileInitPrompt,
  buildContactProfileUpdatePrompt,
  collectContactProfileSourceInputs,
  ensureContactProfileInitializedWithAI,
  maybeAppendContactLogAfterHeartbeat,
  normalizeContactProfileInitResult,
  normalizeContactProfileUpdateResult,
  updateContactProfileWithAI,
} from './xingye-contact-profile-ai';

const ownerAgent: Agent = { id: 'linwu', name: '林雾', yuan: 'hanako', isPrimary: false };

function vcContact(overrides: Partial<XingyePhoneContactView> = {}): XingyePhoneContactView {
  return {
    ownerAgentId: 'linwu',
    targetType: 'virtual_contact',
    targetId: 'vc-1',
    displayName: '北门旧巷',
    originalName: '北门旧巷',
    remark: '北门旧巷',
    impression: '嘴上不饶人，但记仇',
    tags: ['需要观察'],
    status: 'active',
    kind: 'rival',
    ...overrides,
  };
}

function initializedProfile(overrides: Partial<XingyeContactProfile> = {}): XingyeContactProfile {
  return {
    ownerAgentId: 'linwu',
    targetType: 'virtual_contact',
    targetId: 'vc-1',
    accountId: 'beimen_99',
    ipAddress: '雾隐城',
    signature: '少打听。',
    ipHistory: [],
    signatureHistory: [],
    impressionHistory: [],
    contactLog: [{
      id: 'clog-1',
      channel: '灵鹤传书',
      direction: 'incoming',
      whenLabel: '昨夜',
      summary: '催还上次借走的罗盘',
      createdAt: '2026-06-01T00:00:00.000Z',
      source: 'init',
    }],
    initializedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  phoneAiMock.requestPhoneAi.mockReset();
  phoneStoreMock.applyContactProfileAiUpdate.mockReset();
  phoneStoreMock.getContactProfile.mockReset().mockReturnValue(null);
  phoneStoreMock.getPhoneContacts.mockReset().mockReturnValue([]);
  phoneStoreMock.getSmsThread.mockReset().mockReturnValue(null);
  phoneStoreMock.initializeContactProfile.mockReset();
  loreStoreMock.listLoreEntries.mockReset().mockReturnValue([]);
  recentContextMock.collectRecentContextForAgent.mockReset().mockReturnValue({
    agentId: 'linwu', messages: [], summaryText: '', sourceNotes: [], hasOpenHanakoMessages: false,
  });
  mailStoreMock.listMailMessages.mockReset().mockResolvedValue([]);
  speakerMock.resolveXingyeSpeakerUserName.mockReset().mockResolvedValue('Margaret');
  profileStoreMock.readXingyeRoleProfile.mockReset().mockResolvedValue(null);
});

describe('normalize 解析与钳制', () => {
  it('init：钳制字段长度、规整 direction、丢掉缺 summary 的条目', () => {
    const result = normalizeContactProfileInitResult({
      accountId: 'a'.repeat(60),
      ipAddress: '雾隐城',
      signature: '签'.repeat(100),
      contactLog: [
        { channel: '灵鹤传书', direction: 'incoming', whenLabel: '昨夜', summary: '催还罗盘' },
        { channel: '符纸', direction: '胡说', whenLabel: '前日', summary: '约碰面' },
        { channel: '面谈', direction: 'mutual', whenLabel: '上月' }, // 无 summary → 丢
      ],
    });
    expect(result.accountId).toHaveLength(24);
    expect(result.signature).toHaveLength(60);
    expect(result.contactLog).toHaveLength(2);
    expect(result.contactLog[1].direction).toBe('mutual');
  });

  it('init：完全没有可用字段时抛错', () => {
    expect(() => normalizeContactProfileInitResult({})).toThrow();
    expect(() => normalizeContactProfileInitResult('文本')).toThrow();
  });

  it('update：新条目数量按 maxNewEntries 截断', () => {
    const result = normalizeContactProfileUpdateResult({
      newContactLog: Array.from({ length: 6 }, (_, i) => ({
        channel: '电话', direction: 'outgoing', whenLabel: '今天', summary: `事件${i}`,
      })),
    }, 3);
    expect(result.newContactLog).toHaveLength(3);
  });
});

describe('素材采集（只喂相关 + 优雅降级）', () => {
  it('vc：lore 按名字匹配、聊天只保留提到 TA 的行、短信/邮件按联系人过滤', async () => {
    loreStoreMock.listLoreEntries.mockReturnValue([
      { id: 'l1', agentId: 'linwu', title: '北门旧巷', content: '旧巷其人，记仇十年。', category: 'relationship', keywords: [], enabled: true, priority: 50, insertionMode: 'always', visibility: 'canonical', createdAt: '', updatedAt: '' },
      { id: 'l2', agentId: 'linwu', title: '雾隐城坊市', content: '坊市规矩。', category: 'location', keywords: [], enabled: true, priority: 50, insertionMode: 'always', visibility: 'canonical', createdAt: '', updatedAt: '' },
    ]);
    recentContextMock.collectRecentContextForAgent.mockReturnValue({
      agentId: 'linwu',
      messages: [
        { role: 'user', content: '北门旧巷又来催罗盘了？', source: 'openhanako_chat' },
        { role: 'assistant', content: '今天去坊市转了转。', source: 'openhanako_chat' },
      ],
      summaryText: '', sourceNotes: [], hasOpenHanakoMessages: true,
    });
    phoneStoreMock.getSmsThread.mockReturnValue({
      id: 't1', ownerAgentId: 'linwu', targetType: 'virtual_contact', targetId: 'vc-1', updatedAt: '',
      messages: [{ id: 'm1', threadId: 't1', fromAgentId: 'vc-1', toAgentId: 'linwu', content: '罗盘何时还？', createdAt: '' }],
    });
    mailStoreMock.listMailMessages.mockResolvedValue([
      { id: 'mail1', key: 'k1', agentId: 'linwu', mailbox: 'inbox', from: { name: '北门旧巷', address: 'x@x', kind: 'virtual_contact' }, to: [], subject: '罗盘的事', body: '别装死。', isRead: true, isStarred: false, labels: [], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '' },
      { id: 'mail2', key: 'k2', agentId: 'linwu', mailbox: 'promotions', from: { name: '坊市周报', address: 'p@p', kind: 'promotion' }, to: [], subject: '本周特价', body: '…', isRead: true, isStarred: false, labels: [], createdAt: '2026-06-02T00:00:00.000Z', updatedAt: '' },
    ]);

    const inputs = await collectContactProfileSourceInputs({ ownerAgentId: 'linwu', contact: vcContact(), userName: 'Margaret' });
    expect(inputs.matchedLore.map(e => e.title)).toEqual(['北门旧巷']);
    expect(inputs.chatLines).toHaveLength(1);
    expect(inputs.chatLines[0]).toContain('北门旧巷又来催罗盘了？');
    expect(inputs.smsLines).toEqual(['北门旧巷：罗盘何时还？']);
    expect(inputs.mailLines).toHaveLength(1);
    expect(inputs.mailLines[0]).toContain('罗盘的事');
  });

  it('user 联系人：聊天不按名字过滤（全部相关）；短信/邮件一律不喂；lore 抛错降级为空', async () => {
    recentContextMock.collectRecentContextForAgent.mockReturnValue({
      agentId: 'linwu',
      messages: [
        { role: 'user', content: '昨晚睡得不好。', source: 'openhanako_chat' },
        { role: 'assistant', content: '那今天别硬撑。', source: 'openhanako_chat' },
      ],
      summaryText: '', sourceNotes: [], hasOpenHanakoMessages: true,
    });
    // 即便邮箱里有 from 名字命中用户名的邮件，user 条目也不喂（user 详情只由聊天+lore 驱动）。
    mailStoreMock.listMailMessages.mockResolvedValue([
      { id: 'mailU', key: 'kU', agentId: 'linwu', mailbox: 'inbox', from: { name: 'Margaret', address: 'u@u', kind: 'agent' }, to: [], subject: '不该出现', body: '…', isRead: true, isStarred: false, labels: [], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '' },
    ]);
    loreStoreMock.listLoreEntries.mockImplementation(() => { throw new Error('lore down'); });

    const userContact = vcContact({ targetType: 'user', targetId: '__user__', remark: '你', displayName: '你', originalName: '你' });
    const inputs = await collectContactProfileSourceInputs({ ownerAgentId: 'linwu', contact: userContact, userName: 'Margaret' });
    expect(inputs.chatLines).toHaveLength(2);
    expect(inputs.chatLines[0]).toContain('Margaret：');
    expect(inputs.mailLines).toEqual([]);
    expect(mailStoreMock.listMailMessages).not.toHaveBeenCalled();
    expect(inputs.matchedLore).toEqual([]);
    expect(inputs.smsLines).toEqual([]); // user 无短信线程
  });
});

describe('prompt 锚点', () => {
  it('init prompt：含联系人卡片、缺料块标（无）、载体按世界观指南、blocked/deleted 语气规则', () => {
    const prompt = buildContactProfileInitPrompt({
      ownerAgent,
      ownerProfile: null,
      contact: vcContact({ status: 'blocked' }),
      userName: 'Margaret',
      loreContextText: '【星野核心设定摘录】（无）',
      inputs: { matchedLore: [], chatLines: [], smsLines: [], mailLines: [] },
    });
    expect(prompt).toContain('北门旧巷');
    expect(prompt).toContain('嘴上不饶人，但记仇');
    expect(prompt).toContain('（无）');
    expect(prompt).toContain('灵鹤传书'); // 非现代载体示例
    expect(prompt).toContain('不要混用时代');
    expect(prompt).toContain('一次往来'); // 粒度规则：多轮消息聊一件事只记一条
    expect(prompt).toContain('blocked');
    expect(prompt).toContain('accountId');
    // 非 user 联系人不应带 user 专属规则
    expect(prompt).not.toContain('user 本人');
  });

  it('user 条目 prompt：声明联系记录只能依据最近聊天与设定，不得虚构短信/邮件', () => {
    const prompt = buildContactProfileInitPrompt({
      ownerAgent,
      ownerProfile: null,
      contact: vcContact({ targetType: 'user', targetId: '__user__', remark: '你', displayName: '你', originalName: '你' }),
      userName: 'Margaret',
      loreContextText: '【星野核心设定摘录】（无）',
      inputs: { matchedLore: [], chatLines: [], smsLines: [], mailLines: [] },
    });
    expect(prompt).toContain('user 本人');
    expect(prompt).toContain('最近聊天与设定');
    expect(prompt).toContain('不要虚构');
  });

  it('update prompt：喂已有记录锚点、声明 accountId 不可变、ip/签名通常不变', () => {
    const prompt = buildContactProfileUpdatePrompt({
      ownerAgent,
      ownerProfile: null,
      contact: vcContact(),
      profile: initializedProfile(),
      userName: 'Margaret',
      loreContextText: '【星野核心设定摘录】（无）',
      inputs: { matchedLore: [], chatLines: [], smsLines: [], mailLines: [] },
      maxNewEntries: 3,
    });
    expect(prompt).toContain('灵鹤传书｜昨夜｜催还上次借走的罗盘');
    expect(prompt).toContain('不可变');
    expect(prompt).toContain('通常保持不变');
    expect(prompt).toContain('1-3 条');
  });
});

describe('流程', () => {
  it('懒初始化：已初始化直接短路，不打模型', async () => {
    phoneStoreMock.getContactProfile.mockReturnValue(initializedProfile());
    const result = await ensureContactProfileInitializedWithAI({ ownerAgent, ownerProfile: null, contact: vcContact() });
    expect(result.status).toBe('already');
    expect(phoneAiMock.requestPhoneAi).not.toHaveBeenCalled();
  });

  it('懒初始化：未初始化时调用 contact_profile_init 并落库', async () => {
    phoneAiMock.requestPhoneAi.mockResolvedValue({
      raw: {
        accountId: 'beimen_99',
        ipAddress: '雾隐城',
        signature: '少打听。',
        contactLog: [{ channel: '灵鹤传书', direction: 'incoming', whenLabel: '昨夜', summary: '催还罗盘' }],
      },
    });
    const result = await ensureContactProfileInitializedWithAI({ ownerAgent, ownerProfile: null, contact: vcContact() });
    expect(result.status).toBe('created');
    expect(phoneAiMock.requestPhoneAi).toHaveBeenCalledWith(expect.objectContaining({ kind: 'contact_profile_init' }));
    expect(phoneStoreMock.initializeContactProfile).toHaveBeenCalledWith(
      'linwu',
      'virtual_contact',
      'vc-1',
      expect.objectContaining({ accountId: 'beimen_99', contactLog: [expect.objectContaining({ summary: '催还罗盘' })] }),
    );
  });

  it('手动更新：未初始化时拒绝；初始化后走 contact_profile_update + manual_update 落库', async () => {
    await expect(updateContactProfileWithAI({ ownerAgent, ownerProfile: null, contact: vcContact() })).rejects.toThrow('详情还没初始化');

    phoneStoreMock.getContactProfile.mockReturnValue(initializedProfile());
    phoneStoreMock.applyContactProfileAiUpdate.mockReturnValue({ appended: 1, droppedAsDuplicate: 0, ipChanged: false, signatureChanged: false });
    phoneAiMock.requestPhoneAi.mockResolvedValue({
      raw: { newContactLog: [{ channel: '符纸', direction: 'outgoing', whenLabel: '今晨', summary: '约定渡口碰面' }] },
    });
    const result = await updateContactProfileWithAI({ ownerAgent, ownerProfile: null, contact: vcContact() });
    expect(result.appended).toBe(1);
    expect(phoneAiMock.requestPhoneAi).toHaveBeenCalledWith(expect.objectContaining({ kind: 'contact_profile_update' }));
    expect(phoneStoreMock.applyContactProfileAiUpdate).toHaveBeenCalledWith(
      'linwu', 'virtual_contact', 'vc-1',
      expect.objectContaining({ source: 'manual_update' }),
    );
  });

  it('批量初始化：过滤已初始化、串行逐条、单条失败不打断、进度回调收尾', async () => {
    // vc-1 已初始化（不进 total）；vc-2 成功；vc-3 模型挂了 → 计失败但继续。
    phoneStoreMock.getContactProfile.mockImplementation((...args: unknown[]) => (
      args[2] === 'vc-1' ? initializedProfile() : null
    ));
    phoneAiMock.requestPhoneAi.mockImplementation(async (input: { contacts: Array<{ targetId: string }> }) => {
      if (input.contacts[0]?.targetId === 'vc-3') throw new Error('model down');
      return { raw: { accountId: 'acc-x', contactLog: [{ channel: '短信', direction: 'incoming', whenLabel: '昨天', summary: '问好' }] } };
    });
    const progress: Array<[number, number, string | null]> = [];
    const result = await batchInitializeContactProfilesWithAI({
      ownerAgent,
      ownerProfile: null,
      contacts: [vcContact(), vcContact({ targetId: 'vc-2', remark: '老二' }), vcContact({ targetId: 'vc-3', remark: '老三' })],
      onProgress: (done, total, current) => progress.push([done, total, current?.targetId ?? null]),
    });
    expect(result).toEqual({ total: 2, created: 1, skipped: 0, failed: 1, cancelled: false });
    expect(progress).toEqual([[0, 2, 'vc-2'], [1, 2, 'vc-3'], [2, 2, null]]);
    expect(phoneStoreMock.initializeContactProfile).toHaveBeenCalledTimes(1);
  });

  it('批量初始化：shouldCancel 在第二条前停止', async () => {
    phoneStoreMock.getContactProfile.mockReturnValue(null);
    phoneAiMock.requestPhoneAi.mockResolvedValue({ raw: { accountId: 'acc-y', contactLog: [] } });
    let checks = 0;
    const result = await batchInitializeContactProfilesWithAI({
      ownerAgent,
      ownerProfile: null,
      contacts: [vcContact(), vcContact({ targetId: 'vc-2', remark: '老二' })],
      shouldCancel: () => checks++ > 0,
    });
    expect(result.cancelled).toBe(true);
    expect(result.created).toBe(1);
    expect(phoneAiMock.requestPhoneAi).toHaveBeenCalledTimes(1);
  });

  it('心跳追加：没中概率不打模型；中了则挑已初始化的 active vc 走 heartbeat source', async () => {
    const skip = await maybeAppendContactLogAfterHeartbeat(ownerAgent, { randomSource: () => 0.99 });
    expect(skip.appended).toBe(false);
    expect(phoneAiMock.requestPhoneAi).not.toHaveBeenCalled();

    phoneStoreMock.getPhoneContacts.mockReturnValue([
      vcContact(),
      vcContact({ targetId: 'vc-blocked', status: 'blocked' }),
    ]);
    phoneStoreMock.getContactProfile.mockImplementation((...args: unknown[]) => (
      args[2] === 'vc-1' ? initializedProfile() : null
    ));
    phoneStoreMock.applyContactProfileAiUpdate.mockReturnValue({ appended: 1, droppedAsDuplicate: 0, ipChanged: false, signatureChanged: false });
    phoneAiMock.requestPhoneAi.mockResolvedValue({
      raw: { newContactLog: [{ channel: '灵鹤传书', direction: 'incoming', whenLabel: '方才', summary: '约下旬碰面' }] },
    });
    const hit = await maybeAppendContactLogAfterHeartbeat(ownerAgent, { randomSource: () => 0 });
    expect(hit.appended).toBe(true);
    expect(phoneStoreMock.applyContactProfileAiUpdate).toHaveBeenCalledWith(
      'linwu', 'virtual_contact', 'vc-1',
      expect.objectContaining({ source: 'heartbeat' }),
    );
  });
});
