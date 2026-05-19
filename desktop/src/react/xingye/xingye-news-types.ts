/**
 * 小手机「报纸」模块（早期报纸风格）的类型 + 板块 registry。
 *
 * 一份报纸 = 一个 AppEntry（appId='news'）。
 * - entry.title 落 masthead（"《长安暮报》今日号"）
 * - entry.content 落各 section.body 拼起来的纯文本备份（兜底渲染 / 全文搜索）
 * - entry.metadata 落结构化版本 NewsEntryMetadata
 *
 * 板块选择由模型决定（每期 2-4 个），但受以下硬约束（见 selectSectionKindsRules）：
 *   - 必含 `headline_world`（头版要闻不能缺）
 *   - 至少含 {gossip_column, interview, review} 中一个（每期必须有"感情/角色视角"内容）
 *
 * 每个 section_kind 有固定的 layoutSlot —— UI 渲染时按 slot 决定塞到报纸版面的哪个位置。
 * 字数范围由代码强制（normalize 时按 max 截断），下限不强制（留弹性）。
 */

/** 10 个板块 kind，模型每期挑 2-4 个；前后端一致使用这个枚举。 */
export const NEWS_SECTION_KINDS = [
  'headline_world',
  'second_news',
  'gossip_column',
  'interview',
  'review',
  'street_snap',
  'obituary',
  'letters_to_editor',
  'advertisement',
  'weather',
] as const;

export type NewsSectionKind = (typeof NEWS_SECTION_KINDS)[number];

/** 版面槽位。UI 模板按 slot 而非 kind 排版；同一 slot 可塞多个板块。 */
export type NewsLayoutSlot =
  | 'masthead'
  | 'left_column'
  | 'right_column'
  | 'footer_strip'
  | 'margin_right';

export type NewsSectionRegistryEntry = {
  /** 内部固定标签（中文，仅用于日志 / 调试 / 候选池 fallback）。 */
  label: string;
  /** 模型最终选定的板块标题候选池（从中挑 1 个填进 section.title）。 */
  titleCandidates: readonly string[];
  /** 正文字数 [min, max]：prompt 给模型看的目标范围，max 同时是 normalize 截断上限。 */
  targetChars: readonly [number, number];
  /** 渲染槽位，决定塞到报纸版面的哪一块。 */
  layoutSlot: NewsLayoutSlot;
  /** 写进 prompt 的板块说明：告诉模型这个板块该是什么调性 / 视角。 */
  taskPrompt: string;
};

/**
 * 板块 registry。所有 prompt / normalize / UI 模板都从这里取定义，**禁止散落到别处**。
 * 调字数或新增板块只改这一处。
 */
export const NEWS_SECTION_REGISTRY: Record<NewsSectionKind, NewsSectionRegistryEntry> = {
  headline_world: {
    label: '头版要闻',
    titleCandidates: ['今日要闻', '头版大事', '本日纪要', '世闻汇编', '城中要闻'],
    targetChars: [350, 500],
    layoutSlot: 'masthead',
    taskPrompt:
      '本期最重要的世界线 / 世态新闻。第三人称客观报道笔调，像真报纸的头版导语。'
      + '内容必须紧贴 TA 所处世界观（古代街市 / 仙侠门派 / 现代都市 / 废土未来等都按 lore 走）。'
      + '事件可以与 TA / 用户的私人生活无直接因果，但应当折射出 TA 当下心境会关心或忽略的那类大事；'
      + '不要把它写成 TA 的日记或感情独白。',
  },
  second_news: {
    label: '次条新闻',
    titleCandidates: ['次条速递', '余讯', '续闻', '补编'],
    targetChars: [150, 250],
    layoutSlot: 'right_column',
    taskPrompt:
      '次重要的一则世态短讯，与头版要闻不同主题。同样第三人称客观笔调，但篇幅更短、'
      + '可以是一句一段的电讯体；忌与头版重复。',
  },
  gossip_column: {
    label: '感情专栏',
    titleCandidates: ['情事录', '红尘小笺', '月旦评', '街谈巷议'],
    targetChars: [300, 450],
    layoutSlot: 'left_column',
    taskPrompt:
      '第三方"八卦专栏作者"视角，闲谈式地报道 TA 与用户最近的感情进展或关系动向。'
      + '语气暧昧、带点世故的旁观，不要正面引用 TA 的内心独白；可以委婉点名（"那位常被提起的某某"）'
      + '或直呼姓名（参照 lore / 关系状态）。**不要写成 TA 的自述、用户的来信或两人的对话**；只能是第三方在评论。',
  },
  interview: {
    label: '第三人称采访',
    titleCandidates: ['人物专访', '一席谈', '记者手记', '对答录'],
    targetChars: [200, 350],
    layoutSlot: 'left_column',
    taskPrompt:
      '虚构一位"记者"采访与 TA 相关的边缘人物（朋友 / 邻居 / 病人 / 同行等），勾勒 TA 的人物侧面。'
      + '以**夹叙夹议**为主——记者用第三人称叙述场景与受访者的姿态、神态，关键处引用一两句直接引语即可；'
      + '**避免冷生的 Q&A 问答体（"问：……答：……"）**，那样像调查笔录，不像报纸采访稿。'
      + '话题限定在人物的**职业能力 / 习惯口碑 / 人物轶事**层面——感情进展归「感情专栏」管，'
      + '本板块**不要追问 TA 和用户的关系、也不要让受访者主动八卦两人关系**。'
      + '不要原文复读已发生的对话；只能是事后回忆或第三方观察。',
  },
  review: {
    label: '评论员文章',
    titleCandidates: ['主笔评论', '社论', '长评'],
    targetChars: [250, 400],
    layoutSlot: 'left_column',
    taskPrompt:
      '报社"主笔"以社论口吻对 TA 与用户的关系发展、近期事件下结论或提建议。'
      + '语气可以略带说教、报刊体；第三人称，避免直呼"我"。'
      + '可点评判断、可调侃，但要有立场——不要写成中立摘要。',
  },
  street_snap: {
    label: '街角速写',
    titleCandidates: ['街角速写', '市井见', '巷尾拾贝', '此景此情'],
    targetChars: [80, 150],
    layoutSlot: 'footer_strip',
    taskPrompt:
      '一段被路过的记者"偷拍"或速记下来的瞬间。短小、画面感强，'
      + '像旧报纸豆腐块里的市井速写。可以是 TA 一个人的瞬间、TA 和用户的瞬间、或周围人议论 TA 的瞬间。',
  },
  obituary: {
    label: '讣告/纪念',
    titleCandidates: ['怀念', '纪事', '旧事一则'],
    targetChars: [40, 80],
    layoutSlot: 'footer_strip',
    taskPrompt:
      '黑色幽默风的小框：为某段心情 / 某个误会 / 某种旧关系"逝去"写一则讣告式的悼念。'
      + '语气克制肃穆，但所指的"亡者"是抽象之物（如"她对他最后一丝犹豫，殁于昨夜"）。'
      + '不要为真实人物写讣告。',
  },
  letters_to_editor: {
    label: '读者来信',
    titleCandidates: ['来鸿', '读者投书'],
    targetChars: [120, 200],
    layoutSlot: 'right_column',
    taskPrompt:
      '虚构一位读者投书，对 TA 和用户的近况发表评论或提问。'
      + '署名用化名（"洛城读者 X"/"匿名 / 一位老街坊"），第三人称视角议论；'
      + '可以是反对、支持、质疑、或起哄。**不要写成 TA 自己投稿，也不要让用户来信。**',
  },
  advertisement: {
    label: '报纸广告',
    titleCandidates: ['寻人启事', '广告', '招贴'],
    targetChars: [30, 60],
    layoutSlot: 'margin_right',
    taskPrompt:
      '一则极短的报纸广告 / 启事 / 招贴。要呼应 TA 当下心境（比如孤单时出现"寻心人启事"、'
      + '焦虑时出现"安神汤"广告）。文体仿旧报纸广告：标题 + 一两句正文，可以幽默、可以伤感。',
  },
  weather: {
    label: '天气预报',
    titleCandidates: ['今日天气', '阴晴录', '天象一瞥'],
    targetChars: [20, 40],
    layoutSlot: 'margin_right',
    taskPrompt:
      '极短的天气预报：物理天气一句 + 心情天气一句。'
      + '物理天气紧贴世界观（古代用"晴 / 雨 / 沙暴"，未来用"辐尘 / 浮空灰"等），心情天气是 TA 当下情绪的隐喻。',
  },
};

/** 必含的板块：每期 headline_world 不能缺。 */
export const REQUIRED_SECTION_KINDS: readonly NewsSectionKind[] = ['headline_world'];

/**
 * 至少要从这些里挑一个：感情视角是新闻模块的核心价值，每期必须有一个。
 * 三选一，让模型按当期素材挑笔调最合适的那一个。
 */
export const AT_LEAST_ONE_OF_RELATIONSHIP_SECTION_KINDS: readonly NewsSectionKind[] = [
  'gossip_column',
  'interview',
  'review',
];

/** 一期报纸允许的总板块数（含必选项）。 */
export const NEWS_SECTIONS_PER_ISSUE = { min: 2, max: 4 } as const;

/** masthead 总长度限制（"《长安暮报》今日号"这种）。 */
export const NEWS_MASTHEAD_MAX = 24;

export type NewsSection = {
  kind: NewsSectionKind;
  /** 板块标题，应从对应 kind 的 titleCandidates 里选一个；模型若乱写会在 normalize 时 fallback 到 candidates[0]。 */
  title: string;
  /** 正文。normalize 时按 targetChars[1] 截断（防止超长撑爆版面）。 */
  body: string;
  /** 署名（虚构记者名 / 笔名 / 化名），可空。 */
  byline?: string;
};

export type NewsEntryMetadata = {
  /** 这期报纸的"出版日"（ISO 字符串）。 */
  issueDate: string;
  /** 报头（报纸名 + 期号），如"《长安暮报》今日号"。 */
  masthead: string;
  /** 本期板块列表，2-4 个。 */
  sections: NewsSection[];
};

/** 判断一个 unknown 是否符合 NewsSectionKind。 */
export function isNewsSectionKind(value: unknown): value is NewsSectionKind {
  return typeof value === 'string'
    && (NEWS_SECTION_KINDS as readonly string[]).includes(value);
}

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return truncateChars(value, max);
}

function normalizeOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return truncateChars(trimmed, max);
}

function normalizeSection(value: unknown): NewsSection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isNewsSectionKind(raw.kind)) return null;
  const def = NEWS_SECTION_REGISTRY[raw.kind];
  const maxChars = def.targetChars[1];
  const body = normalizeString(raw.body, maxChars);
  if (!body) return null;
  // 标题：模型若选了候选池里的就保留；若乱写但非空也保留（最多 16 字）；
  // 完全空 → fallback 到 candidates[0]，保证版面不缺标题。
  const rawTitle = typeof raw.title === 'string' ? raw.title.trim().slice(0, 16) : '';
  const title = rawTitle || def.titleCandidates[0];
  const out: NewsSection = { kind: raw.kind, title, body };
  const byline = normalizeOptionalString(raw.byline, 24);
  if (byline) out.byline = byline;
  return out;
}

/**
 * 规范化模型返回的 metadata。
 * 不强制执行 REQUIRED / AT_LEAST_ONE_OF 规则 —— 那是 prompt 的事，
 * normalize 只保证字段类型 + 字数 + 板块去重。
 * 板块按出现顺序去重（同一 kind 只保留第一个），再按 NEWS_SECTION_KINDS 的固定顺序排序，
 * 让版面渲染顺序稳定。
 */
export function normalizeNewsEntryMetadata(value: unknown): NewsEntryMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const masthead = normalizeString(raw.masthead, NEWS_MASTHEAD_MAX);
  if (!masthead) return null;
  const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : [];
  const seen = new Set<NewsSectionKind>();
  const sections: NewsSection[] = [];
  for (const s of sectionsRaw) {
    const normalized = normalizeSection(s);
    if (!normalized) continue;
    if (seen.has(normalized.kind)) continue;
    seen.add(normalized.kind);
    sections.push(normalized);
    if (sections.length >= NEWS_SECTIONS_PER_ISSUE.max) break;
  }
  if (sections.length < NEWS_SECTIONS_PER_ISSUE.min) return null;
  // 按 NEWS_SECTION_KINDS 顺序排（保证版面渲染顺序稳定，与模型返回顺序无关）。
  const order = new Map<NewsSectionKind, number>(
    NEWS_SECTION_KINDS.map((kind, idx) => [kind, idx]),
  );
  sections.sort((a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0));

  const issueDate = typeof raw.issueDate === 'string' && raw.issueDate.trim()
    ? raw.issueDate.trim()
    : new Date().toISOString();

  return { issueDate, masthead, sections };
}

/** 把 NewsEntryMetadata 拍成纯文本（落 entry.content，便于兜底显示 / 全文搜索）。 */
export function flattenNewsMetadataToContent(meta: NewsEntryMetadata): string {
  const parts: string[] = [meta.masthead];
  for (const section of meta.sections) {
    parts.push('');
    parts.push(`【${section.title}】`);
    parts.push(section.body);
    if (section.byline) parts.push(`—— ${section.byline}`);
  }
  return parts.join('\n');
}
