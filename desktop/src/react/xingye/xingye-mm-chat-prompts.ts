import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

export type MmChatGenerationMode = 'new' | 'followup';

export function formatMmChatSessionHistoryForPrompt(args: {
  taMoniker: string;
  lines: { role: 'ta' | 'ai'; text: string }[];
  maxChars: number;
}): string {
  const { taMoniker, lines, maxChars } = args;
  if (!lines.length) return '（尚无历史）';
  const chunks = lines.map((line) => {
    const label = line.role === 'ta' ? `${taMoniker} · 向助手提问` : '通用 AI 助手 · 回复';
    return `[${label}]\n${line.text.trim()}`;
  });
  const marker = '…（更早内容已省略）\n\n';
  let chosen = [...chunks];
  let dropped = 0;
  while (chosen.join('\n\n').length > maxChars && chosen.length > 1) {
    chosen = chosen.slice(1);
    dropped += 1;
  }
  let joined = (dropped > 0 ? marker : '') + chosen.join('\n\n');
  if (joined.length > maxChars) {
    const only = chosen[0] ?? '';
    const budget = Math.max(120, maxChars - (dropped > 0 ? marker.length : 0));
    joined =
      (dropped > 0 ? marker : '') +
      (only.length > budget ? `${only.slice(0, budget)}…` : only);
  }
  return joined;
}

function appendContextTail(parts: string[], args: {
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
}): void {
  parts.push(
    '【最近发生的事（仅供构思提问动机；勿在正文中交代信息来源）】',
    args.recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（lore-memory / 常驻设定；勿逐字复述）】',
    args.stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；勿逐字复述）】',
    args.keywordLoreBlock.trim() || '（无）',
    '',
    '【当前对 user 的关系状态摘要（内部参考）】',
    args.relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（若有；仅作情绪参考，勿照抄套话）】',
    args.heartbeatBlock.trim() || '（无）',
  );
}

/** 首轮 MM Chat：角色向通用助手发起的一轮咨询。 */
export function buildMmChatGenerationPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  /**
   * 跨会话反重复锚点（由 buildMmChatContinuityAnchorBlock 渲染）。
   * 抽 TA 最近几个 session 的 title + 首问，让模型在生成 new 会话时换不同切口，
   * 不要短时间内连开几个几乎一模一样的咨询。
   *
   * 空串 → 渲染「（无；这是 TA 第一次咨询通用助手）」。
   */
  continuityAnchorBlock?: string;
}): string {
  const { agent, profile, recentSceneBlock, stableLoreBlock, keywordLoreBlock, relationshipBlock, heartbeatBlock } =
    args;
  const continuityAnchorBlock = (args.continuityAnchorBlock ?? '').trim();
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
    gender: profile?.gender,
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
    '只写一轮：一个 question、一个 answer。不要在同一 JSON 里虚构多轮追问。',
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
    '【近期已咨询过的会话（跨会话反重复锚点；请换不同切口，不要短时间内重复发起几乎相同的咨询）】',
    continuityAnchorBlock || '（无；这是 TA 第一次咨询通用助手）',
    '',
  ];
  appendContextTail(parts, {
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
  });
  return parts.join('\n');
}

/**
 * 追问第 1 步：只生成「当前角色」向通用助手说的下一句追问（agentFollowupQuestion）。
 * 用户提供的 directionHint 仅为创作方向，禁止原样抄成整句提问。
 */
export function buildMmChatFollowupAgentQuestionPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  sessionTitle: string;
  sessionHistoryBlock: string;
  previousAiAnswer: string;
  /** 可选；产品侧「追问方向」短提示，不是角色台词。 */
  followUpDirectionHint: string;
}): string {
  const { agent, profile, relationshipBlock, heartbeatBlock } = args;
  const taMoniker = (profile?.displayName ?? agent.name).trim() || agent.name;
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
    gender: profile?.gender,
  });
  const hint = args.followUpDirectionHint.trim();
  const parts: string[] = [
    '你是星野模式「MM Chat」追问链路的第一步：只生成「当前角色」向「通用 AI 助手」说的下一句追问文本。',
    '只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '场景：角色独自面对中立问答界面，对助手上一轮回复仍不满意、没看懂或想继续澄清，因此自己继续发问。',
    '禁止写成 user/读者在采访角色；禁止把「追问方向提示」里的词原样当作整句提问抄进去（须改写为完整、自然、符合角色口吻的一句/一小段话）。',
    '若「追问方向提示」为（无）：请根据角色设定、上一轮助手回复与会话上下文，自行构思一个带「角色式判断方式」的后续追问。',
    '发问对象始终是通用助手，不要写成给 user 的私信。',
    '',
    '【人格与判断框架（优先级高于本会话闲聊语气）】',
    '角色的长期人格、价值观与习惯来自「当前角色」JSON、「星野核心设定」「按需命中的设定库」等；本会话历史仅作本次咨询的上下文，不得用一两轮问答覆盖或改写角色的稳定判断方式。',
    '「追问方向提示」只提供当下意图方向，不得压过上述稳定人格：追问的措辞与思维习惯仍须像该角色本人。',
    '',
    '【追问须带「角色式判断点」（不要写成平淡的办事员接话）】',
    'agentFollowupQuestion 不应只是复述「我下一步去做某事」或替助手答应执行；应体现该角色惯用的思考切口，并自然嵌入至少一类判断点，例如（择一或组合，勿机械列清单）：',
    '- 哪个环节风险最高、最先该核什么；',
    '- 核验顺序与证据链：先确认什么最不容易误判/不打草惊蛇；',
    '- 如何把说法或行动压在边界内、怎么保留退路；',
    '- 哪些是可验证的事实、哪些仍是推测，需要助手把步骤说到可核对；',
    '- 对信息来源与对方立场的保留态度（不轻易全盘采信），用角色自己的语气表达。',
    '',
    '【克制、冷静、有边界的默认倾向（与具体人设一致时可更强或略柔，但勿滑向套路化焦虑）】',
    '若无相反设定：追问可偏先核事实、先判风险、先排优先级；语气克制、冷静、有边界；话不说满；要求更具体、可执行、可验证的步骤。',
    '',
    '【禁止强行加戏】',
    '若本会话主题明显不是感情/亲密关系：不要主动加入感情拉扯、暧昧、低姿态讨好、反复自我怀疑或关系焦虑式独白。',
    '若主题涉及感情/边界：可以写顾虑，但落点应在边界、行动与可验证选择上，不要写成自我否定的循环。',
    '若主题偏查证、档案、事件复盘、行动方案：优先组织「核验顺序、风险控制、证据链、退路、边界、避免打草惊蛇」类追问，而不是泛泛承诺「我去做再告诉你」。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify({ agentFollowupQuestion: 'string' }, null, 2),
    '',
    `agentFollowupQuestion：${taMoniker} 对助手说的话；口语自然，可含礼貌用语；不要加「角色：」等前缀。`,
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
    '【本会话标题（内部参考）】',
    args.sessionTitle.trim() || '（未命名）',
    '',
    '【本会话既有历史（角色 ⇄ 通用助手；按时间顺序；勿在正文中交代本节标题）】',
    args.sessionHistoryBlock.trim() || '（无）',
    '',
    '【上一轮助手完整回复（聚焦对象；勿在正文中交代本节标题）】',
    args.previousAiAnswer.trim() || '（无）',
    '',
    '【追问方向提示（产品侧；可为空；勿逐字复述为角色整句提问）】',
    hint || '（无）',
    '',
  ];
  appendContextTail(parts, {
    recentSceneBlock: args.recentSceneBlock,
    stableLoreBlock: args.stableLoreBlock,
    keywordLoreBlock: args.keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
  });
  return parts.join('\n');
}

/**
 * 追问第 2 步：通用助手针对 agentFollowupQuestion 生成回复。
 */
export function buildMmChatFollowupAssistantAnswerPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  sessionHistoryBlock: string;
  agentFollowupQuestion: string;
}): string {
  const { agent, profile, relationshipBlock, heartbeatBlock } = args;
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
    gender: profile?.gender,
  });
  const parts: string[] = [
    '你是星野模式「MM Chat」追问链路的第二步：扮演「通用 AI 助手」，针对角色刚提出的追问给出下一段回复。',
    '只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '口吻：清晰、克制、可执行；不要扮演另一个虚构人物；不要替 user 说话；不要反问读者。',
    '禁止在 assistantAnswer 中出现「根据系统」「用户让我」等元叙述。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify({ assistantAnswer: 'string' }, null, 2),
    '',
    'assistantAnswer：直接回答角色的追问，分段换行允许。',
    '',
    '当前角色（便于把握称呼与边界；勿在回答中泄露未在提问中出现的隐私）：',
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
    '【本会话既有历史（仅供理解语境；勿在回答中复述本节标题）】',
    args.sessionHistoryBlock.trim() || '（无）',
    '',
    '【角色本轮追问（须正面回应）】',
    args.agentFollowupQuestion.trim(),
    '',
  ];
  appendContextTail(parts, {
    recentSceneBlock: args.recentSceneBlock,
    stableLoreBlock: args.stableLoreBlock,
    keywordLoreBlock: args.keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
  });
  return parts.join('\n');
}
