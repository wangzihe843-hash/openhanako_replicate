import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  CONTACT_LORE_DEDUPE_INSTRUCTION,
  contactsHaveLoreAlias,
  formatContactLoreListingBlock,
  type XingyeContactLoreHint,
} from './xingye-contact-lore-link';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 与 PhoneMailApp 的 XingyeMailMailbox 对齐。
 * drafts 也参与初始化：agent「想发但没真发出去」的邮件。
 */
export const MAIL_AI_MAILBOXES = ['inbox', 'sent', 'drafts', 'promotions', 'spam'] as const;
export type XingyeMailAiMailbox = (typeof MAIL_AI_MAILBOXES)[number];

export const MAIL_AI_FROM_KINDS = [
  'virtual_contact',
  'agent',
  'system',
  'promotion',
  'spam',
] as const;
export type XingyeMailAiFromKind = (typeof MAIL_AI_FROM_KINDS)[number];

/**
 * 邮件初始化的虚拟联系人 hint = 通讯录候选池统一 hint。
 * 与文件管理 / 朋友圈共用 xingye-contact-lore-link 的 XingyeContactLoreHint：
 * 带昵称（remark 优先）+ 印象 + 与设定库的身份对齐（loreAliases）。
 */
export type XingyeVirtualContactHint = XingyeContactLoreHint;

/**
 * 构造「邮箱历史邮件初始化」prompt：让模型基于当前 agent 的设定 / lore / 通讯录 / 最近聊天，
 * 一次性虚构出一份 5–8 封模拟历史邮件清单（普通邮件 + 推广 + 垃圾），看起来像 Gmail / Outlook
 * 历史邮件列表，但本质是 agent 小手机里的模拟数据。
 *
 * 重要约束：
 * - 邮件是模拟的；这是 agent 小手机里的虚拟邮箱外观，绝不连接任何真实邮件服务（SMTP/IMAP/OAuth）。
 * - 模型不得给出真实公司的真实联系方式、真实优惠 URL、真实订阅链接；地址里的域名只能用虚构域名。
 * - 邮件以 agent 第一人称视角的世界为背景；普通邮件可以来自 virtual_contact、其他 agent 或系统通知。
 * - 推广邮件 (promotion) 与垃圾邮件 (spam) 必须有清楚的语气区分（推广=营销腔，垃圾=低质 / 钓鱼感）。
 * - 任意输入块缺失允许为「（无）」，模型仍需返回若干合理邮件。
 *
 * scope：把生成拆成两段、各吃各的 lore（见 generateMailInitDraftsWithAI）——
 * - 'personal'：私人邮件（inbox / sent / drafts），吃 relationship 提权的 lore + 通讯录 + 关系状态。
 * - 'bulk'：推广 / 垃圾（promotions / spam），吃 worldview 提权的 lore，**不**注入私人关系 / 通讯录，
 *   要像「这个世界里」会收到的营销 / 钓鱼，而非现实世界通用 newsletter。
 */
export function buildMailInitPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  ownerAddress: string;
  /** 'personal'=inbox/sent/drafts；'bulk'=promotions/spam。 */
  scope: 'personal' | 'bulk';
  virtualContacts: XingyeVirtualContactHint[];
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  /**
   * 跨期反重复锚点：列出已有邮箱里最近的邮件（按发件人聚合，同发件人最多 2 条），
   * 由调用方用 buildMailContinuityAnchorBlock 生成。可空。
   */
  continuityAnchorBlock?: string;
}): string {
  const {
    agent,
    userName,
    profile,
    ownerAddress,
    scope,
    virtualContacts,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock = '',
  } = args;
  const isBulk = scope === 'bulk';

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  /*
   * 邮箱豁免 gender 强约束（与 phone-prompts 同理）：
   * 多数邮件来自 virtual_contact / 其他 agent，发件人各有自己的性别。
   * 如果对 currentAgent 强约束「第三人称必须用她」，模型会把所有 NPC 发件人
   * 都按主人性别写代词，邮件落款 / 自指都乱套。
   * currentAgent 自己的性别仍通过下方 profile JSON 自然透传，模型仍能读到。
   */
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
  });

  const contactListing = formatContactLoreListingBlock(virtualContacts);

  const distributionLines = isBulk
    ? [
      '邮件分布建议（总计 2–3 封，只用 promotions / spam）：',
      '- 推广邮件 (mailbox=promotions, kind=promotion) 1–2 封：订阅 newsletter、商家促销、活动通知，营销腔。',
      '- 垃圾邮件 (mailbox=spam, kind=spam) 1 封：明显诈骗 / 中奖 / 钓鱼，措辞收敛、不出现真实公司名。',
      '禁止生成 inbox / sent / drafts（这三类由另一处单独生成）。',
      '【世界观融入（本段最关键）】推广与垃圾要像「这个世界里」会收到的——参考下方世界观设定里的机构 / 地点 / 商品 / 习俗 / 货币来虚构商家、活动、骗局；不要写成现实世界的通用 newsletter。这两类与 TA 的私人关系无关：不要牵扯亲友 / 关系状态 / 对 user 的态度。',
    ]
    : [
      '邮件分布建议（总计 4–6 封，只用 inbox / sent / drafts）：',
      '- 普通邮件 (mailbox=inbox, kind=virtual_contact / agent / system) 3–4 封，主要来自 contactListing 里的虚拟联系人或合理的系统通知。',
      '- 发件箱 (mailbox=sent, kind=agent) 0–1 封，由 agent 自己以 ownerAddress 视角发出，用以补全发件历史。',
      '- 草稿箱 (mailbox=drafts, kind=agent) 1–2 封：agent「想发但最终没有发出」的邮件，收件人 (to) 是 virtual_contact / user / 另一个 agent；内容贴着 TA 的设定与近期关系状态，可以是：不好意思说出口的道歉、欲言又止的关心、想问又怕越界的问题、深夜写下又决定明早再说的告白 / 解释。请把这种「写完又咽回去」的语气写出来，并在 draftReason 里点一句没发的理由。',
      '禁止生成 promotions / spam（这两类由另一处单独生成）。',
    ];

  const parts: string[] = [
    '你是星野模式「小手机模拟邮箱」历史邮件生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '生成目标：这是当前角色自己手机里的「模拟邮箱」，看起来像 Gmail / Outlook 的历史邮件，但本质是虚构内容。',
    '不会真的连接 SMTP / IMAP / OAuth / 真实邮件服务，模型不得给出真实公司域名以外的真实链接 / 真实优惠码 / 真实订阅地址。',
    '不要写「根据聊天记录」「用户让我」「系统提示」「模型」「AI」等元叙述。',
    '',
    '输出 JSON schema（顶层为数组；只此结构）：',
    JSON.stringify(
      [
        {
          mailbox: 'inbox',
          from: { name: 'string', address: 'string', kind: 'virtual_contact' },
          to: [{ name: 'string', address: 'string' }],
          subject: 'string',
          body: 'string',
          draftReason: 'string',
          isRead: false,
          isStarred: false,
          autoStarred: false,
          labels: ['string'],
        },
      ],
      null,
      2,
    ),
    '',
    '字段要求：',
    `- mailbox 只能是 ${MAIL_AI_MAILBOXES.map((m) => `"${m}"`).join(' / ')} 之一。`,
    `- from.kind 只能是 ${MAIL_AI_FROM_KINDS.map((k) => `"${k}"`).join(' / ')} 之一；推广邮件用 promotion，垃圾 / 钓鱼用 spam；sent 与 drafts 必须用 agent，并把 from.address 设为 ownerAddress、from.name 设为当前角色名。`,
    '- from.name 2–24 字（中文/英文均可），from.address 必须是看起来像邮箱的字符串，域名用虚构名（如 newsletter.demo / mail.fictional / promo.box / spam.junk）；除非 mailbox=sent / drafts，否则不要使用 ownerAddress。',
    '- to 字段：mailbox=sent / drafts 必填（agent 本来想发给谁，可以是 virtual_contact、user、或其他 agent，地址用合理的虚构邮箱）；mailbox=inbox / promotions / spam 可省略，前端会自动填入本人地址。',
    '- subject 4–40 字一句话邮件主题。',
    '- body 80–300 字一段邮件正文；要像真实邮箱里的邮件（问候 / 正文 / 落款），但内容只是虚构。',
    '- draftReason 仅 mailbox=drafts 时填写：8–40 字一句话，写 agent 为什么最终没有发出（如「写了又删了，怕显得太黏」「这话当面说更好」「不知道怎么开口」），不要写成长篇剖白。其他 mailbox 留空字符串。',
    '- labels 0–3 个 2–6 字中文标签（如「工作」「家人」「通知」「促销」「未发出」）。',
    '- autoStarred=true 仅用于「来自亲近 virtual_contact 或重要系统通知」的普通邮件；推广 / 垃圾 / 草稿不要 autoStarred。',
    '- isStarred 在初始化阶段保持 false，让 autoStarred 字段独立呈现。',
    '- isRead 大部分为 false，可以少量为 true，模拟历史阅读状态；drafts 与 sent 视为 agent 自己写过的内容，isRead 建议 true。',
    '',
    ...distributionLines,
    '',
    speakerContextBlock,
    `- 视角：邮件正文里如果出现 ${currentAgentName} 是收件人，请直接称呼为「${currentAgentName}」或「你」；不要凭空写出真实姓名外的别号。`,
    '',
    '当前角色（基础身份）：',
    JSON.stringify(
      {
        id: agent.id,
        name: currentAgentName,
        yuan: agent.yuan,
        profile: profile ?? null,
        ownerAddress,
      },
      null,
      2,
    ),
    '',
    // 私人邮件才注入通讯录 / 最近聊天 / 关系状态 / 巡检；推广垃圾段刻意不喂这些（与营销/钓鱼无关，且避免私人关系泄漏到 spam）。
    ...(isBulk
      ? []
      : [
        '【可参考的虚拟联系人 / 关系（可作为发件人名字与关系语气来源）】',
        ...(contactsHaveLoreAlias(virtualContacts) ? [CONTACT_LORE_DEDUPE_INSTRUCTION] : []),
        contactListing,
        '',
        '【最近 OpenHanako 聊天（可能提示工作 / 关系动向；勿在邮件里交代信息来源）】',
        recentSceneBlock.trim() || '（无）',
        '',
      ]),
    isBulk
      ? '【星野核心设定摘录（stable lore；世界观 / 机构 / 地点 / 习俗——推广垃圾的素材来源）】'
      : '【星野核心设定摘录（stable lore；角色边界与世界观参考）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    ...(isBulk
      ? []
      : [
        `【当前对 ${currentUserName} 的关系状态摘要（若有；情绪 / 边界参考）】`,
        relationshipBlock.trim() || '（无）',
        '',
        '【最近一次手机首页巡检结果（若有；仅作背景参考）】',
        heartbeatBlock.trim() || '（无）',
        '',
      ]),
    '【已有邮箱里的最近邮件（跨期防重复，必读；同一发件人不要再发雷同主题，整体上换主题/换笔调）】',
    continuityAnchorBlock.trim() || '（无；这是 TA 第一次整理邮箱）',
    ...(isBulk
      ? [
        '',
        '【推广 / 垃圾防套路复读（最重要）】上面已经出现过的属于哪种套路（中奖抽奖 / 账户异常钓鱼 / 退款账单 / 快递包裹 / 限时折扣 / 周报订阅 / 活动报名 / 会员续费…），这次就**换一种完全不同的套路**，不要再发同一类。即使发件人换了名字 / 地址，只要套路和已有的雷同就算重复。每封的题材、骗局类型、卖点都要彼此不同。',
      ]
      : []),
  ];

  return parts.join('\n');
}
