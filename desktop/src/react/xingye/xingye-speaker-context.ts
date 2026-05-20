import { fetchConfig } from '../hooks/use-config';
import { useStore } from '../stores';
import type { XingyeRoleGender } from './xingye-profile-store';
import type {
  XingyeRecentContext,
  XingyeRecentMessageRole,
} from './xingye-recent-context';

export type XingyeSpeakerContext = {
  currentUserName: string;
  currentAgentName: string;
};

export type XingyeRecentChatSpeaker = 'user' | 'currentAgent' | 'system' | 'unknown';

export type XingyeSpeakerRecentChatExcerpt = {
  speaker: XingyeRecentChatSpeaker;
  speakerLabel: string;
  text: string;
  createdAt?: string;
};

export type XingyeSpeakerAiDebugSnapshot = {
  userName: string;
  agentName: string;
  recentChatExcerpts: Array<{
    speakerLabel: string;
    text: string;
  }>;
  promptSummary: string;
};

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeName(value: string | null | undefined, fallback: string): string {
  const text = value?.trim();
  return text || fallback;
}

function usableUserName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text === 'User' || text === 'user') return null;
  return text;
}

function readConfigUserName(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const user = (config as { user?: unknown }).user;
  if (!user || typeof user !== 'object') return null;
  return usableUserName((user as { name?: unknown }).name);
}

async function readUserNameFromConfig(): Promise<string | null> {
  try {
    return readConfigUserName(await fetchConfig());
  } catch {
    return null;
  }
}

function readUserNameFromStore(): string | null {
  try {
    return usableUserName(useStore.getState().userName);
  } catch {
    return null;
  }
}

export async function resolveXingyeSpeakerUserName(explicitUserName?: string): Promise<string> {
  return (
    await readUserNameFromConfig()
    ?? usableUserName(explicitUserName)
    ?? readUserNameFromStore()
    ?? '用户'
  );
}

/** 与 resolveXingyeSpeakerUserName 一致：OpenHanako config.user.name 优先，其次显式/全局 store，最后「用户」。供 Lore 等同步 UI 使用。 */
export function resolveXingyeLoreTemplateUserNameSync(
  openHanakoConfig: unknown,
  storeUserName?: string | null,
): string {
  return readConfigUserName(openHanakoConfig) ?? usableUserName(storeUserName ?? undefined) ?? '用户';
}

export function buildXingyeSpeakerContext(args: {
  userName?: string | null;
  agentName?: string | null;
}): XingyeSpeakerContext {
  return {
    currentUserName: normalizeName(args.userName, '用户'),
    currentAgentName: normalizeName(args.agentName, '当前角色'),
  };
}

/**
 * 按 gender 生成代词约束段（强约束 / 单独成段，让模型不可能漏看）。
 * unspecified / undefined → 返回空字符串（不约束，模型自决）。
 *
 * 设计要点：
 *  - 段首加显眼 emoji + 全大写英文标签，与上方"实体归因规则"区分
 *  - 明确给出"代词 + 称谓"两个层面的约束
 *  - 显式列出**禁用**的代词，让 LLM 不模糊
 *  - 同时覆盖第一/三人称提及（旁白 / 弹幕 / 评论 / 来信等）
 */
function formatGenderRulesForPrompt(
  gender: XingyeRoleGender | null | undefined,
  currentAgentName: string,
): string {
  if (!gender || gender === 'unspecified') return '';
  if (gender === 'female') {
    return [
      '',
      '【pronoun / 性别与代词约束（强约束）】',
      `- ${currentAgentName} 的性别为「女性」。`,
      `- 第三人称提及 ${currentAgentName} 时（旁白 / 弹幕 / 新闻评论 / 读者来信 / 报道 / 采访稿 / 旁观者议论），代词**必须**使用「她」。`,
      '- 称谓可用：姐姐 / 小姐 / 女士 / 那位姑娘 / 那位女子 / 这位女士 等；具体按当前世界观调整（古风可用「娘子」「公主」「小姐」，西幻可用「夫人」「女爵」，现代可用「姐姐」「女士」）。',
      '- **禁用**「他」「先生」「公子」「哥哥」「弟弟」「君」（作男性敬称）等任何指向男性的代词或称谓。',
      `- ${currentAgentName} 自己第一人称仍用「我」，但被第三方提及时严格按以上规则。`,
    ].join('\n');
  }
  if (gender === 'male') {
    return [
      '',
      '【pronoun / 性别与代词约束（强约束）】',
      `- ${currentAgentName} 的性别为「男性」。`,
      `- 第三人称提及 ${currentAgentName} 时（旁白 / 弹幕 / 新闻评论 / 读者来信 / 报道 / 采访稿 / 旁观者议论），代词**必须**使用「他」。`,
      '- 称谓可用：哥哥 / 弟弟 / 先生 / 公子 / 那位男子 / 那位郎君 等；具体按当前世界观调整（古风可用「公子」「郎君」「将军」，西幻可用「爵士」「先生」「骑士」，现代可用「哥哥」「先生」）。',
      '- **禁用**「她」「姐姐」「妹妹」「小姐」「女士」「娘子」等任何指向女性的代词或称谓。',
      `- ${currentAgentName} 自己第一人称仍用「我」，但被第三方提及时严格按以上规则。`,
    ].join('\n');
  }
  // nonbinary
  return [
    '',
    '【pronoun / 性别与代词约束（强约束）】',
    `- ${currentAgentName} 的性别为「非二元（non-binary）」。`,
    `- 第三人称提及 ${currentAgentName} 时（旁白 / 弹幕 / 新闻评论 / 读者来信 / 报道 / 采访稿 / 旁观者议论），代词**必须**使用「TA」。`,
    '- 称谓使用中性词：这位 / 那位 / 朋友 / 这位友人 / 那个人；避免任何带性别色彩的称谓。',
    '- **禁用**「他」「她」二元代词；**禁用**「先生 / 女士」「姐姐 / 哥哥」「公子 / 娘子」等明确性别的称谓。',
    `- ${currentAgentName} 自己第一人称仍用「我」，但被第三方提及时严格按以上规则。`,
  ].join('\n');
}

export function formatXingyeSpeakerContextForPrompt(args: {
  userName?: string | null;
  agentName?: string | null;
  /** 当前角色的性别。缺省 / 'unspecified' 视为不强制，模型自行决定代词。 */
  gender?: XingyeRoleGender | null;
}): string {
  const ctx = buildXingyeSpeakerContext(args);
  const genderRules = formatGenderRulesForPrompt(args.gender, ctx.currentAgentName);
  return [
    '【speaker context / 实体归因规则】',
    JSON.stringify(
      {
        currentUserName: ctx.currentUserName,
        currentAgentName: ctx.currentAgentName,
        user: 'recent chat 中 speaker label 为“用户”的说话者。',
        currentAgent: 'recent chat 中 speaker label 为“当前角色”的说话者；也是当前小手机主人。',
        companion: '陪 currentAgent 一起执行安排的人。',
        counterparty: '被验收、被核查、送货、供货、交接、被谈论的一方。',
        mentionedPerson: '被提到但没有明确一起执行安排的人。',
      },
      null,
      2,
    ),
    `- currentUserName=${ctx.currentUserName}；currentAgentName=${ctx.currentAgentName}。`,
    `- user 消息中的“我”指 currentUserName=${ctx.currentUserName}；user 消息中的“你”指 currentAgentName=${ctx.currentAgentName}。`,
    `- agent 消息中的“我”指 currentAgentName=${ctx.currentAgentName}；agent 消息中的“你”指 currentUserName=${ctx.currentUserName}。`,
    '- 当 user 说“我陪你”“我们一起”时，companion=user，不要把第三方 NPC 写成 companion。',
    '- 第三方 NPC 只有在原文明确写“和某某一起做”“某某陪你/陪我做”时，才能作为 companion。',
    '- 当某某是送货、供货、被验收、被核查、被确认、被交接或被谈论的一方时，该 NPC 是 counterparty/mentionedPerson，不是 companion。',
    `- 验货/验收语义：如果 user 说“我陪你一起验货/我们一起验货”，而上下文说明某 NPC 是供货商/送货方/被核查对象，正确表达应类似“和${ctx.currentUserName}一起验收该 NPC 送来的物品”；不要把该 NPC 写成同行执行者。`,
    genderRules,
  ].filter(Boolean).join('\n');
}

function mapRecentSpeaker(role: XingyeRecentMessageRole): XingyeRecentChatSpeaker {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'currentAgent';
  if (role === 'system') return 'system';
  return 'unknown';
}

function buildSpeakerLabel(args: {
  speaker: XingyeRecentChatSpeaker;
  userName: string;
  agentName: string;
}): string {
  if (args.speaker === 'user') return `用户 ${args.userName}`;
  if (args.speaker === 'currentAgent') return `当前角色 ${args.agentName}`;
  if (args.speaker === 'system') return '系统';
  return '未知说话者';
}

export function buildXingyeRecentChatExcerpts(args: {
  context: XingyeRecentContext;
  userName: string;
  agentName: string;
  maxMessages?: number;
  maxCharsPerMessage?: number;
}): XingyeSpeakerRecentChatExcerpt[] {
  const maxMessages = args.maxMessages ?? 16;
  const maxCharsPerMessage = args.maxCharsPerMessage ?? 700;
  const userName = normalizeName(args.userName, '用户');
  const agentName = normalizeName(args.agentName, '当前角色');

  return args.context.messages.slice(-maxMessages).map((message) => {
    const speaker = mapRecentSpeaker(message.role);
    return {
      speaker,
      speakerLabel: buildSpeakerLabel({ speaker, userName, agentName }),
      text: truncateChars(message.content, maxCharsPerMessage),
      createdAt: message.createdAt,
    };
  });
}

export function formatXingyeRecentChatExcerptsForPrompt(excerpts: XingyeSpeakerRecentChatExcerpt[]): string {
  if (!excerpts.length) return '';
  return [
    '最近 OpenHanako 聊天原文片段（最旧→最新；优先按 speaker label 判断“我/你/我们”的指代）：',
    ...excerpts.map((excerpt) => {
      const createdAt = excerpt.createdAt ? ` ${excerpt.createdAt}` : '';
      return `[${excerpt.speakerLabel}${createdAt}] ${excerpt.text}`;
    }),
  ].join('\n');
}

export function buildXingyeSpeakerAiDebugSnapshot(args: {
  userName: string;
  agentName: string;
  recentChatExcerpts: XingyeSpeakerRecentChatExcerpt[];
  prompt: string;
}): XingyeSpeakerAiDebugSnapshot {
  return {
    userName: normalizeName(args.userName, '用户'),
    agentName: normalizeName(args.agentName, '当前角色'),
    recentChatExcerpts: args.recentChatExcerpts.slice(-16).map((excerpt) => ({
      speakerLabel: excerpt.speakerLabel,
      text: truncateChars(excerpt.text, 260),
    })),
    promptSummary: truncateChars(args.prompt.replace(/\s+/g, ' '), 900),
  };
}
