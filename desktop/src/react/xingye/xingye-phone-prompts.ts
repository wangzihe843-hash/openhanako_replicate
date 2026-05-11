import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyePhoneContactView } from './xingye-phone-store';

function contactShape(contact: XingyePhoneContactView) {
  return {
    targetType: contact.targetType,
    targetId: contact.targetId,
    displayName: contact.displayName,
    originalName: contact.originalName,
    kind: contact.kind,
    status: contact.status,
    remark: contact.remark,
    impression: contact.impression,
    relationshipHint: contact.relationshipHint,
    tags: contact.tags,
    faction: contact.faction,
    linkedAgentId: contact.linkedAgentId,
    generatedReason: contact.generatedReason,
    source: contact.source,
  };
}

export function buildContactsEnrichmentPrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
}) {
  const { ownerAgent, ownerProfile, contacts } = params;
  return [
    '你是角色手机通讯录补全器。仅返回严格 JSON，不要 Markdown，不要解释。',
    '目标：补全当前角色视角的联系人 remark / impression / relationshipHint / tags / faction / status 建议。',
    '注意：如果已有字段明显是用户手工内容，不要覆盖；只补缺失或明显占位字段。',
    '联系人包含 user / agent / virtual_contact，并包含 active / blocked / deleted。',
    '输出 schema:',
    JSON.stringify({
      contacts: [{
        targetType: 'user | agent | virtual_contact',
        targetId: 'string',
        remark: 'string',
        impression: 'string',
        relationshipHint: 'string',
        tags: ['string'],
        faction: 'string',
        status: 'active | blocked | deleted',
      }],
    }, null, 2),
    '当前角色:',
    JSON.stringify({
      id: ownerAgent.id,
      name: ownerAgent.name,
      yuan: ownerAgent.yuan,
      profile: ownerProfile ?? null,
    }, null, 2),
    '联系人列表:',
    JSON.stringify(contacts.map(contactShape), null, 2),
  ].join('\n');
}

export function buildSmsHistoryPrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
}) {
  const { ownerAgent, ownerProfile, contacts } = params;
  return [
    '你是角色手机短信历史生成器。仅返回严格 JSON，不要 Markdown，不要解释。',
    '为每个联系人生成 4-12 条过往短信，短信要像手机短消息：短句、碎片、自然。',
    '每条短信尽量 3-30 汉字，少量可到 60，禁止长段、旁白、心理描写、列表建议。',
    'blocked 联系人要体现关系紧张或中断；deleted 联系人要更旧。',
    '输出 schema:',
    JSON.stringify({
      contacts: [{
        targetType: 'user | agent | virtual_contact',
        targetId: 'string',
        messages: [{
          from: 'owner | target',
          content: 'string',
          createdAt: 'ISO string',
        }],
        remark: 'string',
        impression: 'string',
        relationshipHint: 'string',
        tags: ['string'],
        faction: 'string',
        status: 'active | blocked | deleted',
      }],
    }, null, 2),
    '当前角色:',
    JSON.stringify({
      id: ownerAgent.id,
      name: ownerAgent.name,
      yuan: ownerAgent.yuan,
      profile: ownerProfile ?? null,
    }, null, 2),
    '联系人列表:',
    JSON.stringify(contacts.slice(0, 12).map(contactShape), null, 2),
  ].join('\n');
}
