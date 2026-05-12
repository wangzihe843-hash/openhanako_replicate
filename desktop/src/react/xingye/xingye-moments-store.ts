import { useEffect, useState } from 'react';
import { getXingyePersistenceStorage } from './xingye-persistence';

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

export type XingyeMomentPostMap = Record<string, XingyeMomentPost>;

export const XINGYE_MOMENTS_STORAGE_KEY = 'xingye.moments';

const XINGYE_MOMENTS_CHANGED_EVENT = 'xingye-moments-changed';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function getLocalStorage(): StorageLike | null {
  return getXingyePersistenceStorage();
}

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

function normalizePost(value: unknown, fallbackId?: string): XingyeMomentPost | null {
  if (!isRecord(value)) return null;

  const id = normalizeOptionalString(value.id) ?? fallbackId;
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

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function notifyXingyeMomentsChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(XINGYE_MOMENTS_CHANGED_EVENT));
}

function saveMomentMap(posts: XingyeMomentPostMap, storage: StorageLike | null) {
  storage?.setItem(XINGYE_MOMENTS_STORAGE_KEY, JSON.stringify(posts));
  notifyXingyeMomentsChanged();
}

export function loadXingyeMomentPosts(storage: StorageLike | null = getLocalStorage()): XingyeMomentPostMap {
  if (!storage) return {};

  try {
    const raw = storage.getItem(XINGYE_MOMENTS_STORAGE_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const posts: XingyeMomentPostMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      const normalized = normalizePost(value, id);
      if (normalized) posts[normalized.id] = normalized;
    }
    return posts;
  } catch (error) {
    console.warn('[xingye-moments-store] failed to load moments:', error);
    return {};
  }
}

export function listXingyeMomentPosts(storage: StorageLike | null = getLocalStorage()): XingyeMomentPost[] {
  return Object.values(loadXingyeMomentPosts(storage)).sort((a, b) => {
    const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return timeDiff || b.id.localeCompare(a.id);
  });
}

export function createXingyeMomentPost(
  authorAgentId: string,
  content: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyeMomentPost | null {
  const normalizedContent = content.trim();
  if (!authorAgentId || !normalizedContent) return null;

  const posts = loadXingyeMomentPosts(storage);
  const post: XingyeMomentPost = {
    id: createId('moment'),
    authorAgentId,
    content: normalizedContent,
    imageUrls: [],
    createdAt: new Date().toISOString(),
    likes: [],
    comments: [],
  };
  posts[post.id] = post;
  saveMomentMap(posts, storage);
  return post;
}

export function toggleXingyeMomentLike(
  postId: string,
  authorId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyeMomentPost | null {
  const posts = loadXingyeMomentPosts(storage);
  const post = posts[postId];
  if (!post || !authorId) return null;

  const liked = post.likes.includes(authorId);
  const nextPost: XingyeMomentPost = {
    ...post,
    likes: liked ? post.likes.filter(id => id !== authorId) : [...post.likes, authorId],
  };
  posts[postId] = nextPost;
  saveMomentMap(posts, storage);
  return nextPost;
}

export function addXingyeMomentComment(
  postId: string,
  authorId: string,
  content: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyeMomentPost | null {
  const normalizedContent = content.trim();
  const posts = loadXingyeMomentPosts(storage);
  const post = posts[postId];
  if (!post || !authorId || !normalizedContent) return null;

  const nextPost: XingyeMomentPost = {
    ...post,
    comments: [
      ...post.comments,
      {
        id: createId('comment'),
        authorId,
        content: normalizedContent,
        createdAt: new Date().toISOString(),
      },
    ],
  };
  posts[postId] = nextPost;
  saveMomentMap(posts, storage);
  return nextPost;
}

export function deleteXingyeMomentPost(
  postId: string,
  storage: StorageLike | null = getLocalStorage(),
): boolean {
  const posts = loadXingyeMomentPosts(storage);
  if (!posts[postId]) return false;

  delete posts[postId];
  saveMomentMap(posts, storage);
  return true;
}

export function useXingyeMomentPosts(): XingyeMomentPost[] {
  const [posts, setPosts] = useState<XingyeMomentPost[]>(() => listXingyeMomentPosts());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const refresh = () => setPosts(listXingyeMomentPosts());
    const refreshFromStorage = (event: StorageEvent) => {
      if (event.key === XINGYE_MOMENTS_STORAGE_KEY) refresh();
    };

    const onPersistence = () => refresh();
    window.addEventListener(XINGYE_MOMENTS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refreshFromStorage);
    window.addEventListener('xingye-persistence-changed', onPersistence);
    return () => {
      window.removeEventListener(XINGYE_MOMENTS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refreshFromStorage);
      window.removeEventListener('xingye-persistence-changed', onPersistence);
    };
  }, []);

  return posts;
}
