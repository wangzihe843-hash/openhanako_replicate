import { useEffect, useState } from 'react';
import type { XingyeStorageBackend } from './xingye-storage-backend';
import {
  createXingyeStore,
  generateXingyeId,
  nowIso,
  requireSafeXingyeAgentId,
  resolveAgentScopedXingyePath,
} from './xingye-store-utils';

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
      if (deleted) notifyXingyeMomentsChanged(aid);
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
