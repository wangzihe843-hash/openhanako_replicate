/**
 * 根据角色档案（星野 profile / Agent / lore 等）推断「占卜叙事」推荐方式。
 * 多占法独立线索打分 + 冲突规则；纯函数、无 I/O；不做真实排盘/星盘。
 */

export type XingyeDivinationMethodId =
  | 'iching_liuyao'
  | 'tarot'
  | 'crystal_ball'
  | 'runes'
  | 'astrology'
  | 'field_oracle'
  | 'oracle_generic';

/** 与 {@link XingyeRoleProfile} / {@link Agent} 等对齐的宽松输入 */
export type XingyeDivinationAgentLike = {
  name?: string | null;
  yuan?: string | null;
  displayName?: string | null;
  shortBio?: string | null;
  identitySummary?: string | null;
  backgroundSummary?: string | null;
  personalitySummary?: string | null;
  relationshipLabel?: string | null;
  speakingStyle?: string | null;
  values?: string | null;
  taboos?: string | null;
  relationshipMode?: string | null;
  /** 分层人设 / profile.json 行为逻辑 */
  behaviorLogic?: string | null;
  lore?: string | string[] | null;
  /** 由 buildDivinationResolverContext 等注入的合并背景（profile 以外 lore 块等） */
  extraCorpus?: string | null;
  description?: string | null;
  era?: string | null;
  culture?: string | null;
  tags?: string[] | readonly string[] | null;
  /** 角色性别，用于占卜文本里的代词与称谓约束（透传给 formatXingyeSpeakerContextForPrompt）。 */
  gender?: 'female' | 'male' | 'nonbinary' | 'unspecified' | null;
};

/** UI / context builder 传入：用于区分「无背景可读」与「有背景但占法不确定」 */
export type DivinationResolverResolveContextHint = {
  contextLength: number;
  contextSources: readonly string[];
  /** 磁盘 lore 中 enabled=false 条数（未纳入占卜语料） */
  loreSkippedDisabledCount?: number;
  /** 已纳入 extraCorpus 的 enabled lore 标题 */
  enabledLoreTitlesInCorpus?: readonly string[];
  /** 无 enabled lore 文本进入占卜合并语料（通常仅有 profile） */
  profileOnlyNoEnabledLore?: boolean;
};

export type XingyeDivinationMethodAlternative = {
  method: XingyeDivinationMethodId;
  methodLabel: string;
  note?: string;
};

/** 命中的单条线索（用于 resolverReason 与测试） */
export type MatchedSignal = {
  id: string;
  method: XingyeDivinationMethodId;
  weight: number;
  /** 实际命中的片段（便于人读） */
  evidence: string;
};

export type XingyeRecommendedDivinationMethod = {
  method: XingyeDivinationMethodId;
  methodLabel: string;
  /** 是否达到置信阈值且非「低置信度通用神谕」 */
  autoSelected: boolean;
  resolverReason: string;
  matchedSignals: MatchedSignal[];
  scores: Record<XingyeDivinationMethodId, number>;
  alternatives?: XingyeDivinationMethodAlternative[];
};

const ALL_METHOD_IDS: readonly XingyeDivinationMethodId[] = [
  'iching_liuyao',
  'tarot',
  'crystal_ball',
  'runes',
  'astrology',
  'field_oracle',
  'oracle_generic',
] as const;

export const METHOD_LABELS_ZH: Record<XingyeDivinationMethodId, string> = {
  iching_liuyao: '八卦/六爻（叙事）',
  tarot: '塔罗',
  crystal_ball: '水晶球',
  runes: '卢恩符文',
  astrology: '星座/星盘（叙事）',
  field_oracle: '战地直觉 / 风险预判 / 行动签',
  oracle_generic: '通用神谕',
};

/** 合并 profile + lore 等背景文本低于此长度时，提示「未读取到角色背景」而非「低置信度」 */
export const DIVINATION_RESOLVER_CONTEXT_MIN_LEN = 48;

/** 达到该分数才认为「有把握」；低于则 oracle_generic */
const CONFIDENCE_THRESHOLD = 15;

/** profile-only（未纳入任何 enabled lore 全文/摘要块）时略放宽，便于弱战地信号仍可选 field_oracle */
const PROFILE_ONLY_CONFIDENCE_THRESHOLD = 12;

function confidenceThreshold(contextHint?: DivinationResolverResolveContextHint | null): number {
  return contextHint?.profileOnlyNoEnabledLore ? PROFILE_ONLY_CONFIDENCE_THRESHOLD : CONFIDENCE_THRESHOLD;
}

/** 两路分数差小于此视为「接近」，需 tie-break */
const CLOSE_SCORE_DELTA = 4;

type ClueRow = {
  id: string;
  method: XingyeDivinationMethodId;
  weight: number;
  terms: readonly string[];
  /** 英文小写语料中匹配的额外词（不含中文） */
  termsEn?: readonly string[];
  /** 仅当语料中已出现任一 `requireAny` 时，本线索才计分（避免孤立「火药」拉起战地） */
  requireAny?: readonly string[];
};

function normalizeCorpus(agentLike: XingyeDivinationAgentLike | null | undefined): string {
  if (!agentLike) return '';
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  };
  push(agentLike.name);
  push(agentLike.yuan);
  push(agentLike.displayName);
  push(agentLike.shortBio);
  push(agentLike.identitySummary);
  push(agentLike.backgroundSummary);
  push(agentLike.personalitySummary);
  push(agentLike.relationshipLabel);
  push(agentLike.speakingStyle);
  push(agentLike.values);
  push(agentLike.taboos);
  push(agentLike.relationshipMode);
  push(agentLike.behaviorLogic);
  push(agentLike.description);
  push(agentLike.era);
  push(agentLike.culture);
  const lore = agentLike.lore;
  if (Array.isArray(lore)) {
    for (const chunk of lore) push(chunk);
  } else {
    push(lore);
  }
  const tags = agentLike.tags;
  if (tags && tags.length) parts.push(tags.join(' '));
  push(agentLike.extraCorpus);
  return parts.join('\n');
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/** 战地/医疗/灾后「锚点」：任一中高权重 field 语境 */
const FIELD_ANCHOR_TERMS: readonly string[] = [
  '战地',
  '边境战乱',
  '边境',
  '战乱',
  '废土',
  '灾后',
  '生存区',
  '隔离区',
  '前线',
  '巡逻',
  '撤离',
  '紧急撤离',
  '补给线',
  '补给',
  '资源短缺',
  '资源不足',
  '感染控制',
  '医疗物资',
  '战地医疗',
  '临时诊所',
  '避难所',
  '伤员',
  '伤员处理',
  '外科',
  '缝合',
  '止血',
  '药物配给',
  '急救',
  '封锁',
  '宵禁',
  '武器化火药',
  '风险评估',
  '路线判断',
  '物资分配',
  '隐蔽行动',
  '救援',
];

function corpusHasAny(corpus: string, terms: readonly string[]): boolean {
  return terms.some((t) => t && corpus.includes(t));
}

const CLUES: readonly ClueRow[] = [
  // ── iching_liuyao 高/中权重 ──
  ...(
    [
      ['ich-explicit-ancient', 22, ['中国古代', '古代中国', '东方古风', '朝代', '王朝', '县衙', '祭天']],
      ['ich-xianxia', 22, ['仙侠', '修仙', '武侠', '江湖', '剑修', '丹药', '山门', '宗门', '道观', '道士']],
      ['ich-book', 20, ['易经', '周易', '六爻', '八卦', '阴阳', '五行', '天干', '地支', '符箓', '蓍草', '铜钱']],
      ['ich-indirect', 12, ['宗族', '门派', '镖局', '驿站', '书院']],
    ] as const
  ).map(([id, weight, terms]) => ({ id, method: 'iching_liuyao' as const, weight, terms })),

  // ── runes ──
  ...(
    [
      ['nord-explicit', 24, ['北欧', '维京', '卢恩', '阿斯加德', '奥丁', '弗雷雅', '瓦尔哈拉', '世界树', '霜巨人', '萨迦']],
      ['nord-ship', 18, ['长船', '符文', '符文石', '寒冬', '部族']],
      ['nord-indirect', 12, ['盾墙', '长屋', '氏族誓言', '海盗远航', '冰原祭司']],
      ['nord-en', 14, [], ['rune', 'runes', 'viking', 'asgard', 'valhalla']],
    ] as const
  ).map(([id, weight, terms, termsEn]) => ({
    id,
    method: 'runes' as const,
    weight,
    terms,
    termsEn: termsEn ?? [],
  })),

  // ── crystal_ball ──
  ...(
    [
      ['cb-explicit', 22, ['水晶球', '女巫', '宫廷占卜师', '预言师', '巫术', '咒语', '魔法学院', '魔镜', '王室顾问']],
      ['cb-medieval', 18, ['中世纪', '城堡', '王国', '黑森林', '炼金术', '炼金', '魔法', '宫廷', '塔楼', '烛台', '魔法行会', '占星塔']],
      ['cb-indirect', 11, ['贵族宫廷', '领主舞会', '童话', '黑暗奇幻']],
    ] as const
  ).map(([id, weight, terms]) => ({ id, method: 'crystal_ball' as const, weight, terms })),

  // ── tarot ──
  ...(
    [
      ['tar-explicit', 24, ['塔罗', '牌阵', '命运之轮', '恋人', '女祭司', '愚者', '隐者', '权杖', '圣杯', '宝剑', '钱币']],
      ['tar-indirect', 22, ['神秘主义', '灵媒', '纸牌', '沙龙', '雾都', '咖啡馆', '剧院', '马车', '贵族社交', '占卜摊']],
      ['tar-era', 14, ['近代欧洲', '维多利亚', '工业革命', '第二次工业革命']],
      ['tar-en', 12, [], ['tarot']],
    ] as const
  ).map(([id, weight, terms, termsEn]) => ({
    id,
    method: 'tarot' as const,
    weight,
    terms,
    termsEn: termsEn ?? [],
  })),

  // ── astrology ──
  ...(
    [
      ['ast-explicit', 18, ['星座', '星盘', '占星', '恋爱运势', '心理测试', '社交媒体', '互联网', '手机', '偶像']],
      ['ast-urban', 14, ['现代都市', '都市', '校园', '大学', '高中', '通勤', '地铁', '写字楼', '办公室', '公司', '上班族', '咖啡店', '都市夜景', '聊天室', 'app', '心理咨询', '娱乐杂志', '现代日常', '当代', '近未来日常']],
      ['ast-en', 10, [], ['instagram', 'twitter', 'smartphone']],
    ] as const
  ).map(([id, weight, terms, termsEn]) => ({
    id,
    method: 'astrology' as const,
    weight,
    terms,
    termsEn: termsEn ?? [],
  })),

  // ── field_oracle（分项累计；火药/枪等需锚点）──
  ...(
    [
      ['field-war-1', 20, ['战地']],
      ['field-war-2', 22, ['边境战乱']],
      ['field-war-3', 20, ['废土']],
      ['field-war-4', 20, ['灾后']],
      ['field-war-5', 18, ['生存区']],
      ['field-war-6', 18, ['隔离区']],
      ['field-sup-1', 20, ['补给线']],
      ['field-sup-2', 20, ['资源短缺']],
      ['field-sup-3', 20, ['资源不足']],
      ['field-bio-1', 22, ['感染控制']],
      ['field-bio-2', 22, ['武器化火药']],
      ['field-front-1', 18, ['前线']],
      ['field-front-2', 16, ['巡逻']],
      ['field-front-3', 20, ['撤离']],
      ['field-front-4', 20, ['紧急撤离']],
      ['field-front-5', 18, ['避难所']],
      ['field-front-6', 18, ['医疗物资']],
      ['field-front-7', 18, ['战地医疗']],
      ['field-front-8', 18, ['临时诊所']],
      ['field-med-1', 20, ['外科缝合']],
      ['field-med-2', 18, ['外科']],
      ['field-med-3', 18, ['缝合']],
      ['field-med-4', 18, ['止血']],
      ['field-med-5', 18, ['药物配给']],
      ['field-med-6', 16, ['急救']],
      ['field-s-cannon', 20, ['炮声']],
      ['field-s-town', 14, ['边境小城']],
      ['field-w-border-doc', 10, ['边境医生']],
      ['field-w-doc-combo', 9, ['医生'], undefined, ['边境', '战乱', '伤患', '伤员', '救治', '急救', '医疗', '外科', '止血', '感染', '缝合', '药物', '资源']],
      ['field-w-war-context', 8, ['战乱'], undefined, ['医生', '边境', '救治', '伤患', '伤员', '医疗', '急救', '外科', '诊所', '营地']],
      ['field-w-save-ph', 9, ['救治伤患', '长期救治伤患', '救治伤员']],
      ['field-w-action-logic', 6, ['行动优先', '重视行动', '实际问题']],
      ['field-tech', 16, ['火药', '枪', '炮', '子弹', '爆炸物'], undefined, FIELD_ANCHOR_TERMS],
      ['field-ind-1', 11, ['风险评估']],
      ['field-ind-2', 11, ['路线判断']],
      ['field-ind-3', 11, ['物资分配']],
      ['field-ind-4', 11, ['伤员处理']],
      ['field-ind-5', 11, ['隐蔽行动']],
      ['field-ind-6', 11, ['救援']],
      ['field-ind-7', 11, ['封锁']],
      ['field-ind-8', 11, ['宵禁']],
    ] as const
  ).map(([id, weight, terms, termsEn, requireAny]) => ({
    id,
    method: 'field_oracle' as const,
    weight,
    terms,
    termsEn: termsEn ?? [],
    requireAny,
  })),
] as const;

function collectMatches(corpusZh: string, corpusLo: string): MatchedSignal[] {
  const matched: MatchedSignal[] = [];
  const combined = `${corpusZh}\n${corpusLo}`;

  for (const row of CLUES) {
    if (row.requireAny && !corpusHasAny(combined, row.requireAny)) continue;

    let hitTerm = '';
    for (const t of row.terms) {
      if (t && corpusZh.includes(t)) {
        hitTerm = t;
        break;
      }
    }
    if (!hitTerm && row.termsEn) {
      for (const t of row.termsEn) {
        if (t && corpusLo.includes(t)) {
          hitTerm = t;
          break;
        }
      }
    }
    if (hitTerm) {
      matched.push({
        id: row.id,
        method: row.method,
        weight: row.weight,
        evidence: hitTerm,
      });
    }
  }

  return matched;
}

/** 同一 clue id 只取该 id 下最大权重一次，避免重复计分 */
function aggregateByClueId(signals: MatchedSignal[]): MatchedSignal[] {
  const best = new Map<string, MatchedSignal>();
  for (const s of signals) {
    const prev = best.get(s.id);
    if (!prev || s.weight > prev.weight) best.set(s.id, s);
  }
  return [...best.values()];
}

function sumScoresByMethod(signals: MatchedSignal[]): Record<XingyeDivinationMethodId, number> {
  const scores = Object.fromEntries(ALL_METHOD_IDS.map((m) => [m, 0])) as Record<XingyeDivinationMethodId, number>;
  for (const s of signals) {
    scores[s.method] += s.weight;
  }
  return scores;
}

/** 国风「文化体系」强度：用于压制孤立技术词误判 field */
function chineseSystemStrength(signals: MatchedSignal[]): number {
  let n = 0;
  for (const s of signals) {
    if (s.method !== 'iching_liuyao') continue;
    if (/^ich-explicit|^ich-xianxia|^ich-book/.test(s.id)) n += s.weight;
  }
  return n;
}

function nordicMythStrength(signals: MatchedSignal[]): number {
  let n = 0;
  for (const s of signals) {
    if (s.method !== 'runes') continue;
    if (s.id === 'nord-en' || s.id === 'nord-explicit' || s.id === 'nord-ship') n += s.weight;
  }
  return n;
}

function fieldAnchorStrength(signals: MatchedSignal[]): number {
  let n = 0;
  for (const s of signals) {
    if (s.method !== 'field_oracle') continue;
    if (
      s.id.startsWith('field-war') ||
      s.id.startsWith('field-bio') ||
      s.id.startsWith('field-front') ||
      s.id.startsWith('field-med') ||
      s.id.startsWith('field-sup')
    ) {
      n += s.weight;
    }
    if (s.evidence && FIELD_ANCHOR_TERMS.includes(s.evidence)) n += 4;
  }
  return n;
}

function crystalVsTarotTieBreak(signals: MatchedSignal[], corpusZh: string): 'crystal_ball' | 'tarot' {
  let cb = 0;
  let tr = 0;
  for (const s of signals) {
    if (s.method === 'crystal_ball') cb += s.weight;
    if (s.method === 'tarot') tr += s.weight;
  }
  const cbBoost = /女巫|水晶球|宫廷|魔咒|魔法学院|魔镜|炼金|城堡|中世纪/.test(corpusZh) ? 8 : 0;
  const trBoost = /纸牌|沙龙|灵媒|雾都|咖啡馆|灵媒|塔罗|牌阵/.test(corpusZh) ? 8 : 0;
  const a = cb + cbBoost;
  const b = tr + trBoost;
  if (a > b + 2) return 'crystal_ball';
  if (b > a + 2) return 'tarot';
  let sum = 0;
  for (let i = 0; i < corpusZh.length; i += 1) sum += corpusZh.charCodeAt(i);
  return sum % 2 === 0 ? 'crystal_ball' : 'tarot';
}

/** 显式占法词优先 */
function explicitMethodLock(corpusZh: string, corpusLo: string): XingyeDivinationMethodId | null {
  const zh = corpusZh;
  const lo = corpusLo;
  if (/六爻|易经|周易|八卦测|蓍草|铜钱卦|八卦与/.test(zh) || (zh.includes('八卦') && zh.includes('易经'))) {
    return 'iching_liuyao';
  }
  if (zh.includes('卢恩') || (lo.includes('rune') && /北欧|维京|斯堪|挪威|冰岛/.test(zh))) {
    return 'runes';
  }
  if (zh.includes('塔罗') || lo.includes('tarot') || zh.includes('牌阵') || zh.includes('命运之轮')) {
    return 'tarot';
  }
  return null;
}

function applyConflictRules(
  scores: Record<XingyeDivinationMethodId, number>,
  signals: MatchedSignal[],
  corpusZh: string,
  contextHint?: DivinationResolverResolveContextHint | null,
): { scores: Record<XingyeDivinationMethodId, number>; notes: string[] } {
  const out = { ...scores };
  const notes: string[] = [];
  const chinese = chineseSystemStrength(signals);
  const fieldAnch = fieldAnchorStrength(signals);
  const nordM = nordicMythStrength(signals);
  const thr = confidenceThreshold(contextHint);

  // 中国古代/仙侠体系 + 孤立火药类：压低 field，让 iching 有机会
  if (chinese >= 18 && fieldAnch < 22 && out.field_oracle > 0 && out.field_oracle <= out.iching_liuyao + 8) {
    const prev = out.field_oracle;
    out.field_oracle = Math.floor(out.field_oracle * 0.35);
    if (prev !== out.field_oracle) {
      notes.push('检测到国风古典/易经体系信号较强，避免将「火药」等技术词单独误判为战地占法，已压低 field_oracle 分数。');
    }
  }

  // 北欧神话体系优先于「仅有火器味」的 field
  if (nordM >= 16 && out.runes >= 14 && out.field_oracle > out.runes && out.field_oracle < out.runes + 12) {
    out.field_oracle = Math.min(out.field_oracle, out.runes - 1);
    notes.push('北欧神话/卢恩体系信号明确，火器相关未构成独立战地叙事时，优先保留卢恩占法竞争位。');
  }

  // field 明显强于 astrology：战地/医疗簇 vs 普通现代日常
  if (out.field_oracle >= thr && out.astrology > 0) {
    if (out.field_oracle >= out.astrology + 6 || fieldAnch >= 28) {
      out.astrology = Math.floor(out.astrology * 0.55);
      notes.push('战地/灾后/医疗救援线索强于都市日常，已压低 astrology 分数以便 field_oracle 胜出。');
    }
  }

  // crystal_ball vs tarot：接近时用女巫/宫廷 vs 沙龙/纸牌 + 码元
  const cb = out.crystal_ball;
  const tr = out.tarot;
  if (cb > 0 && tr > 0 && Math.abs(cb - tr) <= CLOSE_SCORE_DELTA) {
    const pick = crystalVsTarotTieBreak(signals, corpusZh);
    if (pick === 'crystal_ball') {
      out.crystal_ball += 10;
      notes.push('水晶球与塔罗分数接近：魔法/女巫/宫廷线索更偏水晶球，或按语料码元稳定 tie-break。');
    } else {
      out.tarot += 10;
      notes.push('水晶球与塔罗分数接近：纸牌/沙龙/灵媒/近代城市线索更偏塔罗，或按语料码元稳定 tie-break。');
    }
  }

  return { scores: out, notes };
}

function pickWinner(
  scores: Record<XingyeDivinationMethodId, number>,
  contextHint?: DivinationResolverResolveContextHint | null,
): {
  method: XingyeDivinationMethodId;
  runnerUp: XingyeDivinationMethodId | null;
} {
  const thr = confidenceThreshold(contextHint);
  const ranked = ALL_METHOD_IDS.filter((m) => m !== 'oracle_generic')
    .map((m) => ({ m, s: scores[m] }))
    .sort((a, b) => b.s - a.s);
  const best = ranked[0]!;
  const second = ranked[1]!;
  if (!best || best.s < thr) {
    return { method: 'oracle_generic', runnerUp: ranked[0]?.m ?? null };
  }
  // 同分选「更具体」：field > astrology generic; iching > oracle; 固定顺序打破平局
  const tieOrder: XingyeDivinationMethodId[] = [
    'iching_liuyao',
    'runes',
    'field_oracle',
    'crystal_ball',
    'tarot',
    'astrology',
  ];
  const maxS = best.s;
  const tops = ranked.filter((r) => r.s === maxS);
  if (tops.length === 1) return { method: best.m, runnerUp: second && second.s > 0 ? second.m : null };
  tops.sort((a, b) => tieOrder.indexOf(a.m) - tieOrder.indexOf(b.m));
  return { method: tops[0]!.m, runnerUp: tops[1]?.m ?? second?.m ?? null };
}

function buildAlternatives(
  primary: XingyeDivinationMethodId,
  scores: Record<XingyeDivinationMethodId, number>,
): XingyeDivinationMethodAlternative[] | undefined {
  const ranked = ALL_METHOD_IDS.filter((m) => m !== 'oracle_generic' && m !== primary)
    .map((m) => ({ m, s: scores[m] }))
    .filter((x) => x.s >= 8)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  if (!ranked.length) return undefined;
  return ranked.map(({ m, s }) => ({
    method: m,
    methodLabel: METHOD_LABELS_ZH[m],
    note: `分数 ${s}，可作次选参考。`,
  }));
}

function formatSignalsForReason(signals: MatchedSignal[], limit = 8): string {
  const sorted = [...signals].sort((a, b) => b.weight - a.weight);
  const parts = sorted.slice(0, limit).map((s) => `「${s.evidence}」(${METHOD_LABELS_ZH[s.method]})`);
  return parts.length ? parts.join('、') : '（无明显线索）';
}

function appendContextDebug(
  reason: string,
  contextHint: DivinationResolverResolveContextHint | null | undefined,
  signals: MatchedSignal[],
  scores: Record<XingyeDivinationMethodId, number>,
): string {
  if (!contextHint) return reason;
  const scoreStr = ALL_METHOD_IDS.map((m) => `${m}:${scores[m]}`).join(',');
  const src = contextHint.contextSources.length ? contextHint.contextSources.join('>') : '(none)';
  const sigPreview = signals.length
    ? signals
        .slice(0, 16)
        .map((s) => `${s.evidence}→${METHOD_LABELS_ZH[s.method]}:${s.weight}`)
        .join('|')
    : '(none)';
  const skip =
    typeof contextHint.loreSkippedDisabledCount === 'number' ? `skippedDisabledLore=${contextHint.loreSkippedDisabledCount}` : '';
  const titles =
    contextHint.enabledLoreTitlesInCorpus && contextHint.enabledLoreTitlesInCorpus.length
      ? `enabledLoreTitles=${contextHint.enabledLoreTitlesInCorpus.join('|')}`
      : '';
  const extra = [skip, titles].filter(Boolean).join(';');
  const extraSeg = extra ? `;${extra}` : '';
  return `${reason}\n\n【占卜上下文调试】contextLength=${contextHint.contextLength}；contextSources=${src}；matchedSignals=${signals.length}（${sigPreview}）；scores={${scoreStr}}${extraSeg}`;
}

function buildResolverReason(params: {
  method: XingyeDivinationMethodId;
  runnerUp: XingyeDivinationMethodId | null;
  signals: MatchedSignal[];
  scores: Record<XingyeDivinationMethodId, number>;
  conflictNotes: string[];
  explicitLock: boolean;
  contextHint?: DivinationResolverResolveContextHint | null;
  /** normalizeCorpus 结果为空 */
  emptyCorpus?: boolean;
  /** 当前置信阈值（profile-only 时可能为 12） */
  confidenceThr: number;
}): string {
  const { method, runnerUp, signals, scores, conflictNotes, explicitLock, contextHint, emptyCorpus, confidenceThr } = params;
  const profileOnly = Boolean(contextHint?.profileOnlyNoEnabledLore);
  if (method === 'oracle_generic') {
    const maxOther = Math.max(...ALL_METHOD_IDS.filter((m) => m !== 'oracle_generic').map((m) => scores[m]));
    const ctxShort =
      Boolean(contextHint) && (contextHint!.contextLength < DIVINATION_RESOLVER_CONTEXT_MIN_LEN || !contextHint!.contextSources.length);

    if (emptyCorpus && ctxShort) {
      return [
        '未读取到足够的角色背景上下文：请确认已连接服务，且该角色的 xingye/profile.json 与设定库 lore 已加载到本机（占卜解析器不会使用「所问」文本作为世界观来源）。',
        `contextSources：${contextHint?.contextSources?.length ? contextHint.contextSources.join('、') : '（无）'}。`,
        'matchedSignals：',
        formatSignalsForReason(signals),
        conflictNotes.length ? `规则调整说明：${conflictNotes.join('')}` : '',
      ]
        .filter(Boolean)
        .join('');
    }

    if (!emptyCorpus && maxOther === 0 && ctxShort) {
      return [
        profileOnly
          ? '未读取到纳入占卜上下文的 enabled lore，仅使用 profile 摘要；语料仍偏短，未命中占法线索。'
          : '未读取到足够的角色背景上下文，无法在稳定设定中命中占法线索；请检查 profile / lore 是否为空或未同步。',
        `当前置信阈值 ${confidenceThr}。`,
        'matchedSignals：',
        formatSignalsForReason(signals),
        conflictNotes.length ? `规则调整说明：${conflictNotes.join('')}` : '',
      ]
        .filter(Boolean)
        .join('');
    }

    return [
      profileOnly
        ? '未读取到纳入占卜上下文的 enabled lore，仅使用 profile 摘要；'
        : '',
      '未达到任何占法的置信阈值：各路线索分数均偏低，判定为低置信度背景。',
      maxOther > 0
        ? `最高非通用分数约 ${maxOther}（低于阈值 ${confidenceThr}），故使用 oracle_generic。`
        : '语料几乎为空或过短，未形成可分类的世界观信号。',
      'matchedSignals：',
      formatSignalsForReason(signals),
      conflictNotes.length ? `规则调整说明：${conflictNotes.join('')}` : '',
    ]
      .filter(Boolean)
      .join('');
  }

  const bg =
    method === 'iching_liuyao'
      ? '中国古代/仙侠武侠/东方术数叙事背景'
      : method === 'runes'
        ? '北欧神话与卢恩文化背景'
        : method === 'crystal_ball'
          ? '欧洲前现代宫廷/女巫/水晶球式神秘主义背景'
          : method === 'tarot'
            ? '近代欧洲沙龙、纸牌与塔罗神秘主义背景'
            : method === 'astrology'
              ? '现代都市/校园/日常与流行占星语境'
              : method === 'field_oracle'
                ? '战地医疗、边境战乱、灾后生存与资源短缺等高风险行动语境'
                : '泛用叙事';

  const whyNot =
    runnerUp && runnerUp !== 'oracle_generic' && scores[runnerUp] > 0
      ? `未优先选择「${METHOD_LABELS_ZH[runnerUp]}」：其分数为 ${scores[runnerUp]}，低于或弱于主选「${METHOD_LABELS_ZH[method]}」（${scores[method]}）或与冲突规则不符。`
      : '';

  const clarifier =
    method === 'field_oracle'
      ? '与星座/星盘叙事的区分：当前主轴是冲突区、医疗与资源压力下的行动判断，而非通勤/校园/社交媒体主导的轻都市日常。'
      : '';

  const profileFieldNote =
    method === 'field_oracle' && profileOnly
      ? '设定来源：仅使用 profile 摘要，未纳入 enabled lore 全文或摘录；相对完整长背景置信度更低。'
      : '';

  const loreTitlesNote =
    contextHint?.enabledLoreTitlesInCorpus && contextHint.enabledLoreTitlesInCorpus.length
      ? `纳入占卜上下文的 lore：${contextHint.enabledLoreTitlesInCorpus.join('、')}。`
      : '';

  const parts = [
    explicitLock ? '命中显式占法词，已锁定推荐占法。' : '',
    profileFieldNote,
    loreTitlesNote,
    `命中线索（节选）：${formatSignalsForReason(signals)}。`,
    `背景判断：${bg}。`,
    `最终选择「${METHOD_LABELS_ZH[method]}」：综合打分 ${scores[method]}（阈值 ${confidenceThr}），最贴合当前语料中的叙事风险与氛围需求。`,
    whyNot,
    clarifier,
    conflictNotes.length ? `规则细化：${conflictNotes.join('')}` : '',
  ];
  return parts.filter(Boolean).join('');
}

/**
 * 解析推荐占卜叙事方式（中文标签 + 打分明细）。
 */
export function resolveRecommendedDivinationMethod(
  agentLike: XingyeDivinationAgentLike | null | undefined,
  contextHint?: DivinationResolverResolveContextHint | null,
): XingyeRecommendedDivinationMethod {
  const corpusZh = normalizeCorpus(agentLike);
  const corpusLo = asciiLower(corpusZh);

  const zeroScores = Object.fromEntries(ALL_METHOD_IDS.map((m) => [m, 0])) as Record<XingyeDivinationMethodId, number>;

  if (!corpusZh.trim()) {
    const thr = confidenceThreshold(contextHint);
    const resolverReason = appendContextDebug(
      buildResolverReason({
        method: 'oracle_generic',
        runnerUp: null,
        signals: [],
        scores: zeroScores,
        conflictNotes: [],
        explicitLock: false,
        contextHint,
        emptyCorpus: true,
        confidenceThr: thr,
      }),
      contextHint,
      [],
      zeroScores,
    );
    return {
      method: 'oracle_generic',
      methodLabel: METHOD_LABELS_ZH.oracle_generic,
      autoSelected: false,
      resolverReason,
      matchedSignals: [],
      scores: zeroScores,
      alternatives: buildAlternatives('oracle_generic', zeroScores),
    };
  }

  const rawSignals = aggregateByClueId(collectMatches(corpusZh, corpusLo));
  let scores = sumScoresByMethod(rawSignals);
  const lock = explicitMethodLock(corpusZh, corpusLo);
  const conflict = applyConflictRules(scores, rawSignals, corpusZh, contextHint);
  scores = conflict.scores;

  if (lock) {
    scores = { ...scores, [lock]: Math.max(scores[lock], CONFIDENCE_THRESHOLD + 20) };
  }

  const { method: picked, runnerUp } = pickWinner(scores, contextHint);
  const method = lock ?? picked;
  const finalScores = { ...scores };
  if (lock) finalScores[lock] = Math.max(finalScores[lock], CONFIDENCE_THRESHOLD + 20);

  const thr = confidenceThreshold(contextHint);
  const autoSelected = method !== 'oracle_generic' && finalScores[method] >= thr;

  const resolverReason = appendContextDebug(
    buildResolverReason({
      method,
      runnerUp: method === 'oracle_generic' ? runnerUp : runnerUp && runnerUp !== method ? runnerUp : null,
      signals: rawSignals,
      scores: finalScores,
      conflictNotes: conflict.notes,
      explicitLock: Boolean(lock),
      contextHint,
      emptyCorpus: false,
      confidenceThr: thr,
    }),
    contextHint,
    rawSignals,
    finalScores,
  );

  return {
    method,
    methodLabel: METHOD_LABELS_ZH[method],
    autoSelected,
    resolverReason,
    matchedSignals: rawSignals.sort((a, b) => b.weight - a.weight),
    scores: finalScores,
    alternatives: buildAlternatives(method, finalScores),
  };
}

/** UI：七种叙事占法，顺序与下拉框一致 */
export const DIVINATION_METHOD_IDS: readonly XingyeDivinationMethodId[] = [
  'iching_liuyao',
  'tarot',
  'crystal_ball',
  'runes',
  'astrology',
  'field_oracle',
  'oracle_generic',
] as const;

export const DIVINATION_METHODS: readonly { id: XingyeDivinationMethodId; label: string }[] =
  DIVINATION_METHOD_IDS.map((id) => ({ id, label: METHOD_LABELS_ZH[id] }));

export function getDivinationMethodLabel(id: string): string {
  if (Object.prototype.hasOwnProperty.call(METHOD_LABELS_ZH, id)) {
    return METHOD_LABELS_ZH[id as XingyeDivinationMethodId];
  }
  return id;
}

export function isDivinationMethodId(value: unknown): value is XingyeDivinationMethodId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(METHOD_LABELS_ZH, value);
}
