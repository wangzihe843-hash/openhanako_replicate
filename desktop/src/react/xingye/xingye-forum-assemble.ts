/**
 * xingye-forum-assemble.ts — 把 LLM spec 确定性组装成可持久化的论坛记录。
 *
 * 这里是「本地确定性生成」的一侧：ID / 时间 / 点赞浏览数 / 头像 seed / 账号统计 / 私信对象的
 * 挑选 全部在本地算出来，模型只负责定性正文。所有带随机/时间的入口都接受可注入的
 * `now` / `rand`，方便单测断言。
 *
 * 不读存储、不调模型、纯函数。
 */

import {
  type ForumAccount,
  type ForumAccountSpec,
  type ForumComment,
  type ForumCommentReply,
  type ForumDmThreadSpec,
  type ForumPost,
  type ForumPostSpec,
  type ForumThread,
  type ForumThreadOriginKind,
} from './xingye-forum-types';

export interface AssembleOptions {
  /** 当前时间（ms）。默认 Date.now()。 */
  now?: number;
  /** 随机源 [0,1)。默认 Math.random。 */
  rand?: () => number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Ctx {
  now: number;
  rand: () => number;
  seq: { n: number };
}

function makeCtx(opts: AssembleOptions): Ctx {
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

/** 把任意 [0,1) 随机映射到 [min,max] 整数。 */
function randInt(ctx: Ctx, min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(ctx.rand() * (max - min + 1));
}

// ──────────────────────────────────────────────────────────────────────────
// 账号
// ──────────────────────────────────────────────────────────────────────────

export function assembleAccount(spec: ForumAccountSpec, opts: AssembleOptions = {}): ForumAccount {
  const ctx = makeCtx(opts);
  // 注册时间撒在过去 30~400 天，制造「老号」感。
  const joinedMs = ctx.now - randInt(ctx, 30, 400) * DAY;
  const followers = randInt(ctx, 0, 280);
  return {
    accountId: makeId(ctx, 'facc'),
    username: spec.username,
    bio: spec.bio,
    themeLabel: spec.themeLabel,
    themeKeywords: spec.themeKeywords,
    avatarSeed: spec.username,
    joinedAt: iso(joinedMs),
    stats: {
      posts: 0, // 由调用方在落地帖子后回填，或保持 0（UI 也可现算）
      followers,
      following: randInt(ctx, 0, Math.max(20, Math.floor(followers / 3))),
    },
    createdAt: iso(ctx.now),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 帖子（含评论 / 嵌套回复）
// ──────────────────────────────────────────────────────────────────────────

function assemblePost(
  ctx: Ctx,
  spec: ForumPostSpec,
  account: ForumAccount,
  postedMs: number,
): ForumPost {
  const postId = makeId(ctx, 'fpost');
  const authored = spec.relation === 'authored';
  const authorName = authored ? account.username : (spec.authorName || '匿名网友');

  // 评论时间：从发帖后 1 小时起，依次往后撒，整体落在 now 之前。
  const span = Math.max(HOUR, Math.min(DAY * 3, ctx.now - postedMs - HOUR));
  const commentCount = Math.max(1, spec.comments.length);
  const comments: ForumComment[] = spec.comments.map((c, idx) => {
    const commentMs = Math.min(
      ctx.now - 60 * 1000,
      postedMs + HOUR + Math.floor((span * (idx + 1)) / (commentCount + 1)) + randInt(ctx, 0, 30) * 60 * 1000,
    );
    const replies: ForumCommentReply[] = c.replies.map((r, rIdx) => ({
      replyId: makeId(ctx, 'frep'),
      authorName: r.authorIsAgent ? account.username : (r.authorName || '匿名网友'),
      authorIsAgent: r.authorIsAgent,
      ...(r.toName ? { toName: r.toName } : {}),
      body: r.body,
      likes: randInt(ctx, 0, 12),
      postedAt: iso(Math.min(ctx.now - 30 * 1000, commentMs + (rIdx + 1) * randInt(ctx, 10, 90) * 60 * 1000)),
    }));
    return {
      commentId: makeId(ctx, 'fcmt'),
      authorName: c.authorIsAgent ? account.username : (c.authorName || '匿名网友'),
      authorIsAgent: c.authorIsAgent,
      body: c.body,
      likes: randInt(ctx, 0, 36),
      postedAt: iso(commentMs),
      replies,
    };
  });

  const likes = randInt(ctx, comments.length, comments.length * 8 + 12);
  return {
    postId,
    accountId: account.accountId,
    relation: spec.relation,
    board: spec.board,
    title: spec.title,
    body: spec.body,
    authorName,
    authorIsAgent: authored,
    postedAt: iso(postedMs),
    stats: { views: likes * randInt(ctx, 6, 20) + randInt(ctx, 20, 200), likes },
    comments,
    createdAt: iso(ctx.now),
  };
}

/**
 * 组装一批帖子。`spreadDays` 控制发帖时间往过去撒多远：
 *  - bootstrap 用较大值（如 14），制造历史感；
 *  - 增量 batch 用较小值（如 1），让新帖排在 feed 顶部。
 */
export function assemblePosts(
  specs: ForumPostSpec[],
  account: ForumAccount,
  opts: AssembleOptions & { spreadDays?: number } = {},
): ForumPost[] {
  const ctx = makeCtx(opts);
  const spreadMs = Math.max(HOUR, (opts.spreadDays ?? 14) * DAY);
  const n = Math.max(1, specs.length);
  return specs.map((spec, idx) => {
    // 第 0 条最新（靠近 now），依次往过去撒。
    const base = ctx.now - Math.floor((spreadMs * idx) / n) - randInt(ctx, 0, 6) * HOUR - HOUR;
    return assemblePost(ctx, spec, account, base);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 私信对象派生（从帖子里挑「TA 互动过的人」）
// ──────────────────────────────────────────────────────────────────────────

export interface ForumDmPeerCandidate {
  peerName: string;
  originKind: ForumThreadOriginKind;
  originPostId: string;
  originPostTitle: string;
}

/**
 * 从已组装帖子里派生私信候选对象：
 *  - commented 帖的 NPC 帖主 → commented_post_author
 *  - 任意帖里「TA 回复过其评论」的 NPC（该评论的 replies 含 agent 回复）→ replied_commenter
 * 按 peerName 去重（保留首次出现，附带其首个出现帖子的 id/title）。
 */
export function deriveForumDmPeers(posts: ForumPost[]): ForumDmPeerCandidate[] {
  const out: ForumDmPeerCandidate[] = [];
  const seen = new Set<string>();
  const push = (peerName: string, originKind: ForumThreadOriginKind, post: ForumPost) => {
    const name = peerName.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ peerName: name, originKind, originPostId: post.postId, originPostTitle: post.title });
  };
  for (const post of posts) {
    if (post.relation === 'commented' && !post.authorIsAgent) {
      push(post.authorName, 'commented_post_author', post);
    }
    for (const comment of post.comments) {
      if (comment.authorIsAgent) continue;
      const repliedByAgent = comment.replies.some((r) => r.authorIsAgent);
      if (repliedByAgent) push(comment.authorName, 'replied_commenter', post);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 私信线程
// ──────────────────────────────────────────────────────────────────────────

export function assembleDmThreads(
  specs: ForumDmThreadSpec[],
  account: ForumAccount,
  peerMetaByName: Map<string, ForumDmPeerCandidate>,
  opts: AssembleOptions = {},
): ForumThread[] {
  const ctx = makeCtx(opts);
  return specs.map((spec, idx) => {
    const meta = peerMetaByName.get(spec.peerName.toLowerCase());
    // 线程整体落在过去 3 天内，最新的线程靠近 now。
    const threadBase = ctx.now - randInt(ctx, 0, 3) * DAY - idx * randInt(ctx, 1, 6) * HOUR - 5 * 60 * 1000;
    let cursor = threadBase;
    const messages = spec.messages.map((m) => {
      cursor = Math.min(ctx.now - 60 * 1000, cursor + randInt(ctx, 3, 90) * 60 * 1000);
      return {
        messageId: makeId(ctx, 'fmsg'),
        sender: m.sender,
        body: m.body,
        sentAt: iso(cursor),
      };
    });
    const lastMessageAt = messages.length ? messages[messages.length - 1].sentAt : iso(threadBase);
    return {
      threadId: makeId(ctx, 'fthr'),
      accountId: account.accountId,
      peerName: spec.peerName,
      peerAvatarSeed: spec.peerName,
      originKind: meta?.originKind ?? 'replied_commenter',
      ...(meta?.originPostId ? { originPostId: meta.originPostId } : {}),
      ...(meta?.originPostTitle ? { originPostTitle: meta.originPostTitle } : {}),
      messages,
      lastMessageAt,
      createdAt: iso(ctx.now),
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 反重复 anchor（喂标题/版块短锚点，不喂正文 —— 与各 app prompt 反重复约定一致）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 构建给 batch prompt 的反重复锚点：最近帖子的「版块 · 标题」短行 + 已有小号的氛围标签。
 * 只喂标题/标签，不喂正文（输入侧最小化）。
 */
export function buildForumDedupeAnchorBlock(
  recentPosts: ForumPost[],
  accounts: ForumAccount[],
): string {
  const lines: string[] = [];
  const titleSamples = recentPosts.slice(0, 12);
  if (titleSamples.length) {
    lines.push('- 近期帖子（请换不同话题/切口，不要重复标题与版块组合）：');
    for (const p of titleSamples) {
      const who = p.relation === 'authored' ? '发帖' : '评论';
      lines.push(`  · [${p.board}]「${p.title}」（${who}）`);
    }
  }
  if (accounts.length) {
    lines.push('- 已有小号（同主题归到对应号，主题不搭才提议新号）：');
    for (const a of accounts) {
      const kw = a.themeKeywords.length ? `，关键词：${a.themeKeywords.join('/')}` : '';
      lines.push(`  · @${a.username}（${a.themeLabel}${kw}）`);
    }
  }
  return lines.join('\n');
}
