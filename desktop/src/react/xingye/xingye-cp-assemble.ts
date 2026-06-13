/**
 * xingye-cp-assemble.ts — 把「你和 TA 的 CP」的 LLM spec 确定性组装成可持久化记录。
 *
 * 「本地确定性生成」的一侧：ID / 时间 / 点赞浏览数 / 头像 seed / 草稿目标绑定 全部本地算，
 * 模型只负责定性正文。带随机 / 时间的入口都接受可注入的 now / rand，方便单测断言。
 *
 * 不读存储、不调模型、纯函数。
 */

import {
  type CpAltAccount,
  type CpAltSpec,
  type CpComment,
  type CpCommentReply,
  type CpDraft,
  type CpDraftSpec,
  type CpPost,
  type CpPostSpec,
} from './xingye-cp-types';

export interface CpAssembleOptions {
  now?: number;
  rand?: () => number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Ctx {
  now: number;
  rand: () => number;
  seq: { n: number };
}

function makeCtx(opts: CpAssembleOptions): Ctx {
  return {
    now: typeof opts.now === 'number' ? opts.now : Date.now(),
    rand: opts.rand ?? Math.random,
    seq: { n: 0 },
  };
}

function makeId(ctx: Ctx, prefix: string): string {
  ctx.seq.n += 1;
  const rand = Math.floor(ctx.rand() * 1e9).toString(36);
  return `${prefix}-${ctx.now.toString(36)}-${ctx.seq.n.toString(36)}-${rand}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function randInt(ctx: Ctx, min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(ctx.rand() * (max - min + 1));
}

// ──────────────────────────────────────────────────────────────────────────
// CP 马甲（TA 在 CP 板的身份）
// ──────────────────────────────────────────────────────────────────────────

/** 没有合适的现有小号时，从 LLM 新马甲 spec 造一个 CP 专用身份。 */
export function assembleCpAltFromSpec(spec: CpAltSpec, opts: CpAssembleOptions = {}): CpAltAccount {
  const ctx = makeCtx(opts);
  return {
    accountId: makeId(ctx, 'calt'),
    username: spec.username,
    bio: spec.bio,
    themeLabel: spec.themeLabel,
    avatarSeed: spec.username,
    fromForum: false,
  };
}

/** 复用 TA 现有的论坛小号作为 CP 身份（只取展示所需字段，不耦合 forum 类型）。 */
export function assembleCpAltFromForumAccount(account: {
  accountId: string;
  username: string;
  bio: string;
  themeLabel: string;
  avatarSeed: string;
}): CpAltAccount {
  return {
    accountId: account.accountId,
    username: account.username,
    bio: account.bio,
    themeLabel: account.themeLabel,
    avatarSeed: account.avatarSeed || account.username,
    fromForum: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// NPC 帖子（含评论 / 嵌套回复；agent 评论的 authorName 统一覆写为 CP 马甲名）
// ──────────────────────────────────────────────────────────────────────────

function assembleComments(ctx: Ctx, specs: CpPostSpec['comments'], altUsername: string, postedMs: number): CpComment[] {
  const span = Math.max(HOUR, Math.min(DAY * 3, ctx.now - postedMs - HOUR));
  const count = Math.max(1, specs.length);
  return specs.map((c, idx) => {
    const commentMs = Math.min(
      ctx.now - 60 * 1000,
      postedMs + HOUR + Math.floor((span * (idx + 1)) / (count + 1)) + randInt(ctx, 0, 30) * 60 * 1000,
    );
    const replies: CpCommentReply[] = c.replies.map((r, rIdx) => ({
      replyId: makeId(ctx, 'crep'),
      authorName: r.authorIsAgent ? altUsername : r.authorName || '匿名同好',
      authorIsAgent: r.authorIsAgent,
      ...(r.toName ? { toName: r.toName } : {}),
      body: r.body,
      likes: randInt(ctx, 0, 12),
      postedAt: iso(Math.min(ctx.now - 30 * 1000, commentMs + (rIdx + 1) * randInt(ctx, 10, 90) * 60 * 1000)),
    }));
    return {
      commentId: makeId(ctx, 'ccmt'),
      authorName: c.authorIsAgent ? altUsername : c.authorName || '匿名同好',
      authorIsAgent: c.authorIsAgent,
      body: c.body,
      likes: randInt(ctx, 0, 48),
      postedAt: iso(commentMs),
      replies,
    };
  });
}

function assembleCpPost(ctx: Ctx, spec: CpPostSpec, altUsername: string, postedMs: number): CpPost {
  const comments = assembleComments(ctx, spec.comments, altUsername, postedMs);
  const likes = randInt(ctx, Math.max(comments.length, 3), comments.length * 10 + 30);
  return {
    postId: makeId(ctx, 'cpost'),
    origin: 'npc',
    genre: spec.genre,
    board: spec.board,
    title: spec.title,
    body: spec.body,
    authorName: spec.authorName || '匿名同好',
    authorIsAgent: false,
    postedAt: iso(postedMs),
    stats: { views: likes * randInt(ctx, 8, 24) + randInt(ctx, 40, 300), likes },
    comments,
    createdAt: iso(ctx.now),
  };
}

/**
 * 组装一批 NPC 帖子。`spreadDays` 控制发帖时间往过去撒多远（CP 板增量用较小值，让新帖排顶部）。
 * 第 0 条最新（靠近 now），依次往过去撒。`altUsername` 用于把 agent 评论 / 回复署名为 CP 马甲。
 */
export function assembleCpPosts(
  specs: CpPostSpec[],
  altUsername: string,
  opts: CpAssembleOptions & { spreadDays?: number } = {},
): CpPost[] {
  const ctx = makeCtx(opts);
  const spreadMs = Math.max(HOUR, (opts.spreadDays ?? 2) * DAY);
  const n = Math.max(1, specs.length);
  return specs.map((spec, idx) => {
    const base = ctx.now - Math.floor((spreadMs * idx) / n) - randInt(ctx, 0, 6) * HOUR - HOUR;
    return assembleCpPost(ctx, spec, altUsername, base);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 草稿（reply 草稿在组装层绑定到一条已组装 NPC 帖）
// ──────────────────────────────────────────────────────────────────────────

function findTargetPost(posts: CpPost[], targetTitle: string): CpPost | null {
  const t = targetTitle.trim().toLowerCase();
  if (!t) return null;
  const exact = posts.find((p) => p.title.trim().toLowerCase() === t);
  if (exact) return exact;
  // 退一步：标题互相包含（模型可能把标题略写 / 加引号）。
  return posts.find((p) => {
    const pt = p.title.trim().toLowerCase();
    return pt.includes(t) || t.includes(pt);
  }) ?? null;
}

/**
 * 组装草稿：
 *  - kind==='post'：保留为「想发的主题帖」草稿。
 *  - kind==='reply'：把 targetPostTitle 绑定到 `posts` 里的某条 NPC 帖（绑不上则丢弃，
 *    因为「替 TA 发送」需要一个真实的落点帖）。
 */
export function assembleCpDrafts(
  specs: CpDraftSpec[],
  posts: CpPost[],
  opts: CpAssembleOptions = {},
): CpDraft[] {
  const ctx = makeCtx(opts);
  const out: CpDraft[] = [];
  for (const spec of specs) {
    if (spec.kind === 'reply') {
      const target = findTargetPost(posts, spec.targetPostTitle ?? '');
      if (!target) continue; // 绑不上目标帖，丢弃这条 reply 草稿
      out.push({
        draftId: makeId(ctx, 'cdrf'),
        kind: 'reply',
        body: spec.body,
        targetPostId: target.postId,
        targetPostTitle: target.title,
        sendReaction: spec.sendReaction,
        hesitation: spec.hesitation,
        createdAt: iso(ctx.now),
      });
      continue;
    }
    out.push({
      draftId: makeId(ctx, 'cdrf'),
      kind: 'post',
      ...(spec.genre ? { genre: spec.genre } : {}),
      ...(spec.board ? { board: spec.board } : {}),
      ...(spec.title ? { title: spec.title } : {}),
      body: spec.body,
      sendReaction: spec.sendReaction,
      hesitation: spec.hesitation,
      createdAt: iso(ctx.now),
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 「替 TA 发送」：把草稿物化成真正发布的 agent 内容
// ──────────────────────────────────────────────────────────────────────────

/** post 草稿 → 一条 agent-origin 主题帖（刚发出，暂无评论）。 */
export function assembleAgentPostFromDraft(
  draft: CpDraft,
  alt: CpAltAccount,
  opts: CpAssembleOptions = {},
): CpPost {
  const ctx = makeCtx(opts);
  const postedMs = ctx.now - randInt(ctx, 1, 9) * 60 * 1000;
  const likes = randInt(ctx, 0, 4);
  return {
    postId: makeId(ctx, 'cpost'),
    origin: 'agent',
    genre: draft.genre ?? 'discuss',
    board: draft.board ?? 'CP 同好',
    title: draft.title ?? draft.body.slice(0, 20),
    body: draft.body,
    authorName: alt.username,
    authorIsAgent: true,
    postedAt: iso(postedMs),
    stats: { views: likes * randInt(ctx, 4, 12) + randInt(ctx, 6, 40), likes },
    comments: [],
    createdAt: iso(ctx.now),
  };
}

/** reply 草稿 → 一条 agent 评论（挂到目标 NPC 帖底下）。 */
export function buildAgentCommentFromDraft(
  draft: CpDraft,
  alt: CpAltAccount,
  opts: CpAssembleOptions = {},
): CpComment {
  const ctx = makeCtx(opts);
  return {
    commentId: makeId(ctx, 'ccmt'),
    authorName: alt.username,
    authorIsAgent: true,
    body: draft.body,
    likes: randInt(ctx, 0, 3),
    postedAt: iso(ctx.now - randInt(ctx, 1, 5) * 60 * 1000),
    replies: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 反重复 anchor（只喂体裁 · 版块 · 标题短行，不喂正文 —— 与各 app 反重复约定一致）
// ──────────────────────────────────────────────────────────────────────────

const GENRE_LABEL: Record<CpPost['genre'], string> = {
  fic: '同人',
  analysis: '考据',
  squee: '发疯',
  discuss: '讨论',
};

export function buildCpDedupeAnchorBlock(recentPosts: CpPost[]): string {
  const samples = recentPosts.slice(0, 14);
  if (!samples.length) return '（暂无历史帖子）';
  const lines = ['- 近期帖子（请换不同切口 / 体裁，不要重复标题与版块组合）：'];
  for (const p of samples) {
    lines.push(`  · [${GENRE_LABEL[p.genre]}·${p.board}]「${p.title}」`);
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// 聊天水位线签名（判定「有没有新聊天」；纯函数，便于单测）
// ──────────────────────────────────────────────────────────────────────────

function cheapHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * 把「当前最近聊天」压成一个稳定签名。任何新消息都会改变 summaryText / 计数 / 最后时间，
 * 从而改变签名；完全没变则签名一致 → 判定「没有新聊天」。
 */
export function cpChatSignature(input: {
  messageCount: number;
  lastCreatedAt?: string;
  summaryText: string;
}): string {
  return `${input.messageCount}:${input.lastCreatedAt ?? ''}:${cheapHash(input.summaryText)}`;
}
