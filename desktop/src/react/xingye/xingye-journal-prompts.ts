import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 首次打开「日记」app 时的批量历史生成 prompt。
 *
 * 与 buildJournalDraftPrompt（单条草稿）的关键区别：
 *  - 一次产出 desiredCount 条（3–5）「TA 过去某些时间写下的旧日记」；
 *  - 每条必须自带 dayKey（YYYY-MM-DD）；时间跨度不设上限——背景故事可能跨几个月、
 *    几年甚至更久前，由模型按 lore 自己挑日子并跨期分布，**不要全堆在最近一周**；
 *  - 不依赖最近聊天（user 视角可能此前完全没出现），主要靠 stable lore + profile；
 *  - 输出 JSON 是 { entries: [...] } 包络，每条 { title, body, mood?, dayKey }。
 *
 * 调用方拿到结果后直接 append 到 entries.jsonl（绕过 draft 流，避免首开就被 5 条
 * 待确认草稿淹没——和购物 init 同样的处理）。
 */
export function buildJournalHistoryPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  /** 3–5；调用方截到这个范围。 */
  desiredCount: number;
  /** 用来告诉模型今天是哪天，所有 dayKey 都必须早于这天。 */
  todayYmd: string;
}): string {
  const {
    agent,
    profile,
    stableLoreBlock,
    keywordLoreBlock,
    desiredCount,
    todayYmd,
  } = args;
  const count = Math.max(3, Math.min(5, Math.floor(desiredCount)));
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
    gender: profile?.gender,
  });

  const parts: string[] = [
    '你是星野模式「小手机日记 · 初始化历史」生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '场景：TA 刚把日记 app 打开。这是 TA 自己手机里 **过去** 留下的几篇旧日记，由 TA 自己写过、',
    '现在被一并装进新手机本子里。请一次性产出 ' + count + ' 条「TA 在过去某些时刻写下的私人日记」。',
    '',
    '写作身份：第一人称「我」，TA 自己写给自己。',
    '不要写成用户视角、读者视角或系统总结；不要出现「根据聊天记录」「用户说」「系统提示」「模型」「AI」等元叙述。',
    '可以写没有说出口的感受与犹豫；不要凭空捏造重大剧情（生死、关系决裂、未在 lore 里的他人）。',
    '',
    '【时间跨度 · 关键约束】',
    `今天是 ${todayYmd}（YYYY-MM-DD）。每条日记必须自带一个 dayKey 字段，**严格早于今天**。`,
    '时间跨度**不设上限**——TA 的背景故事可能跨几个月、几年甚至更久前。',
    '请根据【星野核心设定】里的身份、年龄、人生节点、世界观，自己判断 TA 哪些过去时刻值得记一笔，',
    '把 ' + count + ' 条 dayKey **跨期分布**，不要全堆在最近一周或同一个月——',
    '可以是「上周某个雨夜」「半年前刚搬家时」「去年生日前」「几年前刚遇到 user 的时候」这种混合。',
    'dayKey 必须是合法 YYYY-MM-DD 格式（例如 2024-03-15），不要写成中文或自然语言。',
    '',
    '【长度 / 字段】',
    '正文 body 约 150–500 个汉字（宁短勿滥）；标题 title 一行、简短，不要书名号堆叠。',
    'mood 字段：2–6 字心情短语（如「平淡 / 想他 / 安静 / 烦躁」），心情不清晰时可省略该字段（不要写空字符串）。',
    '',
    '输出 JSON schema（仅此结构）：一个对象 { "entries": [ ... ] }，entries 数组长度必须 = ' + count + '。每个元素：',
    JSON.stringify(
      {
        title: 'string',
        body: 'string',
        mood: 'string（可省略）',
        dayKey: 'YYYY-MM-DD（必填，严格早于今天）',
      },
      null,
      2,
    ),
    '',
    '【内容多样性】',
    '- ' + count + ' 条日记 **主题 / 情绪 / 笔调要错开**：不要全是想 user、全是工作累、全是雨天。',
    '- 可以混合：日常小事的安静；某次情绪起伏；对一件旧物 / 一个地方的回忆；某天天气；某次小决定。',
    '- 同一主题最多写一篇；同一天最多写一篇（dayKey 不能重复）。',
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
    '【星野核心设定摘录（lore-memory / 常驻设定；是判断 TA 过去经历的主要依据；勿逐字复述）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；勿逐字复述）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    `记住：只输出 { "entries": [...] } 一个 JSON 对象；entries 长度 = ${count}；每条都有合法的 dayKey（YYYY-MM-DD，严格早于 ${todayYmd}），dayKey 互不相同，跨期分布。`,
  ];

  return parts.join('\n');
}

export function buildJournalDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  /**
   * 跨期连续性锚点（防止反复写"今天又…"）：列出最近 8 篇日记的标题 + 开头 30 字。
   * 调用方用 buildJournalContinuityAnchorBlock 生成；可空。
   */
  continuityAnchorBlock?: string;
}): string {
  const {
    agent,
    profile,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock = '',
  } = args;
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
    gender: profile?.gender,
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
    JSON.stringify({ title: 'string', body: 'string', mood: 'string' }, null, 2),
    '',
    'mood 字段：2–6 字的心情短语（如「平淡 / 想他 / 温柔 / 安静 / 低落 / 烦躁」），不超过 24 字符。心情不清晰时可省略该字段；不要写完整句子。',
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
    '',
    '【最近写过的日记（跨期防重复，必读；今天请换主题/换笔调/换角度，不要复读"今天又…"）】',
    continuityAnchorBlock.trim() || '（无；这是 TA 写的第一篇日记）',
  ];

  return parts.join('\n');
}
