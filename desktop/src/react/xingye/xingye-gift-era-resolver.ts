/**
 * 赠礼系统的「归属礼物集」resolver。
 *
 * 与 xingye-news-era-resolver.ts / xingye-divination-method-resolver.ts 同思路
 * （纯函数关键词打分，无 I/O），但分类对齐 XINGYE_GIFT_SETS 的 11 个礼物集。
 * 确定性判定是刻意的：归属集决定「最爱礼物」从哪一套里选，必须跨次稳定，
 * 不能像 LLM 匹配那样漂移。
 *
 * Tie-break 原则：**虚构特有集优先于真实历史集**——仙侠角色的语料必然同时命中
 * 大量"朝代/古风"词，撞车时选更特异的那个（与 news resolver 的"非现代优先"同款逻辑）。
 *
 * 默认回退：modern（最通用、最不容易出戏）。
 */

import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { XingyeGiftSetId } from './xingye-gift-catalog';

/** 与 news/divination resolver 同款的宽松输入；只读文本字段。 */
export type GiftEraAgentLike = {
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
  /** 已合并的 lore 文本（由调用方拼出来传入），可为单字符串或字符串数组。 */
  lore?: string | string[] | null;
  /** 任意补充语料（lore-memory.md 等）。 */
  extraCorpus?: string | null;
  tags?: string[] | readonly string[] | null;
};

type GiftEraClue = {
  set: XingyeGiftSetId;
  weight: number;
  termsZh?: readonly string[];
  termsEn?: readonly string[];
};

/**
 * 关键词表。权重原则与 news resolver 一致：
 *  - 高权重（18-22）：明确指示世界观的专属术语
 *  - 中权重（10-15）：强烈暗示但不绝对
 *  - 低权重（5-8）：辅助信号，需累计
 * 通用古代词（朝代/江湖通用氛围）只给 cn_ancient 低中权重，让 武侠/仙侠 的
 * 专属词（轻功/修仙）在并存时凭高权重+tie-break 胜出。
 */
const GIFT_ERA_CLUES: readonly GiftEraClue[] = [
  // ── xianxia（修仙体系专属）──
  { set: 'xianxia', weight: 22, termsZh: ['仙侠', '修仙', '修真', '修士', '飞升', '渡劫', '金丹期', '元婴', '筑基', '化神'] },
  { set: 'xianxia', weight: 20, termsZh: ['灵石', '灵气', '宗门', '仙门', '法器', '法宝', '丹药', '炼丹', '炼器', '御剑', '仙界', '上仙', '真君', '道君'] },
  { set: 'xianxia', weight: 14, termsZh: ['道修', '剑修', '灵根', '心魔', '天劫', '洞府', '仙山', '蓬莱'] },
  { set: 'xianxia', weight: 8, termsZh: ['道观', '符箓', '拂尘', '蒲团'] },
  { set: 'xianxia', weight: 18, termsEn: ['cultivation', 'cultivator', 'xianxia', 'immortal sect'] },

  // ── wuxia（武侠江湖专属，无超凡力量）──
  { set: 'wuxia', weight: 22, termsZh: ['武侠', '武林', '江湖儿女', '轻功', '内力', '内功', '武功秘籍', '剑客', '侠客', '大侠', '女侠'] },
  { set: 'wuxia', weight: 20, termsZh: ['门派', '掌门', '帮主', '镖局', '武馆', '比武', '切磋', '点穴', '暗器', '刀客'] },
  { set: 'wuxia', weight: 14, termsZh: ['江湖', '侠义', '恩怨', '仇家', '客栈', '酒楼', '走镖', '退隐'] },
  { set: 'wuxia', weight: 8, termsZh: ['佩剑', '剑鞘', '斗笠', '马匪', '山寨'] },
  { set: 'wuxia', weight: 18, termsEn: ['wuxia', 'martial arts world', 'jianghu'] },

  // ── cn_ancient（通用中国古代/宫廷历史）──
  { set: 'cn_ancient', weight: 20, termsZh: ['中国古代', '古代中国', '朝代', '王朝', '汉朝', '唐朝', '宋朝', '明朝', '清朝', '春秋', '战国', '三国'] },
  { set: 'cn_ancient', weight: 16, termsZh: ['皇上', '陛下', '太子', '王爷', '公主', '郡主', '丞相', '尚书', '太医', '宫廷', '后宫', '科举', '状元'] },
  { set: 'cn_ancient', weight: 10, termsZh: ['古风', '东方古风', '县衙', '衙门', '县令', '太守', '书院', '绣坊', '茶馆'] },
  { set: 'cn_ancient', weight: 6, termsZh: ['长袍', '青衫', '马车', '纸伞', '长安', '洛阳', '汴梁', '金陵', '银两', '铜钱', '银票'] },

  // ── republican（民国）──
  { set: 'republican', weight: 22, termsZh: ['民国', '北洋', '上海滩', '十里洋场', '租界', '军阀'] },
  { set: 'republican', weight: 16, termsZh: ['大洋', '银元', '袁大头', '法币', '黄包车', '留声机', '旗袍', '洋行', '电报'] },
  { set: 'republican', weight: 8, termsZh: ['老北京', '戏园子', '舞厅', '报馆', '巡捕'] },

  // ── west_medieval（西方中世纪/真实历史）──
  { set: 'west_medieval', weight: 20, termsZh: ['中世纪', '十字军', '骑士团', '领主', '封臣', '修道院', '教廷', '吟游诗人'] },
  { set: 'west_medieval', weight: 14, termsZh: ['伯爵', '公爵', '男爵', '城堡', '王宫', '宫廷舞会', '纹章', '决斗', '骑士'] },
  { set: 'west_medieval', weight: 6, termsZh: ['酒馆', '商队', '佣兵', '长剑', '盔甲', '盾牌'] },
  { set: 'west_medieval', weight: 16, termsEn: ['medieval', 'knight', 'castle', 'kingdom', 'lord', 'baron', 'duke', 'monastery'] },

  // ── west_fantasy（西幻/魔法）──
  { set: 'west_fantasy', weight: 22, termsZh: ['西幻', '魔法世界', '魔法师', '大法师', '魔王', '勇者', '魔族', 'D&D', '龙与地下城'] },
  { set: 'west_fantasy', weight: 20, termsZh: ['精灵', '矮人', '兽人', '哥布林', '德鲁伊', '圣骑士', '法师塔', '魔法学院', '咒语', '魔药', '炼金术'] },
  { set: 'west_fantasy', weight: 14, termsZh: ['魔法', '巨龙', '龙裔', '魔晶', '法术', '卷轴', '盗贼工会', '神殿'] },
  { set: 'west_fantasy', weight: 18, termsEn: ['fantasy', 'mage', 'wizard', 'elf', 'dwarf', 'orc', 'dragon', 'paladin', 'druid'] },

  // ── steampunk（蒸汽朋克）──
  { set: 'steampunk', weight: 22, termsZh: ['蒸汽朋克', '差分机', '飞艇', '蒸汽机', '发条装置'] },
  { set: 'steampunk', weight: 14, termsZh: ['齿轮', '黄铜', '维多利亚', '机械义肢', '蒸汽', '锅炉', '工业革命'] },
  { set: 'steampunk', weight: 18, termsEn: ['steampunk', 'airship', 'clockwork', 'victorian'] },

  // ── modern（现代都市）──
  { set: 'modern', weight: 18, termsZh: ['现代都市', '当代', '都市', '上班族', '大学生', '高中生'] },
  { set: 'modern', weight: 14, termsZh: ['手机', '微信', '朋友圈', '外卖', '地铁', '公司', '写字楼', '咖啡店', '便利店', '大学', '校园', '高中'] },
  { set: 'modern', weight: 8, termsZh: ['网络', '直播', '游戏', '社交媒体', '快递', '加班'] },
  { set: 'modern', weight: 14, termsEn: ['modern', 'office', 'smartphone', 'university', 'cafe'] },

  // ── cyberpunk（赛博朋克）──
  { set: 'cyberpunk', weight: 22, termsZh: ['赛博朋克', '义体', '义眼', '神经接口', '脑机', '夜之城', '夜城'] },
  { set: 'cyberpunk', weight: 18, termsZh: ['黑客', '巨型企业', '财阀', '霓虹', '植入体', '改造人', '电子脑', '赛博空间', '信用点'] },
  { set: 'cyberpunk', weight: 10, termsZh: ['反乌托邦', '地下城区', '街头帮派'] },
  { set: 'cyberpunk', weight: 18, termsEn: ['cyberpunk', 'cyborg', 'netrunner', 'megacorp', 'neon'] },

  // ── wasteland（废土）──
  { set: 'wasteland', weight: 22, termsZh: ['废土', '末日', '末世', '核战', '辐射', '避难所', '废墟世界'] },
  { set: 'wasteland', weight: 16, termsZh: ['瓶盖', '掠夺者', '聚落', '变异', '辐尘', '拾荒', '配给', '净水'] },
  { set: 'wasteland', weight: 18, termsEn: ['wasteland', 'apocalypse', 'post-apocalyptic', 'vault', 'raider'] },

  // ── space（太空/星际）──
  { set: 'space', weight: 22, termsZh: ['星际', '太空', '星舰', '宇宙飞船', '空间站', '殖民星', '太空歌剧', '银河帝国'] },
  { set: 'space', weight: 16, termsZh: ['舰长', '曲速', '跃迁', '外星', '星系', '宇航员', '登舰', '殖民地'] },
  { set: 'space', weight: 18, termsEn: ['starship', 'galaxy', 'space station', 'interstellar', 'spacefaring'] },
];

/** 撞车（分差 ≤ delta）时的优先级：特异虚构集 > 近代真实 > 古代真实 > 现代。 */
const GIFT_ERA_TIE_PRIORITY: readonly XingyeGiftSetId[] = [
  'xianxia',
  'wuxia',
  'west_fantasy',
  'steampunk',
  'cyberpunk',
  'wasteland',
  'space',
  'republican',
  'west_medieval',
  'cn_ancient',
  'modern',
];

const GIFT_ERA_CONFIDENCE_THRESHOLD = 14;
const GIFT_ERA_CLOSE_SCORE_DELTA = 6;

function pushIfNonEmpty(list: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim()) list.push(value.trim());
}

function normalizeCorpus(agentLike: GiftEraAgentLike | null | undefined): string {
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

export type GiftEraResolution = {
  setId: XingyeGiftSetId;
  score: number;
  scores: Record<XingyeGiftSetId, number>;
  matchedTerms: string[];
  reason: string;
};

function emptyScores(): Record<XingyeGiftSetId, number> {
  return {
    modern: 0,
    cn_ancient: 0,
    republican: 0,
    west_medieval: 0,
    wuxia: 0,
    xianxia: 0,
    west_fantasy: 0,
    steampunk: 0,
    cyberpunk: 0,
    wasteland: 0,
    space: 0,
  };
}

/**
 * 解析 agent 的归属礼物集。
 *
 * 规则：
 *  1. 最高分达到阈值且对第二名分差 > GIFT_ERA_CLOSE_SCORE_DELTA → 直接选它
 *  2. 前两名接近 → 按 GIFT_ERA_TIE_PRIORITY 选更特异的
 *  3. 全部低于阈值 → 默认 modern
 */
export function resolveGiftEra(agentLike: GiftEraAgentLike | null | undefined): GiftEraResolution {
  const corpus = normalizeCorpus(agentLike);
  const corpusLo = corpus.toLowerCase();
  const scores = emptyScores();
  const matchedTerms: string[] = [];

  for (const clue of GIFT_ERA_CLUES) {
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
      scores[clue.set] += clue.weight;
      if (matchedTerms.length < 16) matchedTerms.push(`[${clue.set}] ${hit}`);
    }
  }

  const entries = (Object.entries(scores) as Array<[XingyeGiftSetId, number]>)
    .sort((a, b) => b[1] - a[1]);
  const [topSet, topScore] = entries[0];
  const [secondSet, secondScore] = entries[1];

  if (topScore < GIFT_ERA_CONFIDENCE_THRESHOLD) {
    return {
      setId: 'modern',
      score: scores.modern,
      scores,
      matchedTerms,
      reason: `所有礼物集分数都低于阈值 ${GIFT_ERA_CONFIDENCE_THRESHOLD}（top=${topSet}@${topScore}），默认回退到 modern。`,
    };
  }

  if (topScore - secondScore <= GIFT_ERA_CLOSE_SCORE_DELTA) {
    const tied: XingyeGiftSetId[] = [topSet, secondSet];
    for (const candidate of GIFT_ERA_TIE_PRIORITY) {
      if (tied.includes(candidate)) {
        return {
          setId: candidate,
          score: scores[candidate],
          scores,
          matchedTerms,
          reason: `${topSet}@${topScore} vs ${secondSet}@${secondScore} 接近（差 ≤ ${GIFT_ERA_CLOSE_SCORE_DELTA}），按特异优先级选 ${candidate}。`,
        };
      }
    }
  }

  return {
    setId: topSet,
    score: topScore,
    scores,
    matchedTerms,
    reason: `top=${topSet}@${topScore}（次=${secondSet}@${secondScore}），分差足够，直接选 ${topSet}。`,
  };
}

/** 把 Agent + XingyeRoleProfile 合并成 GiftEraAgentLike，方便调用方一行调通。 */
export function buildGiftEraAgentLike(
  agent: Pick<Agent, 'name' | 'yuan'>,
  profile: XingyeRoleProfile | null | undefined,
  extras?: { lore?: string | string[] | null; extraCorpus?: string | null },
): GiftEraAgentLike {
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
