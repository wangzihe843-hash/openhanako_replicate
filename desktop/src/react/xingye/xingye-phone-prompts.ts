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
    '任务：为每个联系人生成 4-12 条“旧短信”，像真实手机消息，不是小说对白，不是建议清单。',
    '长度规则：每条尽量 3-30 个汉字；允许少量 30-60 字短信，但占比要很低。',
    '禁止：Markdown、旁白、动作描写、心理描写、ChatGPT 式长回复、说教语气。',
    '时间规则：不要把所有消息写在同一分钟；createdAt 必须分布在过去几天/几周/几个月。',
    'active 联系人可有近期消息；blocked 联系人的最后消息更冷淡或中断；deleted 联系人消息更久远。',
    'virtual_contact 的语气要符合 kind 与 generatedReason；user 联系人要符合当前角色关系，默认不要过度亲密。',
    '短信风格要像手机里常见短句：确认、提醒、试探、遗漏信息、简短应答。',
    '好例子：药到了，老地方取。| 别回头。| 你又熬夜了？| 我没事。| 别再联系我。',
    '坏例子：作为你的朋友我建议三点。| 她看着屏幕手指停顿。| 在这个时代我们都需要互相扶持。',
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
