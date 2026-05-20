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
 *   - 至少含 {gossip_column, review} 中一个（每期必须有"感情/角色视角"内容）
 *
 * 注：interview（人物专访）已从可选板块中移除——Q&A 形态在多板块平衡下很难稳定生成，
 * 已迁出为「秘密空间 · TA 的独家专访」独立模块。
 *
 * 每个 section_kind 有固定的 layoutSlot —— UI 渲染时按 slot 决定塞到报纸版面的哪个位置。
 * 字数范围由代码强制（normalize 时按 max 截断），下限不强制（留弹性）。
 */

/** 10 个板块 kind，模型每期挑 2-4 个；前后端一致使用这个枚举。 */
export const NEWS_SECTION_KINDS = [
  'headline_world',
  'second_news',
  'gossip_column',
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
 * 二选一，让模型按当期素材挑笔调最合适的那一个。
 */
export const AT_LEAST_ONE_OF_RELATIONSHIP_SECTION_KINDS: readonly NewsSectionKind[] = [
  'gossip_column',
  'review',
];

/** 一期报纸允许的总板块数（含必选项）。 */
export const NEWS_SECTIONS_PER_ISSUE = { min: 2, max: 4 } as const;

/** masthead 总长度限制（"《长安暮报》今日号"这种）。 */
export const NEWS_MASTHEAD_MAX = 24;

/**
 * 头版「现场证词」黄色卡片的数据。
 * 仅 `kind === 'headline_world'` 的 section 会读取；其它 kind 上写了也会被
 * normalize 丢弃。生成模型在现代/未来时代必填这一段（替代「头版相片」的视觉位）。
 */
export type NewsHeadlineWitness = {
  /** 证人原话；≤ 50 字。组件自带「」引号，模型不要再带。 */
  quote: string;
  /** 落款，形如「旧六区合成饮档店员·对本报记者」；≤ 40 字。 */
  attribution: string;
};

/**
 * 头版「证据 · 时间线」白底卡片的一行。
 */
export type NewsHeadlineEvidenceItem = {
  /** HH:MM 24 小时制。 */
  time: string;
  /** 一句话动作化描述；≤ 24 字。 */
  text: string;
};

/** evidence 数组长度上限（超过 5 条 UI 会显得拥挤）。 */
export const NEWS_HEADLINE_EVIDENCE_MAX = 5;

/**
 * 一条「AI 生成的批注」。
 *
 * 由当前角色（TA）以第一人称视角对自己手机里这份报纸的某段话写下的反应。
 * UI 渲染时按 `highlightText` 在对应 section.body 里做 indexOf 匹配，命中
 * 区间加荧光笔背景；如果模型乱写、找不到匹配，UI 在 section 末尾追加该条
 * 批注（不做高亮）作为兜底。
 */
export type NewsComment = {
  /** 评论本地唯一 id（增删用）。 */
  id: string;
  /** 被评论的 section.kind（必须是合法 NewsSectionKind）。 */
  sectionKind: NewsSectionKind;
  /** 被评论的原文片段——应当是对应 section.body 的连续子串；≤ 60 字。 */
  highlightText: string;
  /** TA 第一人称视角的批注；≤ 80 字。 */
  comment: string;
  /** 评论生成时间 ISO。 */
  createdAt: string;
};

/** 单期报纸允许挂的评论数上限。 */
export const NEWS_COMMENTS_MAX = 8;

export type NewsSection = {
  kind: NewsSectionKind;
  /** 板块标题，应从对应 kind 的 titleCandidates 里选一个；模型若乱写会在 normalize 时 fallback 到 candidates[0]。 */
  title: string;
  /** 正文。normalize 时按 targetChars[1] 截断（防止超长撑爆版面）。 */
  body: string;
  /** 署名（虚构记者名 / 笔名 / 化名），可空。 */
  byline?: string;

  /**
   * 头版「现场证词」黄色卡片。**仅 `kind === 'headline_world'` 时**生效；
   * 其它 kind 上即使写了也会被 normalize 忽略。
   * 缺失时 UI 会用 body 前 42 字 + byline 兜底渲染（不会留空）。
   */
  witness?: NewsHeadlineWitness;

  /**
   * 头版「证据 · 时间线」白底卡片。**仅 `kind === 'headline_world'` 时**生效；
   * 其它 kind 上即使写了也会被 normalize 忽略。
   * 缺失时整块卡片不渲染（不要画空卡）。
   */
  evidence?: NewsHeadlineEvidenceItem[];
};

/**
 * 报纸笔调/版面分化用的「时代」。
 *
 * 与 xingye-news-era-resolver.ts 的 NewsEraId 同义；之所以在 types.ts 这里
 * 也声明一遍，是因为生成端算完 era 后要把它**写进 metadata**（一份报纸只算一次，
 * UI 渲染直接读，不再二次 resolve）。
 *
 * 这避免了「生成侧 resolver 把 recent chat / keyword-triggered lore 喂进来后
 * 判定成 western_fantasy，但 UI 侧 resolver 只看 profile 判定成 modern_or_future」
 * 这种两侧不一致导致正文/版面错位的问题。
 */
export const NEWS_ERA_IDS = ['oriental_classical', 'western_fantasy', 'modern_or_future'] as const;
export type NewsEraId = (typeof NEWS_ERA_IDS)[number];

export function isNewsEraId(value: unknown): value is NewsEraId {
  return typeof value === 'string' && (NEWS_ERA_IDS as readonly string[]).includes(value);
}

export type NewsEntryMetadata = {
  /** 这期报纸的"出版日"（ISO 字符串）。 */
  issueDate: string;
  /** 报头（报纸名 + 期号），如"《长安暮报》今日号"。 */
  masthead: string;
  /** 本期板块列表，2-4 个。 */
  sections: NewsSection[];
  /**
   * 本期所属的时代（笔调 / 版面 era）。生成时由 resolver 算出来写进来；
   * UI 渲染分发**只读这一个字段**，不再二次 resolve（避免两侧 era 算法
   * 因输入不同而走偏）。旧数据可能缺这个字段：UI 侧应 fallback。
   */
  era?: NewsEraId;

  /**
   * AI 生成的批注（TA 第一人称对某段话的反应）。每次"AI 评论"按钮触发追加一条；
   * 上限 NEWS_COMMENTS_MAX；UI 渲染时按 highlightText 做高亮 + 在 section 后挂卡片。
   * 旧数据缺这个字段属于正常状态。
   */
  comments?: NewsComment[];
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

const EVIDENCE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function stripQuoteMarks(s: string): string {
  // 模型若把 「」/ "" / '' 当成 quote 的一部分塞进来，UI 会重复一层引号，所以 strip 干净。
  return s.replace(/^[「『"'“‘]+/, '').replace(/[」』"'”’]+$/, '').trim();
}

function normalizeWitness(value: unknown): NewsHeadlineWitness | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const quoteRaw = typeof raw.quote === 'string' ? stripQuoteMarks(raw.quote) : '';
  const attributionRaw = typeof raw.attribution === 'string' ? raw.attribution.trim() : '';
  if (!quoteRaw || !attributionRaw) return undefined;
  return {
    quote: truncateChars(quoteRaw, 50),
    attribution: truncateChars(attributionRaw, 40),
  };
}

function normalizeEvidenceItem(value: unknown): NewsHeadlineEvidenceItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const time = typeof raw.time === 'string' ? raw.time.trim() : '';
  const textRaw = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!EVIDENCE_TIME_RE.test(time)) return null;
  if (!textRaw) return null;
  return { time, text: truncateChars(textRaw, 24) };
}

function normalizeEvidence(value: unknown): NewsHeadlineEvidenceItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: NewsHeadlineEvidenceItem[] = [];
  for (const raw of value) {
    const item = normalizeEvidenceItem(raw);
    if (!item) continue;
    items.push(item);
    if (items.length >= NEWS_HEADLINE_EVIDENCE_MAX) break;
  }
  return items.length ? items : undefined;
}

function normalizeComment(value: unknown): NewsComment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isNewsSectionKind(raw.sectionKind)) return null;
  const highlightRaw = typeof raw.highlightText === 'string' ? raw.highlightText.trim() : '';
  const commentRaw = typeof raw.comment === 'string' ? raw.comment.trim() : '';
  if (!highlightRaw || !commentRaw) return null;
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim().slice(0, 80)
    : `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim()
    ? raw.createdAt.trim()
    : new Date().toISOString();
  return {
    id,
    sectionKind: raw.sectionKind,
    highlightText: truncateChars(highlightRaw, 60),
    comment: truncateChars(commentRaw, 80),
    createdAt,
  };
}

function normalizeComments(value: unknown): NewsComment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: NewsComment[] = [];
  const seenIds = new Set<string>();
  for (const raw of value) {
    const c = normalizeComment(raw);
    if (!c) continue;
    if (seenIds.has(c.id)) continue;
    seenIds.add(c.id);
    out.push(c);
    if (out.length >= NEWS_COMMENTS_MAX) break;
  }
  return out.length ? out : undefined;
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
  // witness / evidence 只挂在 headline_world 上；其它 kind 即便写了也丢弃。
  if (raw.kind === 'headline_world') {
    const witness = normalizeWitness(raw.witness);
    if (witness) out.witness = witness;
    const evidence = normalizeEvidence(raw.evidence);
    if (evidence) out.evidence = evidence;
  }
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

  const out: NewsEntryMetadata = { issueDate, masthead, sections };
  if (isNewsEraId(raw.era)) out.era = raw.era;
  const comments = normalizeComments(raw.comments);
  if (comments) out.comments = comments;
  return out;
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
