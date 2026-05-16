import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../stores';
import type { Agent } from '../types';
import { MomentCard } from './MomentCard';
import { MomentComposer } from './MomentComposer';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import {
  addXingyeMomentComment,
  createXingyeMomentPost,
  deleteXingyeMomentPost,
  toggleXingyeMomentLike,
  type XingyeMomentActor,
} from './xingye-moments-store';
import { useAggregatedXingyeMoments } from './xingye-moments-feed';
import { generateXingyeMomentDraftWithAI } from './xingye-moments-ai';
import type { MomentComposerSubmitInput } from './MomentComposer';
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
  const [composerOpen, setComposerOpen] = useState(false);

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

  // viewer === 当前 xingye 视角的 agent（用于隐藏其他 agent 的 virtual_contact 互动）。
  const viewerAgentId = composerAgent?.id ?? null;
  const { posts, loading, error, retry } = useAggregatedXingyeMoments(agentIds, viewerAgentId);

  const getAgentDisplayName = (agentId: string): string => {
    const agent = agentsById.get(agentId);
    if (!agent) return '未知角色';
    return getXingyeRoleProfileDisplay(agent, profiles[agent.id] ?? null).displayName;
  };

  const handleCreate = useCallback(
    async ({ content, seedLikes, seedComments }: MomentComposerSubmitInput) => {
      if (!composerAgent) throw new Error('请先选择一个星野角色');
      const authorName = composerDisplay?.displayName ?? composerAgent.name;
      const created = await createXingyeMomentPost({
        authorAgentId: composerAgent.id,
        authorName,
        content,
        source: { kind: 'manual' },
        seedLikes,
        seedComments,
      });
      if (!created) throw new Error('发表失败：内容无效');
      setComposerOpen(false);
    },
    [composerAgent, composerDisplay?.displayName],
  );

  const handleToggleLike = useCallback(
    async (authorAgentId: string, postId: string) => {
      await toggleXingyeMomentLike(authorAgentId, postId, userActor);
    },
    [userActor],
  );

  const handleComment = useCallback(
    async (authorAgentId: string, postId: string, body: string) => {
      const updated = await addXingyeMomentComment(authorAgentId, postId, userActor, body);
      if (!updated) throw new Error('评论失败：内容无效');
    },
    [userActor],
  );

  const handleDelete = useCallback(async (authorAgentId: string, postId: string) => {
    await deleteXingyeMomentPost(authorAgentId, postId);
  }, []);

  const composerProfile = composerAgent ? profiles[composerAgent.id] ?? null : null;
  // roster 里除当前发帖 agent 外的其他角色，作为「其他 agent」可选互动者池。
  const peerAgentHints = useMemo(() => {
    if (!composerAgent) return [];
    return agents
      .filter((a) => a.id !== composerAgent.id)
      .map((a) => {
        const display = getXingyeRoleProfileDisplay(a, profiles[a.id] ?? null);
        return {
          id: a.id,
          displayName: display.displayName || a.name || a.id,
          relationshipLabel: display.relationshipLabel,
        };
      });
  }, [agents, composerAgent, profiles]);

  const handleGenerateAiDraft = useCallback(async () => {
    if (!composerAgent) throw new Error('请先选择一个星野角色');
    return generateXingyeMomentDraftWithAI({
      agent: composerAgent,
      ownerProfile: composerProfile,
      peerAgents: peerAgentHints,
    });
  }, [composerAgent, composerProfile, peerAgentHints]);

  return (
    <div className={styles.momentsPanel}>
      {(() => {
        const coverBgUrl = composerDisplay?.chatBackgroundDataUrl;
        const coverDisplayName =
          composerDisplay?.displayName || composerAgent?.name || 'TA';
        const coverStyle = coverBgUrl
          ? {
              backgroundImage: `url("${coverBgUrl}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : undefined;
        return (
          <div className={styles.momentsCover} style={coverStyle}>
            <div className={styles.momentsCoverGlow} />
            <button
              type="button"
              className={styles.momentsAddButton}
              aria-label={composerOpen ? '收起发布' : '发表新动态'}
              aria-expanded={composerOpen}
              onClick={() => setComposerOpen((prev) => !prev)}
            >
              <svg viewBox="0 0 24 24" aria-hidden focusable="false">
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </button>
            <div className={styles.momentsCoverIdentity}>
              <div className={styles.momentsCoverName}>{coverDisplayName}</div>
              <div className={styles.momentsCoverAvatar} aria-hidden>
                {composerAgent ? (
                  <XingyeAgentAvatar agent={composerAgent} alt={coverDisplayName} />
                ) : (
                  coverDisplayName.slice(0, 1)
                )}
              </div>
            </div>
          </div>
        );
      })()}

      <div className={styles.momentsCaption}>
        <p className={styles.eyebrow}>Xingye Moments</p>
        <h2 className={styles.panelTitle}>朋友圈</h2>
        <p className={styles.panelDescription}>
          聚合所有角色的本地动态流，按时间倒序展示；点赞和评论以「{userName}」的身份发送，仅本地保存。
        </p>
      </div>

      {composerOpen ? (
        <MomentComposer
          agent={composerAgent}
          display={composerDisplay}
          onSubmit={handleCreate}
          onGenerateAiDraft={composerAgent ? handleGenerateAiDraft : undefined}
        />
      ) : null}

      <section className={styles.momentFeed} aria-label="朋友圈动态列表">
        {error ? (
          <div className={styles.momentEmptyState} role="alert">
            <p>朋友圈加载失败：{error}</p>
            <button type="button" onClick={retry}>
              重试
            </button>
          </div>
        ) : loading && posts.length === 0 ? (
          <div className={styles.momentEmptyState} aria-busy="true">
            正在加载朋友圈…
          </div>
        ) : posts.length > 0 ? (
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
