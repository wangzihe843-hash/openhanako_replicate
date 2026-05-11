import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type {
  XingyeAiGeneratedContact,
  XingyeContactStatus,
  XingyeVirtualContact,
  XingyeVirtualContactKind,
} from './xingye-phone-store';

export type XingyeContactGenerationMode = 'rule' | 'ai';

type GenerateContext = {
  ownerAgentId: string;
  agent: Agent;
  profile: XingyeRoleProfile | null | undefined;
  agents: Agent[];
};

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => text.includes(keyword));
}

export function shouldSkipFamilyContacts(profileText: string): boolean {
  return hasAny(profileText, ['父母双亡', '孤儿', '无父无母', '父母已故', '家人全亡']);
}

export function shouldBlockFamilyContacts(profileText: string): boolean {
  return hasAny(profileText, ['与父母关系不好', '被父母抛弃', '家庭决裂', '与家人断绝关系', '与父母关系恶劣', '长期断联']);
}

function createVirtualContact(
  context: GenerateContext,
  input: {
    displayName: string;
    kind: XingyeVirtualContactKind;
    shortBio?: string;
    relationshipHint?: string;
    tags?: string[];
    faction?: string;
    status?: XingyeContactStatus;
    generatedReason: string;
  },
): XingyeVirtualContact {
  const now = new Date().toISOString();
  return {
    ownerAgentId: context.ownerAgentId,
    id: `vc-${context.ownerAgentId}-${Math.random().toString(36).slice(2, 10)}`,
    displayName: input.displayName,
    kind: input.kind,
    shortBio: input.shortBio,
    relationshipHint: input.relationshipHint,
    tags: input.tags,
    faction: input.faction,
    status: input.status ?? 'active',
    source: 'generated',
    generatedReason: input.generatedReason,
    createdAt: now,
    updatedAt: now,
  };
}

export function generateVirtualContactsForRole(context: GenerateContext): XingyeVirtualContact[] {
  const profileText = [
    context.agent.name,
    context.agent.yuan,
    context.profile?.displayName,
    context.profile?.shortBio,
    context.profile?.relationshipLabel,
    context.profile?.speakingStyle,
    context.profile?.identitySummary,
    context.profile?.backgroundSummary,
    context.profile?.personalitySummary,
    context.profile?.behaviorLogic,
  ].map(normalizeText).join(' ');

  const contacts: XingyeVirtualContact[] = [];
  const push = (entry: Parameters<typeof createVirtualContact>[1]) => {
    if (contacts.length >= 14) return;
    contacts.push(createVirtualContact(context, entry));
  };

  const skipFamily = shouldSkipFamilyContacts(profileText);
  const blockFamily = shouldBlockFamilyContacts(profileText);
  const isolated = hasAny(profileText, ['孤僻', '独来独往', '没有朋友', '不信任任何人']);
  const medical = hasAny(profileText, ['医生', '医师', '护士', '医疗', '药剂', '边境医生']);
  const student = hasAny(profileText, ['学生', '学校', '班级', '老师', '社团']);
  const spy = hasAny(profileText, ['杀手', '间谍', '特工', '黑帮', '卧底']);
  const idol = hasAny(profileText, ['偶像', '艺人', '经纪', '舞台']);

  if (!isolated) {
    push({
      displayName: '旧友',
      kind: 'friend',
      shortBio: '认识很久，但联系时断时续。',
      tags: ['亲近的人'],
      faction: '自己人',
      generatedReason: '本地规则：旧识联系人。',
    });
  }

  if (medical) {
    push({
      displayName: '夜班同事',
      kind: 'coworker',
      shortBio: '在同一线值班，配合默契。',
      tags: ['同伴'],
      faction: '自己人',
      generatedReason: '本地规则：医疗夜班同事。',
    });
    push({
      displayName: '药品供应商',
      kind: 'client',
      shortBio: '负责紧缺药品调配，交集频繁。',
      tags: ['需要观察'],
      faction: '中立',
      generatedReason: '本地规则：紧缺药渠道。',
    });
    push({
      displayName: '匿名线人',
      kind: 'informant',
      shortBio: '偶尔提供关键情报，可信度不稳定。',
      tags: ['不可靠'],
      faction: '中立',
      generatedReason: '本地规则：灰色情报线。',
    });
  }

  if (student) {
    push({
      displayName: '班级同学',
      kind: 'classmate',
      shortBio: '平时会交换作业和小道消息。',
      tags: ['同伴'],
      faction: '中立',
      generatedReason: '本地规则：校园同学。',
    });
    push({
      displayName: '指导老师',
      kind: 'mentor',
      shortBio: '经常给建议，但要求严格。',
      tags: ['需要观察'],
      faction: '自己人',
      generatedReason: '本地规则：校内导师。',
    });
  }

  if (spy) {
    push({
      displayName: '联络上级',
      kind: 'superior',
      shortBio: '只在任务节点出现，信息有限。',
      tags: ['危险'],
      faction: '自己人',
      generatedReason: '本地规则：任务链上级。',
    });
    push({
      displayName: '伪装身份联系人',
      kind: 'unknown',
      shortBio: '仅在特定身份下沟通，真实性待确认。',
      tags: ['需要观察'],
      faction: '未知',
      generatedReason: '本地规则：身份待核实对象。',
    });
  }

  if (idol) {
    push({
      displayName: '经纪人',
      kind: 'superior',
      shortBio: '负责行程和资源协调。',
      tags: ['同伴'],
      faction: '自己人',
      generatedReason: '本地规则：艺人经纪人。',
    });
    push({
      displayName: '制作人',
      kind: 'coworker',
      shortBio: '掌握项目节奏，合作频繁。',
      tags: ['需要观察'],
      faction: '中立',
      generatedReason: '本地规则：舞台制作侧。',
    });
  }

  if (!skipFamily && blockFamily) {
    push({
      displayName: '父亲',
      kind: 'family',
      relationshipHint: '关系恶劣',
      status: 'blocked',
      tags: ['危险'],
      faction: '对立',
      generatedReason: '本地规则：家庭紧张线。',
    });
  }

  if (!skipFamily && !blockFamily && !isolated) {
    push({
      displayName: '家里人',
      kind: 'family',
      shortBio: '偶尔联系，保持基本往来。',
      tags: ['亲近的人'],
      faction: '自己人',
      generatedReason: '本地规则：家庭联络人。',
    });
  }

  if (contacts.length < 3) {
    push({
      displayName: '工作联系人',
      kind: 'coworker',
      shortBio: '日常业务沟通对象。',
      tags: ['同伴', '需要观察'],
      faction: '中立',
      generatedReason: '本地规则：通用同事。',
    });
    push({
      displayName: '熟人',
      kind: 'unknown',
      shortBio: '见面不多，但保持联络。',
      tags: ['需要观察'],
      faction: '中立',
      generatedReason: '本地规则：弱关系熟人。',
    });
    push({
      displayName: '不太熟的人',
      kind: 'rival',
      shortBio: '关系偏紧张，需要留意。',
      tags: ['需要观察', '危险'],
      faction: '对立',
      generatedReason: '本地规则：关系紧张对象。',
    });
  }

  return contacts.slice(0, 14);
}

/** 当 AI 返回联系人数量不足时，用规则池补足；source 由调用方设为 rule_fallback。 */
export function buildRuleFallbackAiContacts(
  context: GenerateContext,
  needed: number,
  excludeNamesLower: Set<string>,
): XingyeAiGeneratedContact[] {
  const pool = generateVirtualContactsForRole(context);
  const out: XingyeAiGeneratedContact[] = [];
  for (const vc of pool) {
    if (out.length >= needed) break;
    const key = vc.displayName.trim().toLowerCase();
    if (!key || excludeNamesLower.has(key)) continue;
    excludeNamesLower.add(key);
    const impression = vc.shortBio?.trim()
      ? vc.shortBio.trim().slice(0, 60)
      : '还没有形成明确印象。';
    out.push({
      targetType: 'virtual_contact',
      displayName: vc.displayName,
      kind: vc.kind,
      shortBio: vc.shortBio,
      remark: vc.remark,
      impression,
      relationshipHint: vc.relationshipHint,
      tags: vc.tags ?? [],
      faction: vc.faction,
      status: vc.status ?? 'active',
      generatedReason: vc.generatedReason ?? '本地规则补全联系人。',
    });
  }
  let suffix = 1;
  while (out.length < needed) {
    const name = `联系人${suffix}`;
    suffix += 1;
    const key = name.toLowerCase();
    if (excludeNamesLower.has(key)) continue;
    excludeNamesLower.add(key);
    out.push({
      targetType: 'virtual_contact',
      displayName: name,
      kind: 'unknown',
      shortBio: '弱关系，偶尔联系。',
      impression: '来往不多，印象不深。',
      relationshipHint: '疏远',
      tags: ['需要观察'],
      faction: '中立',
      status: suffix % 4 === 0 ? 'deleted' : 'active',
      generatedReason: '本地规则：数量补足条目。',
    });
  }
  return out;
}
