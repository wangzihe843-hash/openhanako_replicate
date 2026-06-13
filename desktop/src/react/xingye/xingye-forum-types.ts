/**
 * 秘密空间「TA 的论坛小号」模块的类型 + normalize。
 *
 * 形态：通用现代论坛（版块 + 话题；评论平铺 + 对单条评论一层嵌套回复；无楼层/盖楼概念）。
 *
 * 数据分三类持久化（见 xingye-forum-store）：
 *  - 账号（小号）  secret-space/forum/accounts.jsonl
 *  - 帖子          secret-space/forum/posts.jsonl   （评论 / 嵌套回复内嵌在帖子行内）
 *  - 私信线程      secret-space/forum/threads.jsonl （消息内嵌在线程行内）
 *
 * 与专访（interview）一致的取舍：
 *  - LLM 只产「定性正文」（账号签名 / 帖子标题正文 / 评论 / 私信消息）；
 *    ID / 时间 / 点赞浏览数 / 头像 seed / 私信对象的挑选 全部由本地确定性组装
 *    （见 xingye-forum-assemble），不喂给模型也不让模型编。
 *  - normalize 只保证字段类型 + 字数截断 + 关键不变量（见下），不校验业务语义文风。
 *
 * 关键不变量（normalize 阶段保证）：
 *  - 每个帖子必须有 title + body，否则丢弃。
 *  - relation==='commented'（TA 评论的、帖主是 NPC）的帖子：必须带 NPC 帖主名
 *    （authorName），且评论里至少有一条 isAgent===true（否则这帖不该出现在 TA 的主页，丢弃）。
 *  - relation==='authored'（TA 自己发的）：帖主就是当前小号，authorName 留空由组装层回填。
 *  - 每帖评论最多 COMMENTS_PER_POST.max 条；每条评论的嵌套回复最多 REPLIES_PER_COMMENT_MAX 条。
 */

export const FORUM_LIMITS = {
  usernameMax: 16,
  bioMax: 44,
  themeLabelMax: 6,
  themeKeywordMax: 12,
  themeKeywordsMax: 4,
  boardMax: 8,
  postTitleMax: 38,
  postBodyMax: 240,
  authorNameMax: 16,
  commentBodyMax: 90,
  replyBodyMax: 90,
  dmBodyMax: 140,
} as const;

/** 每帖评论条数：下限不强制（少了也能渲染），上限作 normalize 截断阈值。 */
export const COMMENTS_PER_POST = { min: 3, max: 5 } as const;
/** 单条评论的一层嵌套回复上限（通用论坛只做一层嵌套，不无限套娃）。 */
export const REPLIES_PER_COMMENT_MAX = 3;
/** 一次 bootstrap / batch 接受的帖子数上限（防止模型一次塞太多）。 */
export const POSTS_PER_BOOTSTRAP_MAX = 6;
export const POSTS_PER_BATCH_MAX = 3;
/** 私信：单线程消息上限 / 一次生成线程数上限。 */
export const DM_MESSAGES_MAX = 8;
export const DM_THREADS_MAX = 4;

export type ForumPostRelation = 'authored' | 'commented';
export type ForumMessageSender = 'peer' | 'agent';
/** 私信来源：TA 回复过其评论的人 / TA 评论过的帖子的帖主。 */
export type ForumThreadOriginKind = 'replied_commenter' | 'commented_post_author';

// ──────────────────────────────────────────────────────────────────────────
// 持久化类型（落 jsonl）
// ──────────────────────────────────────────────────────────────────────────

export interface ForumAccount {
  accountId: string;
  /** 论坛用户名（小号名）。 */
  username: string;
  /** 个性签名 / 简介。 */
  bio: string;
  /** 这个小号的氛围短标签（如 追番 / 树洞 / 考研）。 */
  themeLabel: string;
  /** 内部主题关键词（路由「新内容归哪个号」+ 反重复用，不在 UI 显眼处展示）。 */
  themeKeywords: string[];
  /** 头像确定性 seed（颜色 + 首字由它派生）。 */
  avatarSeed: string;
  /** 注册时间（本地确定性）。 */
  joinedAt: string;
  stats: { posts: number; followers: number; following: number };
  createdAt: string;
}

export interface ForumCommentReply {
  replyId: string;
  authorName: string;
  authorIsAgent: boolean;
  /** @某人（可选）。 */
  toName?: string;
  body: string;
  likes: number;
  postedAt: string;
}

export interface ForumComment {
  commentId: string;
  authorName: string;
  authorIsAgent: boolean;
  body: string;
  likes: number;
  postedAt: string;
  replies: ForumCommentReply[];
}

export interface ForumPost {
  postId: string;
  /** 这条帖子归属的小号（TA 通过该号发帖 / 评论）。 */
  accountId: string;
  relation: ForumPostRelation;
  /** 版块 / 分区名。 */
  board: string;
  title: string;
  body: string;
  /** 帖主显示名：authored → 小号名；commented → NPC 名。 */
  authorName: string;
  authorIsAgent: boolean;
  postedAt: string;
  stats: { views: number; likes: number };
  comments: ForumComment[];
  createdAt: string;
}

export interface ForumMessage {
  messageId: string;
  sender: ForumMessageSender;
  body: string;
  sentAt: string;
}

export interface ForumThread {
  threadId: string;
  /** 该私信落在哪个小号的收件箱。 */
  accountId: string;
  peerName: string;
  peerAvatarSeed: string;
  originKind: ForumThreadOriginKind;
  /** 关联的帖子（可选，用于语境 / 跳转）。 */
  originPostId?: string;
  originPostTitle?: string;
  messages: ForumMessage[];
  lastMessageAt: string;
  createdAt: string;
}

// ──────────────────────────────────────────────────────────────────────────
// LLM 原始输出 → spec（纯文本，未含 ID / 时间 / 数值；交给 assemble 组装）
// ──────────────────────────────────────────────────────────────────────────

export interface ForumAccountSpec {
  username: string;
  bio: string;
  themeLabel: string;
  themeKeywords: string[];
}

export interface ForumCommentReplySpec {
  authorName: string;
  authorIsAgent: boolean;
  toName?: string;
  body: string;
}

export interface ForumCommentSpec {
  authorName: string;
  authorIsAgent: boolean;
  body: string;
  replies: ForumCommentReplySpec[];
}

export interface ForumPostSpec {
  relation: ForumPostRelation;
  board: string;
  title: string;
  body: string;
  /** commented 帖必填（NPC 帖主名）；authored 可空。 */
  authorName?: string;
  comments: ForumCommentSpec[];
}

export interface ForumDmThreadSpec {
  peerName: string;
  messages: { sender: ForumMessageSender; body: string }[];
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

/** 帖子正文允许保留换行（段落感），仅压多余空白行 + 截断。 */
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

function normalizeThemeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const k = normalizeString(item, FORUM_LIMITS.themeKeywordMax);
    if (!k) continue;
    const lower = k.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(k);
    if (out.length >= FORUM_LIMITS.themeKeywordsMax) break;
  }
  return out;
}

export function normalizeForumAccountSpec(value: unknown): ForumAccountSpec | null {
  if (!isRecord(value)) return null;
  const username = normalizeString(value.username, FORUM_LIMITS.usernameMax);
  if (!username) return null;
  const bio = normalizeString(value.bio, FORUM_LIMITS.bioMax) || '这个人很懒，什么都没写';
  const themeLabel = normalizeString(value.themeLabel, FORUM_LIMITS.themeLabelMax) || '日常';
  const themeKeywords = normalizeThemeKeywords(value.themeKeywords);
  return { username, bio, themeLabel, themeKeywords };
}

function normalizeReplySpec(value: unknown): ForumCommentReplySpec | null {
  if (!isRecord(value)) return null;
  const body = normalizeString(value.body, FORUM_LIMITS.replyBodyMax);
  if (!body) return null;
  // prompt 让模型输出 `isAgent`；兼容旧字段名 `authorIsAgent`。
  const authorIsAgent = asBool(value.isAgent ?? value.authorIsAgent);
  const authorName = normalizeString(value.authorName, FORUM_LIMITS.authorNameMax);
  const toName = normalizeString(value.toName, FORUM_LIMITS.authorNameMax);
  const spec: ForumCommentReplySpec = { authorName, authorIsAgent, body };
  if (toName) spec.toName = toName;
  return spec;
}

function normalizeCommentSpec(value: unknown): ForumCommentSpec | null {
  if (!isRecord(value)) return null;
  const body = normalizeString(value.body, FORUM_LIMITS.commentBodyMax);
  if (!body) return null;
  // prompt 让模型输出 `isAgent`；兼容旧字段名 `authorIsAgent`。
  const authorIsAgent = asBool(value.isAgent ?? value.authorIsAgent);
  const authorName = normalizeString(value.authorName, FORUM_LIMITS.authorNameMax);
  const replies: ForumCommentReplySpec[] = [];
  if (Array.isArray(value.replies)) {
    for (const r of value.replies) {
      const reply = normalizeReplySpec(r);
      if (reply) replies.push(reply);
      if (replies.length >= REPLIES_PER_COMMENT_MAX) break;
    }
  }
  return { authorName, authorIsAgent, body, replies };
}

function normalizeCommentList(value: unknown): ForumCommentSpec[] {
  if (!Array.isArray(value)) return [];
  const out: ForumCommentSpec[] = [];
  for (const c of value) {
    const comment = normalizeCommentSpec(c);
    if (comment) out.push(comment);
    if (out.length >= COMMENTS_PER_POST.max) break;
  }
  return out;
}

function isRelation(value: unknown): value is ForumPostRelation {
  return value === 'authored' || value === 'commented';
}

export function normalizeForumPostSpec(value: unknown): ForumPostSpec | null {
  if (!isRecord(value)) return null;
  const title = normalizeString(value.title, FORUM_LIMITS.postTitleMax);
  const body = normalizeMultiline(value.body, FORUM_LIMITS.postBodyMax);
  if (!title || !body) return null;
  const relation: ForumPostRelation = isRelation(value.relation) ? value.relation : 'authored';
  const board = normalizeString(value.board, FORUM_LIMITS.boardMax) || '广场';
  const authorName = normalizeString(value.authorName, FORUM_LIMITS.authorNameMax);
  const comments = normalizeCommentList(value.comments);

  if (relation === 'commented') {
    // 帖主必须是 NPC（有名字），且评论里至少有 TA 的一条——否则这帖不该挂在 TA 主页。
    if (!authorName) return null;
    if (!comments.some((c) => c.authorIsAgent)) return null;
    return { relation, board, title, body, authorName, comments };
  }
  // authored：帖主是当前小号，authorName 由组装层回填，这里不强制。
  return { relation, board, title, body, comments };
}

/** 解析 bootstrap / batch 返回里的 posts 数组（多余项按 max 截断）。 */
export function normalizeForumPostSpecList(value: unknown, max: number): ForumPostSpec[] {
  const arr = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.posts)
      ? value.posts
      : [];
  const out: ForumPostSpec[] = [];
  for (const p of arr) {
    const post = normalizeForumPostSpec(p);
    if (post) out.push(post);
    if (out.length >= max) break;
  }
  return out;
}

export interface ForumBootstrapResult {
  account: ForumAccountSpec;
  posts: ForumPostSpec[];
}

/** bootstrap：必须有合法 account + 至少 1 个帖子，否则视为失败（调用方报错重试）。 */
export function normalizeForumBootstrapResult(value: unknown): ForumBootstrapResult | null {
  if (!isRecord(value)) return null;
  const account = normalizeForumAccountSpec(value.account);
  if (!account) return null;
  const posts = normalizeForumPostSpecList(value.posts, POSTS_PER_BOOTSTRAP_MAX);
  if (!posts.length) return null;
  return { account, posts };
}

export interface ForumBatchResult {
  posts: ForumPostSpec[];
  /** 模型判断新内容主题不搭已有小号时，提议新开的小号（可空）。 */
  newAccount: ForumAccountSpec | null;
}

export function normalizeForumBatchResult(value: unknown): ForumBatchResult {
  if (!isRecord(value)) return { posts: [], newAccount: null };
  const posts = normalizeForumPostSpecList(value.posts, POSTS_PER_BATCH_MAX);
  const newAccount = value.newAccount ? normalizeForumAccountSpec(value.newAccount) : null;
  return { posts, newAccount };
}

function normalizeDmMessage(value: unknown): { sender: ForumMessageSender; body: string } | null {
  if (!isRecord(value)) return null;
  const body = normalizeString(value.body, FORUM_LIMITS.dmBodyMax);
  if (!body) return null;
  const sender: ForumMessageSender =
    value.sender === 'agent' || value.from === 'agent' || value.sender === 'me' ? 'agent' : 'peer';
  return { sender, body };
}

export function normalizeForumDmThreadSpec(value: unknown): ForumDmThreadSpec | null {
  if (!isRecord(value)) return null;
  const peerName = normalizeString(value.peerName, FORUM_LIMITS.authorNameMax);
  if (!peerName) return null;
  const messages: { sender: ForumMessageSender; body: string }[] = [];
  if (Array.isArray(value.messages)) {
    for (const m of value.messages) {
      const msg = normalizeDmMessage(m);
      if (msg) messages.push(msg);
      if (messages.length >= DM_MESSAGES_MAX) break;
    }
  }
  if (!messages.length) return null;
  return { peerName, messages };
}

export function normalizeForumDmResult(value: unknown): ForumDmThreadSpec[] {
  const arr = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.threads)
      ? value.threads
      : [];
  const out: ForumDmThreadSpec[] = [];
  for (const t of arr) {
    const thread = normalizeForumDmThreadSpec(t);
    if (thread) out.push(thread);
    if (out.length >= DM_THREADS_MAX) break;
  }
  return out;
}
