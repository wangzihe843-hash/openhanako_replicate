import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import type {
  XingyeMomentSeedComment,
  XingyeMomentSeedLike,
} from './xingye-moments-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

export type MomentComposerSubmitInput = {
  content: string;
  seedLikes?: ReadonlyArray<XingyeMomentSeedLike>;
  seedComments?: ReadonlyArray<XingyeMomentSeedComment>;
};

export type MomentComposerAiDraft = {
  content: string;
  seedLikes?: ReadonlyArray<XingyeMomentSeedLike>;
  seedComments?: ReadonlyArray<XingyeMomentSeedComment>;
};

/**
 * 父组件提供的 AI 草稿生成器。新增 `opts.existingContent` 入参：
 *   - 缺省 / 空：完整生成 content + likes + comments（首次点 AI 生成）
 *   - 非空：仅生成 likes / comments，content 由调用方逐字保留
 *
 * 用户已经在编辑框写了内容、又点了一次 AI 生成（想让 AI 帮忙拉互动者）的场景下，
 * 必须传 existingContent，否则模型会重新生成 content 把用户已有正文盖掉。
 */
export type MomentComposerAiDraftRequest = {
  existingContent?: string;
};

/** 发表身份：'user' = 用户本人（用户视角发朋友圈）；'agent' = 当前星野角色。 */
export type MomentComposerIdentityMode = 'user' | 'agent';

interface MomentComposerProps {
  agent: Agent | null;
  display: XingyeRoleProfileDisplay | null;
  /** 当前发表身份。 */
  identityMode: MomentComposerIdentityMode;
  onIdentityModeChange: (mode: MomentComposerIdentityMode) => void;
  /** 用户展示名（identityMode === 'user' 时作为作者展示）。 */
  userName: string;
  onSubmit: (input: MomentComposerSubmitInput) => Promise<void>;
  /** 可选：由父组件提供 AI 草稿生成器；仅在「以角色发表」时显示「AI 生成」按钮。 */
  onGenerateAiDraft?: (opts?: MomentComposerAiDraftRequest) => Promise<MomentComposerAiDraft>;
}

export function MomentComposer({
  agent,
  display,
  identityMode,
  onIdentityModeChange,
  userName,
  onSubmit,
  onGenerateAiDraft,
}: MomentComposerProps) {
  const [content, setContent] = useState('');
  const [seedLikes, setSeedLikes] = useState<XingyeMomentSeedLike[]>([]);
  const [seedComments, setSeedComments] = useState<XingyeMomentSeedComment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const isUser = identityMode === 'user';
  const trimmedContent = content.trim();
  // 以用户身份发表不需要选中角色；以角色身份发表才要求 agent 存在。
  const canSubmit = Boolean(trimmedContent) && (isUser || Boolean(agent)) && !submitting && !aiBusy;
  const canGenerate = !isUser && Boolean(agent && onGenerateAiDraft) && !submitting && !aiBusy;

  // 切换发帖 agent 时，缓存的 seed（含上一位 agent 的 virtual_contact 引用）必须清空，
  // 否则会把 A 的私人通讯录互动写到 B 的帖子里。
  useEffect(() => {
    setContent('');
    setSeedLikes([]);
    setSeedComments([]);
    setSubmitError(null);
    setAiError(null);
  }, [agent?.id]);

  // 切到「我自己」时，清掉角色 AI 生成缓存的 seed（那是角色私人通讯录里的互动者，
  // 与用户帖子无关——用户帖子的互动由发布后的角色扇出产生）。
  useEffect(() => {
    if (isUser) {
      setSeedLikes([]);
      setSeedComments([]);
      setAiError(null);
    }
  }, [isUser]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        content: trimmedContent,
        seedLikes: !isUser && seedLikes.length ? seedLikes : undefined,
        seedComments: !isUser && seedComments.length ? seedComments : undefined,
      });
      setContent('');
      setSeedLikes([]);
      setSeedComments([]);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGenerate = async () => {
    if (!canGenerate || !onGenerateAiDraft) return;
    setAiBusy(true);
    setAiError(null);
    /**
     * 用户已经写了正文 → 进 interactions-only 模式：把已有正文当 `existingContent` 传下去，
     * 父组件层（MomentsPanel）会再透传给 generateXingyeMomentDraftWithAI；AI fn 一侧的
     * prompt 切分支 + 收到结果后逐字 verbatim 覆盖 content。本地这里再做一道：拿到结果后
     * **不**回写 content state，只更新 seedLikes / seedComments。三道防线都断的话才会丢字。
     */
    const preservedContent = trimmedContent;
    const interactionsOnlyMode = preservedContent.length > 0;
    try {
      const draft = await onGenerateAiDraft(
        interactionsOnlyMode ? { existingContent: preservedContent } : undefined,
      );
      if (!interactionsOnlyMode) {
        const next = (draft?.content ?? '').slice(0, 600);
        if (next) setContent(next);
      }
      setSeedLikes(draft?.seedLikes ? [...draft.seedLikes] : []);
      setSeedComments(draft?.seedComments ? [...draft.seedComments] : []);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  };

  const resolvedUserName = (userName ?? '').trim() || '我';
  const userInitial = resolvedUserName.slice(0, 1);
  const identityName = isUser
    ? resolvedUserName
    : display?.displayName ?? agent?.name ?? '未选择角色';
  const identitySub = isUser ? '我自己' : display?.relationshipLabel ?? '关系未设置';
  const placeholder = isUser
    ? '写下这一刻的想法，分享到朋友圈…'
    : agent
      ? '写下这一刻的想法...'
      : '请先选择一个星野角色';

  return (
    <section className={styles.momentComposer} aria-label="发朋友圈">
      <div className={styles.momentComposerAvatar}>
        {isUser ? (
          <span>{userInitial}</span>
        ) : agent ? (
          <XingyeAgentAvatar agent={agent} alt={display?.displayName ?? agent.name} />
        ) : (
          <span>未</span>
        )}
      </div>

      <div className={styles.momentComposerBody}>
        <div
          className={styles.momentComposerIdentitySwitch}
          role="radiogroup"
          aria-label="发表身份"
        >
          <button
            type="button"
            role="radio"
            aria-checked={isUser}
            className={isUser ? styles.momentIdentityChipActive : styles.momentIdentityChip}
            disabled={submitting || aiBusy}
            onClick={() => onIdentityModeChange('user')}
          >
            以我自己发表
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!isUser}
            className={!isUser ? styles.momentIdentityChipActive : styles.momentIdentityChip}
            disabled={submitting || aiBusy || !agent}
            title={agent ? '以当前角色身份发表' : '没有可用角色'}
            onClick={() => onIdentityModeChange('agent')}
          >
            以角色发表
          </button>
        </div>

        <div className={styles.momentComposerHeader}>
          <div className={styles.momentComposerIdentity}>
            <strong>{identityName}</strong>
            <span>{identitySub}</span>
          </div>
          <span className={styles.momentComposerCounter}>{trimmedContent.length}/600</span>
        </div>

        <textarea
          value={content}
          onChange={event => setContent(event.target.value.slice(0, 600))}
          placeholder={placeholder}
          rows={4}
          disabled={(!isUser && !agent) || submitting || aiBusy}
          className={styles.momentComposerInput}
        />

        {submitError ? (
          <p className={styles.momentComposerError} role="alert">
            {submitError}
          </p>
        ) : null}
        {aiError ? (
          <p className={styles.momentComposerError} role="alert">
            AI 生成失败：{aiError}
          </p>
        ) : null}

        <div className={styles.momentComposerFooter}>
          <span>
            {isUser
              ? '发布后，关系够好的角色大概率会来点赞评论'
              : '图片上传暂未接入，imageUrls 字段已预留'}
          </span>
          <div className={styles.momentComposerActions}>
            {!isUser && onGenerateAiDraft ? (
              <button
                type="button"
                className={styles.momentComposerGhostButton}
                disabled={!canGenerate}
                onClick={() => { void handleGenerate(); }}
                title={
                  trimmedContent.length > 0
                    ? '保留当前正文，仅基于正文生成围观点赞与评论'
                    : '从最近聊天 / 角色状态生成完整朋友圈草稿（含点赞评论）'
                }
              >
                {aiBusy
                  ? '生成中…'
                  : (trimmedContent.length > 0 ? 'AI 生成互动' : 'AI 生成')}
              </button>
            ) : null}
            <button type="button" disabled={!canSubmit} onClick={() => { void handleSubmit(); }}>
              {submitting ? '发表中…' : '发表'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
