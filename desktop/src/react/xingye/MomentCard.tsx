import { useState } from 'react';
import type { Agent } from '../types';
import type { XingyeMomentActor, XingyeMomentPost } from './xingye-moments-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

/** 「让 TA 回复」下拉菜单里的一个可选角色。 */
export type MomentReplyAgentOption = {
  id: string;
  displayName: string;
  /** 是否就是这条朋友圈的作者（菜单里标「作者」）。 */
  isAuthor: boolean;
};

interface MomentCardProps {
  authorAgent: Agent | null;
  authorDisplayName: string;
  authorRelationshipLabel?: string;
  /** 这条朋友圈是否由用户本人发布（影响头像与作者行渲染）。 */
  isUserPost?: boolean;
  canDelete: boolean;
  getAgentDisplayName: (agentId: string) => string;
  post: XingyeMomentPost;
  userActor: XingyeMomentActor;
  /** 「让 TA 回复」可选的角色列表；为空则不渲染该按钮。 */
  replyAgentOptions: ReadonlyArray<MomentReplyAgentOption>;
  onComment: (postId: string, body: string) => Promise<void>;
  onDelete: (postId: string) => Promise<void>;
  onToggleLike: (postId: string) => Promise<void>;
  /** 把当前输入框里的评论以 user 身份发出，再让 replyAgentId 角色回复它。 */
  onAgentReply: (postId: string, userCommentBody: string, replyAgentId: string) => Promise<void>;
}

function formatMomentTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;

  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;

  const date = new Date(timestamp);
  const today = new Date();
  if (date.getFullYear() === today.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function resolveLikeDisplayName(
  like: XingyeMomentPost['likes'][number],
  getAgentDisplayName: (agentId: string) => string,
): string {
  if (like.actorType === 'agent') {
    return getAgentDisplayName(like.actorId);
  }
  return like.actorName || '用户';
}

function resolveCommentDisplayName(
  comment: XingyeMomentPost['comments'][number],
  getAgentDisplayName: (agentId: string) => string,
): string {
  if (comment.actorType === 'agent') {
    return getAgentDisplayName(comment.actorId);
  }
  return comment.actorName || '用户';
}

export function MomentCard({
  authorAgent,
  authorDisplayName,
  authorRelationshipLabel,
  isUserPost = false,
  canDelete,
  getAgentDisplayName,
  post,
  userActor,
  replyAgentOptions,
  onComment,
  onDelete,
  onToggleLike,
  onAgentReply,
}: MomentCardProps) {
  const [commentDraft, setCommentDraft] = useState('');
  const [commentPending, setCommentPending] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [likePending, setLikePending] = useState(false);
  const [likeError, setLikeError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [replyMenuOpen, setReplyMenuOpen] = useState(false);
  const [replyPending, setReplyPending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const liked = post.likes.some(
    (like) => like.actorType === userActor.actorType && like.actorId === userActor.actorId,
  );
  const relationshipLabel = isUserPost ? '我' : authorRelationshipLabel ?? '关系未设置';

  const handleCommentSubmit = async () => {
    const body = commentDraft.trim();
    if (!body || commentPending) return;
    setCommentPending(true);
    setCommentError(null);
    try {
      await onComment(post.id, body);
      setCommentDraft('');
    } catch (e) {
      setCommentError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommentPending(false);
    }
  };

  const handlePickReplyAgent = async (replyAgentId: string) => {
    const body = commentDraft.trim();
    if (!body || replyPending || commentPending) return;
    setReplyMenuOpen(false);
    setReplyPending(true);
    setReplyError(null);
    try {
      await onAgentReply(post.id, body, replyAgentId);
      setCommentDraft('');
    } catch (e) {
      setReplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplyPending(false);
    }
  };

  const handleToggleLikeClick = async () => {
    if (likePending) return;
    setLikePending(true);
    setLikeError(null);
    try {
      await onToggleLike(post.id);
    } catch (e) {
      setLikeError(e instanceof Error ? e.message : String(e));
    } finally {
      setLikePending(false);
    }
  };

  const handleDeleteClick = async () => {
    if (deletePending) return;
    setDeletePending(true);
    try {
      await onDelete(post.id);
    } finally {
      setDeletePending(false);
    }
  };

  return (
    <article className={styles.momentCard}>
      <div className={styles.momentAvatar}>
        {isUserPost ? (
          <span>{(authorDisplayName.trim() || '我').slice(0, 1)}</span>
        ) : authorAgent ? (
          <XingyeAgentAvatar agent={authorAgent} alt={authorDisplayName} />
        ) : (
          <span>?</span>
        )}
      </div>

      <div className={styles.momentCardBody}>
        <header className={styles.momentHeader}>
          <div className={styles.momentAuthorBlock}>
            <div className={styles.momentAuthorLine}>
              <h3>{authorDisplayName}</h3>
              <span>{relationshipLabel}</span>
            </div>
            <time dateTime={post.createdAt}>{formatMomentTime(post.createdAt)}</time>
          </div>
          {canDelete ? (
            <button
              className={styles.momentDeleteButton}
              type="button"
              disabled={deletePending}
              onClick={() => { void handleDeleteClick(); }}
            >
              {deletePending ? '删除中…' : '删除'}
            </button>
          ) : null}
        </header>

        <p className={styles.momentContent}>{post.content}</p>

        {post.imageUrls.length > 0 ? (
          <div className={styles.momentImageGrid}>
            {post.imageUrls.map((url) => (
              <img key={url} src={url} alt="" />
            ))}
          </div>
        ) : null}

        <div className={styles.momentActions}>
          <button
            type="button"
            className={`${styles.momentActionPill} ${liked ? styles.momentActionActive : ''}`}
            onClick={() => { void handleToggleLikeClick(); }}
            disabled={likePending}
            aria-pressed={liked}
            aria-busy={likePending}
            aria-label={liked ? '取消点赞' : '点赞'}
          >
            <svg viewBox="0 0 24 24" aria-hidden focusable="false" className={styles.momentActionIcon}>
              <path
                d="M12 20.5s-7-4.5-9.2-9A4.8 4.8 0 0 1 12 6.4a4.8 4.8 0 0 1 9.2 5.1c-2.2 4.5-9.2 9-9.2 9z"
                fill={liked ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
            <span>{likePending ? '处理中…' : liked ? '已赞' : '赞'}</span>
          </button>
          {likeError ? (
            <span className={styles.momentActionError} role="alert">
              {likeError}
            </span>
          ) : null}
        </div>

        {(post.likes.length > 0 || post.comments.length > 0) ? (
          <div className={styles.momentSocialBlock}>
            {post.likes.length > 0 ? (
              <div className={styles.momentLikes}>
                <svg viewBox="0 0 24 24" aria-hidden focusable="false" className={styles.momentLikesIcon}>
                  <path
                    d="M12 20.5s-7-4.5-9.2-9A4.8 4.8 0 0 1 12 6.4a4.8 4.8 0 0 1 9.2 5.1c-2.2 4.5-9.2 9-9.2 9z"
                    fill="currentColor"
                  />
                </svg>
                <p>
                  {post.likes
                    .map((like) => resolveLikeDisplayName(like, getAgentDisplayName))
                    .join('，')}
                </p>
              </div>
            ) : null}

            {post.likes.length > 0 && post.comments.length > 0 ? (
              <div className={styles.momentDivider} />
            ) : null}

            {post.comments.length > 0 ? (
              <div className={styles.momentComments}>
                {post.comments.map((comment) => (
                  <p key={comment.id}>
                    <strong>{resolveCommentDisplayName(comment, getAgentDisplayName)}</strong>
                    <span className={styles.momentCommentColon}>：</span>
                    <span>{comment.body}</span>
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={styles.momentCommentComposer}>
          <input
            type="text"
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
            placeholder={`以 ${userActor.actorName} 的身份评论...`}
            disabled={commentPending || replyPending}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleCommentSubmit();
            }}
          />
          <div className={styles.momentCommentActions}>
            <button
              type="button"
              disabled={!commentDraft.trim() || commentPending || replyPending}
              onClick={() => { void handleCommentSubmit(); }}
            >
              {commentPending ? '评论中…' : '评论'}
            </button>
            {replyAgentOptions.length > 0 ? (
              <div className={styles.momentReplyMenuWrap}>
                <button
                  type="button"
                  className={styles.momentReplyButton}
                  disabled={!commentDraft.trim() || commentPending || replyPending}
                  aria-haspopup="menu"
                  aria-expanded={replyMenuOpen}
                  title="发出这条评论，并让选定的角色回复它"
                  onClick={() => setReplyMenuOpen((prev) => !prev)}
                >
                  {replyPending ? '回复中…' : '让 TA 回复 ▾'}
                </button>
                {replyMenuOpen ? (
                  <>
                    <div
                      className={styles.momentReplyMenuBackdrop}
                      aria-hidden
                      onClick={() => setReplyMenuOpen(false)}
                    />
                    <div className={styles.momentReplyMenu} role="menu">
                      {replyAgentOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          role="menuitem"
                          className={styles.momentReplyMenuItem}
                          onClick={() => { void handlePickReplyAgent(option.id); }}
                        >
                          {option.displayName}
                          {option.isAuthor ? (
                            <span className={styles.momentReplyMenuItemSub}>作者</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {commentError ? (
          <p className={styles.momentCommentError} role="alert">
            {commentError}
          </p>
        ) : null}
        {replyError ? (
          <p className={styles.momentCommentError} role="alert">
            {replyError}
          </p>
        ) : null}
      </div>
    </article>
  );
}
