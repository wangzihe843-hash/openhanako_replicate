import type { Agent } from '../types';
import type { XingyeDivinationAgentLike, XingyeDivinationMethodId } from './xingye-divination-method-resolver';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';
import { getDivinationTheme } from './xingye-divination-themes';

const METHOD_SIGN_LABEL: Record<XingyeDivinationMethodId, string> = {
  iching_liuyao: '卦象',
  tarot: '牌面',
  crystal_ball: '签象',
  runes: '签象',
  astrology: '签象',
  field_oracle: '行动签象',
  oracle_generic: '签象',
};

/**
 * 第 4 小节（行动/建议段）的 label 按占法分化。
 * - 「行动签」是 field_oracle 的本体概念（field_oracle = 战地神谕，其符号系统就叫"行动签"）
 * - iching 用「卦辞」、tarot 用「牌意指引」等
 * - oracle_generic 用「心象提示」，与心象草稿语义对齐
 * 与 desktop/src/react/xingye/xingye-divination-themes.ts actionSectionLabel 保持一致。
 */
const METHOD_ACTION_LABEL: Record<XingyeDivinationMethodId, string> = {
  iching_liuyao: '卦辞',
  tarot: '牌意指引',
  crystal_ball: '影像提示',
  runes: '符意建议',
  astrology: '星象建议',
  field_oracle: '行动签',
  oracle_generic: '心象提示',
};

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function profileBlockFromAgentLike(agentLike: XingyeDivinationAgentLike): string {
  const fields: Array<[string, string | null | undefined]> = [
    ['displayName', agentLike.displayName],
    ['shortBio', agentLike.shortBio],
    ['identitySummary', agentLike.identitySummary],
    ['backgroundSummary', agentLike.backgroundSummary],
    ['personalitySummary', agentLike.personalitySummary],
    ['relationshipLabel', agentLike.relationshipLabel],
    ['speakingStyle', agentLike.speakingStyle],
    ['values', agentLike.values],
    ['taboos', agentLike.taboos],
    ['relationshipMode', agentLike.relationshipMode],
    ['behaviorLogic', agentLike.behaviorLogic],
  ];
  const clean: Record<string, string> = {};
  for (const [key, value] of fields) {
    if (typeof value === 'string' && value.trim()) clean[key] = value.trim();
  }
  return Object.keys(clean).length ? JSON.stringify(clean, null, 2) : '（无）';
}

export function getDivinationSignLabel(methodId: XingyeDivinationMethodId): string {
  return METHOD_SIGN_LABEL[methodId] ?? METHOD_SIGN_LABEL.oracle_generic;
}

export function getDivinationActionLabel(methodId: XingyeDivinationMethodId): string {
  return METHOD_ACTION_LABEL[methodId] ?? METHOD_ACTION_LABEL.oracle_generic;
}

export function buildDivinationReadingPrompt(args: {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  userName?: string;
  agentLike: XingyeDivinationAgentLike;
  methodId: XingyeDivinationMethodId;
  methodLabel: string;
  symbols: readonly string[];
  userProvidedTheme?: string;
  resolverReason?: string;
  recentSceneBlock?: string;
  relationshipBlock?: string;
  heartbeatBlock?: string;
  /**
   * 近期占卜历史抽样（同 method 过滤），由 buildDivinationContinuityAnchorBlock 生成。
   * 让模型避免短期内反复抽到同一张牌/同一卦象/同一类解读。
   * 无历史 → 空字符串 → 这里渲染「（无；这是 TA 的第一次占卜）」。
   */
  continuityAnchorBlock?: string;
  /**
   * 「正式加工」路径会传：用户在草稿区已经看过的「心象」原文。模型应在生成结构化
   * reading 时保留这段心象的意象与口吻；agentQuestion 优先承接草稿里 TA 已经写下的
   * 那句话，而不是另起炉灶。普通正式占卜（无草稿）路径不传。
   */
  seedNarrative?: { agentQuestion?: string; content?: string };
}): string {
  const {
    agent,
    agentLike,
    methodId,
    methodLabel,
    symbols,
    userProvidedTheme,
    resolverReason,
    recentSceneBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
    seedNarrative,
  } = args;
  const theme = getDivinationTheme(methodId);
  const f = theme.fortuneLabels;
  const o = theme.omenLabels;

  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: agentLike.displayName ?? agent.name,
    gender: agentLike.gender ?? null,
  });

  const signLabel = getDivinationSignLabel(methodId);
  const actionLabel = getDivinationActionLabel(methodId);
  const profileBlock = profileBlockFromAgentLike(agentLike);
  const extraCorpus = truncateChars(agentLike.extraCorpus ?? '', 6000);
  const userTheme = (userProvidedTheme ?? '').trim();
  const symbolLine = symbols.length ? symbols.join(' ') : '（请自行从牌面/卦象/星图中选取符号意象）';

  const sections: string[] = [
    '你是星野模式「小手机占卜本」的占卜叙事生成器。只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '写作身份：这是当前角色为自己起的一次占卜，第一人称「我」。',
    'TA 自己生成此刻最想确认的事（agentQuestion），不是用户替 TA 发问；用户提供的「可选关注方向」只是注脚，不得替代占问主体。',
    '禁止任何用户视角、读者视角、系统/AI 元叙述（不出现「用户」「如果用户」「建议用户」「该角色」「这个角色」「角色设定」「根据人设」「根据背景」「从设定来看」「性格分析」「prompt」「context」「system」「instruction」「source」「debug」等）。',
    '禁止第三人称剖析角色（不要写「TA 会…」「她会…」「<角色名>会…」之类）。',
    '禁止复述输入的标签行（例如「角色资料」「最近场景」「关系状态摘要」），也不要在正文里指出信息来源（profile / lore / xingye 等）。',
    '可以写角色没有说出口的犹豫与预感，但不要凭空捏造重大剧情、生死、关系决裂等输入里不存在的事件。',
    '',
    `占法：${methodLabel}（${methodId}）。眼前符号依次为：${symbolLine}。请把这些符号意象（或与之贴合的意象）织入正文，不要罗列符号名称。`,
    `小节标签必须使用：【标题】、【${signLabel}】、【正文】、【${actionLabel}】 这四个，顺序与字面一致。注意 \`${actionLabel}\` 是本占法专属用语——${methodId === 'field_oracle' ? '行动签是 field_oracle 本体概念' : `区别于 field_oracle 的「行动签」，本占法用「${actionLabel}」`}。`,
    '',
    '正文长度：',
    '- title：一行，简短（不超过 24 个汉字）。',
    '- agentQuestion：一句话，第一人称，写出 TA 此刻最想确认的那件事，长度约 12–40 个汉字。',
    '- content：包含 4 个小节，约 220–520 个汉字；每节正文 1–4 行。',
    '',
    '此外还要给出运势评分与简短的宜忌/幸运提示，字段说明：',
    `- fortuneScore：四个 0-100 整数（不要小数，不要 "70+"/"≈70" 这种写法），分别对应「${f.overall}」「${f.career}」「${f.love}」「${f.wealth}」。`,
    '  分数要呼应 content 的情绪（如内省转折较多 → 综合分数不要给极端值），但避免一边倒的"全 90 分"或"全 50 分"。',
    `- omens：good 是${o.good}（一句不超过 14 个汉字的具体动作或意象，不写抽象建议），bad 是${o.bad}（同样长度限制）。两条都来自占法当下的意象，不要套俗语。`,
    `- luckyDirection：${theme.luckyDirectionLabel}，写一个简短的方位词（如「东南」「向北」「靠窗」），不超过 10 个汉字。`,
    `- luckyColor：${theme.luckyColorLabel}，写成「<形容>的<颜色>色」这样的描述性短语（约 4–14 个汉字），例如「古书纸的赭石色」「晨雾的灰蓝色」「松针下的暗绿色」「旧灯笼的暖橘色」。`,
    '  禁止输出 #RRGGBB / rgba() / hsl() 等 CSS 颜色码或英文颜色名；也不要单写一个颜色名（如只写「赭石」「红」），一定要带一个具体的「<形容>的<颜色>色」形态。',
    '',
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify(
      {
        title: 'string',
        agentQuestion: 'string',
        content: 'string',
        fortuneScore: { overall: 0, career: 0, love: 0, wealth: 0 },
        omens: { good: 'string', bad: 'string' },
        luckyDirection: 'string',
        luckyColor: 'string',
      },
      null,
      2,
    ),
    '',
    'content 字段示例骨架（仅作格式参考，不要照抄文字）：',
    [
      '【标题】',
      '<短标题>',
      `【${signLabel}】`,
      '<对符号/卦象/牌面的第一人称简短描摹>',
      '【正文】',
      '<对 agentQuestion 的内省式回应，可融入符号意象；不要给出占卜结论以外的人生建议>',
      `【${actionLabel}】`,
      '<一句可执行的、克制的小提醒>',
    ].join('\n'),
    '',
    '当前角色（基础身份）：',
    JSON.stringify(
      {
        id: agent.id,
        name: agent.name,
        yuan: agent.yuan,
      },
      null,
      2,
    ),
    '',
    speakerContextBlock,
    '',
    '【角色资料（仅供你以第一人称内化，不要直接复述字段名）】',
    profileBlock,
    '',
    '【角色背景与设定（已合并的 enabled lore；仅供内化，不要逐字引用，不得标注来源）】',
    extraCorpus || '（无）',
    '',
    '【最近场景（仅作情绪参考；不要在正文里指出信息来源）】',
    (recentSceneBlock ?? '').trim() || '（无）',
    '',
    '【对 user 的关系状态摘要（内部参考；不要在正文里复述）】',
    (relationshipBlock ?? '').trim() || '（无）',
    '',
    '【最近一次手机首页巡检（仅作情绪参考；不要照抄）】',
    (heartbeatBlock ?? '').trim() || '（无）',
    '',
    // 占卜防重复 anchor：同 method 历史抽样。塔罗 78 张 / 易经 64 卦的符号池
    // 有限，抽多了必然重复，所以这里只在 prompt 端 soft anchor，不在落盘
    // 端硬拒绝。详见 buildDivinationContinuityAnchorBlock。
    '【近期占卜记录（请明确避免重复；含同占法的最近抽签）】',
    (continuityAnchorBlock ?? '').trim() || '（无；这是 TA 的第一次占卜）',
    '',
    '【占法推荐解释（内部参考，不要复述）】',
    (resolverReason ?? '').trim() || '（无）',
    '',
  ];

  const seedAq = seedNarrative?.agentQuestion?.trim() ?? '';
  const seedContent = seedNarrative?.content?.trim() ?? '';
  if (seedAq || seedContent) {
    sections.push(
      '【TA 已经写下的心象（正式加工种子）】',
      seedAq ? `TA 在草稿里问：${seedAq}` : '',
      seedContent ? `TA 写下的心象：\n${seedContent}` : '',
      '把这段心象扩成结构化占卜：',
      '- agentQuestion 优先承接草稿那一句，可微调措辞但保留主题，不要另起炉灶。',
      '- 卦象/牌面/正文/行动签 四节里要保留草稿里的意象与口吻（具体物件、动作、感受），不要替换成无关意象。',
      '- 运势评分要呼应草稿的情绪基调（草稿犹豫 → 综合分数不要给 90+；草稿坚定 → 也不要给 30）。',
      '',
    );
  }

  sections.push(
    '【用户提供的可选关注方向（仅作注脚，不是占问主体）】',
    userTheme || '（无）',
    userTheme
      ? '若 agentQuestion 与该方向无关，也允许；不要让 agentQuestion 与该方向字面雷同。'
      : '没有方向时，agentQuestion 完全由 TA 自己决定。',
  );

  return sections.join('\n');
}
