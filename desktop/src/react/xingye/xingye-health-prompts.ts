import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

/**
 * 健康模块 AI prompt。
 *
 * 关键取舍：只让模型返回「当天状态」(scenario) 与「建议模块」(advice)。
 * 四条曲线（心率/步数/睡眠/压力）一律由前端按 isoDate 播种随机生成，
 * 不进 prompt、也不要求模型返回——让模型只做它擅长的「读情绪、写建议」。
 */
export function buildHealthDayPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  isoDate: string;
  /** 最近聊天摘要——推断当天状态的「主信号」。 */
  recentSceneBlock: string;
  /** 是否真的读到了最近聊天；没读到时模型走平稳默认值。 */
  hasRecentChats: boolean;
  /** 常驻核心设定（辅信号）。 */
  stableLoreBlock: string;
  /** 命中的设定库关键词条目（辅信号）。 */
  keywordLoreBlock: string;
  /** 对 user 的关系状态摘要（辅信号）。 */
  relationshipBlock: string;
  /** 最近一次手机首页巡检结果（辅信号，仅情绪参考）。 */
  heartbeatBlock: string;
  /**
   * 反重复锚点：最近若干天的 scenario / advice 标题 / advice 开头摘录。
   * 由 buildHealthContinuityAnchorBlock 拼好后传入；为空 = TA 还没有历史。
   * 用来劝退模型反复给出「多喝水 / 早睡 / 适度运动」这类万能套话。
   */
  continuityAnchorBlock?: string;
}): string {
  const {
    agent,
    profile,
    isoDate,
    recentSceneBlock,
    hasRecentChats,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
  } = args;

  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: profile?.displayName ?? agent.name,
    gender: profile?.gender,
  });
  const taName = profile?.displayName ?? agent.name ?? 'TA';

  const parts: string[] = [
    '你是 TA 手机里「健康」App 的当日分析器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '任务：根据 TA 最近的经历，判断 TA「今天的整体身体状态」，并写一段健康分析建议。',
    '',
    `输出 JSON schema（仅此结构，字段名必须一致）：`,
    JSON.stringify(
      { scenario: 'calm | high_stress | active', advice: { title: 'string', body: 'string' } },
      null,
      2,
    ),
    '',
    'scenario 取值（三选一，依据见下）：',
    '- "high_stress"：最近 TA 明显处于压力、焦虑、冲突、高强度脑力消耗或情绪起伏中。',
    '- "active"：最近 TA 明显在身体活动 / 外出奔波 / 精力旺盛 / 运动量大。',
    '- "calm"：状态平稳、日常、休息为主。信号微弱或缺失时一律用 "calm"。',
    '',
    '判断 scenario 的依据优先级：',
    '1）【主】最近聊天里 TA 实际经历的事与情绪——这是最重要的信号。',
    '2）【辅】角色设定、关系状态、巡检结果，只在主信号不明确时作为补充。',
    hasRecentChats
      ? '本次读到了最近聊天，请以它为主来判断。'
      : '本次没有读到最近聊天，缺乏主信号——scenario 用 "calm"，advice 写得通用、温和、不要编造具体事件。',
    '',
    'advice 写作要求：',
    `- 第三人称，把对象称作「${taName}」或「TA」；这是健康 App 对 TA 当日状态的分析与建议。`,
    '- 长度 150–250 个汉字，分 1–2 段。专业但温和，有具体、可执行的建议。',
    '- 可以呼应最近发生的事（自然带过即可），但不要复述聊天原文，不要出现「根据聊天记录」「用户说」「系统」「模型」等元叙述。',
    '- 不要编造精确数字（如「78 分」「6240 步」）——真实数值由 App 本地生成，写定量会和图表对不上；用「偏高 / 偏低 / 充足 / 破碎」等定性描述即可。',
    '- advice 的语气应与 scenario 一致（high_stress 偏向减压与休息；active 偏向恢复与补给；calm 偏向维持与巩固）。',
    '- title 一般写「今日分析」，也可按当天状态拟一个简短标题。',
    '',
    `当前日期：${isoDate}`,
    '',
    '当前角色（基础身份）：',
    JSON.stringify(
      { id: agent.id, name: agent.name, yuan: agent.yuan, profile: profile ?? null },
      null,
      2,
    ),
    '',
    speakerContextBlock,
    '',
    '【最近发生的事（主信号；判断当天状态的首要依据）】',
    recentSceneBlock.trim() || '（无）',
    '',
    '【星野核心设定摘录（辅信号；勿逐字复述）】',
    stableLoreBlock.trim() || '（无）',
    '',
    '【按需命中的设定库关键词条目（辅信号；勿逐字复述）】',
    keywordLoreBlock.trim() || '（无）',
    '',
    '【当前对 user 的关系状态摘要（辅信号；内部参考）】',
    relationshipBlock.trim() || '（无）',
    '',
    '【最近一次手机首页巡检结果（辅信号；仅情绪参考，勿照抄套话）】',
    heartbeatBlock.trim() || '（无）',
    '',
    '【近期已给出的健康建议样本（请避免重复）】',
    (continuityAnchorBlock ?? '').trim() || '（无；这是 TA 第一次拿到健康建议）',
  ];

  return parts.join('\n');
}
