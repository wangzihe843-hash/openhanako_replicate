import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

export function buildMmChatGenerationPrompt(args: {
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
    '你是星野模式「MM Chat」生成器：产出当前角色向「通用 AI 助手」发起的一轮咨询。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '场景：角色独自打开一个中立的文字问答界面，向通用助手请教（学习、情绪、计划、措辞、常识等）。',
    '禁止写成短信、群聊、即时通讯里和某个真人的私聊；不要出现收件人昵称、群公告、已读未读等聊天软件桥段。',
    '禁止写成「用户来问角色」或「读者采访角色」；发问者必须是下面 JSON 里描述的当前角色本人。',
    '回答者必须是通用品格的助手口吻（清晰、克制、可执行），不要扮演另一个虚构人物，不要替 user 说话。',
    '',
    '禁止在 question 与 answer 正文中出现：「根据聊天记录」「系统提示」「用户要求」「模型」「OpenHanako」等元叙述。',
    '不要逐字复述输入里的小节标题；不要交代这些信息从何而来。',
    '助手的回答只依据提问里明确给出的信息与常识；不要替提问者确认其未在提问中透露的隐秘设定或他人内心。',
    '',
    '若「最近发生的事」段落几乎为空：question 仍须由角色发起，可以是基于身份与状态的轻量困惑或自我整理式提问；answer 简短务实即可。',
    '',
    '只写一轮：一个 question、一个 answer。不要多轮追问。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify({ title: 'string', question: 'string', answer: 'string' }, null, 2),
    '',
    'title：本会话的简短标题（一行，不要书名号堆叠）。',
    'question：角色对助手的提问，语气符合角色身份与口吻，长度适中。',
    'answer：助手的直接回复，分段换行允许，不要加角色扮演前缀。',
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
    '【最近发生的事（仅供构思提问动机；勿在正文中交代信息来源）】',
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
