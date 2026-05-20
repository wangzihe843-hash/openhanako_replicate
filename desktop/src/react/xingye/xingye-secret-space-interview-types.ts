/**
 * 秘密空间「TA 的独家专访」模块的类型 + normalize。
 *
 * 一份专访 = 一条 secret-space/interview.jsonl 记录。
 *  - record.title 落 metadata.title（"专访 · 林雾：在边境医院的第七年"）
 *  - record.body 落 flatten 后的纯文本（兜底显示 / 全文搜索）
 *  - record.metadata 落结构化 InterviewMetadata
 *
 * 与新闻模块对比：
 *  - 新闻是第三方报刊视角，每期板块数 / kind 浮动（2-4 个板块）
 *  - 专访是 TA 本人第一人称受访，**固定 5 题**结构稳定，加翻页/弹幕/幕后彩蛋
 *
 * 不强制业务规则（譬如"用户题必须排第 3"）—— 那是 prompt 的事；normalize 只保证
 * 字段类型 + 字数截断 + 题数为 5（少补、多截）。
 */

/** 一期专访固定 5 题。改这个值会同时影响 prompt / normalize / 阅读器 dot indicator。 */
export const SECRET_INTERVIEW_QUESTIONS_PER_RECORD = 5;

/** 弹幕每题条数范围。下限不强制（少了也能渲染），上限作 normalize 截断阈值。 */
export const SECRET_INTERVIEW_DANMAKU_PER_QUESTION = { min: 4, max: 6 } as const;

/** 弹幕视角分档。UI 会按 tag 决定颜色 / 飘速 / 字号微调。 */
export const SECRET_INTERVIEW_DANMAKU_TAGS = ['audience', 'fan', 'editor'] as const;
export type SecretInterviewDanmakuTag = (typeof SECRET_INTERVIEW_DANMAKU_TAGS)[number];

export const SECRET_INTERVIEW_DANMAKU_TAG_LABELS: Record<SecretInterviewDanmakuTag, string> = {
  audience: '吃瓜路人',
  fan: '粉丝党',
  editor: '记者旁注',
};

/** 字段长度限制（normalize 时截断；超出时尾部加省略号）。 */
export const SECRET_INTERVIEW_LIMITS = {
  titleMax: 40,
  hostNameMax: 24,
  hostIntroMin: 120,
  hostIntroMax: 260,
  questionTextMax: 48,
  answerMin: 60,
  answerMax: 200,
  danmakuTextMax: 28,
  backstageMin: 160,
  backstageMax: 320,
} as const;

export interface SecretInterviewDanmaku {
  text: string;
  tag: SecretInterviewDanmakuTag;
}

export interface SecretInterviewQuestion {
  q: string;
  a: string;
  danmaku: SecretInterviewDanmaku[];
}

export interface SecretInterviewMetadata {
  /** 录制日（ISO 字符串）。 */
  recordedAt: string;
  /** 本期专访标题。 */
  title: string;
  /** 主持人 / 记者笔名。 */
  hostName: string;
  /** 场记 + 演播室描述（开场页）。 */
  hostIntro: string;
  /** 固定 5 题。 */
  questions: SecretInterviewQuestion[];
  /** "相机关了"的整段彩蛋。 */
  backstage: string;
  /**
   * 若用户出题，标记是第几题（0..4）。用于阅读器在 dot indicator 上做个小标记。
   * 用户没出题时不写。
   */
  userQuestionIndex?: number;
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

function isDanmakuTag(value: unknown): value is SecretInterviewDanmakuTag {
  return typeof value === 'string'
    && (SECRET_INTERVIEW_DANMAKU_TAGS as readonly string[]).includes(value);
}

function normalizeDanmaku(value: unknown): SecretInterviewDanmaku | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const text = normalizeString(raw.text, SECRET_INTERVIEW_LIMITS.danmakuTextMax);
  if (!text) return null;
  const tag: SecretInterviewDanmakuTag = isDanmakuTag(raw.tag) ? raw.tag : 'audience';
  return { text, tag };
}

function normalizeDanmakuList(value: unknown): SecretInterviewDanmaku[] {
  if (!Array.isArray(value)) return [];
  const out: SecretInterviewDanmaku[] = [];
  for (const item of value) {
    const d = normalizeDanmaku(item);
    if (d) out.push(d);
    if (out.length >= SECRET_INTERVIEW_DANMAKU_PER_QUESTION.max) break;
  }
  return out;
}

function normalizeQuestion(value: unknown): SecretInterviewQuestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const q = normalizeString(raw.q, SECRET_INTERVIEW_LIMITS.questionTextMax);
  const a = normalizeString(raw.a, SECRET_INTERVIEW_LIMITS.answerMax);
  if (!q || !a) return null;
  return { q, a, danmaku: normalizeDanmakuList(raw.danmaku) };
}

/**
 * 规范化模型返回的 metadata。
 *
 * 题数规则：
 *  - 多于 5 题 → 截到前 5 题
 *  - 少于 5 题 → 返回 null（拒绝该次生成；调用方应当报错重试或上报失败，
 *    而不是吞下一份"少题"的残缺记录）
 *
 * 不校验语义（如"用户出的题确实出现在了 questions 里"）—— 那是 prompt 的事。
 */
export function normalizeSecretInterviewMetadata(value: unknown): SecretInterviewMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const title = normalizeString(raw.title, SECRET_INTERVIEW_LIMITS.titleMax);
  if (!title) return null;

  const hostName = normalizeString(raw.hostName, SECRET_INTERVIEW_LIMITS.hostNameMax)
    || '本刊记者';

  const hostIntro = normalizeString(raw.hostIntro, SECRET_INTERVIEW_LIMITS.hostIntroMax);
  if (!hostIntro) return null;

  const backstage = normalizeString(raw.backstage, SECRET_INTERVIEW_LIMITS.backstageMax);
  if (!backstage) return null;

  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];
  const questions: SecretInterviewQuestion[] = [];
  for (const q of rawQuestions) {
    const normalized = normalizeQuestion(q);
    if (!normalized) continue;
    questions.push(normalized);
    if (questions.length >= SECRET_INTERVIEW_QUESTIONS_PER_RECORD) break;
  }
  if (questions.length < SECRET_INTERVIEW_QUESTIONS_PER_RECORD) return null;

  const recordedAt = typeof raw.recordedAt === 'string' && raw.recordedAt.trim()
    ? raw.recordedAt.trim()
    : new Date().toISOString();

  const out: SecretInterviewMetadata = {
    recordedAt,
    title,
    hostName,
    hostIntro,
    questions,
    backstage,
  };

  if (typeof raw.userQuestionIndex === 'number'
      && Number.isInteger(raw.userQuestionIndex)
      && raw.userQuestionIndex >= 0
      && raw.userQuestionIndex < SECRET_INTERVIEW_QUESTIONS_PER_RECORD) {
    out.userQuestionIndex = raw.userQuestionIndex;
  }

  return out;
}

/** 把 SecretInterviewMetadata 拍成纯文本（落 record.body，便于兜底显示 / 全文搜索）。 */
export function flattenSecretInterviewToContent(meta: SecretInterviewMetadata): string {
  const parts: string[] = [meta.title, '', `主持 / ${meta.hostName}`, '', meta.hostIntro];
  meta.questions.forEach((q, idx) => {
    parts.push('');
    parts.push(`Q${idx + 1}. ${q.q}`);
    parts.push(q.a);
  });
  parts.push('');
  parts.push('【相机关了之后】');
  parts.push(meta.backstage);
  return parts.join('\n');
}
