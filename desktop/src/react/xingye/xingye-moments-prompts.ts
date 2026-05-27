import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 喂给 prompt 的 virtual_contact hint（朋友圈生成时模型可从此池子里挑互动者）。
 * 与 mail-prompts 的 XingyeVirtualContactHint 同形；保留独立类型以免跨模块强耦合。
 */
export type XingyeMomentVirtualContactHint = {
  id: string;
  displayName: string;
  /** TA 与发帖人的关系类型（friend / rival / enemy / ex ...）——vc 本就是发帖人的联系人。 */
  kind?: string;
  relationshipHint?: string;
  /**
   * 发帖人对这位联系人的印象。**方向是发帖人 → 联系人**（发帖人视角，不是联系人视角），
   * 与 peerAgents 的 impressionOfAuthor（联系人 → 发帖人）方向相反——prompt 里要标清楚。
   */
  impression?: string;
};

/**
 * 喂给 prompt 的"其他 agent"hint（roster 里除当前发帖 agent 外的其他角色）。
 */
export type XingyeMomentPeerAgentHint = {
  id: string;
  displayName: string;
  /** 该角色对 user 的关系标签——仅作口吻参考，不是 TA 与发帖人的关系。 */
  relationshipLabel?: string;
  /**
   * 该角色在自己小手机通讯录里对「当前发帖角色」的备注 / 印象（agent→agent 视角）。
   * 这是补 agent↔agent 关系缺口的关键：让 TA 评论时按这个印象定亲疏冷热。
   * 由 generateXingyeMomentDraftWithAI 读 getPhoneContactMeta 填入，缺省表示没有特别印象。
   */
  impressionOfAuthor?: string;
};

/**
 * 构造朋友圈草稿生成 prompt（用户在 MomentComposer 点击「AI 生成」时使用）。
 * 输出仅 JSON：`{ content, likes?, comments? }`，由调用方塞回编辑框，**不直接发帖**。
 * 与 journal-prompts 同形，差异在任务与口吻：朋友圈是公开短动态而非私人日记。
 *
 * likes/comments 仅允许引用 virtualContacts / peerAgents 池里出现的 ref；
 * user 与发帖 agent 自身不应出现在 likes/comments 中（user 互动由 UI 触发，agent 自赞无意义）。
 */
export function buildMomentDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  /**
   * 跨条朋友圈反重复 anchor block（由 xingye-moments-dedupe.buildMomentsContinuityAnchorBlock
   * 本地构造，列出最近 ~12 条 "作者 + 开头第一句 + 日期"）。喂给模型让它在源头换主题、
   * 不要复读「今天天气好」「凌晨好困」之类的套话。模型**不**回写本字段。
   * 缺省 / 空串 → prompt 里展示「（无；这是 TA 的第一条朋友圈）」占位。
   */
  continuityAnchorBlock?: string;
  virtualContacts?: ReadonlyArray<XingyeMomentVirtualContactHint>;
  peerAgents?: ReadonlyArray<XingyeMomentPeerAgentHint>;
  /**
   * 用户已经写好的朋友圈正文。非空时改变本函数的输出意图：
   *   - 不再让模型生成 content（content 由调用方 verbatim 保留）
   *   - prompt 转成「围绕用户写好的这段内容，只产出 likes/comments」
   * 给模型看到 existingContent 既是上下文也是硬约束，调用方还会再做一道
   * 安全网 verbatim 覆盖（见 xingye-moments-ai.ts），不依赖模型守约。
   */
  existingContent?: string | null;
}): string {
  const {
    agent,
    profile,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
  } = args;
  const virtualContacts = args.virtualContacts ?? [];
  const peerAgents = args.peerAgents ?? [];
  const existingContent = typeof args.existingContent === 'string' ? args.existingContent.trim() : '';
  const interactionsOnlyMode = existingContent.length > 0;
  /*
   * 朋友圈豁免 gender 强约束：
   * 朋友圈正文是 currentAgent 第一人称（"我"），强约束作用有限；
   * 但 comments 来自 virtualContacts + peerAgents（其他 Xingye 角色，
   * **各自有自己的 profile.json + gender**）—— 这些评论者的代词必须按各自性别。
   * 如果强约束 currentAgent 是女性、第三人称必用「她」，模型会把所有评论者也
   * 染成同一代词。currentAgent 自己的性别仍通过下方 profile JSON 透传。
   */
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
  });

  const virtualContactsBlock = virtualContacts.length
    ? JSON.stringify(
        virtualContacts.map((c) => ({
          ref: `vc:${c.id}`,
          displayName: c.displayName,
          kind: c.kind ?? undefined,
          relationshipHint: c.relationshipHint ?? undefined,
          impression: c.impression ?? undefined,
        })),
        null,
        2,
      )
    : '（无）';
  const peerAgentsBlock = peerAgents.length
    ? JSON.stringify(
        peerAgents.map((a) => ({
          ref: `agent:${a.id}`,
          displayName: a.displayName,
          relationshipLabel: a.relationshipLabel ?? undefined,
          impressionOfAuthor: a.impressionOfAuthor ?? undefined,
        })),
        null,
        2,
      )
    : '（无）';

  const headerLines = interactionsOnlyMode
    ? [
        '你是星野模式「朋友圈」围观互动生成器。只返回严格 JSON，不要 Markdown，不要解释。',
        '',
        '【模式：仅生成互动】用户已经写好了朋友圈正文（见下方「用户已写好的正文」段），',
        '你的任务**不是**写 content，而是围绕这段已有正文产出合适的 likes / comments。',
        '不要改写、续写、缩写、扩写用户的正文；不要在 comments 里复述正文里的句子。',
        '为了 schema 完整，可以在返回 JSON 里**原样**回填 content 字段（一字不改），',
        '但调用方会做安全网 verbatim 覆盖——即使你乱写或省略，最终展示的仍是用户原文。',
      ]
    : [
        '你是星野模式「朋友圈」短动态生成器。只返回严格 JSON，不要 Markdown，不要解释。',
        '',
        '写作身份：以当前角色身份发一条朋友圈短动态，第一人称「我」。',
        '禁止写成用户视角、读者视角或系统总结；不要出现「根据聊天记录」「用户说」「系统提示」「模型」「AI」等元叙述。',
        '不要复述或引用输入里的标签行（例如「最近场景」「关系状态」等小节标题）；直接写朋友圈口吻。',
        '可以含蓄、留白、引一两句歌词或随手感想；不要写长篇日记，不要 emoji 堆砌。',
        '不要捏造重大剧情、生死、关系决裂等输入里不存在的事件。',
        '',
        '长度：正文 content 控制在约 30–140 个汉字（朋友圈口吻为主，宁短勿滥）；不要标题，不要分段编号。',
      ];

  const interactionsRulesLines = [
    '',
    interactionsOnlyMode
      ? '生成围观互动 likes / comments（**本次的核心任务**）：'
      : '同时生成围观互动 likes / comments（这是任务的一部分，不是可选润色）：',
    '- 只要下方两个「可选互动者池」**至少一个**非空（不是「（无）」），就必须给出 **至少 2 条 likes 和至少 1 条 comments**；',
    '  能挑出更多合适人选时 likes 给到 3–4 条、comments 给到 2–3 条更好。',
    peerAgents.length > 0
      ? '- comments **不要只来自虚拟联系人**：其他星野角色（`agent:<id>`）同样会刷到并评论朋友圈。「其他星野角色」池非空时，comments 里**至少 1 条必须来自 `agent:<id>`**；理想情况下 agent 与 vc 的评论兼有，别让评论区清一色虚拟联系人。'
      : null,
    '- 两个池都是「（无）」时才允许省略 likes / comments 字段（不要输出空数组占位）；这种场景很少见。',
    '- ref 必须**逐字**取自池中已列出的 ref（形如 `vc:<id>` 或 `agent:<id>`，含前缀），不要凭空捏造、不要写 displayName，不要省掉前缀。',
    '- 不要把当前角色自己、user / 莉莉丝 / 任何用户身份放进 likes 或 comments（用户的点赞评论由 UI 触发）。',
    '- likes 上限 4 条；comments 上限 3 条，每条 body 控制在 30 字以内、口语化、符合该互动者口吻；多个互动者要呼应不同身份/口气，不要复读同一句。',
    '- 写其他星野角色（`agent:<id>`）的评论时，若该角色带了 `impressionOfAuthor`（TA 对发帖人的私下印象），口吻要贴合那份印象——亲近、生分、还是带刺，都按印象来，不要一律写成热络。',
    interactionsOnlyMode
      ? '- comments 要**贴住用户写好的那段正文**做反应（玩笑、关心、追问、共情、调侃皆可）；不要写脱离正文的客套。'
      : null,
  ].filter((line): line is string => line !== null);

  const schemaLines = [
    '',
    '输出 JSON schema（仅此结构，字段名必须一致；除 content 外其余字段在池非空时为必填）：',
    JSON.stringify(
      {
        content: 'string',
        likes: [{ ref: 'vc:<id> 或 agent:<id>' }],
        comments: [{ ref: 'vc:<id> 或 agent:<id>', body: 'string' }],
      },
      null,
      2,
    ),
    '',
    '示例（假设池里有 { ref: "agent:hanako", displayName: "Hanako" } 与 { ref: "vc:vc-night", displayName: "夜班搭子" }）：',
    '注意示例的 comments：既有其他星野角色（agent:hanako），也有虚拟联系人（vc:vc-night）——评论区不要清一色虚拟联系人。',
    JSON.stringify(
      {
        content: '凌晨三点的便利店，泡面味混着冷气。',
        likes: [{ ref: 'agent:hanako' }, { ref: 'vc:vc-night' }],
        comments: [
          { ref: 'agent:hanako', body: '又通宵？明早我替你盯着会。' },
          { ref: 'vc:vc-night', body: '关东煮给你留了，记得过来拿。' },
        ],
      },
      null,
      2,
    ),
    '',
  ];

  const existingContentBlock = interactionsOnlyMode
    ? [
        '【用户已写好的正文（content；必须一字不改）】',
        existingContent,
        '',
      ]
    : [];

  const parts: string[] = [
    ...headerLines,
    ...interactionsRulesLines,
    ...schemaLines,
    ...existingContentBlock,
    '当前角色（基础身份）：',
    JSON.stringify(
      {
        id: agent.id,
        name: agent.name,
        yuan: agent.yuan,
        profile: profile ?? null,
      },
      null,
      2,
    ),
    '',
    speakerContextBlock,
    '',
    '【可选互动者池 · 当前角色的虚拟联系人（vc:<id>，仅本人可见）】',
    '（kind 是 TA 与发帖人的关系类型，relationshipHint 是关系线索，impression 是**发帖人对 TA**的印象（发帖人视角，不是 TA 对发帖人的看法）——写 TA 的评论时三者一起定亲疏冷热。）',
    virtualContactsBlock,
    '',
    '【可选互动者池 · 其他星野角色（agent:<id>，共同好友式可见）】',
    '（这些角色会刷到并评论当前这条朋友圈；impressionOfAuthor 是 TA 私下对发帖人的印象/备注，写 TA 的评论时按这个印象定亲疏冷热，缺省则按 TA 自己的人设自然处理。）',
    peerAgentsBlock,
    '',
    '【最近发生的事（场景参考；勿在正文里交代信息来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（lore-memory / 常驻设定；勿逐字复述）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；勿逐字复述）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    '【当前对 user 的关系状态摘要（内部参考）】',
    relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（若有；仅作情绪参考，勿照抄套话）】',
    heartbeatBlock.trim() || '（无）',
    '',
    '【跨条朋友圈反重复锚点（仅供你换主题用；勿在正文里复述本块文字）】',
    (args.continuityAnchorBlock ?? '').trim() || '（无；这是 TA 的第一条朋友圈）',
  ];

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
//  朋友圈「评论回复」生成（user 写评论 → @ 某个 agent 回复这条评论）
// ─────────────────────────────────────────────────────────────────────────

/** 单条评论回复 body 的硬上限（朋友圈口吻，宁短勿长）。 */
export const MOMENT_COMMENT_REPLY_MAX_CHARS = 80;

export type XingyeMomentCommentReplyPromptArgs = {
  /** 被 @ 来回复的角色。 */
  replyAgent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  replyProfile: XingyeRoleProfile | null | undefined;
  userName?: string;
  /** 帖子作者展示名。 */
  postAuthorDisplayName: string;
  /** 回复者是否就是帖子作者本人（是则不喂「印象」「身份名片」，改写口吻）。 */
  replyIsAuthor: boolean;
  /** 帖子作者的客观身份摘要（来自其 profile.identitySummary），可空。 */
  postAuthorIdentitySummary?: string | null;
  postContent: string;
  /** 评论区已有评论（不含正在回复的那条）。 */
  existingComments: ReadonlyArray<{ authorName: string; body: string }>;
  /** 被回复的那条评论（通常是 user 刚发的）。 */
  targetComment: { authorName: string; body: string };
  /** 回复者通讯录里对帖子作者的备注名 / 印象（replyIsAuthor 时忽略）。 */
  authorContactRemark?: string | null;
  authorContactImpression?: string | null;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
};

function clampReplyChars(text: string, max: number): string {
  const t = text.trim();
  const chars = [...t];
  if (chars.length <= max) return t;
  return `${chars.slice(0, max).join('')}…`;
}

/**
 * 构造朋友圈「评论回复」prompt。
 * 输出仅 JSON：`{ reply: string }`，由调用方以 agent 身份写回评论区。
 *
 * 关键点：`authorContactImpression` 是**回复者视角**对帖子作者的印象（来自回复者
 * 自己的小手机通讯录），不是用户视角——prompt 里据此标注为「你对 TA 的印象」。
 */
export function buildMomentCommentReplyPrompt(args: XingyeMomentCommentReplyPromptArgs): string {
  const {
    replyAgent,
    replyProfile,
    postAuthorDisplayName,
    replyIsAuthor,
    postContent,
    existingComments,
    targetComment,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
  } = args;

  const userName = (args.userName ?? '').trim() || 'user';
  const taMoniker = (replyProfile?.displayName ?? '').trim() || replyAgent.name;
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName,
    agentName: taMoniker,
  });

  const profileBlock = replyProfile
    ? JSON.stringify(replyProfile, null, 2)
    : '（无）';

  const existingCommentsBlock = existingComments.length
    ? existingComments
        .map((c) => `- ${c.authorName}：${c.body}`)
        .join('\n')
    : '（评论区暂无其他评论）';

  const authorIdentity = (args.postAuthorIdentitySummary ?? '').trim();
  const contactRemark = (args.authorContactRemark ?? '').trim();
  const contactImpression = (args.authorContactImpression ?? '').trim();

  const postBlockLines = replyIsAuthor
    ? [
        '【这条朋友圈】这是你自己发的朋友圈，有人在评论区留言，你来回复。',
        `正文：${postContent.trim() || '（空）'}`,
      ]
    : [
        `【这条朋友圈】作者是「${postAuthorDisplayName}」（不是你）。`,
        `正文：${postContent.trim() || '（空）'}`,
      ];

  const authorContextLines = replyIsAuthor
    ? []
    : [
        '',
        '【帖子作者是谁（客观身份名片，仅供你认人，勿逐字复述）】',
        authorIdentity || '（无更多资料）',
        '',
        '【你（在自己的小手机通讯录里）对帖子作者的备注与印象】',
        contactRemark ? `备注名：${contactRemark}` : '备注名：（未设置）',
        contactImpression
          ? `印象：${contactImpression}`
          : '印象：（你的通讯录里还没有对 TA 形成明确印象——按你自己的人设与关系自然处理即可）',
        '注意：以上「印象」是你本人对 TA 的主观看法，请让回复口吻与之一致。',
      ];

  const parts: string[] = [
    '你是星野模式「朋友圈评论回复」生成器：以当前角色身份，在朋友圈评论区回复指定的那条评论。',
    '只返回严格 JSON，不要 Markdown，不要解释，不要思考过程。',
    '',
    '【硬性规则】',
    '1. 你只能输出当前角色本人的一条评论回复，写在 reply 字段。',
    '2. 不要模拟 user 的发言，不要模拟其他人的发言，不要假装别人在说话。',
    '3. 不要一次输出多条回复；不要在同一段里串起多条独立发言；不要使用 JSON 数组。',
    '4. 不要出现「系统提示」「用户要求」「上下文」「模型」「prompt」「AI 助手」等元叙述。',
    `5. 这是朋友圈评论区：回复要短、口语化，像微信朋友圈评论——建议 30 字以内，最长不得超过 ${MOMENT_COMMENT_REPLY_MAX_CHARS} 字；不要分段、不要编号、不要堆 emoji。`,
    '6. 紧扣「你要回复的那条评论」来回应（接话、调侃、关心、追问、共情皆可），要符合当前角色 profile / 关系 / 口吻；第一人称。',
    '7. 不要复述帖子正文或别人评论里的原句。',
    '',
    '【说话人语境】',
    speakerContextBlock,
    '',
    `【你的 agent id】 ${replyAgent.id}`,
    `【你的展示名】 ${taMoniker}`,
    '',
    '【当前角色 profile】',
    profileBlock,
    '',
    ...postBlockLines,
    ...authorContextLines,
    '',
    '【评论区已有评论（时间从早到晚，仅作上下文，不要逐条回应）】',
    existingCommentsBlock,
    '',
    '【★ 你要回复的那条评论（你的回复必须针对它）】',
    `${targetComment.authorName}：${targetComment.body.trim()}`,
    '',
    '【最近发生的事（仅作你的背景情绪参考，不要在 reply 中复述来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【当前对 user 的关系状态摘要（内部参考）】',
    relationshipBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（lore-memory / 常驻设定；勿逐字复述）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；勿逐字复述）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    '【输出 JSON schema（字段名必须一致；不要返回数组）】',
    JSON.stringify({ reply: 'string' }, null, 2),
    '',
    '只返回 JSON 对象，不要任何其他文字。',
  ];

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
//  朋友圈「角色评论用户帖」生成（user 自己发了一条朋友圈 → 各角色围观评论）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 角色评论用户朋友圈时的语气：
 * - friendly：关系正常 / 亲密——友善、关心、调侃皆可，贴合该角色人设；
 * - sarcastic：关系很差——冷嘲热讽、阴阳怪气、夹枪带棒。
 */
export type XingyeMomentUserPostCommentTone = 'friendly' | 'sarcastic';

export type XingyeMomentUserPostCommentPromptArgs = {
  /** 来评论的角色。 */
  commentAgent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  commentProfile: XingyeRoleProfile | null | undefined;
  userName?: string;
  /** 用户本人发的这条朋友圈正文。 */
  postContent: string;
  /** 评论区已有评论（含其他角色刚写的，用来避免复读）。 */
  existingComments: ReadonlyArray<{ authorName: string; body: string }>;
  tone: XingyeMomentUserPostCommentTone;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  /** 该角色对 user 的关系状态摘要（agent→user，第一人称视角）。 */
  relationshipBlock: string;
};

/**
 * 构造「角色评论用户朋友圈」prompt。
 * 输出仅 JSON：`{ reply: string }`，由调用方以 agent 身份写进评论区。
 *
 * 与 buildMomentCommentReplyPrompt 的区别：那条是「回复评论区里某条评论」，需要靠
 * 通讯录印象补 agent↔agent 关系；这里帖子作者就是 user 本人，关系是一等公民——
 * relationshipBlock 直接就是该角色对 user 的态度，不需要任何补丁。
 */
export function buildMomentUserPostCommentPrompt(args: XingyeMomentUserPostCommentPromptArgs): string {
  const {
    commentAgent,
    commentProfile,
    postContent,
    existingComments,
    tone,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
  } = args;

  const userName = (args.userName ?? '').trim() || 'user';
  const taMoniker = (commentProfile?.displayName ?? '').trim() || commentAgent.name;
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName,
    agentName: taMoniker,
  });

  const profileBlock = commentProfile ? JSON.stringify(commentProfile, null, 2) : '（无）';

  const existingCommentsBlock = existingComments.length
    ? existingComments.map((c) => `- ${c.authorName}：${c.body}`).join('\n')
    : '（评论区暂无其他评论，你是第一个评论的人）';

  const toneLines = tone === 'sarcastic'
    ? [
        '【语气：冷嘲热讽】你和 TA 关系很差（见下方关系状态）。这条评论要阴阳怪气、夹枪带棒、',
        '明褒暗贬或看热闹不嫌事大——刻薄但仍像真人朋友圈评论，不要写成谩骂、人身攻击或脏话。',
        '别假装热情，也别突然和好；冷淡、嘲讽、挑刺，符合你对 TA 的真实态度。',
      ]
    : [
        '【语气：友善】你和 TA 关系正常或亲密。这条评论可以关心、调侃、共情、追问、起哄——',
        '自然、口语化，贴合你的人设与你对 TA 的关系，不要客套套话。',
      ];

  const parts: string[] = [
    '你是星野模式「朋友圈评论」生成器：以当前角色身份，给用户本人发的一条朋友圈写一条评论。',
    '只返回严格 JSON，不要 Markdown，不要解释，不要思考过程。',
    '',
    '【硬性规则】',
    '1. 你只能输出当前角色本人的一条评论，写在 reply 字段。',
    '2. 不要模拟 user 的发言，不要模拟其他角色的发言，不要假装别人在说话。',
    '3. 不要一次输出多条评论；不要在同一段里串起多条独立发言；不要使用 JSON 数组。',
    '4. 不要出现「系统提示」「用户要求」「上下文」「模型」「prompt」「AI 助手」等元叙述。',
    `5. 这是朋友圈评论区：评论要短、口语化，像微信朋友圈评论——建议 30 字以内，最长不得超过 ${MOMENT_COMMENT_REPLY_MAX_CHARS} 字；不要分段、不要编号、不要堆 emoji。`,
    '6. 紧扣用户这条朋友圈正文来反应；第一人称，符合当前角色 profile / 关系 / 口吻。',
    '7. 不要复述帖子正文或别人评论里的原句；如果评论区已有别人评论，你的角度要和他们不同。',
    '',
    ...toneLines,
    '',
    '【说话人语境】',
    speakerContextBlock,
    '',
    `【你的 agent id】 ${commentAgent.id}`,
    `【你的展示名】 ${taMoniker}`,
    '',
    '【当前角色 profile】',
    profileBlock,
    '',
    `【这条朋友圈】作者是「${userName}」本人（也就是你正在相处的那个人）。`,
    `正文：${postContent.trim() || '（空）'}`,
    '',
    '【评论区已有评论（时间从早到晚，仅作上下文，不要逐条回应，不要复读）】',
    existingCommentsBlock,
    '',
    '【最近发生的事（仅作你的背景情绪参考，不要在 reply 中复述来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    `【你（当前角色）对「${userName}」的关系状态摘要（决定你评论的态度，内部参考）】`,
    relationshipBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（lore-memory / 常驻设定；勿逐字复述）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；勿逐字复述）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    '【输出 JSON schema（字段名必须一致；不要返回数组）】',
    JSON.stringify({ reply: 'string' }, null, 2),
    '',
    '只返回 JSON 对象，不要任何其他文字。',
  ];

  return parts.join('\n');
}

const MOMENT_COMMENT_REPLY_BODY_FIELDS = ['reply', 'body', 'content', 'text', 'message'] as const;

/**
 * 校验 / 收窄朋友圈评论回复 AI 结果。容忍模型把回复写在 reply / body / content / text / message
 * 任一字段，或直接返回字符串。返回 null 表示无有效回复。
 */
export function normalizeMomentCommentReplyResult(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t ? clampReplyChars(t, MOMENT_COMMENT_REPLY_MAX_CHARS) : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of MOMENT_COMMENT_REPLY_BODY_FIELDS) {
    const v = record[key];
    if (typeof v === 'string' && v.trim()) {
      return clampReplyChars(v.trim(), MOMENT_COMMENT_REPLY_MAX_CHARS);
    }
  }
  return null;
}
