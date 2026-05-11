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
    '禁止把编剧说明、任务说明、生成理由写进 remark / impression / relationshipHint（要像真实通讯录里的自然措辞）。',
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

const VISIBLE_FIELD_RULES = [
  '【字段边界】必须严格区分用户可见字段与内部说明：',
  '- 用户可见：displayName、shortBio、remark、impression、relationshipHint、tags、faction、status。',
  '- 内部说明：仅 generatedReason 可写「为什么生成这个联系人」；不要把这些说明写进 impression/shortBio/remark。',
  '- displayName：必须像真实手机通讯录里的联系人称呼（可匿名），禁止写「增加一个…」「新增一个…」「生成一个…」「补充一个…」等任务句式。',
  '- shortBio：一句话身份/关系简介（谁、在什么场景出现），禁止写生成理由或设计目的。',
  '- impression：当前角色对这个人的主观感受或相处印象，用第一人称视角的自然口语，禁止写功能目的或编剧说明。',
  '- relationshipHint：关系状态标签（如 工作互信、谨慎合作、利益往来、关系紧张、已拉黑、旧识），禁止写开发说明。',
  '- generatedReason：才可写「根据…设定补充…」这类生成依据。',
  '- 用户可见字段禁止出现以下词或句式片段：增加一个、新增一个、添加一个、生成一个、补充一个、强化、体现、用于、根据设定、根据资料、符合、作为角色、角色设定、戏剧张力、功能、模块。',
  '- 若无法确定真实姓名，用自然称呼：夜班同事、药品供应商、老患者、匿名线人、旧友、注意此人、定期复诊、合作医生、线人、供货商 等。',
  '- 不要每次都生成「家里人」；不要无脑生成父母、恋人、同学；资料不足时多生成弱关系（供货商、复诊患者、夜班同事、陌生号码、物业、快递、工作群陌生人）。',
  '- 父母双亡/孤儿：禁止生成在世父母；与父母关系恶劣：可生成家人类但 status 应为 blocked，印象偏负面。',
  '- 输出 contacts 数组；每个对象必须同时有自然的 impression 或 shortBio（至少其一为具象生活化内容，不要模板空话）。',
].join('\n');

export function buildVirtualContactGenerationPrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  intent?: 'initial' | 'regenerate';
}) {
  const { ownerAgent, ownerProfile, contacts } = params;
  const intent = params.intent ?? 'initial';
  const countBlock = intent === 'regenerate'
    ? [
      '【数量】重新生成全部 virtual_contact：目标 8–12 个；至少 6 个；最多 14 个。必须填满到至少 6 个；不足视为错误。',
      '去重：displayName 不要与下列现有联系人重复；同类弱关系可拆成不同具体称呼。',
    ].join('\n')
    : [
      '【数量】首次 AI 生成 virtual_contact：目标 6–10 个；至少 5 个；最多 12 个。必须至少输出 5 个；不足视为错误。',
      '去重：displayName 不要与下列现有联系人重复。',
    ].join('\n');

  return [
    '你是角色手机通讯录里的「虚拟联系人」生成器。只返回 JSON，不要 Markdown，不要解释。',
    countBlock,
    VISIBLE_FIELD_RULES,
    '输出 schema:',
    JSON.stringify({
      contacts: [{
        displayName: 'string',
        kind: 'friend|family|coworker|classmate|mentor|rival|enemy|client|patient|informant|superior|subordinate|ex|neighbor|unknown',
        shortBio: 'string',
        remark: 'string',
        impression: 'string',
        relationshipHint: 'string',
        tags: ['string'],
        faction: 'string',
        status: 'active|deleted|blocked',
        generatedReason: 'string',
      }],
    }, null, 2),
    '当前角色:',
    JSON.stringify({
      id: ownerAgent.id,
      name: ownerAgent.name,
      yuan: ownerAgent.yuan,
      profile: ownerProfile ?? null,
    }, null, 2),
    '现有联系人（用于去重和关系参考）:',
    JSON.stringify(contacts.map(contactShape), null, 2),
  ].join('\n');
}

export function buildContactRegenerateAllPrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
}) {
  return buildVirtualContactGenerationPrompt({ ...params, intent: 'regenerate' });
}

export function buildContactIncrementalUpdatePrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  smsSummary: Array<{ targetType: string; targetId: string; latest?: string; count: number }>;
}) {
  const { ownerAgent, ownerProfile, contacts, smsSummary } = params;
  return [
    '你是角色手机通讯录增量更新器。只返回 JSON，不要 Markdown，不要解释。',
    '【规模】本次更新：新增 virtual_contact 建议 1–4 个；对已有联系人执行 update 建议 2–6 条；避免大量 delete；优先用 block/restore 表达关系变化。',
    '【字段边界】add 时的 contact 对象遵守与虚拟联系人生成相同规则：用户可见字段禁止写任务说明或编剧指令；只有 generatedReason 写生成依据；只有顶层 reason 写「为什么执行该 action」。',
    VISIBLE_FIELD_RULES,
    '规则：不要删除真实 agent；不要 delete/block user；对 virtual_contact 可以 add/update/delete/block/restore。',
    '输出 schema:',
    JSON.stringify({
      updates: [{
        action: 'add|update|delete|block|restore',
        targetType: 'user|agent|virtual_contact',
        targetId: 'string optional',
        matchName: 'string optional',
        contact: {
          displayName: 'string',
          kind: 'string',
          shortBio: 'string',
          remark: 'string',
          impression: 'string',
          relationshipHint: 'string',
          tags: ['string'],
          faction: 'string',
          status: 'active|deleted|blocked',
          generatedReason: 'string',
        },
        patch: {
          remark: 'string',
          impression: 'string',
          relationshipHint: 'string',
          tags: ['string'],
          faction: 'string',
          status: 'active|deleted|blocked',
        },
        reason: 'string',
      }],
    }, null, 2),
    '角色资料:',
    JSON.stringify({ id: ownerAgent.id, name: ownerAgent.name, profile: ownerProfile ?? null }, null, 2),
    '当前联系人:',
    JSON.stringify(contacts.map(contactShape), null, 2),
    '最近短信摘要:',
    JSON.stringify(smsSummary, null, 2),
  ].join('\n');
}

export function buildContactRollbackAndUpdatePrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  smsSummary: Array<{ targetType: string; targetId: string; latest?: string; count: number }>;
}) {
  const { ownerAgent, ownerProfile, contacts, smsSummary } = params;
  return [
    '你是角色手机通讯录「回滚后微调」更新器。只返回 JSON，不要 Markdown，不要解释。',
    '上下文：联系人列表已恢复到上一快照；请在当前规模上做小幅修订，而不是清空重建。',
    '【规模】允许新增 virtual_contact 1–3 个；允许对若干已有联系人 update（重点改 impression、relationshipHint、status、shortBio）；避免大规模 delete；不要 delete/block user；不要删除 agent。',
    '【字段边界】与增量更新相同：用户可见字段禁止开发说明；generatedReason 仅用于 add 的联系人；reason 仅解释 action。',
    VISIBLE_FIELD_RULES,
    '输出 schema:',
    JSON.stringify({
      updates: [{
        action: 'add|update|delete|block|restore',
        targetType: 'user|agent|virtual_contact',
        targetId: 'string optional',
        matchName: 'string optional',
        contact: {
          displayName: 'string',
          kind: 'string',
          shortBio: 'string',
          remark: 'string',
          impression: 'string',
          relationshipHint: 'string',
          tags: ['string'],
          faction: 'string',
          status: 'active|deleted|blocked',
          generatedReason: 'string',
        },
        patch: {
          remark: 'string',
          impression: 'string',
          relationshipHint: 'string',
          tags: ['string'],
          faction: 'string',
          status: 'active|deleted|blocked',
        },
        reason: 'string',
      }],
    }, null, 2),
    '角色资料:',
    JSON.stringify({ id: ownerAgent.id, name: ownerAgent.name, profile: ownerProfile ?? null }, null, 2),
    '当前联系人:',
    JSON.stringify(contacts.map(contactShape), null, 2),
    '最近短信摘要:',
    JSON.stringify(smsSummary, null, 2),
  ].join('\n');
}
