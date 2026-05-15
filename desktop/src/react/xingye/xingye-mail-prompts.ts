import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
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

export type XingyeVirtualContactHint = {
  id?: string;
  displayName: string;
  kind?: string;
  shortBio?: string;
  relationshipHint?: string;
};

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
 */
export function buildMailInitPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  ownerAddress: string;
  virtualContacts: XingyeVirtualContactHint[];
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
}): string {
  const {
    agent,
    userName,
    profile,
    ownerAddress,
    virtualContacts,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
  } = args;

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
  });

  const contactListing = virtualContacts.length
    ? virtualContacts
        .slice(0, 12)
        .map((c) => {
          const parts = [c.displayName];
          if (c.kind) parts.push(`关系：${c.kind}`);
          if (c.relationshipHint) parts.push(`备注：${c.relationshipHint}`);
          if (c.shortBio) parts.push(`简介：${c.shortBio}`);
          return `- ${parts.join('，')}`;
        })
        .join('\n')
    : '（无）';

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
    '邮件分布建议（总计 6–9 封）：',
    '- 普通邮件 (mailbox=inbox, kind=virtual_contact / agent / system) 3–4 封，主要来自 contactListing 里的虚拟联系人或合理的系统通知。',
    '- 推广邮件 (mailbox=promotions, kind=promotion) 1–2 封，可写订阅 newsletter、虚构商家促销活动。',
    '- 垃圾邮件 (mailbox=spam, kind=spam) 1 封，可写明显诈骗 / 中奖 / 钓鱼，但措辞收敛、不出现真实公司名。',
    '- 发件箱 (mailbox=sent, kind=agent) 0–1 封，由 agent 自己以 ownerAddress 视角发出，用以补全发件历史。',
    '- 草稿箱 (mailbox=drafts, kind=agent) 1–2 封：agent「想发但最终没有发出」的邮件，收件人 (to) 是 virtual_contact / user / 另一个 agent；内容贴着 TA 的设定与近期关系状态，可以是：不好意思说出口的道歉、欲言又止的关心、想问又怕越界的问题、深夜写下又决定明早再说的告白 / 解释。请把这种「写完又咽回去」的语气写出来，并在 draftReason 里点一句没发的理由。',
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
    '【可参考的虚拟联系人 / 关系（可作为发件人名字与关系语气来源）】',
    contactListing,
    '',
    '【最近 OpenHanako 聊天（可能提示工作 / 关系动向；勿在邮件里交代信息来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（stable lore；角色边界与世界观参考）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    `【当前对 ${currentUserName} 的关系状态摘要（若有；情绪 / 边界参考）】`,
    relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（若有；仅作背景参考）】',
    heartbeatBlock.trim() || '（无）',
  ];

  return parts.join('\n');
}
