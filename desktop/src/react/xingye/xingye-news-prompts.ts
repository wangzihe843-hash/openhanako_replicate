import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';
import type { NewsEraId } from './xingye-news-era-resolver';
import { NEWS_ERA_LABELS } from './xingye-news-era-resolver';
import { getNewsEraStyle, type NewsEraStyleDescriptor } from './xingye-news-era-style';
import {
  AT_LEAST_ONE_OF_RELATIONSHIP_SECTION_KINDS,
  NEWS_MASTHEAD_MAX,
  NEWS_SECTION_KINDS,
  NEWS_SECTION_REGISTRY,
  NEWS_SECTIONS_PER_ISSUE,
  REQUIRED_SECTION_KINDS,
} from './xingye-news-types';

/**
 * 构造「小手机报纸」一期内容的 prompt。
 *
 * 设计要点：
 *  - 模型一次生整张报纸（masthead + 2-4 个板块），让板块之间能互文。
 *  - 板块定义全部从 NEWS_SECTION_REGISTRY 取，prompt 端只负责"组装"。
 *  - 视角强约束：第三人称客观报道 / 第三方专栏，**禁止** TA 第一人称自述、用户对话原文复读。
 *  - 字数强约束：每个 section.body 必须在 [min, max] 内；超长 normalize 会截断，模型应当尽量贴近 max。
 *  - continuityAnchorBlock 是新闻专属"反重复锚点"：列出近期已用过的 masthead /
 *    headline 标题 / gossip 开头，要求本期与之**不同主题、不同笔调切口**。
 */
export function buildNewsDraftPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  profile: XingyeRoleProfile | null | undefined;
  /** 当期出版日（ISO）。模型可以读到，但不要原样写进正文。 */
  issueDateIso: string;
  /** 用户在弹窗里写的"今天想读什么"提示（可空）。 */
  userIntent: string;
  recentSceneBlock: string;
  stableLoreBlock: string;
  keywordLoreBlock: string;
  relationshipBlock: string;
  heartbeatBlock: string;
  /** 历史 masthead / 头条 / 感情专栏开头样本，跨期防重复用。 */
  continuityAnchorBlock: string;
  /** resolveNewsEra 给出的笔调 era（modern_or_future 兜底）。 */
  era: NewsEraId;
  /** era 对应的笔调描述符。**调用方应**用 getNewsEraStyle(era) 取，与 era 保持一致。 */
  eraStyle: NewsEraStyleDescriptor;
}): string {
  const {
    agent,
    userName,
    profile,
    issueDateIso,
    userIntent,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
    era,
    eraStyle,
  } = args;
  // 兜底：万一调用方传的 eraStyle 与 era 不匹配，按 era 重取一次（防止断链）。
  const style = eraStyle ?? getNewsEraStyle(era);
  const eraLabel = NEWS_ERA_LABELS[era] ?? NEWS_ERA_LABELS.modern_or_future;

  const currentUserName = userName?.trim() || '用户';
  const currentAgentName = profile?.displayName?.trim() || agent.name || '当前角色';
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: currentUserName,
    agentName: currentAgentName,
  });

  const requiredKindList = REQUIRED_SECTION_KINDS.join(' / ');
  const relationshipKindList = AT_LEAST_ONE_OF_RELATIONSHIP_SECTION_KINDS.join(' / ');

  const sectionGuideLines: string[] = [];
  for (const kind of NEWS_SECTION_KINDS) {
    const def = NEWS_SECTION_REGISTRY[kind];
    const titleCands = def.titleCandidates.map((t) => `「${t}」`).join('、');
    const [minC, maxC] = def.targetChars;
    sectionGuideLines.push(
      `- ${kind}（${def.label}）：${def.taskPrompt}`
      + ` 字数 ${minC}-${maxC} 字。标题必须从这些候选里选一个填入：${titleCands}。`,
    );
  }

  const schemaExample = {
    masthead: 'string',
    sections: [
      {
        kind: '上面 10 个 kind 之一',
        title: 'string（必须是对应 kind 的 titleCandidates 之一）',
        body: 'string',
        byline: 'string（可选，虚构记者/笔名/化名）',
      },
    ],
  };

  const eraGuideLines: string[] = [
    `本期报纸的 era（已由系统按 agent 设定识别）：**${era}** — ${eraLabel}。`,
    `笔调：**${style.toneName}**。${style.toneSummary}`,
    '',
    '### 写作守则（按本笔调严格执行）',
    ...style.writingStyleGuide,
    '',
    '### 标题与 headline 风格',
    ...style.headlineStyleGuide,
    '',
    '### 本笔调专属禁忌',
    ...style.taboos.map((t) => `- ${t}`),
  ];

  const parts: string[] = [
    '你是星野模式「小手机报纸」一期内容生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '## 生成目标',
    '生成"当前角色（TA）手机里出现的一张第三方报纸"。这份报纸由虚构的报社记者 / 专栏作者撰写，'
    + '从外部视角报道 TA 所处的世界、以及 TA 与用户的关系动向。**不是 TA 的日记、不是 TA 的朋友圈、'
    + '不是 TA 的私人短信**——而是一份对外发行的报刊，TA 只是其中被报道的对象之一。',
    '',
    '## 视角硬约束（违反就重写）',
    `- 全文第三人称。${currentAgentName}（即 TA）应被作为新闻对象提及，**禁止** TA 的第一人称内心独白。`,
    `- ${currentUserName}（即用户）也是新闻对象，**禁止**用户的第一人称来信或对话原文复读。`,
    '- 板块作者全部是"虚构记者 / 专栏作者 / 投书读者"等第三方；署名（byline）若给出必须是化名 / 笔名 / 匿名。',
    `- 报道笔调贴合 TA 所在的世界观（${eraLabel}），详见下方「笔调与报刊年代」。`,
    '- 不要出现「根据聊天记录」「用户让我」「系统提示」「模型」「AI」「prompt」「OpenHanako」「设定库」等元叙述。',
    '',
    '## 笔调与报刊年代（按 era 分化，必读）',
    ...eraGuideLines,
    '',
    '## 板块选择规则',
    `- 本期总共生成 ${NEWS_SECTIONS_PER_ISSUE.min}-${NEWS_SECTIONS_PER_ISSUE.max} 个板块（含必选）。`,
    `- **必含**：${requiredKindList}（头版要闻必须有，且只能有一个）。`,
    `- **至少含 1 个**：${relationshipKindList}（感情视角是本期必备）。`,
    '- 其他板块按当期素材自行挑选，但同一 kind **只能出现一次**。',
    '- 选板块时优先选与当期素材匹配的：素材充足时多挑、素材稀薄时只生 2-3 个不要硬凑。',
    '',
    '## 字数硬约束',
    '- 每个 section.body 必须落在该 kind 标注的 [min, max] 字数范围内。',
    '- 超出 max 会被系统截断成省略号，所以**写到接近 max 但不超过 max** 是最理想的。',
    '- 短板块（讣告 / 广告 / 天气）就是要短，不要写到 100 字。',
    '',
    '## 各板块说明 + 字数范围 + 标题候选',
    ...sectionGuideLines,
    '',
    `## masthead（报头）：长度 ≤ ${NEWS_MASTHEAD_MAX} 字`,
    `- ${style.mastheadStyleGuide}`,
    `- 仿名样本（仅作笔调锚点，不必照抄；首次发刊时可在样本风格内自创一个紧贴 lore 的报名）：${style.exampleMastheads.map((m) => `「${m}」`).join('、')}。`,
    '- **报头跨期应保持稳定**：如果下方"近期报头样本"已经定下了一个报名，请沿用相同报名，'
    + '只换期号 / 日期；不要每期换一个报名。',
    '',
    '## byline（虚构记者 / 笔名）风格',
    `- ${style.bylineStyleGuide}`,
    `- 仿名样本：${style.exampleBylines.map((b) => `「${b}」`).join('、')}。`,
    '- byline 不是必填——短板块（讣告 / 广告 / 天气）可以不署名。',
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
    `## 当期出版日：${issueDateIso}`,
    '',
    '## 用户附言（可空）',
    userIntent || '（无；自由发挥）',
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
    '## 最近一次桌面巡检的 UI 反馈（可空）',
    heartbeatBlock || '（无）',
    '',
    '## 跨期连续性锚点（防重复，必读）',
    continuityAnchorBlock || '（无；这是 TA 的第一期报纸）',
    '',
    '## 收尾',
    '现在生成本期报纸的 JSON。只输出 JSON 对象本身，不要 ```json``` 围栏，不要任何解释文字。',
  ];

  return parts.join('\n');
}
