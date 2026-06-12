import { describe, expect, it } from 'vitest';
import type { Agent } from '../types';
import {
  buildContactIncrementalUpdatePrompt,
  buildContactRollbackAndUpdatePrompt,
  buildContactRegenerateAllPrompt,
  buildSmsHistoryPrompt,
  buildSmsIncrementalUpdatePrompt,
  buildVirtualContactGenerationPrompt,
} from './xingye-phone-prompts';
import type { XingyePhoneContactView } from './xingye-phone-store';
import type { XingyeRecentContext } from './xingye-recent-context';

const ownerAgent: Agent = { id: 'role-1', name: 'Hanako', yuan: 'hanako', isPrimary: true };
const ownerProfile = {
  agentId: 'role-1',
  displayName: '花子',
  shortBio: '边境医生，冷静克制',
  identitySummary: '医生',
  updatedAt: '2026-05-11T00:00:00.000Z',
};

function makeContact(partial: Partial<XingyePhoneContactView> & { displayName: string; targetType: XingyePhoneContactView['targetType']; targetId: string; status: XingyePhoneContactView['status'] }): XingyePhoneContactView {
  return {
    ownerAgentId: 'role-1',
    targetType: partial.targetType,
    targetId: partial.targetId,
    displayName: partial.displayName,
    originalName: partial.displayName,
    remark: partial.remark ?? partial.displayName,
    impression: partial.impression ?? '还没有形成明确印象。',
    relationshipHint: partial.relationshipHint,
    tags: partial.tags ?? [],
    faction: partial.faction,
    status: partial.status,
    kind: partial.kind,
    shortBio: partial.shortBio,
    source: partial.source,
  };
}

const emptyRecent: XingyeRecentContext = {
  agentId: 'role-1',
  messages: [],
  summaryText: '',
  sourceNotes: [],
  hasOpenHanakoMessages: false,
};

const blockedView = makeContact({
  targetType: 'virtual_contact',
  targetId: 'vc-blocked',
  displayName: '黑蛇',
  status: 'blocked',
});
const deletedView = makeContact({
  targetType: 'virtual_contact',
  targetId: 'vc-deleted',
  displayName: '方老师',
  status: 'deleted',
});
const activeView = makeContact({
  targetType: 'virtual_contact',
  targetId: 'vc-active',
  displayName: '老王',
  status: 'active',
});
const userView = makeContact({
  targetType: 'user',
  targetId: '__user__',
  displayName: '你',
  remark: '你',
  status: 'active',
});

describe('buildVirtualContactGenerationPrompt — initial AI generate', () => {
  const prompt = buildVirtualContactGenerationPrompt({
    ownerAgent,
    ownerProfile,
    contacts: [activeView, blockedView, deletedView],
    intent: 'initial',
    recentContext: emptyRecent,
  });

  it('asks for 3-8 candidates', () => {
    expect(prompt).toMatch(/3[–-]8/);
  });

  it('explicitly tells the model not to copy blocked / deleted as new candidates', () => {
    expect(prompt).toContain('不允许复制已有 blocked / deleted 联系人');
    expect(prompt).toContain('已拉黑联系人（避免重复，不得作为新候选输出）');
    expect(prompt).toContain('已删除联系人（避免重复，不得作为新候选输出）');
  });

  it('lists actual blocked/deleted contact names in their dedicated reference blocks', () => {
    expect(prompt).toContain('黑蛇');
    expect(prompt).toContain('方老师');
  });

  it('makes clear that an empty recent chat is OK and the role profile is enough', () => {
    expect(prompt).toContain('没有最近聊天不代表');
  });

  it('warns against templated names like 黑蛇-危险人物 / 方老师-旧号码', () => {
    expect(prompt).toContain('黑蛇-危险人物');
    expect(prompt).toContain('方老师-旧号码');
  });

  it('does not forbid all-active or mandate blocked/deleted quotas', () => {
    expect(prompt).not.toContain('禁止全员 active');
    expect(prompt).not.toMatch(/至少 1 个 blocked/);
    expect(prompt).not.toMatch(/至少 1 个 deleted/);
    expect(prompt).not.toContain('温和日常也至少应有 1 个 deleted');
    expect(prompt).not.toContain('blocked 与 deleted 合计通常 1–3');
  });

  it('requires reasoned blocked/deleted and allows multi non-active when setting supports', () => {
    expect(prompt).toContain('默认 status=active');
    expect(prompt).toContain('必须言之有理');
    expect(prompt).toContain('2–4');
    expect(prompt).toContain('逐条独立');
  });

  it('does not inject regenerate-only status floor wording', () => {
    expect(prompt).not.toContain('重新生成全部 · status 下限');
  });
});

describe('buildContactRegenerateAllPrompt', () => {
  const prompt = buildContactRegenerateAllPrompt({
    ownerAgent,
    ownerProfile,
    contacts: [activeView, blockedView, deletedView],
    recentContext: emptyRecent,
  });

  it('says manual contacts and manual blocked/deleted will be preserved', () => {
    expect(prompt).toContain('手动编辑过或手动拉黑/删除的虚拟联系人会被保留');
  });

  it('still tells the model not to recreate same-name blocked / deleted entries', () => {
    expect(prompt).toContain('不要试图复现「已拉黑」/「已删除」名单里的同名条目');
  });

  it('requests 8-16 contacts for the full rebuild', () => {
    expect(prompt).toMatch(/8[–-]16/);
  });

  it('includes regenerate-only prompt floor for at least one blocked or deleted', () => {
    expect(prompt).toContain('重新生成全部 · status 下限');
    expect(prompt).toContain('至少出现 1 条 blocked');
    expect(prompt).toContain('1 条 deleted');
    expect(prompt).toContain('不必同时有两种');
    expect(prompt).toContain('2–4 条');
    expect(prompt).toContain('禁止为过关而复制粘贴式硬凑');
  });
});

describe('buildContactIncrementalUpdatePrompt — boundaries are preserved', () => {
  const prompt = buildContactIncrementalUpdatePrompt({
    ownerAgent,
    ownerProfile,
    contacts: [activeView, blockedView],
    smsSummary: [],
    recentContext: emptyRecent,
  });

  it('caps add/block/delete combined to <= 2', () => {
    expect(prompt).toContain('硬性数量');
    expect(prompt).toMatch(/不得超过 2/);
  });

  it('refuses to delete/block user', () => {
    expect(prompt).toContain('不要 delete/block user');
  });

  it('keeps update as the primary action, not mass-add', () => {
    expect(prompt).toContain('本轮不是「造一批新联系人」');
  });

  it('treats no-recent-context as acceptable (no error)', () => {
    expect(prompt).toContain('最近 OpenHanako 聊天上下文');
  });

  it('includes incremental block/delete action guide aligned with reasoned status', () => {
    expect(prompt).toContain('【拉黑 / 已删除 · 仅 virtual_contact');
    expect(prompt).toContain('禁止对 agent 使用 block/delete');
    expect(prompt).toContain('须用户在小手机通讯录内**手动**拉黑/删除');
  });
});

describe('buildSmsHistoryPrompt — profile-driven SMS init', () => {
  const hostileBlocked = makeContact({
    targetType: 'virtual_contact',
    targetId: 'vc-hostile',
    displayName: '线人A',
    status: 'blocked',
    tags: ['危险'],
    faction: '对立',
    impression: '不想再沾边，回复都嫌累。',
    relationshipHint: '已拒绝往来',
  });
  const closeActive = makeContact({
    targetType: 'virtual_contact',
    targetId: 'vc-close',
    displayName: '小夏',
    status: 'active',
    tags: ['亲近的人'],
    faction: '自己人',
    impression: '说话不用过脑子，累了会找她吐槽。',
    relationshipHint: '家人般信任',
  });

  const prompt = buildSmsHistoryPrompt({
    ownerAgent,
    ownerProfile,
    contacts: [hostileBlocked, closeActive],
  });

  it('embeds contact tags/faction/status in the list for the model to consume', () => {
    expect(prompt).toContain('线人A');
    expect(prompt).toContain('危险');
    expect(prompt).toContain('对立');
    expect(prompt).toContain('blocked');
    expect(prompt).toContain('小夏');
    expect(prompt).toContain('亲近的人');
    expect(prompt).toContain('自己人');
  });

  it('requires tone to follow profile and forbids contradicting dangerous/blocked with intimate chat', () => {
    expect(prompt).toContain('【联系人画像驱动');
    expect(prompt).toContain('tags=危险');
    expect(prompt).toContain('亲密热聊');
    expect(prompt).toContain('禁止闺蜜式热聊');
  });

  it('states distinct message count bands including 0–3 for blocked/deleted and 4–10 for close 自己人 active', () => {
    expect(prompt).toMatch(/status=blocked：0[–-]3/);
    expect(prompt).toMatch(/4[–-]10/);
    expect(prompt).toMatch(/2[–-]6/);
  });

  it('schema sample only exposes targetType, targetId, messages under contacts[]', () => {
    const start = prompt.indexOf('输出 schema');
    const end = prompt.indexOf('当前角色:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const schemaBlock = prompt.slice(start, end);
    expect(schemaBlock).toContain('"messages"');
    expect(schemaBlock).not.toContain('"remark"');
    expect(schemaBlock).not.toContain('"impression"');
    expect(schemaBlock).not.toContain('"relationshipHint"');
    expect(schemaBlock).not.toContain('"tags"');
    expect(schemaBlock).not.toContain('"faction"');
    expect(schemaBlock).not.toContain('"status"');
  });

  it('forbids returning address-book fields from the SMS generator', () => {
    expect(prompt).toContain('禁止返回 remark');
    expect(prompt).toContain('只能包含 targetType、targetId、messages');
  });
});

describe('buildSmsIncrementalUpdatePrompt', () => {
  const changeContact = makeContact({
    targetType: 'virtual_contact',
    targetId: 'vc-1',
    displayName: '老周',
    status: 'active',
    impression: '最近有点信不过。',
    tags: ['需要观察'],
    faction: '中立',
  });
  const prompt = buildSmsIncrementalUpdatePrompt({
    ownerAgent,
    ownerProfile,
    changeBundles: [{
      targetType: 'virtual_contact',
      targetId: 'vc-1',
      action: 'update',
      changedFields: ['impression', 'tags'],
      mergedReasons: ['聊天里语气变了'],
      changeLogIds: ['cc-1'],
      contact: changeContact,
      smsSummary: { messageCount: 4, latestContent: '上次见什么时候？' },
    }],
    recentContext: emptyRecent,
  });

  it('identifies incremental SMS updater and caps delete at one message', () => {
    expect(prompt).toContain('短信增量更新器');
    expect(prompt).toContain('action=delete');
    expect(prompt).toContain('最多 1');
  });

  it('includes change bundle reasons and forbids overwriting old messages', () => {
    expect(prompt).toContain('聊天里语气变了');
    expect(prompt).toContain('不要覆盖');
    expect(prompt).toContain('老周');
  });
});

describe('phone prompt builders — lore runtime context section', () => {
  const loreText = [
    '【星野设定参考】',
    '- 标题：边境医院',
    '  分类：地点',
    '  内容：主角任职的小型边境医院。',
  ].join('\n');

  function expectLoreSection(prompt: string) {
    expect(prompt).toContain('【星野设定参考】');
    expect(prompt).toContain('边境医院');
    expect(prompt).toContain('【关于上方"星野设定参考"】');
    expect(prompt).toContain('不要逐字复述');
    expect(prompt).toContain('以最近聊天和角色资料为准');
  }

  function expectNoLeak(prompt: string) {
    expect(prompt).not.toContain('【星野设定参考】');
    expect(prompt).not.toContain('undefined');
    expect(prompt).not.toContain('【关于上方"星野设定参考"】');
  }

  it('includes the lore section when loreContextText is provided to buildSmsHistoryPrompt', () => {
    const prompt = buildSmsHistoryPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      loreContextText: loreText,
    });
    expectLoreSection(prompt);
  });

  it('does not add any lore heading or emit undefined when loreContextText is omitted', () => {
    const prompt = buildSmsHistoryPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
    });
    expectNoLeak(prompt);
  });

  it('does not add any lore heading or emit undefined when loreContextText is empty string', () => {
    const prompt = buildSmsHistoryPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      loreContextText: '',
    });
    expectNoLeak(prompt);
  });

  it('includes the lore section in buildVirtualContactGenerationPrompt', () => {
    const prompt = buildVirtualContactGenerationPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      intent: 'initial',
      recentContext: emptyRecent,
      loreContextText: loreText,
    });
    expectLoreSection(prompt);
  });

  it('omits the lore section in buildVirtualContactGenerationPrompt when loreContextText is empty', () => {
    const prompt = buildVirtualContactGenerationPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      intent: 'initial',
      recentContext: emptyRecent,
      loreContextText: '   ',
    });
    expectNoLeak(prompt);
  });

  it('includes the lore section in buildContactRegenerateAllPrompt', () => {
    const prompt = buildContactRegenerateAllPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      recentContext: emptyRecent,
      loreContextText: loreText,
    });
    expectLoreSection(prompt);
  });

  it('includes the lore section in buildContactIncrementalUpdatePrompt', () => {
    const prompt = buildContactIncrementalUpdatePrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      smsSummary: [],
      recentContext: emptyRecent,
      loreContextText: loreText,
    });
    expectLoreSection(prompt);
  });

  it('omits the lore section in buildContactIncrementalUpdatePrompt when loreContextText is undefined', () => {
    const prompt = buildContactIncrementalUpdatePrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      smsSummary: [],
      recentContext: emptyRecent,
    });
    expectNoLeak(prompt);
  });

  it('includes the lore section in buildSmsIncrementalUpdatePrompt', () => {
    const prompt = buildSmsIncrementalUpdatePrompt({
      ownerAgent,
      ownerProfile,
      changeBundles: [{
        targetType: 'virtual_contact',
        targetId: 'vc-1',
        action: 'update',
        changedFields: ['impression'],
        mergedReasons: ['聊天里有变化'],
        changeLogIds: ['cc-1'],
        contact: activeView,
        smsSummary: { messageCount: 0 },
      }],
      recentContext: emptyRecent,
      loreContextText: loreText,
    });
    expectLoreSection(prompt);
  });

  it('omits the lore section in buildSmsIncrementalUpdatePrompt when loreContextText is undefined', () => {
    const prompt = buildSmsIncrementalUpdatePrompt({
      ownerAgent,
      ownerProfile,
      changeBundles: [{
        targetType: 'virtual_contact',
        targetId: 'vc-1',
        action: 'update',
        changedFields: ['impression'],
        mergedReasons: ['聊天里有变化'],
        changeLogIds: ['cc-1'],
        contact: activeView,
        smsSummary: { messageCount: 0 },
      }],
      recentContext: emptyRecent,
    });
    expectNoLeak(prompt);
  });
});

describe('contact update prompts - user contact updates', () => {
  it('tells incremental update to update the existing user contact with targetId __user__', () => {
    const prompt = buildContactIncrementalUpdatePrompt({
      ownerAgent,
      ownerProfile,
      contacts: [userView, activeView],
      smsSummary: [],
      recentContext: emptyRecent,
    });

    expect(prompt).toContain('targetType=user');
    expect(prompt).toContain('targetId="__user__"');
    expect(prompt).toContain('update user impression');
  });

  it('tells rollback update to update the existing user contact with targetId __user__', () => {
    const prompt = buildContactRollbackAndUpdatePrompt({
      ownerAgent,
      ownerProfile,
      contacts: [userView, activeView],
      smsSummary: [],
      recentContext: emptyRecent,
    });

    expect(prompt).toContain('targetType=user');
    expect(prompt).toContain('targetId="__user__"');
    expect(prompt).toContain('update user impression');
  });

  describe('gender 豁免（通讯录 / 短信不应强制 currentAgent 的代词）', () => {
    /*
     * NPC 各有自己的性别，女性主人也会有男性朋友、男性主人也会有女性同事。
     * speakerContextForPhonePrompt 不传 gender，让模型按各 NPC 自己的 kind / shortBio
     * / impression 决定代词，而不是被 currentAgent 性别带走。
     */
    const femaleOwnerProfile = { ...ownerProfile, gender: 'female' as const };

    it('virtual contact 生成：即使 owner 性别=女，prompt 也不出现 currentAgent 的代词约束段', () => {
      const prompt = buildVirtualContactGenerationPrompt({
        ownerAgent,
        ownerProfile: femaleOwnerProfile,
        contacts: [],
        userName: '莫子',
        recentContext: null,
      });
      expect(prompt).not.toContain('pronoun / 性别与代词约束');
      expect(prompt).not.toContain('必须**使用「她」');
    });

    it('短信历史：同样豁免代词约束段', () => {
      const prompt = buildSmsHistoryPrompt({
        ownerAgent,
        ownerProfile: femaleOwnerProfile,
        contacts: [activeView],
        userName: '莫子',
      });
      expect(prompt).not.toContain('pronoun / 性别与代词约束');
    });

    it('owner 性别仍通过 profile JSON 自然透传（不丢失，仅去强约束段）', () => {
      const prompt = buildVirtualContactGenerationPrompt({
        ownerAgent,
        ownerProfile: femaleOwnerProfile,
        contacts: [],
        userName: '莫子',
        recentContext: null,
      });
      // profile JSON 里 gender 字段会被 stringify 进 prompt，模型仍能读到
      expect(prompt).toContain('"gender": "female"');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SMS 反重复连续性锚点：prompt 透传测试
// ─────────────────────────────────────────────────────────────────────────────
describe('SMS continuityAnchorBlock — prompt 透传', () => {
  it('buildSmsHistoryPrompt：anchor 内容会被注入 prompt 末段', () => {
    const anchor = [
      '@老王 [virtual_contact:vc-active]',
      '- 最近发给这个联系人的短信样本（请避免重复）：',
      '  · [己发] 在吗',
      '  · [对方] 嗯',
    ].join('\n');
    const prompt = buildSmsHistoryPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      continuityAnchorBlock: anchor,
    });
    expect(prompt).toContain('SMS 反重复锚点');
    expect(prompt).toContain('@老王');
    expect(prompt).toContain('[己发] 在吗');
    expect(prompt).toContain('[对方] 嗯');
  });

  it('buildSmsHistoryPrompt：anchor 缺省时显示占位文案', () => {
    const prompt = buildSmsHistoryPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
    });
    expect(prompt).toContain('SMS 反重复锚点');
    expect(prompt).toMatch(/无；这批联系人都还没有 SMS 历史/);
  });

  it('buildSmsIncrementalUpdatePrompt：anchor 内容同样会被注入', () => {
    const anchor = [
      '@老周 [virtual_contact:vc-1]',
      '- 最近发给这个联系人的短信样本：',
      '  · [己发] 上次见什么时候？',
    ].join('\n');
    const changeContact = makeContact({
      targetType: 'virtual_contact',
      targetId: 'vc-1',
      displayName: '老周',
      status: 'active',
    });
    const prompt = buildSmsIncrementalUpdatePrompt({
      ownerAgent,
      ownerProfile,
      changeBundles: [{
        targetType: 'virtual_contact',
        targetId: 'vc-1',
        action: 'update',
        changedFields: ['impression'],
        mergedReasons: ['x'],
        changeLogIds: ['cc-1'],
        contact: changeContact,
        smsSummary: { messageCount: 1, latestContent: '上次见什么时候？' },
      }],
      recentContext: emptyRecent,
      continuityAnchorBlock: anchor,
    });
    expect(prompt).toContain('SMS 反重复锚点');
    expect(prompt).toContain('@老周');
    expect(prompt).toContain('上次见什么时候？');
  });

  it('buildSmsIncrementalUpdatePrompt：anchor 缺省也走占位（无报错）', () => {
    const changeContact = makeContact({
      targetType: 'virtual_contact',
      targetId: 'vc-1',
      displayName: '老周',
      status: 'active',
    });
    const prompt = buildSmsIncrementalUpdatePrompt({
      ownerAgent,
      ownerProfile,
      changeBundles: [{
        targetType: 'virtual_contact',
        targetId: 'vc-1',
        action: 'update',
        changedFields: ['impression'],
        mergedReasons: ['x'],
        changeLogIds: ['cc-1'],
        contact: changeContact,
        smsSummary: { messageCount: 0 },
      }],
      recentContext: emptyRecent,
    });
    expect(prompt).toMatch(/无；这批联系人都还没有 SMS 历史/);
  });
});

describe('SMS contactDetailBlock — 联系人详情页反哺', () => {
  const detailBlock = [
    '- 老王［virtual_contact:vc-active］',
    '  ↳ 详情页：个性签名「岁月不饶人」；IP属地：城南；近期往来（新→旧，背景参考，勿原样照搬成新内容）：电话｜昨夜｜约了下棋',
    '  ↳ 同一个人：此联系人即设定库里的 《老王的杂货铺》——写 TA 时按同一个人处理，人设与事实不得与设定打架，不要拆成两个角色。',
  ].join('\n');

  it('buildSmsHistoryPrompt：详情块与使用规则一起注入', () => {
    const prompt = buildSmsHistoryPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      contactDetailBlock: detailBlock,
    });
    expect(prompt).toContain('联系人详情页补充');
    expect(prompt).toContain('个性签名「岁月不饶人」');
    expect(prompt).toContain('详情页使用规则');
    expect(prompt).toContain('禁止把这些条目原样改写成新短信');
    expect(prompt).toContain('不得写成两个不同的人');
  });

  it('buildSmsHistoryPrompt：缺省 / 占位「（无）」时整段不注入（与旧 prompt 一致）', () => {
    const without = buildSmsHistoryPrompt({ ownerAgent, ownerProfile, contacts: [activeView] });
    expect(without).not.toContain('联系人详情页补充');
    expect(without).not.toContain('详情页使用规则');
    const placeholder = buildSmsHistoryPrompt({
      ownerAgent,
      ownerProfile,
      contacts: [activeView],
      contactDetailBlock: '（无）',
    });
    expect(placeholder).toBe(without);
  });

  it('buildSmsIncrementalUpdatePrompt：详情块同样注入', () => {
    const changeContact = makeContact({
      targetType: 'virtual_contact',
      targetId: 'vc-active',
      displayName: '老王',
      status: 'active',
    });
    const prompt = buildSmsIncrementalUpdatePrompt({
      ownerAgent,
      ownerProfile,
      changeBundles: [{
        targetType: 'virtual_contact',
        targetId: 'vc-active',
        action: 'update',
        changedFields: ['impression'],
        mergedReasons: ['x'],
        changeLogIds: ['cc-1'],
        contact: changeContact,
        smsSummary: { messageCount: 0 },
      }],
      recentContext: emptyRecent,
      contactDetailBlock: detailBlock,
    });
    expect(prompt).toContain('联系人详情页补充');
    expect(prompt).toContain('同一个人');
    expect(prompt).toContain('详情页使用规则');
  });

  it('buildSmsIncrementalUpdatePrompt：缺省不注入', () => {
    const changeContact = makeContact({
      targetType: 'virtual_contact',
      targetId: 'vc-active',
      displayName: '老王',
      status: 'active',
    });
    const prompt = buildSmsIncrementalUpdatePrompt({
      ownerAgent,
      ownerProfile,
      changeBundles: [{
        targetType: 'virtual_contact',
        targetId: 'vc-active',
        action: 'update',
        changedFields: ['impression'],
        mergedReasons: ['x'],
        changeLogIds: ['cc-1'],
        contact: changeContact,
        smsSummary: { messageCount: 0 },
      }],
      recentContext: emptyRecent,
    });
    expect(prompt).not.toContain('联系人详情页补充');
  });
});
