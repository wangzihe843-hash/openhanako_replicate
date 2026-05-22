import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores';
import type { Agent } from '../types';
import { MomentCard, type MomentReplyAgentOption } from './MomentCard';
import { MomentComposer } from './MomentComposer';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import {
  addXingyeMomentComment,
  confirmMomentDraft,
  createXingyeMomentPost,
  deleteXingyeMomentPost,
  discardMomentDraft,
  isXingyeMomentUserAuthor,
  listMomentDrafts,
  toggleXingyeMomentLike,
  XINGYE_MOMENT_USER_AUTHOR_ID,
  type XingyeMomentActor,
  type XingyeMomentPost,
  type XingyePendingMomentDraft,
} from './xingye-moments-store';
import { useAggregatedXingyeMoments } from './xingye-moments-feed';
import {
  generateXingyeMomentCommentReplyWithAI,
  generateXingyeMomentDraftWithAI,
} from './xingye-moments-ai';
import { fanOutAgentReactionsToUserPost } from './xingye-moments-user-fanout';
import type { MomentComposerIdentityMode, MomentComposerSubmitInput } from './MomentComposer';
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
  /** 发表身份：默认「我自己」——用户视角发朋友圈是这个面板的主路径。 */
  const [composerIdentity, setComposerIdentity] = useState<MomentComposerIdentityMode>('user');

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
  // feed 聚合范围里额外纳入「用户本人」这个保留作者——用户自己发的朋友圈也要进流。
  const feedAgentIds = useMemo(
    () => [...agentIds, XINGYE_MOMENT_USER_AUTHOR_ID],
    [agentIds],
  );
  const { posts, loading, error, retry } = useAggregatedXingyeMoments(feedAgentIds, viewerAgentId);

  const getAgentDisplayName = (agentId: string): string => {
    const agent = agentsById.get(agentId);
    if (!agent) return '未知角色';
    return getXingyeRoleProfileDisplay(agent, profiles[agent.id] ?? null).displayName;
  };

  const handleCreate = useCallback(
    async ({ content, seedLikes, seedComments }: MomentComposerSubmitInput) => {
      // 「我自己」身份：以保留作者 id 发帖，发完后台扇出让各角色按关系点赞/评论。
      if (composerIdentity === 'user') {
        const createdByUser = await createXingyeMomentPost({
          authorAgentId: XINGYE_MOMENT_USER_AUTHOR_ID,
          authorName: userName,
          content,
          source: { kind: 'manual' },
        });
        if (!createdByUser) throw new Error('发表失败：内容无效');
        setComposerOpen(false);
        // fire-and-forget：帖子已即时出现，角色反应通过 store 事件陆续刷进 feed。
        void fanOutAgentReactionsToUserPost({
          postId: createdByUser.id,
          agents: agents.map((a) => ({
            agent: a,
            profile: profiles[a.id] ?? null,
            displayName: getXingyeRoleProfileDisplay(a, profiles[a.id] ?? null).displayName,
          })),
        }).catch((err) => {
          console.warn('[MomentsPanel] user-post fan-out failed:', err);
        });
        return;
      }
      // 「以角色发表」身份：沿用原有逻辑（含 AI 生成的 seed 互动者）。
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
    [composerIdentity, userName, agents, profiles, composerAgent, composerDisplay?.displayName],
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

  /** 为某条朋友圈构造「让 TA 回复」可选角色列表：作者排在最前并标记。 */
  const buildReplyAgentOptions = (postAuthorAgentId: string): MomentReplyAgentOption[] =>
    [...agents]
      .sort((a, b) => {
        const aAuthor = a.id === postAuthorAgentId ? 0 : 1;
        const bAuthor = b.id === postAuthorAgentId ? 0 : 1;
        return aAuthor - bAuthor;
      })
      .map((agent) => ({
        id: agent.id,
        displayName: getAgentDisplayName(agent.id),
        isAuthor: agent.id === postAuthorAgentId,
      }));

  /**
   * 「让 TA 回复」：先把用户输入的评论以 user 身份发出，再调 AI 让 replyAgent
   * 针对这条评论生成回复，最后以 agent 身份写进同一条朋友圈的评论区。
   * 任一步抛错都由 MomentCard 捕获并展示，不吞错。
   */
  const handleAgentReply = async (
    post: XingyeMomentPost,
    userCommentBody: string,
    replyAgentId: string,
  ) => {
    const replyAgent = agentsById.get(replyAgentId);
    if (!replyAgent) throw new Error('找不到要回复的角色');

    const userCommented = await addXingyeMomentComment(
      post.authorAgentId,
      post.id,
      userActor,
      userCommentBody,
    );
    if (!userCommented) throw new Error('评论失败：内容无效');

    const authorAgent = agentsById.get(post.authorAgentId) ?? null;
    const authorProfile = authorAgent ? profiles[authorAgent.id] ?? null : null;
    const authorDisplayName = authorAgent
      ? getXingyeRoleProfileDisplay(authorAgent, authorProfile).displayName
      : post.authorName;

    const reply = await generateXingyeMomentCommentReplyWithAI({
      replyAgent,
      replyProfile: profiles[replyAgent.id] ?? null,
      post: {
        authorAgentId: post.authorAgentId,
        authorDisplayName,
        authorIdentitySummary: authorProfile?.identitySummary ?? null,
        content: post.content,
      },
      existingComments: post.comments.map((comment) => ({
        authorName:
          comment.actorType === 'agent'
            ? getAgentDisplayName(comment.actorId)
            : comment.actorName,
        body: comment.body,
      })),
      targetComment: { authorName: userActor.actorName, body: userCommentBody },
    });

    const replied = await addXingyeMomentComment(
      post.authorAgentId,
      post.id,
      {
        actorType: 'agent',
        actorId: replyAgent.id,
        actorName: getAgentDisplayName(replyAgent.id),
      },
      reply,
    );
    if (!replied) throw new Error('回复写入失败：内容无效');
  };

  /** 当前 composerAgent 下「待确认朋友圈草稿」列表。只展示当前角色的草稿， */
  /** 不跨 agent 聚合——草稿是各 agent 独立的，跨角色显示会误导。 */
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingMomentDraft[]>([]);
  const [draftEdits, setDraftEdits] = useState<Record<string, { content: string }>>({});
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  /**
   * 区分两种忙状态：plain confirm 是「确认发表」，combined 是「确认并 AI 生成互动后发表」。
   * 不合并的原因：combined 是两段串行（先 AI 拉互动 → 再 createPost），需要给按钮分别上
   * disabled 状态，免得用户点错另一个；UI 也用这个标志显示「生成互动并发表中…」。
   */
  const [draftBusyKind, setDraftBusyKind] = useState<'plain' | 'combined' | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const reloadDrafts = useCallback(async () => {
    if (!composerAgent) {
      setPendingDrafts([]);
      setDraftEdits({});
      return;
    }
    try {
      const drafts = await listMomentDrafts(composerAgent.id);
      setPendingDrafts(drafts);
    } catch (err) {
      console.warn('[MomentsPanel] failed to load moment drafts:', err);
      setPendingDrafts([]);
    }
  }, [composerAgent]);

  useEffect(() => {
    setDraftError(null);
    setDraftEdits({});
    void reloadDrafts();
  }, [reloadDrafts]);

  const draftWorkingContent = useCallback(
    (draft: XingyePendingMomentDraft) => draftEdits[draft.id]?.content ?? draft.content,
    [draftEdits],
  );

  const handleDraftContentChange = (draftId: string, content: string) => {
    setDraftEdits((prev) => ({ ...prev, [draftId]: { content } }));
  };

  /** Reused by both confirm paths to clean up local UI state after a successful publish. */
  const removeDraftFromUiState = (draftId: string) => {
    setPendingDrafts((prev) => prev.filter((d) => d.id !== draftId));
    setDraftEdits((prev) => {
      if (!(draftId in prev)) return prev;
      const { [draftId]: _omitted, ...rest } = prev;
      return rest;
    });
  };

  const handleConfirmDraft = async (draft: XingyePendingMomentDraft) => {
    if (!composerAgent) return;
    setDraftBusyId(draft.id);
    setDraftBusyKind('plain');
    setDraftError(null);
    try {
      /** 与 handleCreate 同款：用 composerDisplay 解析的 displayName，否则回退 agent.name；都没有再让 store 退到 aid。 */
      const authorName = composerDisplay?.displayName ?? composerAgent.name;
      await confirmMomentDraft(composerAgent.id, draft.id, {
        content: draftWorkingContent(draft),
        authorName,
      });
      removeDraftFromUiState(draft.id);
      /** 让 feed 也刷新一下（新发的 post 通过 XINGYE_MOMENTS_CHANGED_EVENT 会自动 picked up）。 */
      retry();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
      setDraftBusyKind(null);
    }
  };

  /**
   * 「确认并生成互动」组合流程：
   *   1. 用现成 content 调一次 generateXingyeMomentDraftWithAI（interactions-only 模式），拿 seedLikes / seedComments
   *   2. 把 seeds 连同 content 一起经 confirmMomentDraft 落到 posts.jsonl
   * 中间任何一步失败：保留 draft，把错误抛到 UI，让用户决定是用「确认发表」走 plain 路径还是重试。
   * 不依赖模型守约——上一节加的 verbatim 覆盖保证 seedLikes/Comments 即使模型乱写也只影响互动者，不会污染正文。
   */
  const handleConfirmDraftWithInteractions = async (draft: XingyePendingMomentDraft) => {
    if (!composerAgent) return;
    setDraftBusyId(draft.id);
    setDraftBusyKind('combined');
    setDraftError(null);
    try {
      const workingContent = draftWorkingContent(draft);
      if (!workingContent.trim()) {
        throw new Error('正文不能为空，无法生成互动。');
      }
      const aiResult = await handleGenerateAiDraft({ existingContent: workingContent });
      const authorName = composerDisplay?.displayName ?? composerAgent.name;
      await confirmMomentDraft(composerAgent.id, draft.id, {
        content: workingContent,
        seedLikes: aiResult.seedLikes,
        seedComments: aiResult.seedComments,
        authorName,
      });
      removeDraftFromUiState(draft.id);
      retry();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
      setDraftBusyKind(null);
    }
  };

  const handleDiscardDraft = async (draft: XingyePendingMomentDraft) => {
    if (!composerAgent) return;
    if (!window.confirm('确定丢弃这条待确认朋友圈草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setDraftBusyId(draft.id);
    setDraftBusyKind('plain');
    setDraftError(null);
    try {
      const ok = await discardMomentDraft(composerAgent.id, draft.id);
      if (ok) {
        removeDraftFromUiState(draft.id);
      } else {
        await reloadDrafts();
      }
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftBusyId(null);
      setDraftBusyKind(null);
    }
  };

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

  const handleGenerateAiDraft = useCallback(
    async (opts?: { existingContent?: string }) => {
      if (!composerAgent) throw new Error('请先选择一个星野角色');
      return generateXingyeMomentDraftWithAI({
        agent: composerAgent,
        ownerProfile: composerProfile,
        peerAgents: peerAgentHints,
        /**
         * 透传 composer 给的 existingContent。非空时 AI fn 走 interactions-only 分支：
         * 只生成 likes/comments，content 由 AI fn 做 verbatim 覆盖兜底，不会改用户已有正文。
         */
        existingContent: opts?.existingContent,
      });
    },
    [composerAgent, composerProfile, peerAgentHints],
  );

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
          identityMode={composerIdentity}
          onIdentityModeChange={setComposerIdentity}
          userName={userName}
          onSubmit={handleCreate}
          onGenerateAiDraft={composerAgent ? handleGenerateAiDraft : undefined}
        />
      ) : null}

      {pendingDrafts.length > 0 && composerAgent ? (
        <section
          className={styles.momentFeed}
          aria-label="待确认朋友圈草稿"
          data-testid="moments-pending-drafts"
          style={{ paddingBottom: 0 }}
        >
          <p className={styles.panelDescription} style={{ marginBottom: 8 }}>
            <strong>待确认草稿 · 来自心跳巡检</strong> — 角色在巡检里提议但还没发出来。点「确认发表」才会真正出现在
            {composerDisplay?.displayName ?? composerAgent.name} 的朋友圈里。
          </p>
          {draftError ? (
            <p className={styles.panelDescription} role="alert">
              {draftError}
            </p>
          ) : null}
          {pendingDrafts.map((draft) => {
            const working = draftWorkingContent(draft);
            const busy = draftBusyId === draft.id;
            return (
              <div
                key={draft.id}
                className={styles.momentCard}
                style={{ borderStyle: 'dashed' }}
                data-testid={`moments-draft-${draft.id}`}
              >
                <textarea
                  value={working}
                  onChange={(e) => handleDraftContentChange(draft.id, e.target.value)}
                  rows={3}
                  aria-label="待确认朋友圈正文"
                  data-testid={`moments-draft-content-${draft.id}`}
                  disabled={busy}
                  maxLength={280}
                  style={{ width: '100%', font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.25)', padding: '6px', minHeight: 60 }}
                />
                {draft.reason ? (
                  <p className={styles.panelDescription} style={{ margin: '6px 0 0' }}>
                    理由：{draft.reason}
                  </p>
                ) : null}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => void handleConfirmDraft(draft)}
                    disabled={busy}
                    data-testid={`moments-draft-confirm-${draft.id}`}
                    title="直接发表草稿内容，不带点赞/评论"
                  >
                    {busy && draftBusyKind === 'plain' ? '处理中…' : '确认发表'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmDraftWithInteractions(draft)}
                    disabled={busy || !working.trim()}
                    data-testid={`moments-draft-confirm-with-interactions-${draft.id}`}
                    title="先用 AI 基于这段正文拉点赞/评论，再连同正文一起发表（一步完成）"
                  >
                    {busy && draftBusyKind === 'combined' ? '生成互动并发表中…' : '确认并生成互动'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDiscardDraft(draft)}
                    disabled={busy}
                    data-testid={`moments-draft-discard-${draft.id}`}
                  >
                    丢弃
                  </button>
                </div>
              </div>
            );
          })}
        </section>
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
            const isUserPost = isXingyeMomentUserAuthor(post.authorAgentId);
            const authorAgent = isUserPost ? null : agentsById.get(post.authorAgentId) ?? null;
            const fallbackName = post.authorName || authorAgent?.name || post.authorAgentId;
            const authorDisplayName = isUserPost
              ? post.authorName || userName
              : authorAgent
                ? getXingyeRoleProfileDisplay(authorAgent, profiles[authorAgent.id] ?? null).displayName
                : fallbackName;
            const relationshipLabel = isUserPost || !authorAgent
              ? undefined
              : getXingyeRoleProfileDisplay(authorAgent, profiles[authorAgent.id] ?? null).relationshipLabel;
            return (
              <MomentCard
                key={post.id}
                authorAgent={authorAgent}
                authorDisplayName={authorDisplayName}
                authorRelationshipLabel={relationshipLabel}
                isUserPost={isUserPost}
                canDelete={isUserPost || post.authorAgentId === composerAgent?.id}
                getAgentDisplayName={getAgentDisplayName}
                post={post}
                userActor={userActor}
                replyAgentOptions={buildReplyAgentOptions(post.authorAgentId)}
                onComment={(postId, body) => handleComment(post.authorAgentId, postId, body)}
                onDelete={(postId) => handleDelete(post.authorAgentId, postId)}
                onToggleLike={(postId) => handleToggleLike(post.authorAgentId, postId)}
                onAgentReply={(_postId, body, replyAgentId) =>
                  handleAgentReply(post, body, replyAgentId)
                }
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
