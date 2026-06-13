/**
 * 「秘密空间 · TA 的论坛小号」mini-app。
 *
 * 通用现代论坛风（版块 + 话题；评论平铺 + 一层嵌套回复；无楼层）。菜单栏：主页 / 个人中心。
 *  - 主页：当前小号的 feed —— TA 自己发的帖 + TA 评论过的帖（每帖 3-5 条评论含嵌套回复）；点开看详情。
 *  - 个人中心：小号资料 + 切换/新建小号 + 私信（来自 TA 互动过的 NPC）；点开看对话。
 *
 * 数据全部 agent 维度，经 xingye-forum-store 持久化；首开自动 bootstrap，刷新/建号走增量生成。
 * reload 带 reloadSeqRef 守卫，防切角色竞态串读（domain_xingye_persistence_invariants）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import { useXingyeRoleProfile } from './xingye-profile-store';
import {
  appendForumAccount,
  appendForumPosts,
  appendForumThreads,
  listForumAccounts,
  listForumPosts,
  listForumThreads,
  markForumInitialized,
  readForumMeta,
} from './xingye-forum-store';
import { generateForumBootstrap, generateForumBatch } from './xingye-forum-ai';
import type {
  ForumAccount,
  ForumComment,
  ForumPost,
  ForumThread,
} from './xingye-forum-types';
import { XingyeCpBoard } from './XingyeCpBoard';
import styles from './XingyeForumApp.module.css';

interface XingyeForumAppProps {
  agent: Agent;
  onBack: () => void;
}

type ForumTab = 'home' | 'me';

// ── 展示用小工具 ──────────────────────────────────────────────────────────────

const AVATAR_HUES = [210, 280, 340, 12, 40, 150, 190, 96] as const;

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function avatarStyle(seed: string): { background: string } {
  const hue = AVATAR_HUES[hashSeed(seed) % AVATAR_HUES.length];
  return { background: `hsl(${hue} 58% 62%)` };
}

function avatarText(name: string): string {
  const n = name.replace(/^@/, '').trim();
  if (!n) return '?';
  // 取末尾 1-2 个字符更像论坛头像（避免都是「小」「大」开头撞脸）
  return n.length <= 2 ? n : n.slice(-2);
}

export function formatRelative(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天前`;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

// ── 子组件 ────────────────────────────────────────────────────────────────────

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      className={styles.avatar}
      style={{ ...avatarStyle(name), width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden
    >
      {avatarText(name)}
    </span>
  );
}

function PostCard({
  post,
  now,
  onOpen,
}: {
  post: ForumPost;
  now: number;
  onOpen: (postId: string) => void;
}) {
  const isAuthored = post.relation === 'authored';
  return (
    <button type="button" className={styles.postCard} onClick={() => onOpen(post.postId)} data-testid={`forum-post-${post.postId}`}>
      <div className={styles.postCardHead}>
        <span className={styles.boardTag}>{post.board}</span>
        <span className={`${styles.relationTag} ${isAuthored ? styles.relationAuthored : styles.relationCommented}`}>
          {isAuthored ? '发帖' : '评论了'}
        </span>
      </div>
      <div className={styles.postCardTitle}>{post.title}</div>
      <div className={styles.postCardBody}>{post.body}</div>
      <div className={styles.postCardMeta}>
        <span className={styles.postCardAuthor}>
          {isAuthored ? post.authorName : `@${post.authorName}`}
        </span>
        <span className={styles.postCardStats}>
          <span>👁 {formatCount(post.stats.views)}</span>
          <span>👍 {formatCount(post.stats.likes)}</span>
          <span>💬 {post.comments.length}</span>
          <span>{formatRelative(post.postedAt, now)}</span>
        </span>
      </div>
    </button>
  );
}

function CommentItem({
  comment,
  accountUsername,
  now,
}: {
  comment: ForumComment;
  accountUsername: string;
  now: number;
}) {
  const renderName = (name: string, isAgent: boolean) => (
    <span className={`${styles.commentName} ${isAgent ? styles.commentNameAgent : ''}`}>
      {isAgent ? accountUsername : name}
      {isAgent ? <span className={styles.meBadge}>我</span> : null}
    </span>
  );
  return (
    <div className={styles.comment} data-testid={`forum-comment-${comment.commentId}`}>
      <Avatar name={comment.authorIsAgent ? accountUsername : comment.authorName} size={32} />
      <div className={styles.commentBody}>
        <div className={styles.commentTop}>
          {renderName(comment.authorName, comment.authorIsAgent)}
          <span className={styles.commentTime}>{formatRelative(comment.postedAt, now)}</span>
        </div>
        <div className={styles.commentText}>{comment.body}</div>
        <div className={styles.commentFoot}>
          <span>👍 {comment.likes}</span>
        </div>
        {comment.replies.length > 0 ? (
          <div className={styles.replyList}>
            {comment.replies.map((reply) => (
              <div className={styles.reply} key={reply.replyId}>
                {renderName(reply.authorName, reply.authorIsAgent)}
                {reply.toName ? <span className={styles.replyTo}> 回复 @{reply.toName}</span> : null}
                <span className={styles.replyText}>：{reply.body}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 主页 feed 下方的「你和 TA 的 CP」入口卡（点开进 CP 子板）。 */
function CpEntryCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className={styles.cpEntryCard} onClick={onOpen} data-testid="forum-cp-entry">
      <span className={styles.cpEntryHeart} aria-hidden>
        ♡
      </span>
      <span className={styles.cpEntryText}>
        <span className={styles.cpEntryTitle}>你和 TA 的 CP</span>
        <span className={styles.cpEntrySub}>TA 偷偷关注的板块 · 有人在磕你俩</span>
      </span>
      <span className={styles.cpEntryArrow} aria-hidden>
        ›
      </span>
    </button>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

export function XingyeForumApp({ agent, onBack }: XingyeForumAppProps) {
  const profile = useXingyeRoleProfile(agent.id);

  const [accounts, setAccounts] = useState<ForumAccount[]>([]);
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [threads, setThreads] = useState<ForumThread[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [tab, setTab] = useState<ForumTab>('home');
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  /** 是否进入「你和 TA 的 CP」子板（独立全屏视图，入口在主页 feed 下方）。 */
  const [cpOpen, setCpOpen] = useState(false);

  const [loading, setLoading] = useState(false);
  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  const reloadSeqRef = useRef(0);
  const initialBootstrapTriedRef = useRef<string | null>(null);
  const now = Date.now();

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    if (!agent.id) return;
    setLoading(true);
    try {
      const [a, p, t] = await Promise.all([
        listForumAccounts(agent.id),
        listForumPosts(agent.id),
        listForumThreads(agent.id),
      ]);
      if (seq !== reloadSeqRef.current) return; // 被更晚一轮取代，丢弃
      setAccounts(a);
      setPosts(p);
      setThreads(t);
      setActiveAccountId((prev) => (prev && a.some((x) => x.accountId === prev) ? prev : a[0]?.accountId ?? null));
    } catch (err) {
      if (seq !== reloadSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reloadSeqRef.current) setLoading(false);
    }
  }, [agent.id]);

  // 切角色：清状态 + 重置 bootstrap 守卫，再 reload。
  useEffect(() => {
    setAccounts([]);
    setPosts([]);
    setThreads([]);
    setActiveAccountId(null);
    setTab('home');
    setSelectedPostId(null);
    setSelectedThreadId(null);
    setCpOpen(false);
    setError(null);
    setAiError(null);
    setAiNotice(null);
    initialBootstrapTriedRef.current = null;
    void reload();
  }, [reload]);

  // 监听心跳等外部追加，自动刷新。
  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail as { agentId?: string } | undefined;
      if (detail?.agentId === agent.id) void reload();
    };
    window.addEventListener('xingye-forum-changed', onChanged);
    return () => window.removeEventListener('xingye-forum-changed', onChanged);
  }, [agent.id, reload]);

  const handleBootstrap = useCallback(async () => {
    if (!agent.id || bootstrapBusy) return;
    setBootstrapBusy(true);
    setAiError(null);
    try {
      const out = await generateForumBootstrap({ agent, ownerProfile: profile });
      await appendForumAccount(agent.id, out.account);
      if (out.posts.length) await appendForumPosts(agent.id, out.posts);
      if (out.threads.length) await appendForumThreads(agent.id, out.threads);
      await markForumInitialized(agent.id, new Date().toISOString());
      setActiveAccountId(out.account.accountId);
      setTab('home');
      await reload();
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setBootstrapBusy(false);
    }
  }, [agent, profile, bootstrapBusy, reload]);

  // 首开自动 bootstrap：每角色一次；已初始化（含曾被清空）则不再自动生成。
  useEffect(() => {
    if (loading || bootstrapBusy) return;
    if (accounts.length > 0) return;
    if (initialBootstrapTriedRef.current === agent.id) return;
    let cancelled = false;
    void (async () => {
      const meta = await readForumMeta(agent.id);
      if (cancelled) return;
      if (meta?.initializedAt) return; // 之前生成过又被清空——尊重，不自动重灌
      if (initialBootstrapTriedRef.current === agent.id) return;
      initialBootstrapTriedRef.current = agent.id;
      void handleBootstrap();
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.id, accounts.length, loading, bootstrapBusy, handleBootstrap]);

  const activeAccount = useMemo(
    () => accounts.find((a) => a.accountId === activeAccountId) ?? accounts[0] ?? null,
    [accounts, activeAccountId],
  );

  const activePosts = useMemo(
    () => (activeAccount ? posts.filter((p) => p.accountId === activeAccount.accountId) : []),
    [posts, activeAccount],
  );
  const activeThreads = useMemo(
    () => (activeAccount ? threads.filter((t) => t.accountId === activeAccount.accountId) : []),
    [threads, activeAccount],
  );

  const selectedPost = useMemo(
    () => activePosts.find((p) => p.postId === selectedPostId) ?? null,
    [activePosts, selectedPostId],
  );
  const selectedThread = useMemo(
    () => activeThreads.find((t) => t.threadId === selectedThreadId) ?? null,
    [activeThreads, selectedThreadId],
  );

  const runBatch = useCallback(
    async (forceNewAccount: boolean) => {
      if (!agent.id || !activeAccount || batchBusy) return;
      setBatchBusy(true);
      setAiError(null);
      setAiNotice(null);
      try {
        const out = await generateForumBatch({
          agent,
          ownerProfile: profile,
          activeAccount,
          existingAccounts: accounts,
          recentPosts: activePosts.slice(0, 12),
          forceNewAccount,
        });
        if (out.newAccount) await appendForumAccount(agent.id, out.newAccount);
        if (out.posts.length) await appendForumPosts(agent.id, out.posts);
        if (out.threads.length) await appendForumThreads(agent.id, out.threads);
        await reload();
        if (out.newAccount) {
          setActiveAccountId(out.newAccount.accountId);
          setTab('home');
          setSelectedPostId(null);
          setAiNotice(`TA 新开了一个小号 @${out.newAccount.username}`);
        } else if (forceNewAccount) {
          setAiNotice('这次没有新开号，新动态先记到了当前小号');
        } else if (!out.posts.length) {
          setAiError('这次没生成出新内容，再试一次');
        }
      } catch (err) {
        setAiError(err instanceof Error ? err.message : String(err));
      } finally {
        setBatchBusy(false);
      }
    },
    [agent, profile, activeAccount, accounts, activePosts, batchBusy, reload],
  );

  const switchAccount = (accountId: string) => {
    setActiveAccountId(accountId);
    setSelectedPostId(null);
    setSelectedThreadId(null);
    setAiNotice(null);
    setAiError(null);
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  // 「你和 TA 的 CP」是论坛的独立子板：进入后全屏接管，返回回到论坛。
  // 入口在主页 feed 下方，但即便没有小号也可独立使用（CP 板自带临时马甲）。
  if (cpOpen) {
    return (
      <XingyeCpBoard
        agent={agent}
        ownerProfile={profile}
        forumAccounts={accounts}
        onBack={() => setCpOpen(false)}
      />
    );
  }

  const headerTitle = activeAccount ? `@${activeAccount.username}` : 'TA 的论坛小号';

  return (
    <div className={styles.forumApp} data-testid="xingye-forum-app">
      <div className={styles.topBar}>
        <button type="button" className={styles.backBtn} onClick={onBack} data-testid="forum-back">
          ‹ 秘密空间
        </button>
        <div className={styles.topTitle}>{headerTitle}</div>
        <div className={styles.topBarSpacer} />
      </div>

      <div className={styles.tabBar} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'home'}
          className={`${styles.tab} ${tab === 'home' ? styles.tabActive : ''}`}
          onClick={() => setTab('home')}
          data-testid="forum-tab-home"
        >
          主页
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'me'}
          className={`${styles.tab} ${tab === 'me' ? styles.tabActive : ''}`}
          onClick={() => setTab('me')}
          data-testid="forum-tab-me"
        >
          个人中心
        </button>
      </div>

      {aiNotice ? <div className={styles.noticeBanner} data-testid="forum-notice">{aiNotice}</div> : null}
      {aiError ? <div className={styles.errorBanner} data-testid="forum-error">{aiError}</div> : null}

      {bootstrapBusy ? (
        <div className={styles.overlay} data-testid="forum-bootstrap-busy">
          <div className={styles.spinner} />
          <p>正在生成 TA 的论坛小号…</p>
        </div>
      ) : null}

      <div className={styles.body}>
        {!activeAccount && !bootstrapBusy && !loading ? (
          <div className={styles.empty}>
            <p>{error ? `加载失败：${error}` : 'TA 还没有论坛小号'}</p>
            <button type="button" className={styles.primaryBtn} onClick={() => void handleBootstrap()} data-testid="forum-create-first">
              生成一个小号
            </button>
            <CpEntryCard onOpen={() => setCpOpen(true)} />
          </div>
        ) : null}

        {activeAccount && tab === 'home' ? (
          selectedPost ? (
            <PostDetail
              post={selectedPost}
              account={activeAccount}
              now={now}
              onBack={() => setSelectedPostId(null)}
            />
          ) : (
            <div className={styles.feed} data-testid="forum-feed">
              <div className={styles.feedHead}>
                <div className={styles.feedAccountChip}>
                  <Avatar name={activeAccount.avatarSeed} size={28} />
                  <span>@{activeAccount.username}</span>
                  <span className={styles.themeChip}>{activeAccount.themeLabel}</span>
                </div>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => void runBatch(false)}
                  disabled={batchBusy}
                  data-testid="forum-refresh"
                >
                  {batchBusy ? '刷新中…' : '换一批 / 刷新'}
                </button>
              </div>
              {activePosts.length === 0 ? (
                <div className={styles.empty}>
                  <p>这个小号还没有动态</p>
                </div>
              ) : (
                activePosts.map((post) => (
                  <PostCard key={post.postId} post={post} now={now} onOpen={setSelectedPostId} />
                ))
              )}
              <CpEntryCard onOpen={() => setCpOpen(true)} />
            </div>
          )
        ) : null}

        {activeAccount && tab === 'me' ? (
          selectedThread ? (
            <ThreadDetail
              thread={selectedThread}
              account={activeAccount}
              onBack={() => setSelectedThreadId(null)}
            />
          ) : (
            <ProfileCenter
              account={activeAccount}
              accounts={accounts}
              postCount={activePosts.length}
              threads={activeThreads}
              now={now}
              batchBusy={batchBusy}
              onSwitchAccount={switchAccount}
              onNewAccount={() => void runBatch(true)}
              onOpenThread={setSelectedThreadId}
            />
          )
        ) : null}
      </div>
    </div>
  );
}

// ── 帖子详情 ──────────────────────────────────────────────────────────────────

function PostDetail({
  post,
  account,
  now,
  onBack,
}: {
  post: ForumPost;
  account: ForumAccount;
  now: number;
  onBack: () => void;
}) {
  const isAuthored = post.relation === 'authored';
  return (
    <div className={styles.detail} data-testid="forum-post-detail">
      <button type="button" className={styles.detailBack} onClick={onBack}>
        ‹ 返回主页
      </button>
      <div className={styles.boardTag}>{post.board}</div>
      <h3 className={styles.detailTitle}>{post.title}</h3>
      <div className={styles.detailAuthorRow}>
        <Avatar name={isAuthored ? account.avatarSeed : post.authorName} size={36} />
        <div>
          <div className={styles.detailAuthorName}>
            {isAuthored ? account.username : post.authorName}
            {isAuthored ? <span className={styles.meBadge}>楼主 · 我</span> : null}
          </div>
          <div className={styles.detailAuthorTime}>{formatRelative(post.postedAt, now)}</div>
        </div>
      </div>
      <div className={styles.detailBody}>{post.body}</div>
      <div className={styles.detailStats}>
        <span>👁 {formatCount(post.stats.views)}</span>
        <span>👍 {formatCount(post.stats.likes)}</span>
        <span>💬 {post.comments.length} 条评论</span>
      </div>
      {!isAuthored ? (
        <div className={styles.commentedHint}>TA（@{account.username}）在这条帖子下评论过</div>
      ) : null}
      <div className={styles.commentsHeader}>全部评论</div>
      <div className={styles.commentList}>
        {post.comments.map((c) => (
          <CommentItem key={c.commentId} comment={c} accountUsername={account.username} now={now} />
        ))}
      </div>
    </div>
  );
}

// ── 个人中心 ──────────────────────────────────────────────────────────────────

function ProfileCenter({
  account,
  accounts,
  postCount,
  threads,
  now,
  batchBusy,
  onSwitchAccount,
  onNewAccount,
  onOpenThread,
}: {
  account: ForumAccount;
  accounts: ForumAccount[];
  postCount: number;
  threads: ForumThread[];
  now: number;
  batchBusy: boolean;
  onSwitchAccount: (accountId: string) => void;
  onNewAccount: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  return (
    <div className={styles.profileCenter} data-testid="forum-profile-center">
      <div className={styles.profileCard}>
        <Avatar name={account.avatarSeed} size={56} />
        <div className={styles.profileInfo}>
          <div className={styles.profileName}>
            @{account.username}
            <span className={styles.themeChip}>{account.themeLabel}</span>
          </div>
          <div className={styles.profileBio}>{account.bio}</div>
          <div className={styles.profileStats}>
            <span><b>{postCount}</b> 帖子</span>
            <span><b>{formatCount(account.stats.followers)}</b> 粉丝</span>
            <span><b>{formatCount(account.stats.following)}</b> 关注</span>
          </div>
        </div>
      </div>

      <div className={styles.sectionLabel}>切换小号</div>
      <div className={styles.accountSwitcher} data-testid="forum-account-switcher">
        {accounts.map((a) => (
          <button
            type="button"
            key={a.accountId}
            className={`${styles.accountChip} ${a.accountId === account.accountId ? styles.accountChipActive : ''}`}
            onClick={() => onSwitchAccount(a.accountId)}
            data-testid={`forum-account-chip-${a.accountId}`}
          >
            <Avatar name={a.avatarSeed} size={26} />
            <span className={styles.accountChipName}>@{a.username}</span>
          </button>
        ))}
        <button
          type="button"
          className={styles.accountChipNew}
          onClick={onNewAccount}
          disabled={batchBusy}
          data-testid="forum-new-account"
        >
          {batchBusy ? '…' : '＋ 建号'}
        </button>
      </div>

      <div className={styles.sectionLabel}>私信</div>
      <div className={styles.threadList} data-testid="forum-thread-list">
        {threads.length === 0 ? (
          <div className={styles.emptyInline}>还没有私信</div>
        ) : (
          threads.map((t) => {
            const last = t.messages[t.messages.length - 1];
            const originHint =
              t.originKind === 'commented_post_author'
                ? '你评论过 ta 的帖'
                : '帖子评论区聊过';
            return (
              <button
                type="button"
                key={t.threadId}
                className={styles.threadRow}
                onClick={() => onOpenThread(t.threadId)}
                data-testid={`forum-thread-${t.threadId}`}
              >
                <Avatar name={t.peerAvatarSeed} size={40} />
                <div className={styles.threadRowMid}>
                  <div className={styles.threadRowTop}>
                    <span className={styles.threadPeer}>{t.peerName}</span>
                    <span className={styles.threadTime}>{formatRelative(t.lastMessageAt, now)}</span>
                  </div>
                  <div className={styles.threadPreview}>
                    {last ? `${last.sender === 'agent' ? '我：' : ''}${last.body}` : ''}
                  </div>
                  <div className={styles.threadOrigin}>{originHint}</div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── 私信对话 ──────────────────────────────────────────────────────────────────

function ThreadDetail({
  thread,
  account,
  onBack,
}: {
  thread: ForumThread;
  account: ForumAccount;
  onBack: () => void;
}) {
  return (
    <div className={styles.detail} data-testid="forum-thread-detail">
      <button type="button" className={styles.detailBack} onClick={onBack}>
        ‹ 返回个人中心
      </button>
      <div className={styles.dmHeader}>
        <Avatar name={thread.peerAvatarSeed} size={36} />
        <div>
          <div className={styles.dmPeer}>{thread.peerName}</div>
          {thread.originPostTitle ? (
            <div className={styles.dmOrigin}>缘起：「{thread.originPostTitle}」</div>
          ) : null}
        </div>
      </div>
      <div className={styles.dmThread}>
        {thread.messages.map((m) => (
          <div
            key={m.messageId}
            className={`${styles.dmRow} ${m.sender === 'agent' ? styles.dmRowMe : styles.dmRowPeer}`}
          >
            {m.sender === 'peer' ? <Avatar name={thread.peerAvatarSeed} size={30} /> : null}
            <div className={styles.dmBubble}>{m.body}</div>
            {m.sender === 'agent' ? <Avatar name={account.avatarSeed} size={30} /> : null}
          </div>
        ))}
      </div>
      <div className={styles.dmFootHint}>这是 TA 这个小号收到的私信（你在翻看）</div>
    </div>
  );
}
