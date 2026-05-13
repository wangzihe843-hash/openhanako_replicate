import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

export function buildJournalDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
}): string {
  const { agent, profile, recentSceneBlock, stableLoreBlock, keywordLoreBlock, relationshipBlock, heartbeatBlock } = args;
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
  });

  const parts: string[] = [
    '你是星野模式「小手机日记」草稿生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '写作身份：这是当前角色写给自己的私人日记，第一人称「我」。',
    '禁止写成用户视角、读者视角或系统总结；不要出现「根据聊天记录」「用户说」「系统提示」「模型」「AI」等元叙述。',
    '不要复述或引用输入里的标签行（例如「最近场景」「关系状态」等小节标题）；直接写日记口吻。',
    '可以写角色没有说出口的感受与犹豫，但不要凭空捏造重大剧情、生死、关系决裂等输入里不存在的事件。',
    '',
    '长度：正文 body 约 150–500 个汉字（宁短勿滥）；标题 title 一行、简短，不要书名号堆叠。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify({ title: 'string', body: 'string' }, null, 2),
    '',
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
  ];

  return parts.join('\n');
}
