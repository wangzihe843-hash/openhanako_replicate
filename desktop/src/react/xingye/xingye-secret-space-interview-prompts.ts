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
  SECRET_INTERVIEW_PROP_ICONS,
  SECRET_INTERVIEW_PROP_LIMITS,
  SECRET_INTERVIEW_PROPS_PER_RECORD,
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
    hostIntro: `string（${limits.hostIntroMin}-${limits.hostIntroMax} 字；以**主持人/记者直接开口讲的话**为主体——欢迎语 + 引介 TA + 抛话题铺垫；可夹极少量舞台括注但不要写成小说环境描写）`,
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
    backstage: `string（${limits.backstageMin}-${limits.backstageMax} 字；"相机关了"的彩蛋——必须包含至少一位现场工作人员（场记/摄影/导演/音控/化妆 任选）跟 TA 的互动调侃，以及 TA 的反应；反应方式必须严格 fit TA 的人设）`,
    userQuestionIndex: 'number（仅当用户出了题时填，标记该题是 questions 里第几个，0..4；用户没出题时省略）',
    backstageProps: [
      {
        id: `string（仅 [a-z0-9_]，≤ ${SECRET_INTERVIEW_PROP_LIMITS.idMax} 字符；如 "button" / "yellow_cup"）`,
        label: `string（≤ ${SECRET_INTERVIEW_PROP_LIMITS.labelMax} 字；纯物件名，如「黄铜纽扣」「没动过的水」，不要加修饰）`,
        icon: `'${SECRET_INTERVIEW_PROP_ICONS.join("' | '")}'`,
        x: 'number（百分比 8..92；横坐标）',
        y: 'number（百分比 8..92；纵坐标）',
        snippet: `string（≤ ${SECRET_INTERVIEW_PROP_LIMITS.snippetMax} 字；主持人/旁观视角的一句没说出口的注脚，补 backstage 没明说的层次，不要复述正文）`,
      },
    ],
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
    `- **hostIntro**：**主体是主持人/记者直接开口讲的开场白**（电视/电台/podcast 主持的口吻），不是小说式环境白描。结构上应当包含：欢迎语 → 简短自我介绍/栏目名 → 引介本期嘉宾（TA）是谁、为什么请到 TA → 抛一句话题铺垫，把话题交到 TA 手里。**不要在 hostIntro 里直接问出 Q1**——那是下一页的事。**不要让 TA 在 hostIntro 里开口**——TA 的第一次发声留到 Q1 的 a。允许夹极少量舞台括注（如「（笑）」「（看向镜头）」「（翻开手卡）」），但占比要小；环境描写如果要有，最多一两句话作背景，**不要让场景描写盖过主持人的话**。`,
    `- **backstage**：第三人称场景小段，**必须出现至少一位现场工作人员**（场记 / 摄影 / 导演 / 音控 / 化妆师 / 实习生 任选其一）跟 TA 的互动——通常是工作人员拿刚才录制中的某个点调侃 TA（某题答得太"装"、某句话太硬、某个表情、TA 自己提过的某件糗事），TA **必须**有反应。**关键硬约束：TA 的反应方式必须严格贴合人设**，根据 profile.personalitySummary / speakingStyle / relationshipMode 综合判断：`,
    '  · 温柔 / 内敛 / 守礼型 → 嗔怪一句、耳根发红、装没听见、转移话题、低头笑一下；**不会发火**。',
    '  · 傲娇 / 嘴硬 / 别扭型 → 假装恼火、嘴硬反击、摔个小道具、扭头不理；表面凶但藏不住情绪。',
    '  · 冷淡 / 高冷 / 寡言型 → 淡淡一句不痛不痒的回敬、瞥一眼、不接话；**不会真情绪外露**。',
    '  · 活泼 / 外放 / 没架子型 → 才可能真"恼羞成怒"地拍一下工作人员、笑着追打两句、放话报复回去。',
    '  · 其它（沉稳 / 油滑 / 病娇 / 痞气…）依此类推——核心是"这个反应放在 TA 身上要让人觉得自然"。**写出一个明显错位的反应（例如温柔角色突然爆粗、冷淡角色拍桌）= 重写**。',
    `- **backstage 的灵魂**：与 Q&A 期间的"公开人设"形成微妙落差——TA 在镜头前是一种样子，相机关了被熟人调侃时又是另一种。**不要**直接揭穿、不要写成"原来 TA 真实的一面是 xxx"这种反转独白；用工作人员的一两句对话 + TA 的动作 / 神态 / 一句没头没尾的回话来透。`,
    '- **backstage 写法格式**：场景化叙述，可以直接写工作人员的话（用引号或破折号引出，并交代是哪个工种在说，如「场记探头进来：『……』」「摄影一边收线一边嘟囔：『……』」），紧跟 TA 的动作或一句回应。**不要写成纯独白也不要写成纯环境白描**。',
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
    `## 现场物证 backstageProps（可选 ${SECRET_INTERVIEW_PROPS_PER_RECORD.min}-${SECRET_INTERVIEW_PROPS_PER_RECORD.max} 件）`,
    '从你刚写的 backstage 段落里，挑出 1-3 个具体的物件细节，让用户在「相机关了之后」那一页上点击点亮它们，触发一句额外旁白。这是"可选字段"——但有它能让幕后页明显更有"现场感"，尽量给。',
    '',
    '硬约束：',
    '- 每件物件**必须**在 backstage 正文里至少出现一次（或正文里有明确暗示其存在的细节），不许凭空新加物件。',
    `- icon 从固定 ${SECRET_INTERVIEW_PROP_ICONS.length} 类中选：${SECRET_INTERVIEW_PROP_ICONS.map((i) => `\`${i}\``).join(' / ')}（分别对应：纽扣 / 水杯 / 线材 / 纸条 / 打火机 / 卡片）。找不到合适的 icon 就**不要加这件**——宁缺毋滥。`,
    `- label ≤ ${SECRET_INTERVIEW_PROP_LIMITS.labelMax} 字，**只写物件名**（"黄铜纽扣"对，"林雾的黄铜纽扣"或"她口袋里的旧纽扣"错——形容词留给 snippet）。`,
    `- snippet ≤ ${SECRET_INTERVIEW_PROP_LIMITS.snippetMax} 字，用主持人/旁观第三方视角写的一句**没说出口的注脚**：补 backstage 没明说的层次（来历、习惯、未言之意），**不要复述正文里已经写过的话**。`,
    '- x / y 是百分比坐标（8..92），把物件错开摆放——**不要全挤在 x ∈ [30, 70] 且 y ∈ [30, 60] 的正文区域**；优先靠近画面四角或两侧。',
    '- id 用 [a-z0-9_]，简短可读（如 "button" / "cup" / "cable" / "yellow_card"），同一期 id 不要重复。',
    '- 物件之间应有不同切面：不要 3 件都是同类小物（如 3 个水杯）；理想是物 + 物 + 物各自指向不同细节。',
    '',
    '**降级规则：若 backstage 正文里没有合适的具体物件，或挑出来与正文矛盾，请省略 backstageProps 或返回空数组——不要凭空造。** 阅读器会优雅降级到无物件交互。',
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
