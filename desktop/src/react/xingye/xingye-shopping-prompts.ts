import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 与 PhoneShoppingApp 的 ShoppingEntryStatus 对齐。
 */
export const SHOPPING_AI_STATUSES = [
  'wanted',
  'hesitating',
  'ordered',
  'received',
  'favorite',
  'returned',
] as const;

export const SHOPPING_AI_PLATFORM_STYLES = [
  'generic',
  'amazon',
  'taobao',
  'xianyu',
] as const;

/**
 * 构造「购物记录草稿」prompt：让模型扮演当前 agent，把最近聊天 / 状态 / 设定里的购物冲动整理成一条本地模拟记录。
 *
 * 重要约束：
 * - 第一人称，agent 自己写自己的购物清单。
 * - 不连接任何真实平台、价格、链接、推荐；价格只能是「TA 想象里的价格感」。
 * - 不写日记 / 日程 / 阅读笔记 / 邮件 / 资料柜条目。
 * - 任何输入块缺失都允许为「（无）」。
 */
export function buildShoppingDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  /** 用户在弹窗里写下的购物意图（可空）。 */
  userIntent: string;
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
    userIntent,
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

  const parts: string[] = [
    '你是星野模式「小手机购物」记录草稿生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '生成目标：这是当前角色自己手机里的购物记录，由 TA 自己写出来；只是模拟，不会真的下单、付款、查价格、接外部商城。',
    '不是日记，不是日程，不是阅读笔记，不是资料柜条目。',
    '不要出现「根据聊天记录」「用户让我」「系统提示」「模型」「AI」「推荐你」等元叙述。',
    '不要使用 user 视角或第三人称视角；只能是 agent 第一人称想买 / 犹豫 / 收藏 / 已下单（虚构的）的口吻。',
    '不要出现真实电商平台名字以外的真实链接 / 真实价格区间 / 折扣信息；imaginedPrice 只能是 TA 想象里的价格感（如「大概一杯奶茶钱」「应该要小几百」）。',
    '如果输入信息不足以判断 TA 想买什么，可以写成「最近想置办点小东西」之类的轻量物件，不要凭空捏造重大购买（车 / 房 / 奢侈品）。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify(
      {
        itemName: 'string',
        status: 'wanted',
        platformStyle: 'generic',
        category: 'string',
        imaginedPrice: 'string',
        reason: 'string',
        tags: ['string'],
        content: 'string',
      },
      null,
      2,
    ),
    '',
    '字段要求：',
    `- status 只能是 ${SHOPPING_AI_STATUSES.map((s) => `"${s}"`).join(' / ')} 之一；缺乏明确动作时默认 "wanted"。`,
    `- platformStyle 只能是 ${SHOPPING_AI_PLATFORM_STYLES.map((s) => `"${s}"`).join(' / ')} 之一；不确定时用 "generic"。`,
    '- itemName 必填，2–24 字的中文物品名；不要写品牌型号 SKU。',
    '- category 0–8 字（如「日用 / 文具 / 衣物 / 食物 / 礼物」），不确定可空字符串。',
    '- imaginedPrice 0–24 字；只能是模糊价格感，不要写「￥199.00」这类精确标价。',
    '- reason 0–80 字一句话，写 TA 为什么想要 / 犹豫 / 收藏。',
    '- tags 0–5 个 2–6 字中文标签；不要复述 itemName 或 category。',
    '- content 30–200 字 agent 的备忘段落，可以写挑选时的心情、看到时的场合，但不要写真实购买动作。',
    '',
    speakerContextBlock,
    `- 视角：把 TA 写成「我」，把 ${currentUserName} 写成「${currentUserName}」；不要写成「TA / 她 / 他」或「您」。`,
    '',
    '当前角色（基础身份）：',
    JSON.stringify(
      {
        id: agent.id,
        name: currentAgentName,
        yuan: agent.yuan,
        profile: profile ?? null,
      },
      null,
      2,
    ),
    '',
    '【用户输入的购物意图（若有；只是提示方向，不要照抄）】',
    userIntent.trim() || '（无）',
    '',
    '【最近 OpenHanako 聊天（可能藏着购物冲动；勿在输出里交代信息来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（stable lore；只作角色边界与世界观参考）】',
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
