import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

export function buildScheduleDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
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
  const currentAgentName = profile?.displayName?.trim() || agent.name;
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });

  const parts: string[] = [
    '你是星野模式「小手机日程」草稿生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '生成目标：这是当前角色手机里的安排记录，不是系统提醒，不会触发通知、倒计时、后台任务或自动执行。',
    '不要写成 OpenHanako 任务、task plan、cron、reminder、系统待办或开发计划。',
    '不要出现「根据聊天记录」「系统提示」「模型」「AI」「用户让我」等元叙述。',
    '如果聊天里没有明确安排，不要硬编；可以让 content 或 note 简短说明材料不足，但必须避免制造重大剧情。',
    '可以保留自然语言时间，例如「明天上午」「下次去诊所前」「今晚睡前」。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify(
      {
        title: 'string',
        dateLabel: 'string',
        timeText: 'string',
        content: 'string',
        note: 'string',
        status: 'planned',
        category: 'string',
      },
      null,
      2,
    ),
    '',
    '字段要求：status 只能是 "planned"。title/dateLabel/content 不能为空；timeText 和 note 可以为空字符串。',
    'category 字段：在「约定 / 提醒 / 自己定的 / 也许吧 / 平常」五个中文短语中选一项（用于客户端配色）。无法判断时输出 "平常"；不要发明新的分类。',
    '',
    speakerContextBlock,
    '- heartbeat result、relationship state、stable lore、keyword lore 都只是辅助身份/关系背景；具体安排优先来自用户输入和带 speaker label 的 recent chat 原文片段。',
    `- 日程标题/内容要写成当前角色手机里的安排；验货场景可写“和${currentUserName}一起验收刘老板送来的药品”，但不得写“与刘老板验药”或“和刘老板一起验药”。`,
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
    '【用户输入的日程意图（若有）】',
    userIntent.trim() || '（无）',
    '',
    '【最近 OpenHanako 聊天（安排来源；勿在输出里交代信息来源）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（stable lore；只作角色边界参考）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    '【当前对 user 的关系状态摘要（若有）】',
    relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（若有；仅作背景参考）】',
    heartbeatBlock.trim() || '（无）',
  ];

  return parts.join('\n');
}
