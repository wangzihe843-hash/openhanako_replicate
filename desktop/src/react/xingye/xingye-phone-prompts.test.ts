import { describe, expect, it } from 'vitest';
import type { Agent } from '../types';
import {
  buildContactIncrementalUpdatePrompt,
  buildContactRegenerateAllPrompt,
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
