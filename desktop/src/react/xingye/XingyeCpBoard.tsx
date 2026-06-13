/**
 * 「你和 TA 的 CP」板块 mini-view（论坛子模块）。
 *
 * 产品意象：用户偷看 TA 的手机，发现 TA 偷偷关注着一个嗑「你俩 CP」的饭圈板块。
 *  - 不自动初始化：首开是空的；只有点「偷看更新」且**有新聊天**时才生成（水位线闸门）。
 *  - 板上只有 NPC 主题帖（同人文 / 考据 / 发疯 / 讨论）；TA 顶多用一个 CP 马甲在帖下评论。
 *  - 草稿箱（「＋」入口）：TA 想发没发的内容；「替 TA 发送」/「替 TA 关注」会弹 TA 反应彩蛋。
 *
 * 复用 XingyeForumApp 的样式原子（根用 forumStyles.forumApp，--forum-* 变量沿继承）+ Avatar 等。
 * reload 带 reloadSeqRef 守卫，防切角色竞态串读（domain_xingye_persistence_invariants）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type { ForumAccount } from './xingye-forum-types';
import { Avatar, formatCount, formatRelative } from './XingyeForumApp';
import forumStyles from './XingyeForumApp.module.css';
import styles from './XingyeCpBoard.module.css';
import {
  appendCpDrafts,
  appendCpPosts,
  deleteCpDraft,
  listCpDrafts,
  listCpPosts,
  markCpInitialized,
  readCpMeta,
  replaceCpPost,
  writeCpMeta,
} from './xingye-cp-store';
import { assembleAgentPostFromDraft, buildAgentCommentFromDraft } from './xingye-cp-assemble';
import { evaluateCpChatGate, generateCpBoardBatch } from './xingye-cp-ai';
import type { CpChatGate } from './xingye-cp-ai';
import type { CpComment, CpDraft, CpMeta, CpPost, CpPostGenre } from './xingye-cp-types';

interface XingyeCpBoardProps {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  forumAccounts: ForumAccount[];
  onBack: () => void;
}

type CpTab = 'feed' | 'drafts';
interface EasterEgg {
  altUsername: string;
  text: string;
}

const GENRE_META: Record<CpPostGenre, { label: string; cls: string }> = {
  fic: { label: '同人', cls: 'genreFic' },
  analysis: { label: '考据', cls: 'genreAnalysis' },
  squee: { label: '发疯', cls: 'genreSquee' },
  discuss: { label: '讨论', cls: 'genreDiscuss' },
};

// ── 子组件 ────────────────────────────────────────────────────────────────────

function GenreTag({ genre }: { genre: CpPostGenre }) {
  const meta = GENRE_META[genre];
  return <span className={`${styles.genreTag} ${styles[meta.cls]}`}>{meta.label}</span>;
}

function CpPostCard({ post, now, onOpen }: { post: CpPost; now: number; onOpen: (id: string) => void }) {
  const isAgent = post.origin === 'agent';
  return (
    <button
      type="button"
      className={forumStyles.postCard}
      onClick={() => onOpen(post.postId)}
      data-testid={`cp-post-${post.postId}`}
    >
      <div className={forumStyles.postCardHead}>
        <GenreTag genre={post.genre} />
        <span className={forumStyles.boardTag}>{post.board}</span>
        {isAgent ? <span className={styles.agentPostTag}>TA 发的</span> : null}
      </div>
      <div className={forumStyles.postCardTitle}>{post.title}</div>
      <div className={forumStyles.postCardBody}>{post.body}</div>
      <div className={forumStyles.postCardMeta}>
        <span className={forumStyles.postCardAuthor}>
          {isAgent ? `${post.authorName}` : `@${post.authorName}`}
        </span>
        <span className={forumStyles.postCardStats}>
          <span>👁 {formatCount(post.stats.views)}</span>
          <span>👍 {formatCount(post.stats.likes)}</span>
          <span>💬 {post.comments.length}</span>
          <span>{formatRelative(post.postedAt, now)}</span>
        </span>
      </div>
    </button>
  );
}

function CpCommentItem({ comment, now }: { comment: CpComment; now: number }) {
  const renderName = (name: string, isAgent: boolean) => (
    <span className={`${forumStyles.commentName} ${isAgent ? forumStyles.commentNameAgent : ''}`}>
      {name}
      {isAgent ? <span className={forumStyles.meBadge}>TA</span> : null}
    </span>
  );
  return (
    <div className={forumStyles.comment} data-testid={`cp-comment-${comment.commentId}`}>
      <Avatar name={comment.authorName} size={32} />
      <div className={forumStyles.commentBody}>
        <div className={forumStyles.commentTop}>
          {renderName(comment.authorName, comment.authorIsAgent)}
          <span className={forumStyles.commentTime}>{formatRelative(comment.postedAt, now)}</span>
        </div>
        <div className={forumStyles.commentText}>{comment.body}</div>
        <div className={forumStyles.commentFoot}>
          <span>👍 {comment.likes}</span>
        </div>
        {comment.replies.length > 0 ? (
          <div className={forumStyles.replyList}>
            {comment.replies.map((reply) => (
              <div className={forumStyles.reply} key={reply.replyId}>
                {renderName(reply.authorName, reply.authorIsAgent)}
                {reply.toName ? <span className={forumStyles.replyTo}> 回复 @{reply.toName}</span> : null}
                <span className={forumStyles.replyText}>：{reply.body}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CpPostDetail({ post, now, onBack }: { post: CpPost; now: number; onBack: () => void }) {
  const isAgent = post.origin === 'agent';
  return (
    <div className={forumStyles.detail} data-testid="cp-post-detail">
      <button type="button" className={forumStyles.detailBack} onClick={onBack}>
        ‹ 返回围观
      </button>
      <div className={forumStyles.postCardHead}>
        <GenreTag genre={post.genre} />
        <span className={forumStyles.boardTag}>{post.board}</span>
      </div>
      <h3 className={forumStyles.detailTitle}>{post.title}</h3>
      <div className={forumStyles.detailAuthorRow}>
        <Avatar name={post.authorName} size={36} />
        <div>
          <div className={forumStyles.detailAuthorName}>
            {isAgent ? post.authorName : `@${post.authorName}`}
            {isAgent ? <span className={forumStyles.meBadge}>TA · 马甲</span> : null}
          </div>
          <div className={forumStyles.detailAuthorTime}>{formatRelative(post.postedAt, now)}</div>
        </div>
      </div>
      <div className={forumStyles.detailBody}>{post.body}</div>
      <div className={forumStyles.detailStats}>
        <span>👁 {formatCount(post.stats.views)}</span>
        <span>👍 {formatCount(post.stats.likes)}</span>
        <span>💬 {post.comments.length} 条评论</span>
      </div>
      {isAgent ? (
        <div className={styles.agentPostHint}>这条是 TA（@{post.authorName}）真的发出去的——是你替 TA 点的发送。</div>
      ) : null}
      <div className={forumStyles.commentsHeader}>全部评论</div>
      {post.comments.length === 0 ? (
        <div className={forumStyles.emptyInline}>还没有人评论</div>
      ) : (
        <div className={forumStyles.commentList}>
          {post.comments.map((c) => (
            <CpCommentItem key={c.commentId} comment={c} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function CpDraftCard({
  draft,
  busy,
  onSend,
  onDiscard,
}: {
  draft: CpDraft;
  busy: boolean;
  onSend: (d: CpDraft) => void;
  onDiscard: (d: CpDraft) => void;
}) {
  const isReply = draft.kind === 'reply';
  return (
    <div className={styles.draftCard} data-testid={`cp-draft-${draft.draftId}`}>
      <div className={styles.draftHead}>
        <span className={`${styles.draftKind} ${isReply ? styles.draftKindReply : styles.draftKindPost}`}>
          {isReply ? '想回复' : '想发帖'}
        </span>
        {isReply && draft.targetPostTitle ? (
          <span className={styles.draftTarget}>回应「{draft.targetPostTitle}」</span>
        ) : null}
        {!isReply && draft.title ? <span className={styles.draftTitle}>{draft.title}</span> : null}
      </div>
      <div className={styles.draftBody}>{draft.body}</div>
      <div className={styles.draftHesitation}>—— {draft.hesitation}</div>
      <div className={styles.draftActions}>
        <button
          type="button"
          className={styles.draftSend}
          onClick={() => onSend(draft)}
          disabled={busy}
          data-testid={`cp-draft-send-${draft.draftId}`}
        >
          {busy ? '发送中…' : '替 TA 发送'}
        </button>
        <button
          type="button"
          className={styles.draftDiscard}
          onClick={() => onDiscard(draft)}
          disabled={busy}
          data-testid={`cp-draft-discard-${draft.draftId}`}
        >
          丢弃
        </button>
      </div>
    </div>
  );
}

function EasterEggModal({ egg, onClose }: { egg: EasterEgg; onClose: () => void }) {
  return (
    <div
      className={styles.eggOverlay}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.eggCard} role="dialog" aria-modal="true" data-testid="cp-easter-egg">
        <div className={styles.eggHeart} aria-hidden>
          ♡
        </div>
        <div className={styles.eggWho}>@{egg.altUsername} · TA</div>
        <div className={styles.eggText}>{egg.text}</div>
        <button type="button" className={styles.eggClose} onClick={onClose} data-testid="cp-easter-egg-close">
          知道了
        </button>
      </div>
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

export function XingyeCpBoard({ agent, ownerProfile, forumAccounts, onBack }: XingyeCpBoardProps) {
  const [posts, setPosts] = useState<CpPost[]>([]);
  const [drafts, setDrafts] = useState<CpDraft[]>([]);
  const [meta, setMeta] = useState<CpMeta | null>(null);

  const [tab, setTab] = useState<CpTab>('feed');
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [egg, setEgg] = useState<EasterEgg | null>(null);
  const [gate, setGate] = useState<CpChatGate>({ status: 'no_chat', signature: '' });

  const reloadSeqRef = useRef(0);
  const now = Date.now();

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    if (!agent.id) return;
    setLoading(true);
    try {
      const [p, d, m] = await Promise.all([listCpPosts(agent.id), listCpDrafts(agent.id), readCpMeta(agent.id)]);
      if (seq !== reloadSeqRef.current) return;
      setPosts(p);
      setDrafts(d);
      setMeta(m);
      setGate(evaluateCpChatGate({ agentId: agent.id, watermark: m?.watermark }));
    } catch (err) {
      if (seq !== reloadSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reloadSeqRef.current) setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    setSelectedPostId(null);
    setTab('feed');
    setNotice(null);
    setError(null);
    setEgg(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail as { agentId?: string } | undefined;
      if (detail?.agentId === agent.id) void reload();
    };
    window.addEventListener('xingye-cp-changed', onChanged);
    return () => window.removeEventListener('xingye-cp-changed', onChanged);
  }, [agent.id, reload]);

  const selectedPost = useMemo(
    () => posts.find((p) => p.postId === selectedPostId) ?? null,
    [posts, selectedPostId],
  );

  const handleUpdate = useCallback(async () => {
    if (!agent.id || generating) return;
    setGenerating(true);
    setNotice(null);
    setError(null);
    try {
      const out = await generateCpBoardBatch({
        agent,
        ownerProfile,
        meta,
        forumAccounts,
        recentPosts: posts.slice(0, 14),
      });
      if (out.status === 'no_chat') {
        setNotice('缺少聊天内容，无法更新——TA 最近没和你说过话，CP 板自然也没有新料。');
        return;
      }
      if (out.status === 'no_new_chat') {
        setNotice('自上次以来没有新的聊天，CP 板这会儿刷不出新东西。');
        return;
      }
      await appendCpPosts(agent.id, out.posts);
      if (out.drafts.length) await appendCpDrafts(agent.id, out.drafts);
      const patch: Partial<CpMeta> = { watermark: out.signature };
      if (!meta?.alt) patch.alt = out.alt;
      if (!meta?.cpName) patch.cpName = out.cpName;
      if (!meta?.followed) patch.followReaction = out.followReaction;
      await writeCpMeta(agent.id, patch);
      await markCpInitialized(agent.id, new Date().toISOString());
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }, [agent, ownerProfile, meta, forumAccounts, posts, generating, reload]);

  const handleSendDraft = useCallback(
    async (draft: CpDraft) => {
      if (!agent.id || draftBusyId) return;
      const alt = meta?.alt;
      if (!alt) {
        setError('还没解析出 TA 在 CP 板的马甲，先点一次「偷看更新」。');
        return;
      }
      setDraftBusyId(draft.draftId);
      setError(null);
      try {
        if (draft.kind === 'post') {
          const post = assembleAgentPostFromDraft(draft, alt);
          await appendCpPosts(agent.id, [post]);
        } else {
          const target = posts.find((p) => p.postId === draft.targetPostId);
          if (!target) {
            setError('要回应的那条帖子找不到了（可能已被清理），这条草稿先留着。');
            setDraftBusyId(null);
            return;
          }
          const comment = buildAgentCommentFromDraft(draft, alt);
          const updated: CpPost = { ...target, comments: [...target.comments, comment] };
          await replaceCpPost(agent.id, updated);
        }
        await deleteCpDraft(agent.id, draft.draftId);
        await reload();
        setEgg({ altUsername: alt.username, text: draft.sendReaction });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDraftBusyId(null);
      }
    },
    [agent.id, meta, posts, draftBusyId, reload],
  );

  const handleDiscardDraft = useCallback(
    async (draft: CpDraft) => {
      if (!agent.id || draftBusyId) return;
      if (typeof window !== 'undefined' && !window.confirm('丢弃这条 TA 没发出去的草稿？丢了就没了（TA 之后可能在新聊天后重新憋出别的）。')) {
        return;
      }
      setDraftBusyId(draft.draftId);
      try {
        await deleteCpDraft(agent.id, draft.draftId);
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDraftBusyId(null);
      }
    },
    [agent.id, draftBusyId, reload],
  );

  const handleFollow = useCallback(async () => {
    if (!agent.id || followBusy || meta?.followed) return;
    const reaction = meta?.followReaction;
    const altUsername = meta?.alt?.username ?? 'TA';
    if (!reaction) {
      setError('先点一次「偷看更新」，TA 才会有被关注时的反应。');
      return;
    }
    setFollowBusy(true);
    try {
      await writeCpMeta(agent.id, { followed: true });
      await reload();
      setEgg({ altUsername, text: reaction });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFollowBusy(false);
    }
  }, [agent.id, meta, followBusy, reload]);

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  const hasContent = posts.length > 0;
  const followed = meta?.followed ?? false;
  const canFollow = !followed && Boolean(meta?.followReaction);

  const cpName = meta?.cpName?.trim() || '';
  const boardTitle = cpName || '你和 TA 的 CP';
  const updateLabel = generating ? '偷看中…' : hasContent ? '偷看更新' : '偷看一下 TA 关注了什么';

  return (
    <div className={forumStyles.forumApp} data-testid="xingye-cp-board">
      <div className={forumStyles.topBar}>
        <button type="button" className={forumStyles.backBtn} onClick={onBack} data-testid="cp-back">
          ‹ 论坛主页
        </button>
        <div className={forumStyles.topTitle} title={cpName ? `${cpName} · 你 × TA` : undefined}>
          {boardTitle}
        </div>
        {followed ? (
          <span className={styles.followDone} data-testid="cp-followed">
            已替关注 ♥
          </span>
        ) : (
          <button
            type="button"
            className={styles.followBtn}
            onClick={() => void handleFollow()}
            disabled={!canFollow || followBusy}
            data-testid="cp-follow"
            title={canFollow ? '替 TA 关注本板' : '先偷看更新一次'}
          >
            {followBusy ? '…' : '＋ 替 TA 关注'}
          </button>
        )}
      </div>

      <div className={styles.introBar}>
        <div className={styles.introText}>
          {cpName ? <>圈名《{cpName}》——一个嗑「你 × TA」的板块，TA 偷偷关注着。</> : <>一个嗑「你 × TA」的板块，TA 偷偷关注着。</>}
          <span className={styles.introSub}>板里没有 TA 的主帖——只有人在磕你俩。</span>
        </div>
        <button
          type="button"
          className={styles.updateBtn}
          onClick={() => void handleUpdate()}
          disabled={generating}
          data-testid="cp-update"
        >
          {updateLabel}
        </button>
      </div>

      {gate.status !== 'ok' && !generating ? (
        <div className={styles.gateHint} data-testid="cp-gate-hint">
          {gate.status === 'no_chat'
            ? '缺少聊天内容，暂时无法更新。'
            : '自上次以来没有新的聊天，暂时刷不出新料。'}
        </div>
      ) : null}

      {notice ? <div className={forumStyles.noticeBanner} data-testid="cp-notice">{notice}</div> : null}
      {error ? <div className={forumStyles.errorBanner} data-testid="cp-error">{error}</div> : null}

      {generating ? (
        <div className={forumStyles.overlay} data-testid="cp-generating">
          <div className={forumStyles.spinner} />
          <p>正在偷看 TA 的 CP 板…</p>
        </div>
      ) : null}

      {hasContent ? (
        <div className={styles.segBar} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'feed'}
            className={`${styles.segBtn} ${tab === 'feed' ? styles.segBtnActive : ''}`}
            onClick={() => {
              setTab('feed');
              setSelectedPostId(null);
            }}
            data-testid="cp-tab-feed"
          >
            围观
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'drafts'}
            className={`${styles.segBtn} ${tab === 'drafts' ? styles.segBtnActive : ''}`}
            onClick={() => setTab('drafts')}
            data-testid="cp-tab-drafts"
          >
            ＋ 草稿箱{drafts.length ? ` (${drafts.length})` : ''}
          </button>
        </div>
      ) : null}

      <div className={forumStyles.body}>
        {!hasContent && !generating && !loading ? (
          <div className={styles.lockedCard} data-testid="cp-empty">
            <div className={styles.lockedHeart} aria-hidden>
              ♡?
            </div>
            <div className={styles.lockedTitle}>TA 偷偷关注的板块</div>
            <p className={styles.lockedDesc}>
              这里好像有一群人在嗑「你 × TA」。要不要趁 TA 不在，偷看一眼 TA 都在关注些什么？
              <br />
              （只有你俩最近聊过天，才刷得出新内容。）
            </p>
            <button
              type="button"
              className={styles.lockedBtn}
              onClick={() => void handleUpdate()}
              disabled={generating}
              data-testid="cp-empty-update"
            >
              {generating ? '偷看中…' : '偷看一下'}
            </button>
          </div>
        ) : null}

        {hasContent && tab === 'feed' ? (
          selectedPost ? (
            <CpPostDetail post={selectedPost} now={now} onBack={() => setSelectedPostId(null)} />
          ) : (
            <div className={styles.feed} data-testid="cp-feed">
              {posts.map((post) => (
                <CpPostCard key={post.postId} post={post} now={now} onOpen={setSelectedPostId} />
              ))}
            </div>
          )
        ) : null}

        {hasContent && tab === 'drafts' ? (
          <div className={styles.draftsView} data-testid="cp-drafts">
            <div className={styles.draftsIntro}>
              TA 想发，但没点发送。<span className={styles.introSub}>替 TA 发出去，看看 TA 什么反应。</span>
            </div>
            {drafts.length === 0 ? (
              <div className={forumStyles.emptyInline}>TA 这会儿没有憋着没发的话。</div>
            ) : (
              drafts.map((d) => (
                <CpDraftCard
                  key={d.draftId}
                  draft={d}
                  busy={draftBusyId === d.draftId}
                  onSend={(x) => void handleSendDraft(x)}
                  onDiscard={(x) => void handleDiscardDraft(x)}
                />
              ))
            )}
          </div>
        ) : null}
      </div>

      {egg ? <EasterEggModal egg={egg} onClose={() => setEgg(null)} /> : null}
    </div>
  );
}
