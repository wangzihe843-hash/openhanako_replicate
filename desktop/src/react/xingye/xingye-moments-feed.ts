import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  XINGYE_MOMENTS_CHANGED_EVENT,
  listXingyeMomentPosts,
  type XingyeMomentPost,
} from './xingye-moments-store';

export type AggregatedXingyeMomentPost = XingyeMomentPost;

export type UseAggregatedXingyeMomentsResult = {
  posts: XingyeMomentPost[];
  loading: boolean;
  error: string | null;
  retry: () => void;
};

function sortNewestFirst(posts: XingyeMomentPost[]): XingyeMomentPost[] {
  return [...posts].sort((a, b) => {
    const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return diff || b.id.localeCompare(a.id);
  });
}

function uniqueTrimmedIds(agentIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of agentIds) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export type ListAggregatedXingyeMomentsOptions = {
  listForAgent?: (agentId: string) => Promise<XingyeMomentPost[]>;
  onAgentError?: (agentId: string, error: unknown) => void;
  /**
   * 当前查看者 agent id。用于隐藏 `virtual_contact` 类型的点赞 / 评论：
   * - user / agent 互动始终可见；
   * - virtual_contact 互动仅在 viewer === post.authorAgentId 时可见（共同好友规则）。
   * 未传则相当于以「无视角」浏览，所有 virtual_contact 互动一律不可见。
   */
  viewerAgentId?: string | null;
};

function isVirtualContactActor(actor: { actorType?: unknown }): boolean {
  return actor?.actorType === 'virtual_contact';
}

function applyViewerVisibility(
  post: XingyeMomentPost,
  viewerAgentId: string | null,
): XingyeMomentPost {
  const viewerCanSeeVirtualContacts = viewerAgentId === post.authorAgentId;
  if (viewerCanSeeVirtualContacts) return post;
  const filteredLikes = post.likes.filter((like) => !isVirtualContactActor(like));
  const filteredComments = post.comments.filter((comment) => !isVirtualContactActor(comment));
  if (filteredLikes.length === post.likes.length && filteredComments.length === post.comments.length) {
    return post;
  }
  return { ...post, likes: filteredLikes, comments: filteredComments };
}

/**
 * Aggregates moments across agents into a single newest-first feed.
 * Per-agent failures are isolated: if one agent's posts.jsonl is corrupt or
 * the read throws, the other agents' posts are still returned.
 */
export async function listAggregatedXingyeMoments(
  agentIds: readonly string[],
  options: ListAggregatedXingyeMomentsOptions = {},
): Promise<XingyeMomentPost[]> {
  const ids = uniqueTrimmedIds(agentIds);
  if (!ids.length) return [];

  const listForAgent = options.listForAgent ?? listXingyeMomentPosts;
  const onAgentError = options.onAgentError
    ?? ((agentId: string, error: unknown) => {
      console.warn('[xingye-moments-feed] failed to list moments for agent', agentId, error);
    });
  const viewerAgentId = typeof options.viewerAgentId === 'string' && options.viewerAgentId.trim()
    ? options.viewerAgentId.trim()
    : null;

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return await listForAgent(id);
      } catch (error) {
        onAgentError(id, error);
        return [] as XingyeMomentPost[];
      }
    }),
  );

  const flat: XingyeMomentPost[] = [];
  for (const posts of results) {
    if (Array.isArray(posts)) {
      for (const post of posts) flat.push(applyViewerVisibility(post, viewerAgentId));
    }
  }
  return sortNewestFirst(flat);
}

/**
 * React hook: returns aggregated moments across the given agent ids, newest first,
 * plus loading / error / retry state for the UI.
 *
 * Re-fetches when the agent list changes or any moments file is updated
 * (via 'xingye-moments-changed' / 'xingye-persistence-changed' events).
 */
export function useAggregatedXingyeMoments(
  agentIds: readonly string[],
  viewerAgentId: string | null = null,
): UseAggregatedXingyeMomentsResult {
  const ids = useMemo(() => uniqueTrimmedIds(agentIds), [agentIds]);
  const idsKey = ids.join('|');
  const viewerKey = viewerAgentId ?? '';
  const [posts, setPosts] = useState<XingyeMomentPost[]>([]);
  const [loading, setLoading] = useState<boolean>(ids.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const viewerRef = useRef(viewerAgentId);
  viewerRef.current = viewerAgentId;

  const retry = useCallback(() => {
    setReloadCounter((c) => c + 1);
  }, []);

  useEffect(() => {
    const currentIds = idsRef.current;
    if (!currentIds.length) {
      setPosts([]);
      setLoading(false);
      setError(null);
      return undefined;
    }

    let cancelled = false;
    let inFlight = 0;
    const refresh = () => {
      const ticket = ++inFlight;
      setLoading(true);
      void listAggregatedXingyeMoments(idsRef.current, { viewerAgentId: viewerRef.current })
        .then((next) => {
          if (cancelled || ticket !== inFlight) return;
          setPosts(next);
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          console.warn('[xingye-moments-feed] failed to load aggregated moments:', err);
          if (cancelled || ticket !== inFlight) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    };

    refresh();
    if (typeof window === 'undefined') {
      return () => {
        cancelled = true;
      };
    }

    const onMomentsChanged = () => refresh();
    const onPersistence = () => refresh();
    window.addEventListener(XINGYE_MOMENTS_CHANGED_EVENT, onMomentsChanged);
    window.addEventListener('xingye-persistence-changed', onPersistence);
    return () => {
      cancelled = true;
      window.removeEventListener(XINGYE_MOMENTS_CHANGED_EVENT, onMomentsChanged);
      window.removeEventListener('xingye-persistence-changed', onPersistence);
    };
  }, [idsKey, viewerKey, reloadCounter]);

  return { posts, loading, error, retry };
}
