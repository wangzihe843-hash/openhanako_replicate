import { useEffect, useState } from 'react';
import type { XingyeStorageBackend } from './xingye-storage-backend';
import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import {
  createXingyeStore,
  generateXingyeId,
  nowIso,
  requireSafeXingyeAgentId,
  resolveAgentScopedXingyePath,
} from './xingye-store-utils';

async function appendMomentEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-moments-store] event log append failed:', error);
  }
}

export type XingyeMomentActorType = 'user' | 'agent' | 'virtual_contact';

export type XingyeMomentActor = {
  actorType: XingyeMomentActorType;
  actorId: string;
  actorName: string;
};

export type XingyeMomentLike = {
  id: string;
  actorType: XingyeMomentActorType;
  actorId: string;
  actorName: string;
  createdAt: string;
};

export type XingyeMomentComment = {
  id: string;
  actorType: XingyeMomentActorType;
  actorId: string;
  actorName: string;
  body: string;
  createdAt: string;
};

export type XingyeMomentPostSource = {
  kind?: 'manual' | 'candidate' | 'chat_related';
  recentChatIds?: string[];
  eventIds?: string[];
};

export type XingyeMomentPost = {
  id: string;
  authorAgentId: string;
  authorName: string;
  content: string;
  imageUrls: string[];
  createdAt: string;
  updatedAt: string;
  likes: XingyeMomentLike[];
  comments: XingyeMomentComment[];
  source?: XingyeMomentPostSource;
};

export const XINGYE_MOMENTS_POSTS_JSONL = 'apps/moments/posts.jsonl';

const XINGYE_MOMENTS_CHANGED_EVENT = 'xingye-moments-changed';

const EPOCH_ISO = new Date(0).toISOString();

type XingyeMomentStoreOptions = {
  idFactory?: (prefix: string) => string;
  now?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const text = normalizeOptionalString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

function normalizeActorType(value: unknown): XingyeMomentActorType {
  if (value === 'user') return 'user';
  if (value === 'virtual_contact') return 'virtual_contact';
  return 'agent';
}

function normalizeLike(value: unknown, idFactory: (prefix: string) => string): XingyeMomentLike | null {
  if (typeof value === 'string') {
    const actorId = value.trim();
    if (!actorId) return null;
    return {
      id: idFactory('like'),
      actorType: 'agent',
      actorId,
      actorName: actorId,
      createdAt: EPOCH_ISO,
    };
  }

  if (!isRecord(value)) return null;
  const actorId = normalizeOptionalString(value.actorId) ?? normalizeOptionalString(value.authorId);
  if (!actorId) return null;
  return {
    id: normalizeOptionalString(value.id) ?? idFactory('like'),
    actorType: normalizeActorType(value.actorType),
    actorId,
    actorName: normalizeOptionalString(value.actorName) ?? actorId,
    createdAt: normalizeOptionalString(value.createdAt) ?? EPOCH_ISO,
  };
}

function normalizeComment(value: unknown, idFactory: (prefix: string) => string): XingyeMomentComment | null {
  if (!isRecord(value)) return null;

  const actorId = normalizeOptionalString(value.actorId) ?? normalizeOptionalString(value.authorId);
  const body = normalizeOptionalString(value.body) ?? normalizeOptionalString(value.content);
  if (!actorId || !body) return null;

  return {
    id: normalizeOptionalString(value.id) ?? idFactory('comment'),
    actorType: normalizeActorType(value.actorType),
    actorId,
    actorName: normalizeOptionalString(value.actorName) ?? actorId,
    body,
    createdAt: normalizeOptionalString(value.createdAt) ?? EPOCH_ISO,
  };
}

function normalizeSource(value: unknown): XingyeMomentPostSource | undefined {
  if (!isRecord(value)) return undefined;
  const source: XingyeMomentPostSource = {};
  const kind = normalizeOptionalString(value.kind);
  if (kind === 'manual' || kind === 'candidate' || kind === 'chat_related') {
    source.kind = kind;
  }
  const recentChatIds = uniqueStrings(value.recentChatIds);
  if (recentChatIds.length) source.recentChatIds = recentChatIds;
  const eventIds = uniqueStrings(value.eventIds);
  if (eventIds.length) source.eventIds = eventIds;
  return Object.keys(source).length ? source : undefined;
}

function dedupeLikes(likes: XingyeMomentLike[]): XingyeMomentLike[] {
  const seen = new Set<string>();
  const out: XingyeMomentLike[] = [];
  for (const like of likes) {
    const key = `${like.actorType}:${like.actorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(like);
  }
  return out;
}

function normalizePost(value: unknown, idFactory: (prefix: string) => string): XingyeMomentPost | null {
  if (!isRecord(value)) return null;

  const id = normalizeOptionalString(value.id);
  const authorAgentId = normalizeOptionalString(value.authorAgentId);
  const content = normalizeOptionalString(value.content);
  const createdAt = normalizeOptionalString(value.createdAt);
  if (!id || !authorAgentId || !content || !createdAt) return null;

  const likes = Array.isArray(value.likes)
    ? dedupeLikes(
        value.likes
          .map((v) => normalizeLike(v, idFactory))
          .filter((l): l is XingyeMomentLike => Boolean(l)),
      )
    : [];

  const comments = Array.isArray(value.comments)
    ? value.comments
        .map((v) => normalizeComment(v, idFactory))
        .filter((c): c is XingyeMomentComment => Boolean(c))
    : [];

  const post: XingyeMomentPost = {
    id,
    authorAgentId,
    authorName: normalizeOptionalString(value.authorName) ?? authorAgentId,
    content,
    imageUrls: uniqueStrings(value.imageUrls),
    createdAt,
    updatedAt: normalizeOptionalString(value.updatedAt) ?? createdAt,
    likes,
    comments,
  };

  const source = normalizeSource(value.source);
  if (source) post.source = source;

  return post;
}

function sortMomentPosts(posts: XingyeMomentPost[]): XingyeMomentPost[] {
  return [...posts].sort((a, b) => {
    const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return timeDiff || b.id.localeCompare(a.id);
  });
}

function notifyXingyeMomentsChanged(agentId: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(XINGYE_MOMENTS_CHANGED_EVENT, { detail: { agentId } }));
}

export function resolveMomentsPostsScopedPath(agentId: string) {
  return resolveAgentScopedXingyePath(agentId, XINGYE_MOMENTS_POSTS_JSONL);
}

export type XingyeMomentSeedLike = {
  actorType: XingyeMomentActorType;
  actorId: string;
  actorName: string;
  createdAt?: string;
};

export type XingyeMomentSeedComment = {
  actorType: XingyeMomentActorType;
  actorId: string;
  actorName: string;
  body: string;
  createdAt?: string;
};

export type CreateXingyeMomentPostInput = {
  authorAgentId: string;
  authorName: string;
  content: string;
  imageUrls?: unknown;
  source?: XingyeMomentPostSource;
  /**
   * 朋友圈生成时一并写入的初始点赞 / 评论种子（virtual_contact / 其他 agent）。
   * 不影响后续 user / agent 的 toggleLike / addComment 行为。
   */
  seedLikes?: ReadonlyArray<XingyeMomentSeedLike>;
  seedComments?: ReadonlyArray<XingyeMomentSeedComment>;
};

export function createXingyeMomentStore(
  backend?: XingyeStorageBackend,
  options: XingyeMomentStoreOptions = {},
) {
  const store = createXingyeStore(backend);
  const idFactory = options.idFactory ?? ((prefix: string) => generateXingyeId(prefix));
  const getNow = options.now ?? nowIso;

  async function listPosts(agentId: string): Promise<XingyeMomentPost[]> {
    const aid = requireSafeXingyeAgentId(agentId);
    const rows = await store.listJsonl<unknown>(aid, XINGYE_MOMENTS_POSTS_JSONL);
    return sortMomentPosts(
      rows
        .map((row) => normalizePost(row, idFactory))
        .filter((post): post is XingyeMomentPost => Boolean(post)),
    );
  }

  async function writePosts(agentId: string, posts: XingyeMomentPost[]): Promise<void> {
    const aid = requireSafeXingyeAgentId(agentId);
    await store.writeJsonl<XingyeMomentPost>(aid, XINGYE_MOMENTS_POSTS_JSONL, posts);
    notifyXingyeMomentsChanged(aid);
  }

  function normalizeActor(actor: XingyeMomentActor): XingyeMomentActor | null {
    const actorId = normalizeOptionalString(actor?.actorId);
    const actorName = normalizeOptionalString(actor?.actorName);
    if (!actorId || !actorName) return null;
    return {
      actorType: normalizeActorType(actor.actorType),
      actorId,
      actorName,
    };
  }

  return {
    listPosts,

    async createPost(input: CreateXingyeMomentPostInput): Promise<XingyeMomentPost | null> {
      const aid = requireSafeXingyeAgentId(input.authorAgentId);
      const normalizedContent = input.content.trim();
      const authorName = normalizeOptionalString(input.authorName) ?? aid;
      if (!normalizedContent) return null;

      const now = getNow();
      const seedLikes = dedupeLikes(
        (input.seedLikes ?? [])
          .map((seed) => {
            const normalizedActor = normalizeActor(seed);
            if (!normalizedActor) return null;
            const like: XingyeMomentLike = {
              id: idFactory('like'),
              actorType: normalizedActor.actorType,
              actorId: normalizedActor.actorId,
              actorName: normalizedActor.actorName,
              createdAt: normalizeOptionalString(seed.createdAt) ?? now,
            };
            return like;
          })
          .filter((like): like is XingyeMomentLike => Boolean(like)),
      );
      const seedComments: XingyeMomentComment[] = (input.seedComments ?? [])
        .map((seed) => {
          const normalizedActor = normalizeActor(seed);
          const body = normalizeOptionalString(seed.body);
          if (!normalizedActor || !body) return null;
          const comment: XingyeMomentComment = {
            id: idFactory('comment'),
            actorType: normalizedActor.actorType,
            actorId: normalizedActor.actorId,
            actorName: normalizedActor.actorName,
            body,
            createdAt: normalizeOptionalString(seed.createdAt) ?? now,
          };
          return comment;
        })
        .filter((comment): comment is XingyeMomentComment => Boolean(comment));

      const post: XingyeMomentPost = {
        id: idFactory('moment'),
        authorAgentId: aid,
        authorName,
        content: normalizedContent,
        imageUrls: uniqueStrings(input.imageUrls),
        createdAt: now,
        updatedAt: now,
        likes: seedLikes,
        comments: seedComments,
      };
      if (input.source) {
        const source = normalizeSource(input.source);
        if (source) post.source = source;
      }
      await store.appendJsonl<XingyeMomentPost>(aid, XINGYE_MOMENTS_POSTS_JSONL, post);
      notifyXingyeMomentsChanged(aid);
      await appendMomentEventBestEffort(aid, {
        type: 'moment.created',
        source: 'xingye-moments-store',
        subjectId: post.id,
        payload: {
          postId: post.id,
          authorAgentId: post.authorAgentId,
          hasImages: post.imageUrls.length > 0,
          imageCount: post.imageUrls.length,
          sourceKind: post.source?.kind,
          seedLikeCount: post.likes.length,
          seedCommentCount: post.comments.length,
        },
      });
      return post;
    },

    async toggleLike(
      agentId: string,
      postId: string,
      actor: XingyeMomentActor,
    ): Promise<XingyeMomentPost | null> {
      const aid = requireSafeXingyeAgentId(agentId);
      const normalizedActor = normalizeActor(actor);
      const pid = normalizeOptionalString(postId);
      if (!pid || !normalizedActor) return null;

      const posts = await listPosts(aid);
      const index = posts.findIndex((post) => post.id === pid);
      if (index < 0) return null;

      const post = posts[index];
      const existingIndex = post.likes.findIndex(
        (like) => like.actorType === normalizedActor.actorType && like.actorId === normalizedActor.actorId,
      );

      const now = getNow();
      const nextLikes = existingIndex >= 0
        ? post.likes.filter((_, i) => i !== existingIndex)
        : [
            ...post.likes,
            {
              id: idFactory('like'),
              actorType: normalizedActor.actorType,
              actorId: normalizedActor.actorId,
              actorName: normalizedActor.actorName,
              createdAt: now,
            } satisfies XingyeMomentLike,
          ];

      const nextPost: XingyeMomentPost = {
        ...post,
        likes: nextLikes,
        updatedAt: now,
      };
      posts[index] = nextPost;
      await writePosts(aid, posts);
      return nextPost;
    },

    async addComment(
      agentId: string,
      postId: string,
      actor: XingyeMomentActor,
      body: string,
    ): Promise<XingyeMomentPost | null> {
      const aid = requireSafeXingyeAgentId(agentId);
      const pid = normalizeOptionalString(postId);
      const normalizedActor = normalizeActor(actor);
      const normalizedBody = body.trim();
      if (!pid || !normalizedActor || !normalizedBody) return null;

      const posts = await listPosts(aid);
      const index = posts.findIndex((post) => post.id === pid);
      if (index < 0) return null;

      const now = getNow();
      const post = posts[index];
      const nextPost: XingyeMomentPost = {
        ...post,
        comments: [
          ...post.comments,
          {
            id: idFactory('comment'),
            actorType: normalizedActor.actorType,
            actorId: normalizedActor.actorId,
            actorName: normalizedActor.actorName,
            body: normalizedBody,
            createdAt: now,
          },
        ],
        updatedAt: now,
      };
      posts[index] = nextPost;
      await writePosts(aid, posts);
      return nextPost;
    },

    async deletePost(agentId: string, postId: string): Promise<boolean> {
      const aid = requireSafeXingyeAgentId(agentId);
      const pid = normalizeOptionalString(postId);
      if (!pid) return false;

      const deleted = await store.deleteJsonlRecord(aid, XINGYE_MOMENTS_POSTS_JSONL, pid);
      if (deleted) {
        notifyXingyeMomentsChanged(aid);
        await appendMomentEventBestEffort(aid, {
          type: 'moment.deleted',
          source: 'xingye-moments-store',
          subjectId: pid,
          payload: { postId: pid },
        });
      }
      return deleted;
    },
  };
}

const defaultMomentStore = createXingyeMomentStore();

export const listXingyeMomentPosts = defaultMomentStore.listPosts;
export const createXingyeMomentPost = defaultMomentStore.createPost;
export const toggleXingyeMomentLike = defaultMomentStore.toggleLike;
export const addXingyeMomentComment = defaultMomentStore.addComment;
export const deleteXingyeMomentPost = defaultMomentStore.deletePost;

export function useXingyeMomentPosts(agentId: string | null | undefined): XingyeMomentPost[] {
  const [posts, setPosts] = useState<XingyeMomentPost[]>([]);

  useEffect(() => {
    const aid = agentId?.trim();
    if (!aid) {
      setPosts([]);
      return undefined;
    }

    let cancelled = false;
    const refresh = () => {
      void listXingyeMomentPosts(aid)
        .then((nextPosts) => {
          if (!cancelled) setPosts(nextPosts);
        })
        .catch((error) => {
          console.warn('[xingye-moments-store] failed to load moments:', error);
          if (!cancelled) setPosts([]);
        });
    };

    refresh();
    if (typeof window === 'undefined') return () => {
      cancelled = true;
    };

    const onMomentsChanged = (event: Event) => {
      const changedAgentId = (event as CustomEvent<{ agentId?: string }>).detail?.agentId;
      if (!changedAgentId || changedAgentId === aid) refresh();
    };
    const onPersistence = () => refresh();
    window.addEventListener(XINGYE_MOMENTS_CHANGED_EVENT, onMomentsChanged);
    window.addEventListener('xingye-persistence-changed', onPersistence);
    return () => {
      cancelled = true;
      window.removeEventListener(XINGYE_MOMENTS_CHANGED_EVENT, onMomentsChanged);
      window.removeEventListener('xingye-persistence-changed', onPersistence);
    };
  }, [agentId]);

  return posts;
}

export { XINGYE_MOMENTS_CHANGED_EVENT };

// ─────────────────────────────────────────────────────────────────────────
//  Pending moment drafts (heartbeat-proposed, awaiting user confirmation)
// ─────────────────────────────────────────────────────────────────────────

/**
 * 心跳巡检（或其他自动来源）产出的「待确认朋友圈草稿」存放路径，与 posts 同目录、分文件。
 * 同 journal/schedule：posts.jsonl 是「已生成」列表；drafts.jsonl 是 agent 提议、用户未确认的候选。
 *
 * 注意：草稿层只承诺 `content`，不带 likes/comments/imageUrls；互动者依赖通讯录与 peer roster，
 * 在巡检上下文里很难稳定填对——保留给用户在 MomentComposer 用「AI 生成」路径现拉。
 */
export const XINGYE_MOMENT_DRAFTS_JSONL = 'apps/moments/drafts.jsonl';

const SAFE_MOMENT_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const draftsBackend = createAgentXingyeStorageBackend(postXingyeStorage);

export type XingyePendingMomentDraft = {
  id: string;
  content: string;
  /** 为什么提议这条草稿（展示给用户帮助决定是否确认）。 */
  reason?: string;
  /** Producer 标识，例：'xingye-heartbeat-tool'。 */
  source: string;
  /** 触发本草稿的 xingye event id 列表（可空，用于追溯）。 */
  sourceEventIds?: string[];
  createdAt: string;
};

function normalizeMomentDraftRow(value: unknown): XingyePendingMomentDraft | null {
  if (!isRecord(value)) return null;
  const id = normalizeOptionalString(value.id);
  const content = normalizeOptionalString(value.content);
  if (!id || !content) return null;
  const createdAt = normalizeOptionalString(value.createdAt) ?? new Date(0).toISOString();
  const source = normalizeOptionalString(value.source) ?? 'unknown';
  const reason = normalizeOptionalString(value.reason);
  const eventIdsRaw = value.sourceEventIds;
  const sourceEventIds = Array.isArray(eventIdsRaw)
    ? eventIdsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  return { id, content, createdAt, reason, source, sourceEventIds };
}

function sortMomentDrafts(a: XingyePendingMomentDraft, b: XingyePendingMomentDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function newMomentDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function clampMomentDraftContent(s: string, maxCodePoints: number): string {
  const t = s.trim();
  const chars = [...t];
  if (chars.length <= maxCodePoints) return t;
  return `${chars.slice(0, maxCodePoints).join('')}…`;
}

const MOMENT_DRAFT_CONTENT_MAX = 280;

export async function listMomentDrafts(agentId: string): Promise<XingyePendingMomentDraft[]> {
  const aid = agentId.trim();
  if (!aid) return [];
  try {
    const rows = await draftsBackend.listJsonl<unknown>(aid, XINGYE_MOMENT_DRAFTS_JSONL);
    return rows
      .map(normalizeMomentDraftRow)
      .filter((d): d is XingyePendingMomentDraft => Boolean(d))
      .sort(sortMomentDrafts);
  } catch {
    return [];
  }
}

export async function appendMomentDraft(
  agentId: string,
  input: { content: string; reason?: string; source: string; sourceEventIds?: string[] },
): Promise<XingyePendingMomentDraft> {
  const aid = agentId.trim();
  if (!aid) throw new Error('保存草稿失败：缺少 agentId。');
  if (!SAFE_MOMENT_AGENT_ID_RE.test(aid)) {
    throw new Error('保存草稿失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  const content = clampMomentDraftContent(input.content, MOMENT_DRAFT_CONTENT_MAX);
  if (!content) throw new Error('草稿正文不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const reason = normalizeOptionalString(input.reason);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newMomentDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingMomentDraft & { key: string } = {
    id, key: id, content, createdAt, reason, source, sourceEventIds,
  };
  await draftsBackend.appendJsonl(aid, XINGYE_MOMENT_DRAFTS_JSONL, row);
  await appendMomentEventBestEffort(aid, {
    type: 'moment.draft_proposed',
    source,
    subjectId: id,
    payload: { draftId: id, contentExcerpt: content.slice(0, 60), reason: reason ?? null, sourceEventIds: sourceEventIds ?? [] },
  });
  return { id, content, createdAt, reason, source, sourceEventIds };
}

export async function discardMomentDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = agentId.trim();
  const did = draftId.trim();
  if (!aid) throw new Error('丢弃草稿失败：缺少 agentId。');
  if (!SAFE_MOMENT_AGENT_ID_RE.test(aid)) {
    throw new Error('丢弃草稿失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await draftsBackend.deleteJsonlRecord(aid, XINGYE_MOMENT_DRAFTS_JSONL, did);
  if (deleted) {
    await appendMomentEventBestEffort(aid, {
      type: 'moment.draft_discarded',
      source: 'xingye-moments-store',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/**
 * 用户在「待确认草稿」区点「确认生成」/「确认并生成互动」时调用：通过
 * createXingyeMomentPost 把 draft.content 写成 post（自动发 moment.created），
 * 再从 drafts 删掉，最后发 draft_confirmed。post 写入失败时保留 draft 不重复写。
 *
 * opts:
 *  - content：用户在 UI 行内编辑后的最终正文（缺省 → 用 draft.content）
 *  - seedLikes / seedComments：可选，用于「确认并 AI 生成互动」流程——调用方先
 *    跑一次 generateXingyeMomentDraftWithAI({ existingContent }) 拿到 seeds，
 *    再连同 content 一起传进来。本函数不做 AI 调用，纯落盘。
 */
export async function confirmMomentDraft(
  agentId: string,
  draftId: string,
  opts?: {
    content?: string;
    seedLikes?: ReadonlyArray<XingyeMomentSeedLike>;
    seedComments?: ReadonlyArray<XingyeMomentSeedComment>;
  },
): Promise<XingyeMomentPost> {
  const aid = agentId.trim();
  const did = draftId.trim();
  if (!aid) throw new Error('确认草稿失败：缺少 agentId。');
  if (!SAFE_MOMENT_AGENT_ID_RE.test(aid)) {
    throw new Error('确认草稿失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  const draft = (await listMomentDrafts(aid)).find((d) => d.id === did);
  if (!draft) throw new Error('确认草稿失败：草稿不存在或已被丢弃。');

  const content = (opts?.content ?? draft.content).trim();
  if (!content) throw new Error('确认草稿失败：正文不能为空。');

  const post = await createXingyeMomentPost({
    authorAgentId: aid,
    authorName: aid,
    content,
    seedLikes: opts?.seedLikes,
    seedComments: opts?.seedComments,
    source: { kind: 'candidate' },
  });
  if (!post) throw new Error('确认草稿失败：写入朋友圈失败。');
  try {
    await draftsBackend.deleteJsonlRecord(aid, XINGYE_MOMENT_DRAFTS_JSONL, did);
  } catch (error) {
    console.warn('[xingye-moments-store] confirm draft: failed to delete draft after post create:', error);
  }
  await appendMomentEventBestEffort(aid, {
    type: 'moment.draft_confirmed',
    source: 'xingye-moments-store',
    subjectId: did,
    payload: { draftId: did, postId: post.id },
  });
  return post;
}
