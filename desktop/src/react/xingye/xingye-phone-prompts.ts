import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyePhoneContactView } from './xingye-phone-store';
import type { XingyeRecentContext } from './xingye-recent-context';
import { describeRecentContextForPrompt } from './xingye-recent-context';

function contactShape(contact: XingyePhoneContactView) {
  return {
    targetType: contact.targetType,
    targetId: contact.targetId,
    displayName: contact.displayName,
    originalName: contact.originalName,
    kind: contact.kind,
    shortBio: contact.shortBio,
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
    'tags 必须从以下词表中选取 1–3 个（不得为空数组）：亲近的人、需要观察、不可靠、同伴、危险。',
    'faction 必须从以下词表中选一项（不得为空）：自己人、中立、对立、未知。',
    '输出 schema:',
    JSON.stringify({
      contacts: [{
        targetType: 'user | agent | virtual_contact',
        targetId: 'string',
        remark: 'string',
        impression: 'string',
        relationshipHint: 'string',
        tags: ['亲近的人|需要观察|不可靠|同伴|危险'],
        faction: '自己人|中立|对立|未知',
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
    '不要为 targetType=user 的联系人编造新短信；若列表含 user，可省略其 messages 或返回空数组。',
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
  '- impression：当前角色对这个人的主观感受或相处印象，用第一人称视角的自然口语，禁止写功能目的或编剧说明；不得与 generatedReason 同句复述。',
  '- relationshipHint：关系状态标签（如 工作互信、谨慎合作、利益往来、关系紧张、已拉黑、旧识），禁止写开发说明。',
  '- generatedReason：才可写「根据…设定补充…」这类生成依据。',
  '- 用户可见字段禁止出现以下词或句式片段：增加一个、新增一个、添加一个、生成一个、补充一个、强化、体现、用于、根据设定、根据资料、符合、作为角色、角色设定、戏剧张力、功能、模块。',
  '- 若无法确定真实姓名，用自然称呼：夜班同事、药品供应商、老患者、匿名线人、旧友、注意此人、定期复诊、合作医生、线人、供货商 等。',
  '- 不要每次都生成「家里人」；不要无脑生成父母、恋人、同学；资料不足时多生成弱关系（供货商、复诊患者、夜班同事、陌生号码、物业、快递、工作群陌生人）。',
  '- 父母双亡/孤儿：禁止生成在世父母；与父母关系恶劣：可生成家人类但 status 应为 blocked，印象偏负面。',
  '- 输出 contacts 数组；每个对象必须同时有自然的 impression 或 shortBio（至少其一为具象生活化内容，不要模板空话）。',
].join('\n');

const TAG_FACTION_STATUS_RULES = [
  '【tags 强制】每个联系人 tags 为非空数组，元素只能来自：亲近的人、需要观察、不可靠、同伴、危险；建议 1–3 个；禁止全员只剩「需要观察」。',
  '【faction 强制】每个联系人 faction 只能为：自己人、中立、对立、未知；禁止为空；禁止几乎全部「未知」——不确定身份的一两条即可，其余应落在自己人/中立/对立。',
  '【阵营分布参考】在贴合设定的前提下，整体大致：自己人 2–4、中立 2–5、对立 1–3、未知 1–3（可按剧情微调，但禁止全员未知）。',
  '【status 强制】每个联系人 status 必须为 active、blocked、deleted 之一；禁止全员 active。',
  '【status 语义】blocked 可表示纠缠者、危险线人、不可信供应商、越界者、黑市、旧债主等，不必是大反派；deleted 表示旧号码、断联旧友、失效渠道、已离开的同事等软删除，不是人间蒸发。',
  '【status 分布参考】active 约 70%–85%；blocked 与 deleted 合计通常 1–3 人；高压/间谍/黑帮等可略多；温和日常也至少应有 1 个 deleted 表示断联旧人；blocked 若与设定严重冲突可省略，但 deleted 仍建议保留。',
  '【首轮生成硬性】至少 1 个 blocked 或 1 个 deleted；重新生成全部时：至少 1 个 deleted；若角色明显不适合拉黑（全年龄治愈日常且无危险要素），可没有 blocked，但仍须有多种 faction 与 tags。',
  '【禁止】不要把 user 设为 blocked/deleted；不要把已有真实 agent 默认设为 blocked/deleted（除非原数据已是该状态且剧情明确要求）。',
].join('\n');

const CONTACT_JSON_SHAPE = [
  '每个 contact 必须严格包含以下键（不得省略）：',
  JSON.stringify({
    displayName: 'string',
    kind: 'friend|family|coworker|classmate|mentor|rival|enemy|client|patient|informant|superior|subordinate|ex|neighbor|unknown',
    shortBio: 'string',
    remark: 'string',
    impression: 'string',
    relationshipHint: 'string',
    tags: ['亲近的人|需要观察|不可靠|同伴|危险'],
    faction: '自己人|中立|对立|未知',
    status: 'active|deleted|blocked',
    generatedReason: 'string',
  }, null, 2),
].join('\n');

const VIRTUAL_CONTACT_RECENT_CHAT_GUIDE = [
  '【最近 OpenHanako 对话（默认优先参考）】生成虚拟联系人时，先看下一段「最近聊天」是否有可读内容：',
  '- 若有：名单应优先从对话里已出现或可合理映射到手机通讯录的人物、组织、渠道、对立面等衍生（称呼可匿名）；不要机械复述原句进 impression / shortBio。',
  '- 若无或仅有说明、无可用人物：则完全依据「当前角色」资料与下方「现有联系人」列表虚构合理社交圈，不要编造「刚在聊天里说过」的事实。',
  '- 没有最近聊天不代表"无法生成"——角色的人设、生活圈、世界观本身就足够推导出合理的联系人。',
].join('\n');

/** AI 生成联系人：明确禁止把已有 blocked/deleted 当作新候选反复输出。 */
const BLOCKED_DELETED_AVOIDANCE_GUIDE = [
  '【已拉黑 / 已删除联系人 → 只是去重参考，不是生成目标】下文给出的「已拉黑」「已删除」名单仅供你避免重复输出，不要把它们作为新候选再次返回：',
  '- 不允许复制已有 blocked / deleted 联系人的 displayName / remark 作为本批新候选；同名条目会被去重层归并，不会产生第二份。',
  '- 不要反复套用模板化的"黑蛇-危险人物""方老师-旧号码""旧情人-断联""仇人-威胁"这类符号化名字。',
  '- 已有 blocked / deleted 的角色，如果剧情没明确变化，保持不在本批输出里；它们的状态由保存层保留。',
  '- 如果 AI 输出已经存在的 blocked / deleted 联系人，会被合并刷新印象，但不会自动恢复为 active，也不会新增第二条。',
  '- "至少 1 个 blocked / 1 个 deleted"的硬性分布规则只适用于：首次生成且当前完全没有 blocked/deleted；如果当前已经有 blocked 或 deleted，请不要为了凑分布再造同类。',
].join('\n');

/** 虚拟联系人生成：同一人多称呼时不能仅靠 displayName 判重。 */
const SEMANTIC_DEDUP_FOR_VIRTUAL_GENERATION = [
  '【身份去重（优先于 displayName）】现实里同一人常有多个备注名（如「老王」「AAA建材王姐」「豆豆妈」），仅靠 displayName 比对会漏判或误判。',
  '- 每写一条新 contact 之前：对照下方「现有联系人」每一条，以及你本批 contacts 里已写好的条目；综合 shortBio、impression、relationshipHint、kind、以及对话/设定里可识别的身份锚点（职业、亲属关系、摊位/公司、孩子昵称等）判断是否为「实为同一人」。',
  '- 若与某 existing virtual_contact 或 agent 为同一人：不要换 displayName 再造一条平行记录；要么省略该条，要么只保留一条并把身份锚点写进 shortBio，使读者能认出与列表中谁为同一人。',
  '- 若本批内两条不同 displayName 实为同一人：合并为一条输出。',
  '- 仅当你确信在语义上是新角色时，才使用新的 displayName。',
  '- displayName 字面重复仍不允许：本批内不得出现两条完全相同的 displayName（忽略首尾空格、大小写）。',
].join('\n');

function summarizeContactReference(contact: XingyePhoneContactView) {
  return {
    targetType: contact.targetType,
    displayName: contact.displayName,
    remark: contact.remark,
    kind: contact.kind,
    status: contact.status,
    shortBio: contact.shortBio,
    relationshipHint: contact.relationshipHint,
    tags: contact.tags,
    faction: contact.faction,
  };
}

export function buildVirtualContactGenerationPrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  intent?: 'initial' | 'regenerate';
  /** 默认由调用方 `collectRecentContextForAgent` 填入；缺省时 prompt 内仍会写明「无最近聊天则只看资料」。 */
  recentContext?: XingyeRecentContext | null;
}) {
  const { ownerAgent, ownerProfile, contacts } = params;
  const intent = params.intent ?? 'initial';
  const recentContext = params.recentContext ?? {
    agentId: ownerAgent.id,
    messages: [],
    summaryText: '',
    sourceNotes: ['未提供最近聊天上下文；请完全依据当前角色资料与现有联系人列表生成。'],
    hasOpenHanakoMessages: false,
  };
  const countBlock = intent === 'regenerate'
    ? [
      '【流程】运行时已把当前 virtual_contact 表备份为快照；系统只保留最近 2 份快照。手动编辑过或手动拉黑/删除的虚拟联系人会被保留，不在本批清空范围内。',
      '【数量】请输出 8–16 条 virtual_contact（目标可落在 10–14 条左右）；少于 8 条视为不合格。不要试图复现「已拉黑」/「已删除」名单里的同名条目（它们已经存在并保持原状态）。',
      '【关系网】要像角色手机里长期积累的真实社交网：工作、灰色渠道、旧识、威胁、断联号码、拉黑对象等应同时存在，而不是「全员正常好友列表」。',
    ].join('\n')
    : [
      '【边界】本任务只为当前角色补充新的 virtual_contact；不得删除 user/agent，也不得删除任何已有联系人。整表清空仅属于「重新生成全部」流程。',
      '【数量】请输出 3–8 个 virtual_contact 候选（须像真实手机里一小撮联系人，不要贪多）。保存层会自动去重，与已有 active / blocked / deleted 同名联系人不会新增第二条。',
      '【关系网】混合亲近与风险：可信同伴、谨慎合作、对立或勒索者、断联旧人、拉黑对象等可自然共存；人数少时不必强行凑满类型。',
      '【最近聊天可能为空】允许且常见——此时请基于角色人设、身份、世界观推导合理生活联系人（同事/朋友/上司/同学/旧识/家人/医生/店员/邻居/任务相关人物/组织成员/过去关系中的人），不要返回 0 条。',
    ].join('\n');

  const activeContacts = contacts.filter(c => c.status === 'active');
  const blockedContacts = contacts.filter(c => c.status === 'blocked');
  const deletedContacts = contacts.filter(c => c.status === 'deleted');

  const contactsLabel = intent === 'regenerate'
    ? '下列为本次重新生成时仍保留的联系人（user / 真实 agent / 手动维护的虚拟联系人 / 已拉黑 / 已删除）。请用 shortBio、impression、relationshipHint、kind 与之做人设级去重，并避免输出同名条目：'
    : '现有联系人（含 user / agent / 已有 virtual / 已拉黑 / 已删除）。请用 shortBio、impression、relationshipHint、kind 等做人设级去重，勿仅靠 displayName：';

  const lines: string[] = [
    '你是角色手机通讯录里的「虚拟联系人」生成器。只返回 JSON，不要 Markdown，不要解释。',
    '你的任务：为当前角色的小手机生成新的、合理的、非重复联系人。',
    '主要输入：当前角色人设 / 身份 / 世界观、已有联系人、最近聊天摘要（如有）。',
    countBlock,
  ];
  lines.push(SEMANTIC_DEDUP_FOR_VIRTUAL_GENERATION);
  lines.push(
    BLOCKED_DELETED_AVOIDANCE_GUIDE,
    VIRTUAL_CONTACT_RECENT_CHAT_GUIDE,
    describeRecentContextForPrompt(recentContext),
    TAG_FACTION_STATUS_RULES,
    VISIBLE_FIELD_RULES,
    CONTACT_JSON_SHAPE,
    '输出顶层 schema:',
    JSON.stringify({
      contacts: ['见上每个 contact 的形状'],
    }, null, 2),
    '当前角色:',
    JSON.stringify({
      id: ownerAgent.id,
      name: ownerAgent.name,
      yuan: ownerAgent.yuan,
      profile: ownerProfile ?? null,
    }, null, 2),
    contactsLabel,
    JSON.stringify(activeContacts.map(contactShape), null, 2),
    '【已拉黑联系人（避免重复，不得作为新候选输出）】:',
    JSON.stringify(blockedContacts.map(summarizeContactReference), null, 2),
    '【已删除联系人（避免重复，不得作为新候选输出）】:',
    JSON.stringify(deletedContacts.map(summarizeContactReference), null, 2),
  );
  return lines.join('\n');
}

export function buildContactRegenerateAllPrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  recentContext?: XingyeRecentContext | null;
}) {
  return buildVirtualContactGenerationPrompt({ ...params, intent: 'regenerate' });
}

const RECENT_CONTEXT_GUIDE = [
  '【最近 OpenHanako 聊天】下面给出的「最近聊天」是当前角色与用户最近一次原生对话片段，作为本轮更新的主要参考：',
  '- 提取最近聊天中出现的人物、组织/势力、地点/渠道、关系变化、冲突、合作、旧识、风险信号。',
  '- 重心：凡能在当前联系人列表里对上号的人（用 targetId 或 matchName 精确匹配），优先各返回一条 update，重点调 patch.tags 与 patch.impression（可酌情改 relationshipHint / faction；不要为凑字段大面积改 remark）。',
  '- 尽量不新增联系人：批量「造名单」应走「AI 生成联系人」等流程。仅当聊天里出现明确新人且无法与任何现有联系人视为同一人时，才考虑 add；且全轮 add 不得超过 2 条，默认以 0 条 add 为目标。',
  '- 不要因为聊天没提到某联系人就删除它；未在聊天中出现的联系人不要返回 update。',
  '- 明显断联 / 危险 / 旧号码 / 拉黑暗示且证据充分时，才用 block 或 delete；可疑但不确定 → 只用 update 调 tags（如「需要观察」「危险」）而非 block/delete。',
  '- 严禁把聊天原文直接复制到 impression / remark / relationshipHint / shortBio；要用自然通讯录措辞改写。',
  '- 严禁出现"根据聊天记录""根据最近对话""强化设定""新增一个"等生成器语言。reason / generatedReason 可解释依据，但不要复述聊天原句。',
  '- 如「最近聊天」标注为「（无）」，请不要凭空编造关系变化，仅在必要时基于角色资料做小幅 patch。',
].join('\n');

/** 增量更新 / 回滚后更新专用：与「初次生成整本通讯录」的 TAG 分布规则区分，避免模型为凑人数而乱 add/block。 */
const INCREMENTAL_VS_TAG_FACTION_RULES = [
  '【与下方 TAG_FACTION_STATUS_RULES 的关系】该段规则用于保证：凡出现在你输出的 add.contact 或 update.patch 里的 tags/faction/status 等字段，枚举值合法、tags 非空。',
  '它不要求本轮把整个通讯录凑成「初次生成」时的全局人数比例或「至少若干 blocked」；禁止为凑分布而批量 add、block、delete。',
].join('\n');

export function buildContactIncrementalUpdatePrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  smsSummary: Array<{ targetType: string; targetId: string; latest?: string; count: number }>;
  recentContext?: XingyeRecentContext | null;
}) {
  const { ownerAgent, ownerProfile, contacts, smsSummary, recentContext } = params;
  const recentBlock = recentContext
    ? describeRecentContextForPrompt(recentContext)
    : '最近 OpenHanako 聊天上下文：（无）';
  return [
    '你是角色手机通讯录增量更新器。只返回 JSON，不要 Markdown，不要解释。',
    '【规模与重心】本轮不是「造一批新联系人」。批量拉人请用「AI 生成联系人」等入口。本轮以 update 为主：最近聊天里能对上现有联系人的 NPC，应逐条 update，优先 patch.tags 与 patch.impression。',
    '【硬性数量】本轮 updates 中 action 为 add、block、delete 的条数合计不得超过 2（含 0）；其中 add 单独也不得超过 2 条，且默认尽量 0 条 add。restore 仅在有明确剧情需要时少量使用。',
    '【add 的 contact】必须满足与虚拟联系人生成相同的字段强制：tags 非空且来自固定词表；faction 非空；status 非空；impression 非空；generatedReason 不得写入 impression。',
    TAG_FACTION_STATUS_RULES,
    INCREMENTAL_VS_TAG_FACTION_RULES,
    '【字段边界】add 时的 contact 对象遵守与虚拟联系人生成相同规则：用户可见字段禁止写任务说明或编剧指令；只有 generatedReason 写生成依据；只有顶层 reason 写「为什么执行该 action」。',
    VISIBLE_FIELD_RULES,
    RECENT_CONTEXT_GUIDE,
    '规则：不要删除真实 agent；不要 delete/block user；对 virtual_contact 可以 add/update/delete/block/restore。',
    '未在最近聊天或当前联系人中明确提到的联系人，保持原样不要返回它的 update。',
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
          tags: ['亲近的人|需要观察|不可靠|同伴|危险'],
          faction: '自己人|中立|对立|未知',
          status: 'active|deleted|blocked',
          generatedReason: 'string',
        },
        patch: {
          remark: 'string',
          impression: 'string',
          relationshipHint: 'string',
          tags: ['亲近的人|需要观察|不可靠|同伴|危险'],
          faction: '自己人|中立|对立|未知',
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
    recentBlock,
  ].join('\n');
}

export function buildContactRollbackAndUpdatePrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  smsSummary: Array<{ targetType: string; targetId: string; latest?: string; count: number }>;
  recentContext?: XingyeRecentContext | null;
}) {
  const { ownerAgent, ownerProfile, contacts, smsSummary, recentContext } = params;
  const recentBlock = recentContext
    ? describeRecentContextForPrompt(recentContext)
    : '最近 OpenHanako 聊天上下文：（无）';
  return [
    '你是角色手机通讯录「回滚后微调」更新器。只返回 JSON，不要 Markdown，不要解释。',
    '上下文：联系人列表已恢复到上一快照；请在当前规模上做小幅修订，而不是清空重建。',
    '【规模与重心】与「更新联系人」一致：以 update 为主，逐条对齐最近聊天里能匹配上的联系人，优先 patch.tags 与 patch.impression。批量新增名单请走「AI 生成联系人」。',
    '【硬性数量】本轮 updates 中 action 为 add、block、delete 的条数合计不得超过 2（含 0）；add 单独也不得超过 2 条，默认尽量 0 条 add。不要 delete/block user；不要删除 agent。',
    '【字段强制】add 或 patch 若含 tags/faction/status，须遵守固定词表与非空规则；tags 不得为空数组；不要求为凑分布而强行改全员 status。',
    '【字段边界】与增量更新相同：用户可见字段禁止开发说明；generatedReason 仅用于 add 的联系人；reason 仅解释 action。',
    VISIBLE_FIELD_RULES,
    TAG_FACTION_STATUS_RULES,
    INCREMENTAL_VS_TAG_FACTION_RULES,
    RECENT_CONTEXT_GUIDE,
    '未在最近聊天或当前联系人中明确提到的联系人，保持原样不要返回它的 update。',
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
          tags: ['亲近的人|需要观察|不可靠|同伴|危险'],
          faction: '自己人|中立|对立|未知',
          status: 'active|deleted|blocked',
          generatedReason: 'string',
        },
        patch: {
          remark: 'string',
          impression: 'string',
          relationshipHint: 'string',
          tags: ['亲近的人|需要观察|不可靠|同伴|危险'],
          faction: '自己人|中立|对立|未知',
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
    recentBlock,
  ].join('\n');
}
