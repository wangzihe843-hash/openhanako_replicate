/**
 * 「小手机报纸」模块按 agent 背景分化笔调用的 era resolver。
 *
 * 与 xingye-divination-method-resolver.ts 同思路（关键词打分），但只有 3 个分类：
 *  - oriental_classical: 中国古代 / 武侠江湖 / 仙侠 / 民国 → 民国小报闲笔体
 *  - western_fantasy:    西幻 / 中世纪 / 文艺复兴 / 蒸汽朋克 → 早期欧洲小报翻译体
 *  - modern_or_future:   现代 / 近未来 / 赛博朋克 / 废土 / 太空 → 现代八卦狗仔体
 *
 * 默认回退：modern_or_future（最通用、最不容易出戏的 fallback）。
 * 用于让 prompt 选择对应的写作守则、信源词汇库、masthead 命名风格。
 *
 * 纯函数、无 I/O；输入 profile/lore 文本，输出 era id。
 */

import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';

export type NewsEraId = 'oriental_classical' | 'western_fantasy' | 'modern_or_future';

export const NEWS_ERA_LABELS: Record<NewsEraId, string> = {
  oriental_classical: '东方古典（中国古代 / 武侠 / 仙侠 / 民国）',
  western_fantasy: '西方奇幻（西幻 / 中世纪 / 文艺复兴 / 蒸汽朋克）',
  modern_or_future: '现代或未来（现代都市 / 近未来 / 赛博朋克 / 废土 / 太空）',
};

/** 与 divination resolver 同款的宽松输入。本模块只读 profile 文本字段。 */
export type NewsEraAgentLike = {
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
  behaviorLogic?: string | null;
  description?: string | null;
  era?: string | null;
  culture?: string | null;
  /** 已合并的 lore 文本（由调用方拼出来传入），可为单字符串或字符串数组。 */
  lore?: string | string[] | null;
  /** 任意补充语料（外部传入的 lore-memory.md 等）。 */
  extraCorpus?: string | null;
  tags?: string[] | readonly string[] | null;
};

type EraClue = {
  era: NewsEraId;
  weight: number;
  /** 中文关键词；命中则计该 era 一次 weight。 */
  termsZh?: readonly string[];
  /** 英文关键词（小写匹配）；语料里命中也算。 */
  termsEn?: readonly string[];
};

/**
 * Era 关键词表。覆盖范围按以下原则取：
 *  - 高权重（18-22）：明确指示 era 的专属术语（朝代、灵石、星舰、信用点 …）
 *  - 中权重（10-15）：强烈暗示但不绝对（江湖、伯爵、便利店 …）
 *  - 低权重（5-8）：辅助信号，需多个累计才能压过其他 era
 *
 * 同一类目可拆多条以增加覆盖面；重叠不去重——一个词条命中只加一次权重。
 */
const ERA_CLUES: readonly EraClue[] = [
  // ── oriental_classical（高权重 / 朝代 + 武侠 + 仙侠 + 民国）──
  { era: 'oriental_classical', weight: 22, termsZh: ['中国古代', '古代中国', '古风', '东方古风', '武侠', '仙侠', '修仙', '修真', '江湖'] },
  { era: 'oriental_classical', weight: 22, termsZh: ['朝代', '王朝', '汉朝', '唐朝', '宋朝', '元朝', '明朝', '清朝', '春秋', '战国', '三国'] },
  { era: 'oriental_classical', weight: 20, termsZh: ['灵石', '丹药', '宗门', '门派', '剑修', '道修', '道观', '山门', '仙门', '化神', '元婴', '筑基'] },
  { era: 'oriental_classical', weight: 20, termsZh: ['民国', '北洋', '上海滩', '老北京', '租界', '十里洋场', '军阀', '大洋', '银元', '袁大头', '法币'] },
  // 中权重武侠/古风元素
  { era: 'oriental_classical', weight: 14, termsZh: ['江湖儿女', '镖局', '驿站', '书院', '钱庄', '当铺', '茶馆', '客栈', '酒楼', '街市', '集市', '城门', '县衙', '官府', '衙门'] },
  { era: 'oriental_classical', weight: 14, termsZh: ['县令', '太守', '皇上', '陛下', '太子', '王爷', '公主', '郡主', '将军', '丞相', '尚书', '太医'] },
  { era: 'oriental_classical', weight: 14, termsZh: ['两银子', '银两', '碎银', '铜钱', '银票', '银锭'] },
  // 低权重古风氛围词
  { era: 'oriental_classical', weight: 8, termsZh: ['长袍', '青衫', '布衣', '佩剑', '马车', '纸伞', '油纸伞', '茶肆', '驿丞'] },
  { era: 'oriental_classical', weight: 8, termsZh: ['苏州', '杭州', '洛阳', '长安', '汴梁', '金陵', '幽州', '关外'] },

  // ── western_fantasy（高权重 / 西幻 + 中世纪 + 文艺复兴 + 蒸汽朋克）──
  { era: 'western_fantasy', weight: 22, termsZh: ['西幻', '中世纪', '文艺复兴', '蒸汽朋克', '魔法世界', 'D&D', '龙与地下城', '艾尔登', '提瓦特', '美剧奇幻'] },
  { era: 'western_fantasy', weight: 20, termsZh: ['精灵', '矮人', '兽人', '哥布林', '半身人', '巨魔', '龙裔', '德鲁伊', '法师', '骑士团', '圣骑士', '游侠', '盗贼工会'] },
  { era: 'western_fantasy', weight: 20, termsZh: ['王国', '公国', '城邦', '帝国领主', '伯爵', '公爵', '男爵', '子爵', '宫廷', '王宫', '城堡', '塔楼', '修道院', '教廷'] },
  { era: 'western_fantasy', weight: 20, termsZh: ['金币', '银币', '铜板', '魔晶石', '法术卷轴', '咒文', '咒语', '炼金术', '炼金'] },
  // 中权重欧式中世纪元素
  { era: 'western_fantasy', weight: 14, termsZh: ['酒馆', '吟游诗人', '商队', '佣兵', '雇佣兵', '黑森林', '魔法学院', '修道士', '神殿', '神职', '主教', '红衣主教', '修士'] },
  { era: 'western_fantasy', weight: 14, termsZh: ['长剑', '战锤', '十字弓', '长弓', '盾牌', '盔甲', '皮甲', '锁子甲', '魔杖'] },
  // 蒸汽朋克
  { era: 'western_fantasy', weight: 14, termsZh: ['蒸汽机', '齿轮', '飞艇', '黄铜', '工业革命前', '维多利亚'] },
  // 低权重氛围词
  { era: 'western_fantasy', weight: 8, termsZh: ['艾尔', '伊瑞', '塞尔', '艾莉', '加尔', '欧文', '安德烈'] },
  // 英文关键词
  { era: 'western_fantasy', weight: 18, termsEn: ['fantasy', 'medieval', 'kingdom', 'castle', 'knight', 'elf', 'dwarf', 'orc', 'goblin', 'mage', 'wizard', 'druid', 'paladin'] },
  { era: 'western_fantasy', weight: 12, termsEn: ['lord', 'baron', 'duke', 'earl', 'count', 'duchess', 'cathedral', 'monastery', 'tavern', 'guild', 'rune'] },

  // ── modern_or_future（高权重 / 现代 + 近未来 + 赛博朋克 + 废土 + 太空）──
  { era: 'modern_or_future', weight: 22, termsZh: ['现代都市', '当代', '近未来', '未来', '赛博朋克', '反乌托邦', '废土', '末日', '末世', '太空', '星际', '太空歌剧', '殖民星'] },
  { era: 'modern_or_future', weight: 20, termsZh: ['手机', 'app', '应用', '智能手机', '互联网', '社交媒体', '微信', '微博', '抖音', 'twitter', '小红书', '朋友圈', '网络'] },
  { era: 'modern_or_future', weight: 20, termsZh: ['公司', '写字楼', '办公室', '上班族', '通勤', '地铁', '高铁', '飞机', '出租车', '便利店', '商场', '超市', '快递'] },
  { era: 'modern_or_future', weight: 20, termsZh: ['义体', '改造', '神经接口', '芯片', '黑客', '夜城', '巨型企业', '财阀', '反抗军', '机甲', '机器人', '人工智能', 'AI 觉醒'] },
  { era: 'modern_or_future', weight: 20, termsZh: ['信用点', '星币', '联邦币', '银河币', '瓶盖', '配给券', '水票', '物资点', '能量单位'] },
  { era: 'modern_or_future', weight: 18, termsZh: ['辐尘', '辐射', '突变', '掠夺者', '聚落', '避难所', '末日小镇', '废土小镇'] },
  // 中权重现代氛围词
  { era: 'modern_or_future', weight: 14, termsZh: ['学生', '高中', '大学', '校园', '咖啡店', '便利店', '电梯', '电脑', '电视', '路灯', '红绿灯', '地图导航'] },
  // 英文关键词
  { era: 'modern_or_future', weight: 18, termsEn: ['cyberpunk', 'dystopian', 'wasteland', 'apocalypse', 'starship', 'cyborg', 'android', 'hacker', 'neon', 'megacorp'] },
  { era: 'modern_or_future', weight: 14, termsEn: ['smartphone', 'iphone', 'app', 'subway', 'wifi', 'internet', 'twitter', 'instagram'] },
];

function pushIfNonEmpty(list: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim()) list.push(value.trim());
}

function normalizeCorpus(agentLike: NewsEraAgentLike | null | undefined): string {
  if (!agentLike) return '';
  const parts: string[] = [];
  pushIfNonEmpty(parts, agentLike.name);
  pushIfNonEmpty(parts, agentLike.yuan);
  pushIfNonEmpty(parts, agentLike.displayName);
  pushIfNonEmpty(parts, agentLike.shortBio);
  pushIfNonEmpty(parts, agentLike.identitySummary);
  pushIfNonEmpty(parts, agentLike.backgroundSummary);
  pushIfNonEmpty(parts, agentLike.personalitySummary);
  pushIfNonEmpty(parts, agentLike.relationshipLabel);
  pushIfNonEmpty(parts, agentLike.speakingStyle);
  pushIfNonEmpty(parts, agentLike.values);
  pushIfNonEmpty(parts, agentLike.taboos);
  pushIfNonEmpty(parts, agentLike.relationshipMode);
  pushIfNonEmpty(parts, agentLike.behaviorLogic);
  pushIfNonEmpty(parts, agentLike.description);
  pushIfNonEmpty(parts, agentLike.era);
  pushIfNonEmpty(parts, agentLike.culture);
  pushIfNonEmpty(parts, agentLike.extraCorpus);
  const lore = agentLike.lore;
  if (Array.isArray(lore)) {
    for (const chunk of lore) pushIfNonEmpty(parts, chunk);
  } else {
    pushIfNonEmpty(parts, lore);
  }
  const tags = agentLike.tags;
  if (tags && tags.length) {
    for (const tag of tags) pushIfNonEmpty(parts, tag);
  }
  return parts.join('\n');
}

function asciiLower(s: string): string {
  return s.toLowerCase();
}

/** 达到该分数才认为「有把握」；低于则走默认 modern_or_future。 */
const ERA_CONFIDENCE_THRESHOLD = 14;

/** 两路分数差小于此视为「接近」，需 tie-break。 */
const ERA_CLOSE_SCORE_DELTA = 6;

export type NewsEraResolution = {
  era: NewsEraId;
  /** 最终选定 era 的分数。 */
  score: number;
  /** 全部 era 的分数（便于调试）。 */
  scores: Record<NewsEraId, number>;
  /** 命中的关键词样本（截断；便于排错）。 */
  matchedTerms: string[];
  /** 解析过程的简短说明（写进 prompt 时可省略；调试用）。 */
  reason: string;
};

/**
 * 解析 agent 的 era。
 *
 * Tie-break 规则：
 *  1. 任一 era 达到 ERA_CONFIDENCE_THRESHOLD 且其它都比它低超过 ERA_CLOSE_SCORE_DELTA → 直接选它
 *  2. 两个 era 分数接近（差 ≤ ERA_CLOSE_SCORE_DELTA）→ 选 oriental_classical > western_fantasy > modern_or_future
 *     （古风 / 西幻 通常视觉差异大，撞车时优先非现代，避免把仙侠角色误判为现代）
 *  3. 所有 era 都低于阈值 → 默认 modern_or_future（现代是最 generic 的 fallback）
 */
export function resolveNewsEra(agentLike: NewsEraAgentLike | null | undefined): NewsEraResolution {
  const corpus = normalizeCorpus(agentLike);
  const corpusLo = asciiLower(corpus);
  const scores: Record<NewsEraId, number> = {
    oriental_classical: 0,
    western_fantasy: 0,
    modern_or_future: 0,
  };
  const matchedTerms: string[] = [];

  for (const clue of ERA_CLUES) {
    let hit = '';
    if (clue.termsZh) {
      for (const t of clue.termsZh) {
        if (t && corpus.includes(t)) {
          hit = t;
          break;
        }
      }
    }
    if (!hit && clue.termsEn) {
      for (const t of clue.termsEn) {
        if (t && corpusLo.includes(t)) {
          hit = t;
          break;
        }
      }
    }
    if (hit) {
      scores[clue.era] += clue.weight;
      if (matchedTerms.length < 16) matchedTerms.push(`[${clue.era}] ${hit}`);
    }
  }

  // 找最高分
  const entries = (Object.entries(scores) as Array<[NewsEraId, number]>)
    .sort((a, b) => b[1] - a[1]);
  const [topEra, topScore] = entries[0];
  const [secondEra, secondScore] = entries[1];

  // 阈值兜底
  if (topScore < ERA_CONFIDENCE_THRESHOLD) {
    return {
      era: 'modern_or_future',
      score: scores.modern_or_future,
      scores,
      matchedTerms,
      reason: `所有 era 分数都低于阈值 ${ERA_CONFIDENCE_THRESHOLD}（top=${topEra} @ ${topScore}），默认回退到 modern_or_future。`,
    };
  }

  // tie-break：接近时按优先级 oriental_classical > western_fantasy > modern_or_future
  if (topScore - secondScore <= ERA_CLOSE_SCORE_DELTA) {
    const priority: NewsEraId[] = ['oriental_classical', 'western_fantasy', 'modern_or_future'];
    const tied: NewsEraId[] = [topEra, secondEra];
    for (const candidate of priority) {
      if (tied.includes(candidate)) {
        return {
          era: candidate,
          score: scores[candidate],
          scores,
          matchedTerms,
          reason: `${topEra}@${topScore} vs ${secondEra}@${secondScore} 接近（差 ≤ ${ERA_CLOSE_SCORE_DELTA}），按优先级选 ${candidate}。`,
        };
      }
    }
  }

  return {
    era: topEra,
    score: topScore,
    scores,
    matchedTerms,
    reason: `top=${topEra}@${topScore}（次=${secondEra}@${secondScore}），分差足够，直接选 ${topEra}。`,
  };
}

/** 把 Agent + XingyeRoleProfile 合并成 NewsEraAgentLike，方便调用方一行调通。 */
export function buildNewsEraAgentLike(
  agent: Pick<Agent, 'name' | 'yuan'>,
  profile: XingyeRoleProfile | null | undefined,
  extras?: { lore?: string | string[] | null; extraCorpus?: string | null },
): NewsEraAgentLike {
  return {
    name: agent.name,
    yuan: agent.yuan,
    displayName: profile?.displayName,
    shortBio: profile?.shortBio,
    identitySummary: profile?.identitySummary,
    backgroundSummary: profile?.backgroundSummary,
    personalitySummary: profile?.personalitySummary,
    relationshipLabel: profile?.relationshipLabel,
    speakingStyle: profile?.speakingStyle,
    values: profile?.values,
    taboos: profile?.taboos,
    relationshipMode: profile?.relationshipMode,
    behaviorLogic: profile?.behaviorLogic,
    lore: extras?.lore ?? null,
    extraCorpus: extras?.extraCorpus ?? null,
  };
}
