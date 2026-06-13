/**
 * xingye-forum-store.ts — 「TA 的论坛小号」的 agent 维度持久化。
 *
 * 复用 createAgentXingyeStorageBackend（同 secret-space store）。文件布局：
 *   secret-space/forum/accounts.jsonl   小号
 *   secret-space/forum/posts.jsonl      帖子（评论 / 嵌套回复内嵌）
 *   secret-space/forum/threads.jsonl    私信线程（消息内嵌）
 *   secret-space/forum/meta.json        { initializedAt }（首开 bootstrap 幂等标记）
 *
 * 持久化不变量（与 domain_xingye_persistence_invariants 一致）：
 *  - 每行带 key/id/recordId = 实体 id，便于 deleteJsonlRecord 与服务端匹配。
 *  - replace/delete 走 read-modify-write；读失败（list 抛错）直接抛，**绝不**接着写空表覆写。
 *  - 找不到目标记录时是 no-op（return false），不写文件。
 *  - 追加/变更后派发 `xingye-forum-changed`，让打开中的论坛页自动刷新（如心跳追加）。
 */

import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import type { ForumAccount, ForumPost, ForumThread } from './xingye-forum-types';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

const DIR = 'secret-space/forum';
const ACCOUNTS_REL = `${DIR}/accounts.jsonl`;
const POSTS_REL = `${DIR}/posts.jsonl`;
const THREADS_REL = `${DIR}/threads.jsonl`;
const META_REL = `${DIR}/meta.json`;

export interface ForumMeta {
  initializedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function emitChanged(agentId: string, kind: 'accounts' | 'posts' | 'threads'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('xingye-forum-changed', { detail: { agentId, kind } }));
}

/** 给落盘行补 key/id/recordId（=实体 id），与 secret-space store 的稳定删除约定一致。 */
function withIds<T extends Record<string, unknown>>(entity: T, id: string): T & { key: string; id: string; recordId: string } {
  return { ...entity, key: id, id, recordId: id };
}

// ── 账号 ────────────────────────────────────────────────────────────────────

function normalizeAccount(value: unknown): ForumAccount | null {
  if (!isRecord(value)) return null;
  const accountId = str(value.accountId) || str(value.id) || str(value.key);
  const username = str(value.username);
  if (!accountId || !username) return null;
  const stats = isRecord(value.stats) ? value.stats : {};
  return {
    accountId,
    username,
    bio: str(value.bio),
    themeLabel: str(value.themeLabel) || '日常',
    themeKeywords: Array.isArray(value.themeKeywords)
      ? value.themeKeywords.filter((k): k is string => typeof k === 'string')
      : [],
    avatarSeed: str(value.avatarSeed) || username,
    joinedAt: str(value.joinedAt) || new Date(0).toISOString(),
    stats: {
      posts: typeof stats.posts === 'number' ? stats.posts : 0,
      followers: typeof stats.followers === 'number' ? stats.followers : 0,
      following: typeof stats.following === 'number' ? stats.following : 0,
    },
    createdAt: str(value.createdAt) || new Date(0).toISOString(),
  };
}

export async function listForumAccounts(agentId: string): Promise<ForumAccount[]> {
  if (!agentId) return [];
  try {
    const rows = await backend.listJsonl<Record<string, unknown>>(agentId, ACCOUNTS_REL);
    return rows
      .map(normalizeAccount)
      .filter((a): a is ForumAccount => Boolean(a))
      .sort((a, b) => Date.parse(a.createdAt || '0') - Date.parse(b.createdAt || '0'));
  } catch {
    return [];
  }
}

export async function appendForumAccount(agentId: string, account: ForumAccount): Promise<void> {
  if (!agentId) return;
  await backend.appendJsonl(agentId, ACCOUNTS_REL, withIds({ ...account }, account.accountId));
  emitChanged(agentId, 'accounts');
}

// ── 帖子 ────────────────────────────────────────────────────────────────────

function normalizePost(value: unknown): ForumPost | null {
  if (!isRecord(value)) return null;
  const postId = str(value.postId) || str(value.id) || str(value.key);
  const title = str(value.title);
  const body = str(value.body);
  const accountId = str(value.accountId);
  if (!postId || !title || !body || !accountId) return null;
  const stats = isRecord(value.stats) ? value.stats : {};
  const relation = value.relation === 'commented' ? 'commented' : 'authored';
  const comments = Array.isArray(value.comments)
    ? value.comments.filter(isRecord).map((c) => ({
        commentId: str(c.commentId) || str(c.id),
        authorName: str(c.authorName) || '匿名网友',
        authorIsAgent: c.authorIsAgent === true,
        body: str(c.body),
        likes: typeof c.likes === 'number' ? c.likes : 0,
        postedAt: str(c.postedAt) || new Date(0).toISOString(),
        replies: Array.isArray(c.replies)
          ? c.replies.filter(isRecord).map((r) => ({
              replyId: str(r.replyId) || str(r.id),
              authorName: str(r.authorName) || '匿名网友',
              authorIsAgent: r.authorIsAgent === true,
              ...(str(r.toName) ? { toName: str(r.toName) } : {}),
              body: str(r.body),
              likes: typeof r.likes === 'number' ? r.likes : 0,
              postedAt: str(r.postedAt) || new Date(0).toISOString(),
            }))
          : [],
      }))
    : [];
  return {
    postId,
    accountId,
    relation,
    board: str(value.board) || '广场',
    title,
    body,
    authorName: str(value.authorName) || '匿名网友',
    authorIsAgent: value.authorIsAgent === true,
    postedAt: str(value.postedAt) || new Date(0).toISOString(),
    stats: {
      views: typeof stats.views === 'number' ? stats.views : 0,
      likes: typeof stats.likes === 'number' ? stats.likes : 0,
    },
    comments,
    createdAt: str(value.createdAt) || new Date(0).toISOString(),
  };
}

/** 返回全部帖子，按 postedAt 倒序（最新在前）。UI 自行按 accountId 过滤。 */
export async function listForumPosts(agentId: string): Promise<ForumPost[]> {
  if (!agentId) return [];
  try {
    const rows = await backend.listJsonl<Record<string, unknown>>(agentId, POSTS_REL);
    return rows
      .map(normalizePost)
      .filter((p): p is ForumPost => Boolean(p))
      .sort((a, b) => Date.parse(b.postedAt || '0') - Date.parse(a.postedAt || '0'));
  } catch {
    return [];
  }
}

export async function appendForumPosts(agentId: string, posts: ForumPost[]): Promise<void> {
  if (!agentId || !posts.length) return;
  for (const post of posts) {
    await backend.appendJsonl(agentId, POSTS_REL, withIds({ ...post }, post.postId));
  }
  emitChanged(agentId, 'posts');
}

/** 用更新后的帖子整体替换同 postId 的行（如给已有帖追加评论）。找不到则 no-op 返回 false。 */
export async function replaceForumPost(agentId: string, post: ForumPost): Promise<boolean> {
  if (!agentId) return false;
  const rows = await backend.listJsonl<Record<string, unknown>>(agentId, POSTS_REL); // 读失败抛错 → 不覆写
  let found = false;
  const next = rows.map((row) => {
    const id = str(row.postId) || str(row.id) || str(row.key);
    if (id === post.postId) {
      found = true;
      return withIds({ ...post }, post.postId);
    }
    return row;
  });
  if (!found) return false;
  await backend.writeJsonl(agentId, POSTS_REL, next);
  emitChanged(agentId, 'posts');
  return true;
}

export async function deleteForumPost(agentId: string, postId: string): Promise<boolean> {
  if (!agentId || !postId) return false;
  const ok = await backend.deleteJsonlRecord(agentId, POSTS_REL, postId);
  if (ok) emitChanged(agentId, 'posts');
  return ok;
}

// ── 私信线程 ──────────────────────────────────────────────────────────────────

function normalizeThread(value: unknown): ForumThread | null {
  if (!isRecord(value)) return null;
  const threadId = str(value.threadId) || str(value.id) || str(value.key);
  const accountId = str(value.accountId);
  const peerName = str(value.peerName);
  if (!threadId || !accountId || !peerName) return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.filter(isRecord).map((m) => ({
        messageId: str(m.messageId) || str(m.id),
        sender: m.sender === 'agent' ? ('agent' as const) : ('peer' as const),
        body: str(m.body),
        sentAt: str(m.sentAt) || new Date(0).toISOString(),
      }))
    : [];
  const originKind = value.originKind === 'commented_post_author' ? 'commented_post_author' : 'replied_commenter';
  return {
    threadId,
    accountId,
    peerName,
    peerAvatarSeed: str(value.peerAvatarSeed) || peerName,
    originKind,
    ...(str(value.originPostId) ? { originPostId: str(value.originPostId) } : {}),
    ...(str(value.originPostTitle) ? { originPostTitle: str(value.originPostTitle) } : {}),
    messages,
    lastMessageAt: str(value.lastMessageAt) || new Date(0).toISOString(),
    createdAt: str(value.createdAt) || new Date(0).toISOString(),
  };
}

/** 返回全部私信线程，按 lastMessageAt 倒序。 */
export async function listForumThreads(agentId: string): Promise<ForumThread[]> {
  if (!agentId) return [];
  try {
    const rows = await backend.listJsonl<Record<string, unknown>>(agentId, THREADS_REL);
    return rows
      .map(normalizeThread)
      .filter((t): t is ForumThread => Boolean(t))
      .sort((a, b) => Date.parse(b.lastMessageAt || '0') - Date.parse(a.lastMessageAt || '0'));
  } catch {
    return [];
  }
}

export async function appendForumThreads(agentId: string, threads: ForumThread[]): Promise<void> {
  if (!agentId || !threads.length) return;
  for (const thread of threads) {
    await backend.appendJsonl(agentId, THREADS_REL, withIds({ ...thread }, thread.threadId));
  }
  emitChanged(agentId, 'threads');
}

/** 整体替换同 threadId 的行（如给线程追加一条消息）。找不到则 no-op 返回 false。 */
export async function replaceForumThread(agentId: string, thread: ForumThread): Promise<boolean> {
  if (!agentId) return false;
  const rows = await backend.listJsonl<Record<string, unknown>>(agentId, THREADS_REL);
  let found = false;
  const next = rows.map((row) => {
    const id = str(row.threadId) || str(row.id) || str(row.key);
    if (id === thread.threadId) {
      found = true;
      return withIds({ ...thread }, thread.threadId);
    }
    return row;
  });
  if (!found) return false;
  await backend.writeJsonl(agentId, THREADS_REL, next);
  emitChanged(agentId, 'threads');
  return true;
}

// ── 元信息（bootstrap 幂等标记） ────────────────────────────────────────────────

export async function readForumMeta(agentId: string): Promise<ForumMeta | null> {
  if (!agentId) return null;
  try {
    return await backend.readJson<ForumMeta>(agentId, META_REL);
  } catch {
    return null;
  }
}

export async function markForumInitialized(agentId: string, iso: string): Promise<void> {
  if (!agentId) return;
  const existing = (await readForumMeta(agentId)) ?? {};
  await backend.writeJson<ForumMeta>(agentId, META_REL, { ...existing, initializedAt: iso });
}
