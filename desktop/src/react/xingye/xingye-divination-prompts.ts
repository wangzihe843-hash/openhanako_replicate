import type { Agent } from '../types';
import type { XingyeDivinationAgentLike, XingyeDivinationMethodId } from './xingye-divination-method-resolver';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

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
  } = args;

  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName: args.userName,
    agentName: agentLike.displayName ?? agent.name,
  });

  const signLabel = getDivinationSignLabel(methodId);
  const actionLabel = getDivinationActionLabel(methodId);
  const profileBlock = profileBlockFromAgentLike(agentLike);
  const extraCorpus = truncateChars(agentLike.extraCorpus ?? '', 6000);
  const theme = (userProvidedTheme ?? '').trim();
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
    '输出 JSON schema（仅此结构，字段名必须一致）：',
    JSON.stringify({ title: 'string', agentQuestion: 'string', content: 'string' }, null, 2),
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
    '【占法推荐解释（内部参考，不要复述）】',
    (resolverReason ?? '').trim() || '（无）',
    '',
    '【用户提供的可选关注方向（仅作注脚，不是占问主体）】',
    theme || '（无）',
    theme
      ? '若 agentQuestion 与该方向无关，也允许；不要让 agentQuestion 与该方向字面雷同。'
      : '没有方向时，agentQuestion 完全由 TA 自己决定。',
  ];

  return sections.join('\n');
}
