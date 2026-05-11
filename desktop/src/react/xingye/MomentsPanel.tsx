import { useMemo } from 'react';
import type { Agent } from '../types';
import { MomentCard } from './MomentCard';
import { MomentComposer } from './MomentComposer';
import {
  addXingyeMomentComment,
  createXingyeMomentPost,
  deleteXingyeMomentPost,
  toggleXingyeMomentLike,
  useXingyeMomentPosts,
} from './xingye-moments-store';
import { getXingyeRoleProfileDisplay, useXingyeRoleProfiles } from './xingye-profile-store';
import styles from './XingyeShell.module.css';

interface MomentsPanelProps {
  agents: Agent[];
  currentAgentId: string | null;
  selectedXingyeAgentId: string | null;
}

export function MomentsPanel({ agents, currentAgentId, selectedXingyeAgentId }: MomentsPanelProps) {
  const posts = useXingyeMomentPosts();
  const profiles = useXingyeRoleProfiles();
  const agentsById = useMemo(
    () => new Map(agents.map(agent => [agent.id, agent] as const)),
    [agents],
  );

  const actorAgent = useMemo(() => {
    const selectedAgent = selectedXingyeAgentId ? agentsById.get(selectedXingyeAgentId) : null;
    if (selectedAgent) return selectedAgent;

    const currentAgent = currentAgentId ? agentsById.get(currentAgentId) : null;
    if (currentAgent) return currentAgent;

    return agents[0] ?? null;
  }, [agents, agentsById, currentAgentId, selectedXingyeAgentId]);

  const actorDisplay = actorAgent
    ? getXingyeRoleProfileDisplay(actorAgent, profiles[actorAgent.id] ?? null)
    : null;

  const getAgentDisplay = (agent: Agent | null) => (
    agent ? getXingyeRoleProfileDisplay(agent, profiles[agent.id] ?? null) : null
  );

  const getCommentAuthorDisplayName = (agentId: string) => {
    const agent = agentsById.get(agentId);
    if (!agent) return '未知角色';
    return getXingyeRoleProfileDisplay(agent, profiles[agent.id] ?? null).displayName;
  };

  const handleCreate = (content: string) => {
    if (!actorAgent) return;
    createXingyeMomentPost(actorAgent.id, content);
  };

  const handleToggleLike = (postId: string) => {
    if (!actorAgent) return;
    toggleXingyeMomentLike(postId, actorAgent.id);
  };

  const handleComment = (postId: string, content: string) => {
    if (!actorAgent) return;
    addXingyeMomentComment(postId, actorAgent.id, content);
  };

  return (
    <div className={styles.momentsPanel}>
      <div className={styles.momentsHeader}>
        <div>
          <p className={styles.eyebrow}>Xingye Moments</p>
          <h2 className={styles.panelTitle}>朋友圈</h2>
          <p className={styles.panelDescription}>
            静态本地动态流，只保存到 localStorage，不接入 AI 自动生成。
          </p>
        </div>
      </div>

      <MomentComposer agent={actorAgent} display={actorDisplay} onSubmit={handleCreate} />

      <section className={styles.momentFeed} aria-label="朋友圈动态列表">
        {posts.length > 0 ? (
          posts.map(post => {
            const authorAgent = agentsById.get(post.authorAgentId) ?? null;
            return (
              <MomentCard
                key={post.id}
                actorAgentId={actorAgent?.id ?? null}
                authorAgent={authorAgent}
                authorDisplay={getAgentDisplay(authorAgent)}
                commentAuthorDisplayName={getCommentAuthorDisplayName}
                post={post}
                onComment={handleComment}
                onDelete={deleteXingyeMomentPost}
                onToggleLike={handleToggleLike}
              />
            );
          })
        ) : (
          <div className={styles.momentEmptyState}>还没有动态</div>
        )}
      </section>
    </div>
  );
}
