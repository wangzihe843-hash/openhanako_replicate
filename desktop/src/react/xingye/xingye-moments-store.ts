import { useEffect, useState } from 'react';
import type { XingyeStorageBackend } from './xingye-storage-backend';
import {
  createXingyeStore,
  generateXingyeId,
  nowIso,
  requireSafeXingyeAgentId,
  resolveAgentScopedXingyePath,
} from './xingye-store-utils';

export type XingyeMomentPost = {
  id: string;
  authorAgentId: string;
  content: string;
  imageUrls: string[];
  createdAt: string;
  likes: string[];
  comments: {
    id: string;
    authorId: string;
    content: string;
    createdAt: string;
  }[];
};

export const XINGYE_MOMENTS_POSTS_JSONL = 'apps/moments/posts.jsonl';

const XINGYE_MOMENTS_CHANGED_EVENT = 'xingye-moments-changed';

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

function normalizeComment(value: unknown): XingyeMomentPost['comments'][number] | null {
  if (!isRecord(value)) return null;

  const id = normalizeOptionalString(value.id);
  const authorId = normalizeOptionalString(value.authorId);
  const content = normalizeOptionalString(value.content);
  if (!id || !authorId || !content) return null;

  return {
    id,
    authorId,
    content,
    createdAt: normalizeOptionalString(value.createdAt) ?? new Date(0).toISOString(),
  };
}

function normalizePost(value: unknown): XingyeMomentPost | null {
  if (!isRecord(value)) return null;

  const id = normalizeOptionalString(value.id);
  const authorAgentId = normalizeOptionalString(value.authorAgentId);
  const content = normalizeOptionalString(value.content);
  const createdAt = normalizeOptionalString(value.createdAt);
  if (!id || !authorAgentId || !content || !createdAt) return null;

  return {
    id,
    authorAgentId,
    content,
    imageUrls: uniqueStrings(value.imageUrls),
    createdAt,
    likes: uniqueStrings(value.likes),
    comments: Array.isArray(value.comments)
      ? value.comments.map(normalizeComment).filter((comment): comment is XingyeMomentPost['comments'][number] => Boolean(comment))
      : [],
  };
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
      rows.map(normalizePost).filter((post): post is XingyeMomentPost => Boolean(post)),
    );
  }

  async function writePosts(agentId: string, posts: XingyeMomentPost[]): Promise<void> {
    const aid = requireSafeXingyeAgentId(agentId);
    await store.writeJsonl<XingyeMomentPost>(aid, XINGYE_MOMENTS_POSTS_JSONL, posts);
    notifyXingyeMomentsChanged(aid);
  }

  return {
    listPosts,

    async createPost(authorAgentId: string, content: string, imageUrls: unknown = []): Promise<XingyeMomentPost | null> {
      const aid = requireSafeXingyeAgentId(authorAgentId);
      const normalizedContent = content.trim();
      if (!normalizedContent) return null;

      const post: XingyeMomentPost = {
        id: idFactory('moment'),
        authorAgentId: aid,
        content: normalizedContent,
        imageUrls: uniqueStrings(imageUrls),
        createdAt: getNow(),
        likes: [],
        comments: [],
      };
      await store.appendJsonl<XingyeMomentPost>(aid, XINGYE_MOMENTS_POSTS_JSONL, post);
      notifyXingyeMomentsChanged(aid);
      return post;
    },

    async toggleLike(agentId: string, postId: string, authorId: string): Promise<XingyeMomentPost | null> {
      const aid = requireSafeXingyeAgentId(agentId);
      const likerId = normalizeOptionalString(authorId);
      const pid = normalizeOptionalString(postId);
      if (!pid || !likerId) return null;

      const posts = await listPosts(aid);
      const index = posts.findIndex(post => post.id === pid);
      if (index < 0) return null;

      const post = posts[index];
      const liked = post.likes.includes(likerId);
      const nextPost: XingyeMomentPost = {
        ...post,
        likes: liked ? post.likes.filter(id => id !== likerId) : [...post.likes, likerId],
      };
      posts[index] = nextPost;
      await writePosts(aid, posts);
      return nextPost;
    },

    async addComment(agentId: string, postId: string, authorId: string, content: string): Promise<XingyeMomentPost | null> {
      const aid = requireSafeXingyeAgentId(agentId);
      const pid = normalizeOptionalString(postId);
      const commenterId = normalizeOptionalString(authorId);
      const normalizedContent = content.trim();
      if (!pid || !commenterId || !normalizedContent) return null;

      const posts = await listPosts(aid);
      const index = posts.findIndex(post => post.id === pid);
      if (index < 0) return null;

      const post = posts[index];
      const nextPost: XingyeMomentPost = {
        ...post,
        comments: [
          ...post.comments,
          {
            id: idFactory('comment'),
            authorId: commenterId,
            content: normalizedContent,
            createdAt: getNow(),
          },
        ],
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
        .then(nextPosts => {
          if (!cancelled) setPosts(nextPosts);
        })
        .catch(error => {
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
