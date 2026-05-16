import { useState } from 'react';
import type { Agent } from '../types';
import type { XingyeMomentActor, XingyeMomentPost } from './xingye-moments-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

interface MomentCardProps {
  authorAgent: Agent | null;
  authorDisplayName: string;
  authorRelationshipLabel?: string;
  canDelete: boolean;
  getAgentDisplayName: (agentId: string) => string;
  post: XingyeMomentPost;
  userActor: XingyeMomentActor;
  onComment: (postId: string, body: string) => void;
  onDelete: (postId: string) => void;
  onToggleLike: (postId: string) => void;
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
  canDelete,
  getAgentDisplayName,
  post,
  userActor,
  onComment,
  onDelete,
  onToggleLike,
}: MomentCardProps) {
  const [commentDraft, setCommentDraft] = useState('');
  const liked = post.likes.some(
    (like) => like.actorType === userActor.actorType && like.actorId === userActor.actorId,
  );
  const relationshipLabel = authorRelationshipLabel ?? '关系未设置';

  const handleCommentSubmit = () => {
    const body = commentDraft.trim();
    if (!body) return;
    onComment(post.id, body);
    setCommentDraft('');
  };

  return (
    <article className={styles.momentCard}>
      <div className={styles.momentAvatar}>
        {authorAgent ? (
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
            <button className={styles.momentDeleteButton} type="button" onClick={() => onDelete(post.id)}>
              删除
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
            onClick={() => onToggleLike(post.id)}
            aria-pressed={liked}
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
            <span>{liked ? '已赞' : '赞'}</span>
          </button>
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
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleCommentSubmit();
            }}
          />
          <button type="button" disabled={!commentDraft.trim()} onClick={handleCommentSubmit}>
            评论
          </button>
        </div>
      </div>
    </article>
  );
}
