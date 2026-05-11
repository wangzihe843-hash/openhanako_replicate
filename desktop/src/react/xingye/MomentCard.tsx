import { useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import type { XingyeMomentPost } from './xingye-moments-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

interface MomentCardProps {
  actorAgentId: string | null;
  authorAgent: Agent | null;
  authorDisplay: XingyeRoleProfileDisplay | null;
  commentAuthorDisplayName: (agentId: string) => string;
  post: XingyeMomentPost;
  onComment: (postId: string, content: string) => void;
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

export function MomentCard({
  actorAgentId,
  authorAgent,
  authorDisplay,
  commentAuthorDisplayName,
  post,
  onComment,
  onDelete,
  onToggleLike,
}: MomentCardProps) {
  const [commentDraft, setCommentDraft] = useState('');
  const liked = Boolean(actorAgentId && post.likes.includes(actorAgentId));
  const authorName = authorDisplay?.displayName ?? authorAgent?.name ?? '未知角色';
  const relationshipLabel = authorDisplay?.relationshipLabel ?? '关系未设置';

  const handleCommentSubmit = () => {
    const content = commentDraft.trim();
    if (!content) return;
    onComment(post.id, content);
    setCommentDraft('');
  };

  return (
    <article className={styles.momentCard}>
      <div className={styles.momentAvatar}>
        {authorAgent ? (
          <XingyeAgentAvatar agent={authorAgent} alt={authorName} />
        ) : (
          <span>?</span>
        )}
      </div>

      <div className={styles.momentCardBody}>
        <header className={styles.momentHeader}>
          <div className={styles.momentAuthorBlock}>
            <div className={styles.momentAuthorLine}>
              <h3>{authorName}</h3>
              <span>{relationshipLabel}</span>
            </div>
            <time dateTime={post.createdAt}>{formatMomentTime(post.createdAt)}</time>
          </div>
          <button className={styles.momentDeleteButton} type="button" onClick={() => onDelete(post.id)}>
            删除
          </button>
        </header>

        <p className={styles.momentContent}>{post.content}</p>

        {post.imageUrls.length > 0 ? (
          <div className={styles.momentImageGrid}>
            {post.imageUrls.map(url => (
              <img key={url} src={url} alt="" />
            ))}
          </div>
        ) : null}

        <div className={styles.momentActions}>
          <button type="button" className={liked ? styles.momentActionActive : ''} onClick={() => onToggleLike(post.id)}>
            {liked ? '已赞' : '赞'} {post.likes.length ? post.likes.length : ''}
          </button>
        </div>

        {(post.likes.length > 0 || post.comments.length > 0) ? (
          <div className={styles.momentSocialBlock}>
            {post.likes.length > 0 ? (
              <div className={styles.momentLikes}>
                <span>♥</span>
                <p>{post.likes.map(commentAuthorDisplayName).join('、')}</p>
              </div>
            ) : null}

            {post.likes.length > 0 && post.comments.length > 0 ? (
              <div className={styles.momentDivider} />
            ) : null}

            {post.comments.length > 0 ? (
              <div className={styles.momentComments}>
                {post.comments.map(comment => (
                  <p key={comment.id}>
                    <strong>{commentAuthorDisplayName(comment.authorId)}</strong>
                    <span>：{comment.content}</span>
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
            onChange={event => setCommentDraft(event.target.value)}
            placeholder={actorAgentId ? '写评论...' : '请先选择角色'}
            disabled={!actorAgentId}
            onKeyDown={event => {
              if (event.key === 'Enter') handleCommentSubmit();
            }}
          />
          <button type="button" disabled={!actorAgentId || !commentDraft.trim()} onClick={handleCommentSubmit}>
            评论
          </button>
        </div>
      </div>
    </article>
  );
}
