import { useEffect, useState } from 'react';
import {
  XINGYE_MOMENTS_CHANGED_EVENT,
  listXingyeMomentPosts,
  type XingyeMomentPost,
} from './xingye-moments-store';

export type AggregatedXingyeMomentPost = XingyeMomentPost;

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
};

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
    if (Array.isArray(posts)) flat.push(...posts);
  }
  return sortNewestFirst(flat);
}

/**
 * React hook: returns aggregated moments across the given agent ids, newest first.
 * Re-fetches when the agent list changes or any moments file is updated
 * (via 'xingye-moments-changed' / 'xingye-persistence-changed' events).
 */
export function useAggregatedXingyeMoments(agentIds: readonly string[]): XingyeMomentPost[] {
  const idsKey = uniqueTrimmedIds(agentIds).join('');
  const [posts, setPosts] = useState<XingyeMomentPost[]>([]);

  useEffect(() => {
    const ids = idsKey ? idsKey.split('') : [];
    if (!ids.length) {
      setPosts([]);
      return undefined;
    }

    let cancelled = false;
    const refresh = () => {
      void listAggregatedXingyeMoments(ids)
        .then((next) => {
          if (!cancelled) setPosts(next);
        })
        .catch((error) => {
          console.warn('[xingye-moments-feed] failed to load aggregated moments:', error);
          if (!cancelled) setPosts([]);
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
  }, [idsKey]);

  return posts;
}
