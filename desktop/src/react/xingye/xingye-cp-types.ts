/**
 * 论坛子模块「你和 TA 的 CP」的类型 + normalize。
 *
 * 产品设定（见 domain_xingye_forum_alt / 本次需求）：
 *  - 模拟「用户偷看 TA 的手机，发现 TA 在关注一个嗑『你俩 CP』的论坛板块」。
 *  - **不自动初始化**：CP 板首开是空的，只有用户主动「偷看更新」且**有新聊天**时才生成。
 *  - **只有 NPC 主题帖**（饭圈三类：同人文 / 细节考据 / CP 粉发疯日常 / 普通讨论）。
 *    TA 不主动发主题帖，最多以一个「CP 马甲」在帖下评论 / 澄清（按性格 + 关系决定回不回）。
 *  - 草稿区：TA「想发没发」的内容（可以是一条主题帖，也可以是对某条 NPC 帖的回复）。
 *    「替 TA 发送」会把它真正发布（agent-origin 帖 / agent 评论）并弹 TA 反应彩蛋。
 *  - 「替 TA 关注本板」也弹 TA 反应彩蛋。两个彩蛋反应都**随板块内容一次性预生成**。
 *
 * 与论坛小号一致的取舍：LLM 只产「定性正文」；ID / 时间 / 数值 / 头像 seed / 草稿目标绑定
 * 全部由本地确定性组装（见 xingye-cp-assemble），normalize 只保证字段类型 + 截断 + 关键不变量。
 *
 * 刻意与 forum-types 解耦（不 import forum 的类型）：CP 板是论坛的独立子模块，
 * 自带一套窄类型，避免 forum 改动无声波及 CP（见 domain_xingye_upstream_sync_silent_break 同源风险）。
 */

export const CP_LIMITS = {
  altUsernameMax: 16,
  altBioMax: 44,
  altThemeLabelMax: 6,
  boardMax: 8,
  postTitleMax: 38,
  postBodyMax: 240,
  authorNameMax: 16,
  commentBodyMax: 90,
  replyBodyMax: 90,
  draftBodyMax: 240,
  reactionMax: 80,
  hesitationMax: 60,
  /** CP 名（饭圈嗑法，4 字诗化/谐音为主，留点余量给偶尔的 3/5 字）。 */
  cpNameMax: 8,
} as const;

/** 每帖评论条数：下限不强制，上限作 normalize 截断阈值。 */
export const CP_COMMENTS_PER_POST = { min: 2, max: 5 } as const;
/** 单条评论的一层嵌套回复上限。 */
export const CP_REPLIES_PER_COMMENT_MAX = 3;
/** 一次生成接受的 NPC 帖数 / 草稿数上限。 */
export const CP_POSTS_PER_BATCH_MAX = 4;
export const CP_DRAFTS_PER_BATCH_MAX = 3;

/** 饭圈帖体裁：同人文 / 细节考据 / 无能狂喜发疯 / 普通讨论。 */
export type CpPostGenre = 'fic' | 'analysis' | 'squee' | 'discuss';
/** 帖子来源：npc=饭圈网友发的；agent=TA 用 CP 马甲发的（仅「替 TA 发送 post 草稿」产生）。 */
export type CpPostOrigin = 'npc' | 'agent';
/** 草稿类型：post=一条想发的主题帖；reply=对某条 NPC 帖的回复 / 澄清。 */
export type CpDraftKind = 'post' | 'reply';

const CP_GENRES: readonly CpPostGenre[] = ['fic', 'analysis', 'squee', 'discuss'];

// ──────────────────────────────────────────────────────────────────────────
// 持久化类型（落 jsonl / json）
// ──────────────────────────────────────────────────────────────────────────

/** TA 在 CP 板的固定身份（首次生成锁定，写进 meta；之后所有 agent 内容都用它）。 */
export interface CpAltAccount {
  accountId: string;
  username: string;
  bio: string;
  themeLabel: string;
  avatarSeed: string;
  /** true=复用了 TA 现有的论坛小号；false=没合适的，临时造的 CP 专用马甲。 */
  fromForum: boolean;
}

export interface CpCommentReply {
  replyId: string;
  authorName: string;
  authorIsAgent: boolean;
  toName?: string;
  body: string;
  likes: number;
  postedAt: string;
}

export interface CpComment {
  commentId: string;
  authorName: string;
  authorIsAgent: boolean;
  body: string;
  likes: number;
  postedAt: string;
  replies: CpCommentReply[];
}

export interface CpPost {
  postId: string;
  origin: CpPostOrigin;
  genre: CpPostGenre;
  board: string;
  title: string;
  body: string;
  /** 帖主显示名：npc → NPC 网名；agent → CP 马甲名。 */
  authorName: string;
  authorIsAgent: boolean;
  postedAt: string;
  stats: { views: number; likes: number };
  comments: CpComment[];
  createdAt: string;
}

export interface CpDraft {
  draftId: string;
  kind: CpDraftKind;
  /** kind==='post' 时有意义。 */
  genre?: CpPostGenre;
  board?: string;
  title?: string;
  body: string;
  /** kind==='reply' 时绑定的目标 NPC 帖。 */
  targetPostId?: string;
  targetPostTitle?: string;
  /** 「替 TA 发送」后弹的 TA 反应彩蛋（角色第一人称，预生成）。 */
  sendReaction: string;
  /** 给用户看的一句「为什么想发又没发」（角色口吻；不是数据溯源式说明）。 */
  hesitation: string;
  createdAt: string;
}

export interface CpMeta {
  /** 首次成功生成时间（幂等标记 / 区分「从未生成」与「生成过又被清空」）。 */
  initializedAt?: string;
  /** 饭圈给「你 × TA」起的 CP 名（首次生成锁定，之后沿用；NPC 帖与板块标题都用它）。 */
  cpName?: string;
  /** 上次生成时的聊天签名（水位线）：相同则判定「没有新聊天」。 */
  watermark?: string;
  /** 用户是否已替 TA 关注本板。 */
  followed?: boolean;
  /** 「替 TA 关注本板」后弹的 TA 反应彩蛋（预生成；followed 后不再覆写）。 */
  followReaction?: string;
  /** TA 在 CP 板锁定的身份。 */
  alt?: CpAltAccount;
}

// ──────────────────────────────────────────────────────────────────────────
// LLM 原始输出 → spec（纯文本，未含 ID / 时间 / 数值；交给 assemble 组装）
// ──────────────────────────────────────────────────────────────────────────

export interface CpAltSpec {
  username: string;
  bio: string;
  themeLabel: string;
}

/** alt 解析：要么挑中一个现有小号名，要么给一个新 CP 马甲 spec。 */
export interface CpAltResolutionSpec {
  /** 选中的现有论坛小号 username（必须是给定列表里的）。 */
  pickUsername?: string | null;
  /** 没有合适的现有小号时，新造一个 CP 专用马甲。 */
  newAlt?: CpAltSpec | null;
}

export interface CpCommentReplySpec {
  authorName: string;
  authorIsAgent: boolean;
  toName?: string;
  body: string;
}

export interface CpCommentSpec {
  authorName: string;
  authorIsAgent: boolean;
  body: string;
  replies: CpCommentReplySpec[];
}

export interface CpPostSpec {
  genre: CpPostGenre;
  board: string;
  title: string;
  body: string;
  /** NPC 帖主网名（必填）。 */
  authorName: string;
  comments: CpCommentSpec[];
}

export interface CpDraftSpec {
  kind: CpDraftKind;
  genre?: CpPostGenre;
  board?: string;
  title?: string;
  body: string;
  /** kind==='reply'：模型从本次 posts 里挑一个 NPC 帖标题作目标。 */
  targetPostTitle?: string;
  sendReaction: string;
  hesitation: string;
}

export interface CpBoardSpec {
  /** 饭圈给「你 × TA」起的 CP 名（4 字诗化/谐音为主）。 */
  cpName: string;
  alt: CpAltResolutionSpec;
  posts: CpPostSpec[];
  drafts: CpDraftSpec[];
  followReaction: string;
}

// ──────────────────────────────────────────────────────────────────────────
// normalize helpers
// ──────────────────────────────────────────────────────────────────────────

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return truncateChars(value.replace(/\s+/g, ' '), max);
}

/** 正文允许保留换行（段落感），仅压多余空白行 + 截断。 */
function normalizeMultiline(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const t = value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

function normalizeGenre(value: unknown): CpPostGenre {
  return typeof value === 'string' && (CP_GENRES as readonly string[]).includes(value)
    ? (value as CpPostGenre)
    : 'discuss';
}

// ── alt ───────────────────────────────────────────────────────────────────

export function normalizeCpAltSpec(value: unknown): CpAltSpec | null {
  if (!isRecord(value)) return null;
  const username = normalizeString(value.username, CP_LIMITS.altUsernameMax);
  if (!username) return null;
  const bio = normalizeString(value.bio, CP_LIMITS.altBioMax) || '只是路过磕一口';
  const themeLabel = normalizeString(value.themeLabel, CP_LIMITS.altThemeLabelMax) || '潜水';
  return { username, bio, themeLabel };
}

export function normalizeCpAltResolutionSpec(value: unknown): CpAltResolutionSpec {
  if (!isRecord(value)) return { pickUsername: null, newAlt: null };
  const pickUsername = normalizeString(value.pickUsername, CP_LIMITS.altUsernameMax) || null;
  const newAlt = value.newAlt ? normalizeCpAltSpec(value.newAlt) : null;
  return { pickUsername, newAlt };
}

// ── 评论 / 回复 ───────────────────────────────────────────────────────────

function normalizeReplySpec(value: unknown): CpCommentReplySpec | null {
  if (!isRecord(value)) return null;
  const body = normalizeString(value.body, CP_LIMITS.replyBodyMax);
  if (!body) return null;
  // prompt 让模型输出 `isAgent`；兼容旧字段名 `authorIsAgent`（与 forum 同款约定）。
  const authorIsAgent = asBool(value.isAgent ?? value.authorIsAgent);
  const authorName = normalizeString(value.authorName, CP_LIMITS.authorNameMax);
  const toName = normalizeString(value.toName, CP_LIMITS.authorNameMax);
  const spec: CpCommentReplySpec = { authorName, authorIsAgent, body };
  if (toName) spec.toName = toName;
  return spec;
}

function normalizeCommentSpec(value: unknown): CpCommentSpec | null {
  if (!isRecord(value)) return null;
  const body = normalizeString(value.body, CP_LIMITS.commentBodyMax);
  if (!body) return null;
  const authorIsAgent = asBool(value.isAgent ?? value.authorIsAgent);
  const authorName = normalizeString(value.authorName, CP_LIMITS.authorNameMax);
  const replies: CpCommentReplySpec[] = [];
  if (Array.isArray(value.replies)) {
    for (const r of value.replies) {
      const reply = normalizeReplySpec(r);
      if (reply) replies.push(reply);
      if (replies.length >= CP_REPLIES_PER_COMMENT_MAX) break;
    }
  }
  return { authorName, authorIsAgent, body, replies };
}

function normalizeCommentList(value: unknown): CpCommentSpec[] {
  if (!Array.isArray(value)) return [];
  const out: CpCommentSpec[] = [];
  for (const c of value) {
    const comment = normalizeCommentSpec(c);
    if (comment) out.push(comment);
    if (out.length >= CP_COMMENTS_PER_POST.max) break;
  }
  return out;
}

// ── 帖子 ──────────────────────────────────────────────────────────────────

export function normalizeCpPostSpec(value: unknown): CpPostSpec | null {
  if (!isRecord(value)) return null;
  const title = normalizeString(value.title, CP_LIMITS.postTitleMax);
  const body = normalizeMultiline(value.body, CP_LIMITS.postBodyMax);
  const authorName = normalizeString(value.authorName, CP_LIMITS.authorNameMax);
  // CP 板只收 NPC 主题帖：必须有帖主名 + 标题 + 正文，否则丢弃。
  if (!title || !body || !authorName) return null;
  const genre = normalizeGenre(value.genre);
  const board = normalizeString(value.board, CP_LIMITS.boardMax) || 'CP 同好';
  const comments = normalizeCommentList(value.comments);
  return { genre, board, title, body, authorName, comments };
}

export function normalizeCpPostSpecList(value: unknown, max: number): CpPostSpec[] {
  const arr = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.posts) ? value.posts : [];
  const out: CpPostSpec[] = [];
  for (const p of arr) {
    const post = normalizeCpPostSpec(p);
    if (post) out.push(post);
    if (out.length >= max) break;
  }
  return out;
}

// ── 草稿 ──────────────────────────────────────────────────────────────────

const CP_SEND_REACTION_FALLBACK = '……你怎么连这个都翻出来了。';
const CP_HESITATION_FALLBACK = '写是写了，但没敢点发送。';

export function normalizeCpDraftSpec(value: unknown): CpDraftSpec | null {
  if (!isRecord(value)) return null;
  const body = normalizeMultiline(value.body, CP_LIMITS.draftBodyMax);
  if (!body) return null;
  const kind: CpDraftKind = value.kind === 'post' ? 'post' : 'reply';
  const sendReaction = normalizeString(value.sendReaction, CP_LIMITS.reactionMax) || CP_SEND_REACTION_FALLBACK;
  const hesitation = normalizeString(value.hesitation, CP_LIMITS.hesitationMax) || CP_HESITATION_FALLBACK;
  if (kind === 'post') {
    const title = normalizeString(value.title, CP_LIMITS.postTitleMax);
    if (!title) return null; // 主题帖草稿必须有标题
    return {
      kind,
      genre: normalizeGenre(value.genre),
      board: normalizeString(value.board, CP_LIMITS.boardMax) || 'CP 同好',
      title,
      body,
      sendReaction,
      hesitation,
    };
  }
  const targetPostTitle = normalizeString(value.targetPostTitle, CP_LIMITS.postTitleMax);
  if (!targetPostTitle) return null; // 回复草稿必须指明目标帖（组装层据此绑定）
  return { kind, body, targetPostTitle, sendReaction, hesitation };
}

export function normalizeCpDraftSpecList(value: unknown, max: number): CpDraftSpec[] {
  const arr = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.drafts) ? value.drafts : [];
  const out: CpDraftSpec[] = [];
  for (const d of arr) {
    const draft = normalizeCpDraftSpec(d);
    if (draft) out.push(draft);
    if (out.length >= max) break;
  }
  return out;
}

// ── 整批结果 ──────────────────────────────────────────────────────────────

export interface CpBoardResultSpec {
  /** 归一化后的 CP 名（可能为空串——交给 ai 层按名字兜底，见 resolveCpName）。 */
  cpName: string;
  alt: CpAltResolutionSpec;
  posts: CpPostSpec[];
  drafts: CpDraftSpec[];
  followReaction: string;
}

const CP_FOLLOW_REACTION_FALLBACK = '你替我点了关注？……行吧，反正都看见了。';

/**
 * normalize 整批生成结果。posts 为空视为失败（返回 null，调用方报错重试）——
 * 一次「偷看更新」至少要刷出一条 NPC 帖才有意义；草稿 / followReaction 可空（有兜底）。
 */
export function normalizeCpBoardResult(value: unknown): CpBoardResultSpec | null {
  if (!isRecord(value)) return null;
  const posts = normalizeCpPostSpecList(value.posts, CP_POSTS_PER_BATCH_MAX);
  if (!posts.length) return null;
  const alt = normalizeCpAltResolutionSpec(value.alt);
  const drafts = normalizeCpDraftSpecList(value.drafts, CP_DRAFTS_PER_BATCH_MAX);
  const followReaction =
    normalizeString(value.followReaction, CP_LIMITS.reactionMax) || CP_FOLLOW_REACTION_FALLBACK;
  const cpName = normalizeString(value.cpName, CP_LIMITS.cpNameMax); // 空串由 ai 层兜底
  return { cpName, alt, posts, drafts, followReaction };
}
