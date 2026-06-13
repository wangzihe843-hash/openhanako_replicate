/**
 * xingye-cp-store.ts — 「你和 TA 的 CP」板块的 agent 维度持久化。
 *
 * 复用 createAgentXingyeStorageBackend。文件布局（挂在论坛目录下的 cp 子目录）：
 *   secret-space/forum/cp/posts.jsonl    帖子（评论 / 嵌套回复内嵌）
 *   secret-space/forum/cp/drafts.jsonl   草稿（想发没发的内容）
 *   secret-space/forum/cp/meta.json      { initializedAt, watermark, followed, followReaction, alt }
 *
 * 持久化不变量（与 domain_xingye_persistence_invariants 一致）：
 *  - 每行带 key/id/recordId = 实体 id，便于 deleteJsonlRecord 与服务端匹配。
 *  - replace/delete 走 read-modify-write；读失败（list 抛错）直接抛，**绝不**接着写空表覆写。
 *  - 找不到目标记录时是 no-op（return false），不写文件。
 *  - 追加/变更后派发 `xingye-cp-changed`，让打开中的 CP 板自动刷新。
 */

import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import type { CpDraft, CpMeta, CpPost } from './xingye-cp-types';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

const DIR = 'secret-space/forum/cp';
const POSTS_REL = `${DIR}/posts.jsonl`;
const DRAFTS_REL = `${DIR}/drafts.jsonl`;
const META_REL = `${DIR}/meta.json`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export type CpChangedKind = 'posts' | 'drafts' | 'meta';

function emitChanged(agentId: string, kind: CpChangedKind): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('xingye-cp-changed', { detail: { agentId, kind } }));
}

function withIds<T extends Record<string, unknown>>(entity: T, id: string): T & { key: string; id: string; recordId: string } {
  return { ...entity, key: id, id, recordId: id };
}

// ── 帖子 ────────────────────────────────────────────────────────────────────

function normalizePost(value: unknown): CpPost | null {
  if (!isRecord(value)) return null;
  const postId = str(value.postId) || str(value.id) || str(value.key);
  const title = str(value.title);
  const body = str(value.body);
  if (!postId || !title || !body) return null;
  const stats = isRecord(value.stats) ? value.stats : {};
  const genre = value.genre === 'fic' || value.genre === 'analysis' || value.genre === 'squee' ? value.genre : 'discuss';
  const origin = value.origin === 'agent' ? 'agent' : 'npc';
  const comments = Array.isArray(value.comments)
    ? value.comments.filter(isRecord).map((c) => ({
        commentId: str(c.commentId) || str(c.id),
        authorName: str(c.authorName) || '匿名同好',
        authorIsAgent: c.authorIsAgent === true,
        body: str(c.body),
        likes: num(c.likes),
        postedAt: str(c.postedAt) || new Date(0).toISOString(),
        replies: Array.isArray(c.replies)
          ? c.replies.filter(isRecord).map((r) => ({
              replyId: str(r.replyId) || str(r.id),
              authorName: str(r.authorName) || '匿名同好',
              authorIsAgent: r.authorIsAgent === true,
              ...(str(r.toName) ? { toName: str(r.toName) } : {}),
              body: str(r.body),
              likes: num(r.likes),
              postedAt: str(r.postedAt) || new Date(0).toISOString(),
            }))
          : [],
      }))
    : [];
  return {
    postId,
    origin,
    genre,
    board: str(value.board) || 'CP 同好',
    title,
    body,
    authorName: str(value.authorName) || '匿名同好',
    authorIsAgent: value.authorIsAgent === true,
    postedAt: str(value.postedAt) || new Date(0).toISOString(),
    stats: { views: num(stats.views), likes: num(stats.likes) },
    comments,
    createdAt: str(value.createdAt) || new Date(0).toISOString(),
  };
}

/** 返回全部帖子，按 postedAt 倒序（最新在前）。 */
export async function listCpPosts(agentId: string): Promise<CpPost[]> {
  if (!agentId) return [];
  try {
    const rows = await backend.listJsonl<Record<string, unknown>>(agentId, POSTS_REL);
    return rows
      .map(normalizePost)
      .filter((p): p is CpPost => Boolean(p))
      .sort((a, b) => Date.parse(b.postedAt || '0') - Date.parse(a.postedAt || '0'));
  } catch {
    return [];
  }
}

export async function appendCpPosts(agentId: string, posts: CpPost[]): Promise<void> {
  if (!agentId || !posts.length) return;
  for (const post of posts) {
    await backend.appendJsonl(agentId, POSTS_REL, withIds({ ...post }, post.postId));
  }
  emitChanged(agentId, 'posts');
}

/** 整体替换同 postId 的行（如「替 TA 发送」reply 草稿后给目标帖追加评论）。找不到则 no-op 返回 false。 */
export async function replaceCpPost(agentId: string, post: CpPost): Promise<boolean> {
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

// ── 草稿 ────────────────────────────────────────────────────────────────────

function normalizeDraft(value: unknown): CpDraft | null {
  if (!isRecord(value)) return null;
  const draftId = str(value.draftId) || str(value.id) || str(value.key);
  const body = str(value.body);
  if (!draftId || !body) return null;
  const kind = value.kind === 'post' ? 'post' : 'reply';
  const genre =
    value.genre === 'fic' || value.genre === 'analysis' || value.genre === 'squee' || value.genre === 'discuss'
      ? value.genre
      : undefined;
  return {
    draftId,
    kind,
    ...(kind === 'post' && genre ? { genre } : {}),
    ...(kind === 'post' && str(value.board) ? { board: str(value.board) } : {}),
    ...(kind === 'post' && str(value.title) ? { title: str(value.title) } : {}),
    body,
    ...(kind === 'reply' && str(value.targetPostId) ? { targetPostId: str(value.targetPostId) } : {}),
    ...(kind === 'reply' && str(value.targetPostTitle) ? { targetPostTitle: str(value.targetPostTitle) } : {}),
    sendReaction: str(value.sendReaction) || '……你怎么连这个都翻出来了。',
    hesitation: str(value.hesitation) || '写是写了，但没敢点发送。',
    createdAt: str(value.createdAt) || new Date(0).toISOString(),
  };
}

/** 返回全部草稿，按 createdAt 倒序（最新在前）。 */
export async function listCpDrafts(agentId: string): Promise<CpDraft[]> {
  if (!agentId) return [];
  try {
    const rows = await backend.listJsonl<Record<string, unknown>>(agentId, DRAFTS_REL);
    return rows
      .map(normalizeDraft)
      .filter((d): d is CpDraft => Boolean(d))
      .sort((a, b) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'));
  } catch {
    return [];
  }
}

export async function appendCpDrafts(agentId: string, drafts: CpDraft[]): Promise<void> {
  if (!agentId || !drafts.length) return;
  for (const draft of drafts) {
    await backend.appendJsonl(agentId, DRAFTS_REL, withIds({ ...draft }, draft.draftId));
  }
  emitChanged(agentId, 'drafts');
}

export async function deleteCpDraft(agentId: string, draftId: string): Promise<boolean> {
  if (!agentId || !draftId) return false;
  const ok = await backend.deleteJsonlRecord(agentId, DRAFTS_REL, draftId);
  if (ok) emitChanged(agentId, 'drafts');
  return ok;
}

// ── 元信息（水位线 / 关注 / CP 马甲身份） ──────────────────────────────────────

function normalizeMeta(value: unknown): CpMeta {
  if (!isRecord(value)) return {};
  const alt = isRecord(value.alt) ? value.alt : null;
  return {
    ...(str(value.initializedAt) ? { initializedAt: str(value.initializedAt) } : {}),
    ...(str(value.cpName) ? { cpName: str(value.cpName) } : {}),
    ...(str(value.watermark) ? { watermark: str(value.watermark) } : {}),
    ...(value.followed === true ? { followed: true } : {}),
    ...(str(value.followReaction) ? { followReaction: str(value.followReaction) } : {}),
    ...(alt && str(alt.accountId) && str(alt.username)
      ? {
          alt: {
            accountId: str(alt.accountId),
            username: str(alt.username),
            bio: str(alt.bio),
            themeLabel: str(alt.themeLabel) || '潜水',
            avatarSeed: str(alt.avatarSeed) || str(alt.username),
            fromForum: alt.fromForum === true,
          },
        }
      : {}),
  };
}

export async function readCpMeta(agentId: string): Promise<CpMeta | null> {
  if (!agentId) return null;
  try {
    const raw = await backend.readJson<unknown>(agentId, META_REL);
    if (raw == null) return null;
    return normalizeMeta(raw);
  } catch {
    return null;
  }
}

/** 合并写 meta（读失败按空对象兜底——meta 是单 json，缺失即视为初始态，与 jsonl 不同不抛）。 */
export async function writeCpMeta(agentId: string, patch: Partial<CpMeta>): Promise<void> {
  if (!agentId) return;
  const existing = (await readCpMeta(agentId)) ?? {};
  await backend.writeJson<CpMeta>(agentId, META_REL, { ...existing, ...patch });
  emitChanged(agentId, 'meta');
}

export async function markCpInitialized(agentId: string, iso: string): Promise<void> {
  if (!agentId) return;
  const existing = (await readCpMeta(agentId)) ?? {};
  if (existing.initializedAt) return;
  await writeCpMeta(agentId, { initializedAt: iso });
}
