import { useMemo } from 'react';
import { useStore } from '../stores';
import type { Agent } from '../types';
import { MomentCard } from './MomentCard';
import { MomentComposer } from './MomentComposer';
import {
  addXingyeMomentComment,
  createXingyeMomentPost,
  deleteXingyeMomentPost,
  toggleXingyeMomentLike,
  type XingyeMomentActor,
} from './xingye-moments-store';
import { useAggregatedXingyeMoments } from './xingye-moments-feed';
import { getXingyeRoleProfileDisplay, useXingyeRoleProfiles } from './xingye-profile-store';
import styles from './XingyeShell.module.css';

interface MomentsPanelProps {
  agents: Agent[];
  currentAgentId: string | null;
  selectedXingyeAgentId: string | null;
}

const USER_ACTOR_ID = 'user';

function resolveUserActorName(storeUserName: string | null | undefined): string {
  const trimmed = typeof storeUserName === 'string' ? storeUserName.trim() : '';
  if (!trimmed || trimmed === 'User' || trimmed === 'user') return '用户';
  return trimmed;
}

export function MomentsPanel({ agents, currentAgentId, selectedXingyeAgentId }: MomentsPanelProps) {
  const profiles = useXingyeRoleProfiles();
  const storeUserName = useStore((state) => state.userName);

  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent] as const)),
    [agents],
  );
  const agentIds = useMemo(() => agents.map((agent) => agent.id), [agents]);

  const composerAgent = useMemo(() => {
    const selected = selectedXingyeAgentId ? agentsById.get(selectedXingyeAgentId) : null;
    if (selected) return selected;
    const current = currentAgentId ? agentsById.get(currentAgentId) : null;
    if (current) return current;
    return agents[0] ?? null;
  }, [agents, agentsById, currentAgentId, selectedXingyeAgentId]);

  const composerDisplay = composerAgent
    ? getXingyeRoleProfileDisplay(composerAgent, profiles[composerAgent.id] ?? null)
    : null;

  const userName = resolveUserActorName(storeUserName);
  const userActor: XingyeMomentActor = useMemo(
    () => ({ actorType: 'user', actorId: USER_ACTOR_ID, actorName: userName }),
    [userName],
  );

  const posts = useAggregatedXingyeMoments(agentIds);

  const getAgentDisplayName = (agentId: string): string => {
    const agent = agentsById.get(agentId);
    if (!agent) return '未知角色';
    return getXingyeRoleProfileDisplay(agent, profiles[agent.id] ?? null).displayName;
  };

  const handleCreate = (content: string) => {
    if (!composerAgent) return;
    const authorName = composerDisplay?.displayName ?? composerAgent.name;
    void createXingyeMomentPost({
      authorAgentId: composerAgent.id,
      authorName,
      content,
      source: { kind: 'manual' },
    });
  };

  const handleToggleLike = (authorAgentId: string, postId: string) => {
    void toggleXingyeMomentLike(authorAgentId, postId, userActor);
  };

  const handleComment = (authorAgentId: string, postId: string, body: string) => {
    void addXingyeMomentComment(authorAgentId, postId, userActor, body);
  };

  const handleDelete = (authorAgentId: string, postId: string) => {
    void deleteXingyeMomentPost(authorAgentId, postId);
  };

  return (
    <div className={styles.momentsPanel}>
      <div className={styles.momentsHeader}>
        <div>
          <p className={styles.eyebrow}>Xingye Moments</p>
          <h2 className={styles.panelTitle}>朋友圈</h2>
          <p className={styles.panelDescription}>
            聚合所有角色的本地动态流，按时间倒序展示；点赞和评论以「{userName}」的身份发送，仅本地保存。
          </p>
        </div>
      </div>

      <MomentComposer agent={composerAgent} display={composerDisplay} onSubmit={handleCreate} />

      <section className={styles.momentFeed} aria-label="朋友圈动态列表">
        {posts.length > 0 ? (
          posts.map((post) => {
            const authorAgent = agentsById.get(post.authorAgentId) ?? null;
            const fallbackName = post.authorName || authorAgent?.name || post.authorAgentId;
            const authorDisplayName = authorAgent
              ? getXingyeRoleProfileDisplay(authorAgent, profiles[authorAgent.id] ?? null).displayName
              : fallbackName;
            const relationshipLabel = authorAgent
              ? getXingyeRoleProfileDisplay(authorAgent, profiles[authorAgent.id] ?? null).relationshipLabel
              : undefined;
            return (
              <MomentCard
                key={post.id}
                authorAgent={authorAgent}
                authorDisplayName={authorDisplayName}
                authorRelationshipLabel={relationshipLabel}
                canDelete={post.authorAgentId === composerAgent?.id}
                getAgentDisplayName={getAgentDisplayName}
                post={post}
                userActor={userActor}
                onComment={(postId, body) => handleComment(post.authorAgentId, postId, body)}
                onDelete={(postId) => handleDelete(post.authorAgentId, postId)}
                onToggleLike={(postId) => handleToggleLike(post.authorAgentId, postId)}
              />
            );
          })
        ) : (
          <div className={styles.momentEmptyState}>还没有朋友圈动态</div>
        )}
      </section>
    </div>
  );
}
