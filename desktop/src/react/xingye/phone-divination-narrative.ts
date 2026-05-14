import type { XingyeDivinationAgentLike, XingyeDivinationMethodId } from './xingye-divination-method-resolver';
import { getDivinationMethodLabel } from './xingye-divination-method-resolver';

function stablePickIndex(seed: string, modulo: number): number {
  if (modulo <= 0) return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % modulo;
}

const FIELD_AGENT_TOPICS: readonly string[] = [
  '下一轮伤员潮里，我还能不能把底线守到换防之后。',
  '补给线与信任之间，我更该把体温递给哪一端。',
  '撤离窗口被压缩时，我该把执念留在原地还是带走。',
  '感染和失血抢同一条命时，我有没有一刻过于仁慈。',
  '边境上的善意会不会在某个宵禁后反噬自己。',
  '哨卡换防的空档里，谁在偷看我们的药柜与缝合线。',
  '资源见底时，先保人还是先保路线——我心里那杆秤有没有偏。',
];

const ICHING_AGENT_TOPICS: readonly string[] = [
  '山门内的卦象与人心，哪一边更先松动。',
  '这一卦更像在问我：执念与道义，该让谁先退一步。',
  '动爻落在心里时，我是在求答案，还是在求一个能说服自己的借口。',
];

const RUNE_AGENT_TOPICS: readonly string[] = [
  '卢恩刻痕里，氏族誓言与远航风险，哪一句更值得我押上今晚的睡眠。',
  '寒风与部族之间，我有没有把勇气错当成鲁莽。',
];

const CRYSTAL_AGENT_TOPICS: readonly string[] = [
  '球心雾气聚拢时，我在宫廷与诅咒之间，更怕哪一种沉默。',
  '魔镜与烛火同时看我——我该信哪一道反光。',
];

const TAROT_AGENT_TOPICS: readonly string[] = [
  '沙龙纸牌的背面，哪一张其实在影射我藏起来的那一角自尊。',
  '灵媒的尾音落下时，我是在听命运，还是在听自己想听的版本。',
];

const ASTROLOGY_AGENT_TOPICS: readonly string[] = [
  '通勤与群聊的杂音里，哪一句其实在影射我此刻的摇摆。',
  '星盘或运势标签之外，我真正想确认的是不是「明天还敢不敢心软」。',
];

const GENERIC_AGENT_TOPICS: readonly string[] = [
  '此刻我心里那句真正想问的话，其实还没说出口——我想先把它摸清楚。',
  '直觉里有一团雾，我想知道该往左探还是往右让。',
];

const POOLS: Record<XingyeDivinationMethodId, readonly string[]> = {
  iching_liuyao: ICHING_AGENT_TOPICS,
  tarot: TAROT_AGENT_TOPICS,
  crystal_ball: CRYSTAL_AGENT_TOPICS,
  runes: RUNE_AGENT_TOPICS,
  astrology: ASTROLOGY_AGENT_TOPICS,
  field_oracle: FIELD_AGENT_TOPICS,
  oracle_generic: GENERIC_AGENT_TOPICS,
};

const METHOD_FLAVOR_LINE: Record<XingyeDivinationMethodId, string> = {
  iching_liuyao: '卦象起落如线，我把动爻与伏神在心里过了一遍。',
  tarot: '牌面叠影掠过指尖，我记下最先停住的那几张意象。',
  crystal_ball: '雾气在球心聚拢又散开，我抓住其中一缕形状，当作线索。',
  runes: '刻痕在石上轻轻作响，我把卢恩串成一句能说服自己的话。',
  astrology: '星图在暗幕上缓缓转动，我把与当下最贴近的几颗星连成一句。',
  field_oracle: '风声像警报，我把风险、路线和手里仅剩的资源在脑子里过了一遍。',
  oracle_generic: '没有固定仪轨，我只凭直觉把零碎征兆拼成一段独白。',
};

const METHOD_SIGN_LABEL: Record<XingyeDivinationMethodId, string> = {
  iching_liuyao: '卦象',
  tarot: '牌面',
  crystal_ball: '签象',
  runes: '签象',
  astrology: '签象',
  field_oracle: '行动签象',
  oracle_generic: '签象',
};

function corpusSeed(agentLike: XingyeDivinationAgentLike | null | undefined): string {
  if (!agentLike) return '';
  return [
    agentLike.displayName,
    agentLike.name,
    agentLike.shortBio,
    agentLike.identitySummary,
    agentLike.backgroundSummary,
    agentLike.personalitySummary,
    agentLike.behaviorLogic,
  ]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .join('|');
}

/**
 * 由 agent 视角决定的占问核心（非用户替问）；`themeHint` 不参与选题，仅供叙事里单独说明。
 */
export function pickAgentDivinationQuestion(
  methodId: XingyeDivinationMethodId,
  agentLike: XingyeDivinationAgentLike | null | undefined,
): string {
  const pool = POOLS[methodId] ?? GENERIC_AGENT_TOPICS;
  const seed = `${methodId}|${corpusSeed(agentLike)}`;
  const idx = stablePickIndex(seed, pool.length);
  return pool[idx] ?? pool[0]!;
}

export function titleForDivinationEntry(methodId: XingyeDivinationMethodId, agentQuestion: string): string {
  const label = getDivinationMethodLabel(methodId);
  const q = agentQuestion.trim();
  const short = q.length > 28 ? `${q.slice(0, 27)}…` : q;
  return `【${label}】${short || '自占'}`;
}

export function summarizeDivinationContextSources(sources: readonly string[]): string {
  void sources;
  return '';
}

const DIVINATION_SAFE_FALLBACK =
  '【标题】\n合上的牌\n【签象】\n牌面只留下一点风声。\n【正文】\n我把牌面合上。今天的结果很短：别急着把空白填满。先确认风是从哪边来的，再决定要不要开门。\n【行动签】\n先把手伸向能确认的地方。';

const INTERNAL_LINE_RE =
  /(?:xingye\.|\.jsonl?\b|HANA_HOME|agents[\\/]|<agentId>|上下文摘要|上下文线索|用来掂量此刻|你是当前角色本人|不是别人替你发问|根据你的背景|近期状态|用户没有替你提问|不要让叙事读成|对方并没有替你发问|对方没有替你填|角色侧叙事模拟|真实术数|写作参考|\b(?:prompt|context|system|developer|instruction|source|debug)\b)/i;

const PERSPECTIVE_POLLUTION_LINE_RE =
  /(?:用户|如果用户|建议用户|林雾会|她会|TA\s*会|该角色|这个角色|角色设定|根据人设|根据背景|从设定来看|性格分析|她对用户|角色会以|角色分析器|用户建议助手)/i;

const CONTEXT_BLOCK_RE = /(?:上下文摘要|上下文线索|用来掂量此刻)/;
const RULE_REPLAY_RE = /(?:你是当前角色本人|不是别人替你发问|根据你的背景|用户在替你问卜|用户没有替你提问)/;

function contextCorpus(agentLike: XingyeDivinationAgentLike | null | undefined): string {
  if (!agentLike) return '';
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  };
  push(agentLike.shortBio);
  push(agentLike.identitySummary);
  push(agentLike.backgroundSummary);
  push(agentLike.personalitySummary);
  push(agentLike.behaviorLogic);
  push(agentLike.extraCorpus);
  push(agentLike.lore);
  if (Array.isArray(agentLike.lore)) parts.push(...agentLike.lore.filter((x): x is string => typeof x === 'string'));
  return parts.join('\n');
}

function collectDivinationImages(input: {
  agentQuestion: string;
  userProvidedTheme?: string | null;
  agentContext?: XingyeDivinationAgentLike | null;
}): string[] {
  const corpus = [input.agentQuestion, input.userProvidedTheme ?? '', contextCorpus(input.agentContext)].join('\n');
  const candidates = [
    '红盐码头',
    '蓝线风铃',
    '药柜',
    '缝合线',
    '风铃',
    '蓝线',
    '哨声',
    '哨卡',
    '空档',
    '风',
  ];
  const found: string[] = [];
  for (const image of candidates) {
    if (corpus.includes(image) && !found.some((x) => x.includes(image) || image.includes(x))) {
      found.push(image);
    }
    if (found.length >= 2) break;
  }
  return found;
}

function imageSentence(images: readonly string[]): string {
  if (!images.length) return '旧影子在边缘晃了一下，我没有急着追过去。';
  if (images.length === 1) return `${images[0]}像被压在屏幕背面的一点冷光，提醒我先别把预感说死。`;
  return `${images[0]}和${images[1]}一前一后浮上来，像两枚没有落款的征兆，提醒我别把回声听成命令。`;
}

function normalizeOutputLines(raw: string): string[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let skippingContextBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }

    if (CONTEXT_BLOCK_RE.test(trimmed)) {
      skippingContextBlock = true;
      continue;
    }

    if (skippingContextBlock) {
      if (INTERNAL_LINE_RE.test(trimmed)) continue;
      skippingContextBlock = false;
    }

    if (RULE_REPLAY_RE.test(trimmed) || INTERNAL_LINE_RE.test(trimmed) || PERSPECTIVE_POLLUTION_LINE_RE.test(trimmed)) continue;
    kept.push(trimmed);
  }

  while (kept[0] === '') kept.shift();
  while (kept[kept.length - 1] === '') kept.pop();
  return kept;
}

export function sanitizeDivinationReadingContent(raw: unknown): string {
  const input = typeof raw === 'string' ? raw : '';
  const cleaned = normalizeOutputLines(input).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length < 16) return DIVINATION_SAFE_FALLBACK;
  if (INTERNAL_LINE_RE.test(cleaned) || PERSPECTIVE_POLLUTION_LINE_RE.test(cleaned)) return DIVINATION_SAFE_FALLBACK;
  return cleaned;
}

export function buildDivinationReadingContent(input: {
  displayName: string;
  methodId: XingyeDivinationMethodId;
  methodLabel: string;
  /** agent 自己形成的占问核心 */
  agentQuestion: string;
  /** 用户可选关注方向，可为空；不得替代 agentQuestion */
  userProvidedTheme?: string | null;
  symbols: string[];
  contextSummary: string;
  agentContext?: XingyeDivinationAgentLike | null;
}): string {
  const theme = typeof input.userProvidedTheme === 'string' ? input.userProvidedTheme.trim() : '';
  const symLine = input.symbols.join(' ');
  const aq = input.agentQuestion.trim() || '（我在心里把占问压成一句还没说透的话。）';
  const images = collectDivinationImages({
    agentQuestion: aq,
    userProvidedTheme: theme,
    agentContext: input.agentContext,
  });
  const signLabel = METHOD_SIGN_LABEL[input.methodId] ?? METHOD_SIGN_LABEL.oracle_generic;
  const title = images.length ? `${images[0]}旁边的短签` : '屏幕里的短签';
  const themeLine = theme ? `那句「${theme}」只像水面上的小石子，我看见涟漪，但不让它替我开口。` : '';

  // Profile/lore/recent context has already affected method and question selection upstream;
  // final output lines must not render source summaries or internal labels.
  const finalLines: string[] = [
    '【标题】',
    title,
    `【${signLabel}】`,
    METHOD_FLAVOR_LINE[input.methodId] ?? METHOD_FLAVOR_LINE.oracle_generic,
    `眼前符号依次排开：${symLine}`,
    '',
    '【正文】',
    `我把这次结果记在手机里。它不像答案，更像一个贴近掌心的提醒：${aq}`,
    themeLine,
    imageSentence(images),
    '我能感觉到自己想立刻确认什么，也能感觉到那股急意正在把门缝推开。先不追着影子跑，先听清哪一声是真的。冰冷一点没有关系，至少手还稳着。',
    '【行动签】',
    '先确认风从哪边来，再决定要不要开门。',
  ].filter(Boolean);

  return sanitizeDivinationReadingContent(finalLines.join('\n'));
}
