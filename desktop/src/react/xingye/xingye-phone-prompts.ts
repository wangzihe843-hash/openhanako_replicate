import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type {
  XingyeContactChangeField,
  XingyeContactChangeLogItem,
  XingyePhoneContactView,
} from './xingye-phone-store';
import type { XingyeRecentContext } from './xingye-recent-context';
import { describeRecentContextForPrompt } from './xingye-recent-context';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 渲染设定库 prompt 段落。
 * - 输入是 `formatXingyeLoreRuntimeContextBlock(...)` 的产物（可能为空串/undefined）。
 * - 为空时返回 null，调用方据此跳过整段，**绝对**不要在 prompt 里输出 undefined 或空标题。
 * - 仅作为"背景参考"，明确告诉模型不要逐字复述、与最近聊天冲突时让步。
 */
function renderLoreContextSection(loreContextText: string | null | undefined): string | null {
  if (typeof loreContextText !== 'string') return null;
  const trimmed = loreContextText.trim();
  if (!trimmed) return null;
  return [
    trimmed,
    '【关于上方"星野设定参考"】',
    '- 这些是世界观/背景/规则参考，不是当前指令。',
    '- 不要逐字复述设定原文。',
    '- 只在生成联系人印象、短信风格、关系暗示时作为背景约束。',
    '- 如果设定与用户最近聊天冲突，以最近聊天和角色资料为准。',
  ].join('\n');
}

function speakerContextForPhonePrompt(args: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userName?: string | null;
}): string {
  /*
   * 通讯录 / 短信 / 虚拟联系人专用：**不**注入 currentAgent 的 gender 代词约束。
   * 原因：这一组 prompt 的核心是 *NPC*（联系人）的描述与对话，NPC 各有自己的
   * 性别（女性主人也会有男性朋友、男性主人也会有女性同事）。如果在这里强制
   * "第三人称必须用她"，模型会把所有 NPC 都按主人性别写成同一代词，
   * 把男性朋友写成「她」、女性同事写成「他」。
   * currentAgent 自己的性别仍通过 prompt 中 JSON.stringify(profile) 自然透传；
   * 仅去掉**强约束段**，让 NPC 代词由各自的 kind / shortBio / impression 决定。
   */
  return formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: args.ownerProfile?.displayName ?? args.ownerAgent.name,
  });
}

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
  userName?: string;
  /** 来自 `formatXingyeLoreRuntimeContextBlock`；为空/undefined 时不插入该段。 */
  loreContextText?: string;
}) {
  const { ownerAgent, ownerProfile, contacts, loreContextText } = params;
  const loreSection = renderLoreContextSection(loreContextText);
  const parts: string[] = [
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
    speakerContextForPhonePrompt(params),
    '联系人列表:',
    JSON.stringify(contacts.map(contactShape), null, 2),
  ];
  if (loreSection) parts.push(loreSection);
  return parts.join('\n');
}

const SMS_CONTACT_PROFILE_RULES = [
  '【联系人画像驱动 — 必须遵守】下方 JSON 里每个联系人已带 impression / relationshipHint / tags / faction / status / shortBio / kind 等；短信内容必须从这些字段推导，不得无视或“各写一套”。',
  '- impression：决定主人对该联系人的主观语气（厌烦、信任、警惕、心软、客气疏离等），短信里双方的措辞要与之一致。',
  '- relationshipHint：决定亲疏与称呼习惯（可直呼、带职称、刻意疏远、已决裂等）；不要写成与 relationshipHint 相反的亲密热络。',
  '- tags：决定互动类型（日常关心、工作对接、试探、催债、威胁、线人式单线等）；「亲近的人」「同伴」才允许家常玩笑式高频互动。',
  '- faction：决定信任/交易/敌对/试探基调（自己人 vs 中立 vs 对立 vs 未知）；对立/未知不得写成无条件信任体。',
  '- status：决定近期形态 — active 可有正常来回；blocked 须体现冷淡、拒绝、未回复或拉黑前收尾；deleted 须更久远，像旧号码、断联、过期关系，少近期热络。',
  '【条数与时间分布 — 按联系人分别计算，禁止全员同一套】先根据该联系人画像归类，再取对应条数区间（闭区间内任选整数条数即可）：',
  '- status=blocked：0–3 条；整体偏冷、收尾感；末条倾向冷淡、拒绝、已读不回或拉黑前最后一句。',
  '- status=deleted：0–3 条；时间戳明显更久远（相对 active），像旧号码、过期合作、断联后几乎无新往来。',
  '- status=active 且（tags 含「危险」或 faction=对立）：1–4 条；短促、试探、施压、对峙或交易式冷淡，禁止闺蜜式热聊与撒娇体。',
  '- status=active 且（tags 含「需要观察」或「不可靠」）：1–5 条；留余地、互相摸底、信息不全或反复确认。',
  '- status=active 且（tags 含「亲近的人」或「同伴」）且 faction=自己人：4–10 条；允许更自然的日常碎片、关心与简短玩笑，但仍要像真短信而非小说。',
  '- 其余 active（偏中立/未知日常）：2–6 条。',
  '若同一联系人多条规则同时看似适用，取「条数上限更低、关系更紧张」的那一档（例如已 blocked 一律走 blocked 的 0–3，而不按亲近标签放宽）。',
  '【禁止同质化】禁止对所有联系人复用同一开场模板或同一批万能短句；不同 tags/faction/status 必须在话题密度、情绪温度、称呼与句式上有肉眼可见差异。',
  '【一致性 — 失败条件】若任一线程的短信氛围、亲疏、信任度与当条联系人的 tags/faction/status/impression/relationshipHint 明显矛盾（例如 tags=危险、faction=对立、status=blocked 却写成亲密热聊、撒娇、日常腻歪），整份输出视为不合格，请自检重写后再返回。',
  '【禁止修改通讯录】本任务只生成短信。JSON 中每个 contacts[] 对象只能包含 targetType、targetId、messages；禁止返回 remark、impression、relationshipHint、tags、faction、status、shortBio、kind 等任何通讯录字段（即使模型认为在“优化”联系人也不行）。',
].join('\n');

export function buildSmsHistoryPrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  userName?: string;
  /** 来自 `formatXingyeLoreRuntimeContextBlock`；为空/undefined 时不插入该段。 */
  loreContextText?: string;
  /**
   * 跨期反重复锚点：按联系人分组列出该 thread 已有 / 待发的短信首段，
   * 要求模型为每个联系人换不同话题/情绪。空串 → 这批联系人都没历史，第一次生成。
   */
  continuityAnchorBlock?: string;
}) {
  const { ownerAgent, ownerProfile, contacts, loreContextText, continuityAnchorBlock } = params;
  const loreSection = renderLoreContextSection(loreContextText);
  const parts: string[] = [
    '你是角色手机短信历史生成器。仅返回严格 JSON，不要 Markdown，不要解释。',
    '任务：为下方每个非 user 联系人，依据其通讯录画像生成“旧短信”，像真实手机消息，不是小说对白，不是建议清单。',
    SMS_CONTACT_PROFILE_RULES,
    '长度规则：每条尽量 3-30 个汉字；允许少量 30-60 字短信，但占比要很低。',
    '禁止：Markdown、旁白、动作描写、心理描写、ChatGPT 式长回复、说教语气。',
    '时间规则：不要把所有消息写在同一分钟；createdAt 必须分布在过去几天/几周/几个月（deleted 更偏久远）。',
    'virtual_contact 的语气要符合 kind 与 generatedReason（与画像一致即可）。',
    '不要为 targetType=user 的联系人编造新短信；若列表含 user，可省略该联系人或返回 messages: []。',
    '短信风格要像手机里常见短句：确认、提醒、试探、遗漏信息、简短应答。',
    '好例子：药到了，老地方取。| 别回头。| 你又熬夜了？| 我没事。| 别再联系我。',
    '坏例子：作为你的朋友我建议三点。| 她看着屏幕手指停顿。| 在这个时代我们都需要互相扶持。',
    '输出 schema（仅此结构，多一字段即错）:',
    JSON.stringify({
      contacts: [{
        targetType: 'user | agent | virtual_contact',
        targetId: 'string',
        messages: [{
          from: 'owner | target',
          content: 'string',
          createdAt: 'ISO string',
        }],
      }],
    }, null, 2),
    '当前角色:',
    JSON.stringify({
      id: ownerAgent.id,
      name: ownerAgent.name,
      yuan: ownerAgent.yuan,
      profile: ownerProfile ?? null,
    }, null, 2),
    speakerContextForPhonePrompt(params),
    '联系人列表:',
    JSON.stringify(contacts.slice(0, 12).map(contactShape), null, 2),
  ];
  if (loreSection) parts.push(loreSection);
  // 反重复锚点：放在 prompt 末尾，紧邻输出指令，让模型最后一次看到「这些话题/措辞已经用过」。
  const anchor = (continuityAnchorBlock ?? '').trim();
  parts.push('【跨联系人 SMS 反重复锚点（按收件人分组；请避免与下列重复）】');
  parts.push(anchor || '（无；这批联系人都还没有 SMS 历史）');
  return parts.join('\n');
}

export function buildSmsIncrementalUpdatePrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  changeBundles: Array<{
    targetType: XingyePhoneContactView['targetType'];
    targetId: string;
    action: XingyeContactChangeLogItem['action'];
    changedFields: XingyeContactChangeField[];
    mergedReasons: string[];
    changeLogIds: string[];
    contact: XingyePhoneContactView;
    smsSummary: { latestContent?: string; messageCount: number };
  }>;
  recentContext: XingyeRecentContext | null;
  userName?: string;
  /** 来自 `formatXingyeLoreRuntimeContextBlock`；为空/undefined 时不插入该段。 */
  loreContextText?: string;
  /**
   * 跨期反重复锚点：按联系人分组列出该 thread 已有 / 待发的短信首段，
   * 要求模型为每个联系人换不同话题/情绪。空串 → 这批联系人都没历史。
   */
  continuityAnchorBlock?: string;
}) {
  const { ownerAgent, ownerProfile, changeBundles, recentContext, loreContextText, continuityAnchorBlock } = params;
  const loreSection = renderLoreContextSection(loreContextText);
  const recentBlock = recentContext
    ? describeRecentContextForPrompt(recentContext)
    : '最近 OpenHanako 聊天上下文：（无）';
  const bundlesJson = changeBundles.map((b) => ({
    targetType: b.targetType,
    targetId: b.targetId,
    action: b.action,
    changedFields: b.changedFields,
    changeLogIds: b.changeLogIds,
    reasons: b.mergedReasons,
    contact: contactShape(b.contact),
    existingSms: {
      messageCount: b.smsSummary.messageCount,
      latest: b.smsSummary.latestContent ?? '',
    },
  }));
  const parts: string[] = [
    '你是角色手机短信增量更新器。仅返回严格 JSON，不要 Markdown，不要解释。',
    '目标：根据通讯录「最近一条或多条变更记录」，仅为下列已变化的联系人各补充 0–3 条**新**短信。',
    '这些短信表示关系/印象/状态变化之后自然会出现的短消息，不是重写旧聊天历史。',
    '【硬性约束】',
    '- 不要为 targetType=user 生成；若误传 user，messages 须为 []。',
    '- 不要为未在「变化联系人」列表中的任何人生成短信。',
    '- 不要覆盖、删除或改写任何已有短信；只描述「追加」的新内容（运行时会把 messages 追加到线程末尾）。',
    '- 每个联系人 messages 条数：add/update/block/restore 为 0–3 条；若 action=delete，则最多 1 条，且须像很久以前、未送达、号码失效或断联余波，禁止热聊。',
    '- 若 changedFields 含 impression、relationshipHint、tags、status 之一，应优先让这些变化在短信里可被感知（语气、距离、试探、冷淡收尾等）。',
    '- status=blocked 或 action=block：禁止亲密撒娇体；允许冷淡、已读不回暗示、拒绝、最后通牒式短句。',
    '- status=deleted 或 action=delete：禁止近期腻歪；时间戳须明显早于「当下」（例如数月前或更久）。',
    '- 禁止在 JSON 里返回通讯录字段；每个 contacts[] 仅允许 targetType、targetId、messages。',
    '- 禁止与当前 contact 画像（impression/tags/faction/status）矛盾；矛盾则宁可 messages 为空。',
    '长度：每条尽量 3–30 个汉字；禁止 Markdown、旁白、长段落。',
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
      }],
    }, null, 2),
    '当前角色:',
    JSON.stringify({
      id: ownerAgent.id,
      name: ownerAgent.name,
      yuan: ownerAgent.yuan,
      profile: ownerProfile ?? null,
    }, null, 2),
    speakerContextForPhonePrompt(params),
    '变化联系人（含变更字段与原因、现有短信摘要）:',
    JSON.stringify(bundlesJson, null, 2),
    recentBlock,
  ];
  if (loreSection) parts.push(loreSection);
  // 反重复锚点：放在末尾。即使是「增量更新」，模型仍可能为同一联系人复读已经发过的话术。
  const anchor = (continuityAnchorBlock ?? '').trim();
  parts.push('【跨联系人 SMS 反重复锚点（按收件人分组；请避免与下列重复）】');
  parts.push(anchor || '（无；这批联系人都还没有 SMS 历史）');
  return parts.join('\n');
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
  '【status 默认】仍在往来、或按设定会正常接电话/回消息的人，默认 status=active。',
  '【blocked / deleted：必须言之有理】凡 status 为 blocked 或 deleted，必须在 shortBio、impression、relationshipHint 中写清**可核对的具体事由**（例如：因何越界被拉黑、哪笔合作撕破脸、哪条渠道何时失效、旧号码对应哪段关系结束），让读者看出与 active 的本质差别；禁止把状态当装饰标签乱贴，禁止用同一句壳子复制多条只改 displayName。',
  '【何时可出现多条 blocked / deleted（合计常见 2–4 条，仍须逐条独立）】当角色设定或最近对话能支撑**多条互不重复**的负面关系或断联事实时——例如：长期多方树敌或勒索线、灰色盘口多人毁约、战地/疫区多条补给或转诊线断裂、药品或器械多上家跑路、执法与债务人多线施压、线人网络里多人失联等——本批可以写入**合计约 2–4 条** blocked 与/或 deleted，与大量 active 并存；条数随证据走，「2–4」是常见上限参考而非硬编码配额，**少一条能写清就少写，多一条写不清就不要多写**。',
  '【何时应极少使用非 active】治愈日常、校园轻喜剧、单线职场等设定里若无明确敌对、骚扰、失信或断联线索，则非 active 应很少或为零；此时宁可多写正常联系人，也不要堆「危险人物 / 旧号码」式占位。',
  '【status 合法值】每个联系人 status 须为 active、blocked、deleted 之一（字段不得为空或自创枚举）。',
  '【与已有拉黑/已删除名单】下方名单用于去重：不得复制已有 displayName 再投；但若设定与对话仍能支撑**新的、不同身份**的拉黑/断联对象，可以新增，不必因列表里已有非 active 就自我限流——前提是每条新人仍有独立因果，禁止换皮重复。',
  '【禁止模板化名】除非设定中真实出现或强相关，否则禁止套用：黑蛇-危险人物、方老师-旧号码、黑市眼镜、老疤、老魏、方姐、老班长、战地医院旧号 等套路化黑名单/旧号名。',
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
  '【已拉黑 / 已删除联系人 → 去重参考，不是禁止写非 active】下文「已拉黑」「已删除」名单用于避免同名重复输出，不要把同名条目当新候选再返回：',
  '- 不允许复制已有 blocked / deleted 联系人的 displayName / remark 作为本批新候选；同名 incoming 必须 merge 到旧联系人；同名条目会被去重层归并，不会产生第二份。',
  '- 不要反复套用模板化的"黑蛇-危险人物""方老师-旧号码""旧情人-断联""仇人-威胁"这类符号化名字。',
  '- 已有 blocked / deleted 的角色，若剧情无新变化，不必在本批重复输出；其状态由保存层保留。',
  '- 若 AI 输出已存在的 blocked / deleted 同名联系人，会合并刷新印象，不会自动恢复为 active，也不会新增第二条。',
  '联系人要像真实手机通讯录：同事、朋友、上司、同学、医生、店员、邻居、客户、线人、供应商、旧识等。日常主体应是 active；**若设定与对话里确有纠纷、骚扰、毁约或渠道断联**，应通过 shortBio/impression 把因果写足，再标 blocked/deleted，不要为了「通讯录看起来太平」而抹掉合理冲突线索。',
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
  userName?: string;
  /** 默认由调用方 `collectRecentContextForAgent` 填入；缺省时 prompt 内仍会写明「无最近聊天则只看资料」。 */
  recentContext?: XingyeRecentContext | null;
  /** 来自 `formatXingyeLoreRuntimeContextBlock`；为空/undefined 时不插入该段。 */
  loreContextText?: string;
}) {
  const { ownerAgent, ownerProfile, contacts, loreContextText } = params;
  const loreSection = renderLoreContextSection(loreContextText);
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
      '【关系网 · status】要像角色手机里长期积累的真实社交网；工作、日常、旧识仍以 active 为主体。若资料或对话指向**多方树敌、多线灰色合作崩盘、倒卖/假药链多人失信、战地或疫区多条转诊与补给断联、讨债与执法多线施压**等，可写入**多条** blocked 与/或 deleted（合计常见 **2–4 条**为参考上限），**每条**须有互不重复的 shortBio/impression 因果；无此类证据时不要硬塞一排「反派占位」。',
      '【重新生成全部 · status 下限（仅本流程）】本批须至少出现 1 条 blocked **或** 1 条 deleted（满足其一即可，不必同时有两种）。若设定平和、几乎全为 active，仍须用**单条**把因果写充分的 deleted（如失效渠道）或 blocked（如骚扰来源）满足此下限；若设定动荡且证据充分，可按上条写多条非 active，但**禁止为过关而复制粘贴式硬凑**。',
    ].join('\n')
    : [
      '【边界】本任务只为当前角色补充新的 virtual_contact；不得删除 user/agent，也不得删除任何已有联系人。整表清空仅属于「重新生成全部」流程。',
      '【数量】请输出 3–8 个 virtual_contact 候选（须像真实手机里一小撮联系人，不要贪多）。保存层会自动去重，与已有 active / blocked / deleted 同名联系人不会新增第二条。',
      '【关系网 · status】以 active 为主，写清仍在往来的日常关系。若设定或最近对话能支撑**多条独立**的敌对、骚扰、毁约或断联事实（如多方勒索、多上家跑路、多线旧号码失效），本批候选里可出现**合计约 2–4 条** blocked 与/或 deleted，**每条**须在可见字段写足事理；若无此类证据则不要写非 active。',
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
    speakerContextForPhonePrompt(params),
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
  if (loreSection) lines.push(loreSection);
  return lines.join('\n');
}

export function buildContactRegenerateAllPrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  recentContext?: XingyeRecentContext | null;
  userName?: string;
  /** 来自 `formatXingyeLoreRuntimeContextBlock`；为空/undefined 时不插入该段。 */
  loreContextText?: string;
}) {
  return buildVirtualContactGenerationPrompt({ ...params, intent: 'regenerate' });
}

const RECENT_CONTEXT_GUIDE = [
  '【最近 OpenHanako 聊天】下面给出的「最近聊天」是当前角色与用户最近一次原生对话片段，作为本轮更新的主要参考：',
  '- 提取最近聊天中出现的人物、组织/势力、地点/渠道、关系变化、冲突、合作、旧识、风险信号。',
  '- 重心：凡能在当前联系人列表里对上号的人（用 targetId 或 matchName 精确匹配），优先各返回一条 update，重点调 patch.tags 与 patch.impression（可酌情改 relationshipHint / faction；不要为凑字段大面积改 remark）。',
  '- 尽量不新增联系人：批量「造名单」应走「AI 生成联系人」等流程。仅当聊天里出现明确新人且无法与任何现有联系人视为同一人时，才考虑 add；且全轮 add 不得超过 2 条，默认以 0 条 add 为目标。',
  '- 不要因为聊天没提到某联系人就删除它；未在聊天中出现的联系人不要返回 update。',
  '- 明显断联 / 危险 / 旧号码 / 拉黑暗示且证据充分时，仅对 **virtual_contact** 才用 block 或 delete；对 agent 只用 update 调 tags/impression。可疑但不确定 → 只用 update 调 tags（如「需要观察」「危险」）而非 block/delete。',
  '- 严禁把聊天原文直接复制到 impression / remark / relationshipHint / shortBio；要用自然通讯录措辞改写。',
  '- 严禁出现"根据聊天记录""根据最近对话""强化设定""新增一个"等生成器语言。reason / generatedReason 可解释依据，但不要复述聊天原句。',
  '- 如「最近聊天」标注为「（无）」，请不要凭空编造关系变化，仅在必要时基于角色资料做小幅 patch。',
].join('\n');

const USER_CONTACT_UPDATE_GUIDE = [
  '【user contact update】当最近聊天体现出用户本人对当前角色的态度、承诺、边界、照顾方式或风险沟通有新的变化时（这是触发信号），应更新现有 user 联系人。',
  '- 视角约定：user 这条也在当前角色的通讯录里，impression / remark / relationshipHint 写的是**当前角色对这位用户**的相处印象与关系判断（第一人称视角，与其他联系人一致），不要把用户原话或用户自述的心情直接搬进 impression。用户的态度变化只是触发；写入字段时按"角色怎么看这位用户"来写。',
  '- Use targetType=user and targetId="__user__" for the existing user contact. Do not add a second user contact.',
  '- update user impression / relationshipHint / tags / remark only. Do not delete/block/restore user and do not set user status/faction/linkedAgentId.',
  '- user 的 tags 可以是当前角色给这位用户贴的简短自然标签（例如「尊重边界」「不逞强」「愿意配合」），不需要压成 NPC 固定分类词。',
  '- 如果最近聊天同时提到用户和其他联系人，请分别返回 user update 与其他联系人 update。',
].join('\n');

/** 增量 / 回滚后更新：仅 virtual_contact 可由 AI block/delete；真实 agent 须用户手动（与 store 行为一致）。 */
const INCREMENTAL_BLOCK_DELETE_ACTION_GUIDE = [
  '【拉黑 / 已删除 · 仅 virtual_contact（禁止 user；禁止对 agent 使用 block/delete）】',
  '- **真实 agent（targetType=agent）**：AI 本轮不得使用 `action: "block"`、`action: "delete"`，也不得在 `update.patch` 里改 `status` 为 blocked/deleted；仅可用 `update` 调整 tags/impression/relationshipHint 等。若要把真实角色移入黑名单或已删除，须用户在小手机通讯录内**手动**拉黑/删除。',
  '- **virtual_contact**：`action: "block"` → status=blocked（纠缠、越界、明确拒绝往来等）；`action: "delete"` → status=deleted（断联、旧号、失效渠道等软删）。写入 meta 并与虚拟实体同步。',
  '- **把仍为 active 的 virtual_contact 标成 blocked/deleted**：须最近聊天对该**具体条目**给出充分、可核对的事由；顶层 `reason` 写清依据。证据不足 → 只用 `update` 改 tags/impression，不要用 block/delete。',
  '- **语义分工**：纠缠/威胁/越界 → 倾向 block；旧号/渠道作废/自然断联 → 倾向 delete。',
  '- **推荐写法**：优先单独一条 `action: "block"` 或 `"delete"`，带准 `targetType: "virtual_contact"` 与 `targetId` 或可靠 `matchName`；若还需改印象可再发 `update`（注意 add+block+delete 合计上限）。',
  '- **亦可**对 virtual_contact 使用 `update` 且 `patch.status` 为 blocked/deleted，但须满足相同充分事由，且 impression/relationshipHint 与状态一致。',
  '- **restore**：仅对 virtual_contact；有明确和解、恢复往来时可用，须在 `reason` 写清。',
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
  userName?: string;
  /** 来自 `formatXingyeLoreRuntimeContextBlock`；为空/undefined 时不插入该段。 */
  loreContextText?: string;
}) {
  const { ownerAgent, ownerProfile, contacts, smsSummary, recentContext, loreContextText } = params;
  const loreSection = renderLoreContextSection(loreContextText);
  const recentBlock = recentContext
    ? describeRecentContextForPrompt(recentContext)
    : '最近 OpenHanako 聊天上下文：（无）';
  const parts: string[] = [
    '你是角色手机通讯录增量更新器。只返回 JSON，不要 Markdown，不要解释。',
    '【规模与重心】本轮不是「造一批新联系人」。批量拉人请用「AI 生成联系人」等入口。本轮以 update 为主：最近聊天里能对上现有联系人的 NPC，应逐条 update，优先 patch.tags 与 patch.impression。',
    '【硬性数量】本轮 updates 中 action 为 add、block、delete 的条数合计不得超过 2（含 0）；其中 add 单独也不得超过 2 条，且默认尽量 0 条 add。restore 仅在有明确剧情需要时少量使用。',
    '【add 的 contact】必须满足与虚拟联系人生成相同的字段强制：tags 非空且来自固定词表；faction 非空；status 非空；impression 非空；generatedReason 不得写入 impression。',
    TAG_FACTION_STATUS_RULES,
    INCREMENTAL_VS_TAG_FACTION_RULES,
    '【字段边界】add 时的 contact 对象遵守与虚拟联系人生成相同规则：用户可见字段禁止写任务说明或编剧指令；只有 generatedReason 写生成依据；只有顶层 reason 写「为什么执行该 action」。',
    VISIBLE_FIELD_RULES,
    speakerContextForPhonePrompt(params),
    RECENT_CONTEXT_GUIDE,
    USER_CONTACT_UPDATE_GUIDE,
    INCREMENTAL_BLOCK_DELETE_ACTION_GUIDE,
    '规则：不要 delete/block user。对 agent 仅 add/update（不得 block/delete/restore）；对 virtual_contact 可 add/update/delete/block/restore。',
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
  ];
  if (loreSection) parts.push(loreSection);
  return parts.join('\n');
}

export function buildContactRollbackAndUpdatePrompt(params: {
  ownerAgent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  contacts: XingyePhoneContactView[];
  smsSummary: Array<{ targetType: string; targetId: string; latest?: string; count: number }>;
  recentContext?: XingyeRecentContext | null;
  userName?: string;
  /** 来自 `formatXingyeLoreRuntimeContextBlock`；为空/undefined 时不插入该段。 */
  loreContextText?: string;
}) {
  const { ownerAgent, ownerProfile, contacts, smsSummary, recentContext, loreContextText } = params;
  const loreSection = renderLoreContextSection(loreContextText);
  const recentBlock = recentContext
    ? describeRecentContextForPrompt(recentContext)
    : '最近 OpenHanako 聊天上下文：（无）';
  const parts: string[] = [
    '你是角色手机通讯录「回滚后微调」更新器。只返回 JSON，不要 Markdown，不要解释。',
    '上下文：联系人列表已恢复到上一快照；请在当前规模上做小幅修订，而不是清空重建。',
    '【规模与重心】与「更新联系人」一致：以 update 为主，逐条对齐最近聊天里能匹配上的联系人，优先 patch.tags 与 patch.impression。批量新增名单请走「AI 生成联系人」。',
    '【硬性数量】本轮 updates 中 action 为 add、block、delete 的条数合计不得超过 2（含 0）；add 单独也不得超过 2 条，默认尽量 0 条 add。不要 delete/block user；不要删除 agent。',
    '【字段强制】add 或 patch 若含 tags/faction/status，须遵守固定词表与非空规则；tags 不得为空数组；不要求为凑分布而强行改全员 status。',
    '【字段边界】与增量更新相同：用户可见字段禁止开发说明；generatedReason 仅用于 add 的联系人；reason 仅解释 action。',
    VISIBLE_FIELD_RULES,
    speakerContextForPhonePrompt(params),
    TAG_FACTION_STATUS_RULES,
    INCREMENTAL_VS_TAG_FACTION_RULES,
    RECENT_CONTEXT_GUIDE,
    USER_CONTACT_UPDATE_GUIDE,
    INCREMENTAL_BLOCK_DELETE_ACTION_GUIDE,
    '【与本轮指令一致】不要 delete/block user；不要 delete agent；不要对 agent 使用 block/delete/restore；未在最近聊天或当前联系人中明确提到的联系人，保持原样不要返回它的 update。',
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
  ];
  if (loreSection) parts.push(loreSection);
  return parts.join('\n');
}
