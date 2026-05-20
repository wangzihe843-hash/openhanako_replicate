/**
 * 「秘密空间 · TA 的独家专访」的 prompt 构造器。
 *
 * 模型一次返回整期专访：1 个开场场记 + 5 个 Q&A（每题带 4-6 条弹幕）+ 1 段"相机关了"彩蛋。
 * 与新闻模块的不同之处：
 *  - **第一人称受访**：TA 自己开口回答，不是第三方报道。
 *  - **固定 5 题**：少了或多了都会被 normalize 拒绝。
 *  - **可吃用户出题**：如果用户给了一题（userQuestion），必须原样出现在 questions 里
 *    其中一个位置；同时设置 userQuestionIndex 标记它是第几题。
 *  - **三档弹幕**：audience / fan / editor，UI 会按 tag 上色与微调动画。
 *  - **backstage 必须存在**：单独一段"相机关了"的彩蛋，是这个模块的灵魂；少了就重写。
 */

import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';
import {
  SECRET_INTERVIEW_DANMAKU_PER_QUESTION,
  SECRET_INTERVIEW_DANMAKU_TAGS,
  SECRET_INTERVIEW_LIMITS,
  SECRET_INTERVIEW_QUESTIONS_PER_RECORD,
} from './xingye-secret-space-interview-types';

export function buildSecretInterviewPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  /** 录制日（ISO）。模型可以读到，但不要原样写进正文。 */
  recordedAtIso: string;
  /** 用户出的那一题（可空）；若给出，必须放到 questions 里某一个位置。 */
  userQuestion?: string;
  /** 上一期专访的标题 + 主持人名（跨期连续性，可空）。 */
  continuityAnchorBlock: string;
  /** 最近聊天 / 场景摘要。 */
  recentSceneBlock: string;
  /** 设定库 always 块（lore-memory.md 或 always 项）。 */
  stableLoreBlock: string;
  /** 设定库关键词触发块。 */
  keywordLoreBlock: string;
  /** 当前关系状态（JSON 序列化）。 */
  relationshipBlock: string;
}): string {
  const {
    agent,
    userName,
    profile,
    recordedAtIso,
    userQuestion,
    continuityAnchorBlock,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
  } = args;

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
    gender: profile?.gender,
  });

  const userQ = userQuestion?.trim() ?? '';

  const limits = SECRET_INTERVIEW_LIMITS;
  const danmakuRange = SECRET_INTERVIEW_DANMAKU_PER_QUESTION;
  const danmakuTagList = SECRET_INTERVIEW_DANMAKU_TAGS.join(' / ');

  const schemaExample = {
    title: 'string（≤ 40 字；如「专访 · 林雾：在边境医院的第七年」）',
    hostName: 'string（≤ 24 字；虚构主持人/记者笔名）',
    hostIntro: `string（${limits.hostIntroMin}-${limits.hostIntroMax} 字；演播室 / 录音室 / 后台描述 + 主持人开场白）`,
    questions: [
      {
        q: `string（≤ ${limits.questionTextMax} 字；主持人提问）`,
        a: `string（${limits.answerMin}-${limits.answerMax} 字；TA 第一人称回答）`,
        danmaku: [
          {
            text: `string（≤ ${limits.danmakuTextMax} 字）`,
            tag: `'${SECRET_INTERVIEW_DANMAKU_TAGS.join("' | '")}'`,
          },
        ],
      },
    ],
    backstage: `string（${limits.backstageMin}-${limits.backstageMax} 字；"相机关了"的彩蛋）`,
    userQuestionIndex: 'number（仅当用户出了题时填，标记该题是 questions 里第几个，0..4；用户没出题时省略）',
  };

  const parts: string[] = [
    '你是星野模式「秘密空间 · TA 的独家专访」一期内容生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '## 生成目标',
    `生成一期 ${currentAgentName}（即 TA）以**第一人称**接受访问的录制稿。`,
    '这不是 TA 的日记，也不是聊天记录——这是一份虚构的"专访栏目"录制内容，主持人提问，TA 回答；',
    '观众通过弹幕实时评论；录制结束后还有一段"相机关了"的彩蛋——TA 以为相机关了之后说 / 做的事。',
    '',
    '## 视角硬约束（违反就重写）',
    `- **Q&A 部分**：q 是主持人提问，第三人称问 TA；a 是 ${currentAgentName} 用**第一人称**回答（"我……"），语气、用词、节奏都要符合 TA 平时的说话风格。`,
    `- **不要写成对话剧本**：每个 a 是 TA 的一段独白式回答，里面可以引述用户但**不要让 ${currentUserName} 直接出场说话**。`,
    `- **hostIntro**：第三人称场景描述（演播室、TA 进门、灯光、神态），可以含主持人开场白一两句；不是 TA 自述。`,
    `- **backstage**：第三人称场景描述为主，可以引用 TA 一两句"以为相机关了之后"的话。**关键点**：与 Q&A 期间的"公开人设"形成微妙落差——TA 在镜头前是一种样子，相机关了又是另一种样子。**不要**直接揭穿、不要写成反转独白；用动作 / 神态 / 一句没头没尾的话来透。`,
    '- 不要出现「根据聊天记录」「用户让我」「系统提示」「模型」「AI」「prompt」「OpenHanako」「设定库」等元叙述。',
    '',
    '## 题数与结构硬约束',
    `- **必须恰好 ${SECRET_INTERVIEW_QUESTIONS_PER_RECORD} 题**。少了会被拒收，多了会被截断。`,
    '- 5 题应当有节奏：1-2 题轻松/破冰（职业、日常、最近在忙什么） → 3-4 题挖深一点（价值观、与用户的关系、一个具体事件） → 5 题留余韵（一个意味深长的开放问题）。',
    '- 题目之间要有递进或对比，不要 5 题都问同类问题。',
    '',
    '## 用户出题（重要）',
    userQ
      ? `- 用户本次出了一题：「${userQ}」。**必须把这题原样（或仅做极小润色，保留语义）放进 questions 中的某一题**，并设置 userQuestionIndex 为该题的下标（0..4）。`
        + '\n- 建议把用户的题放在第 3 题（index=2）或第 4 题（index=3）的位置，让它出现在挖深的环节，而不是开场或收尾。'
      : '- 用户本次**没有**出题——5 题全部由你拟定。**不要**设置 userQuestionIndex。',
    '',
    '## 弹幕硬约束',
    `- 每题配 ${danmakuRange.min}-${danmakuRange.max} 条弹幕。少了会显得单调，多了会被截到 ${danmakuRange.max} 条。`,
    `- tag 必须是这三档之一：${danmakuTagList}。`,
    '  · audience（吃瓜路人）：旁观、揶揄、起哄。如「她这眼神又来了」「上一题答得真心虚」「我嗑爆」。',
    '  · fan（粉丝党）：偏爱、护短、磕 cp。如「姐姐永远是我心头朱砂痣」「这一段我已经截图存好了」。',
    '  · editor（记者旁注）：像剧本提示 / 场记。如「此处停顿三秒」「TA 看了一眼摄像机」「下意识攥紧了袖口」。',
    '- editor 弹幕兼有"舞台描述"功能，每题至少要有 1 条 editor 弹幕（不然全是吵闹，缺骨架）。',
    `- 单条弹幕 ≤ ${limits.danmakuTextMax} 字。`,
    '- 不同弹幕之间不要重复语义；不要全部围绕同一句答话评论。',
    '',
    '## 字数硬约束',
    `- hostIntro：${limits.hostIntroMin}-${limits.hostIntroMax} 字。`,
    `- q：≤ ${limits.questionTextMax} 字。`,
    `- a：${limits.answerMin}-${limits.answerMax} 字。`,
    `- danmaku.text：≤ ${limits.danmakuTextMax} 字。`,
    `- backstage：${limits.backstageMin}-${limits.backstageMax} 字。`,
    `- title：≤ ${limits.titleMax} 字。`,
    `- hostName：≤ ${limits.hostNameMax} 字（虚构笔名即可）。`,
    '- 超长会被系统截断成省略号，所以**写到接近 max 但不超过 max** 是理想区间。',
    '',
    '## 跨期连续性（必读）',
    continuityAnchorBlock || '（无；这是 TA 的第一期独家专访——可以新设定一个栏目名 / 主持人名，后续期数应当沿用同一组）',
    '',
    '## 输出 JSON schema（结构必须严格一致；额外字段会被丢弃）',
    JSON.stringify(schemaExample, null, 2),
    '',
    '## 当前角色',
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
    `## 录制日：${recordedAtIso}`,
    '',
    '## 用户本次出的题（可空）',
    userQ || '（无；5 题全由你拟定）',
    '',
    '## 设定库（always 项 / lore-memory.md）',
    stableLoreBlock || '（无）',
    '',
    '## 设定库（关键词触发）',
    keywordLoreBlock || '（无）',
    '',
    '## 最近聊天 / 场景摘要',
    recentSceneBlock || '（无）',
    '',
    '## 当前关系状态',
    relationshipBlock || '（无）',
    '',
    '## 收尾',
    '现在生成本期专访的 JSON。只输出 JSON 对象本身，不要 ```json``` 围栏，不要任何解释文字。',
  ];

  return parts.join('\n');
}
