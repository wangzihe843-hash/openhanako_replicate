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

interface MomentComposerProps {
  agent: Agent | null;
  display: XingyeRoleProfileDisplay | null;
  onSubmit: (input: MomentComposerSubmitInput) => Promise<void>;
  /** 可选：由父组件提供 AI 草稿生成器；若缺省则不显示「AI 生成」按钮。 */
  onGenerateAiDraft?: () => Promise<MomentComposerAiDraft>;
}

export function MomentComposer({ agent, display, onSubmit, onGenerateAiDraft }: MomentComposerProps) {
  const [content, setContent] = useState('');
  const [seedLikes, setSeedLikes] = useState<XingyeMomentSeedLike[]>([]);
  const [seedComments, setSeedComments] = useState<XingyeMomentSeedComment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const trimmedContent = content.trim();
  const canSubmit = Boolean(agent && trimmedContent) && !submitting && !aiBusy;
  const canGenerate = Boolean(agent && onGenerateAiDraft) && !submitting && !aiBusy;

  // 切换发帖 agent 时，缓存的 seed（含上一位 agent 的 virtual_contact 引用）必须清空，
  // 否则会把 A 的私人通讯录互动写到 B 的帖子里。
  useEffect(() => {
    setContent('');
    setSeedLikes([]);
    setSeedComments([]);
    setSubmitError(null);
    setAiError(null);
  }, [agent?.id]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        content: trimmedContent,
        seedLikes: seedLikes.length ? seedLikes : undefined,
        seedComments: seedComments.length ? seedComments : undefined,
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
    try {
      const draft = await onGenerateAiDraft();
      const next = (draft?.content ?? '').slice(0, 600);
      if (next) setContent(next);
      setSeedLikes(draft?.seedLikes ? [...draft.seedLikes] : []);
      setSeedComments(draft?.seedComments ? [...draft.seedComments] : []);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <section className={styles.momentComposer} aria-label="发朋友圈">
      <div className={styles.momentComposerAvatar}>
        {agent ? (
          <XingyeAgentAvatar agent={agent} alt={display?.displayName ?? agent.name} />
        ) : (
          <span>未</span>
        )}
      </div>

      <div className={styles.momentComposerBody}>
        <div className={styles.momentComposerHeader}>
          <div className={styles.momentComposerIdentity}>
            <strong>{display?.displayName ?? agent?.name ?? '未选择角色'}</strong>
            <span>{display?.relationshipLabel ?? '关系未设置'}</span>
          </div>
          <span className={styles.momentComposerCounter}>{trimmedContent.length}/600</span>
        </div>

        <textarea
          value={content}
          onChange={event => setContent(event.target.value.slice(0, 600))}
          placeholder={agent ? '写下这一刻的想法...' : '请先选择一个星野角色'}
          rows={4}
          disabled={!agent || submitting || aiBusy}
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
          <span>图片上传暂未接入，imageUrls 字段已预留</span>
          <div className={styles.momentComposerActions}>
            {onGenerateAiDraft ? (
              <button
                type="button"
                className={styles.momentComposerGhostButton}
                disabled={!canGenerate}
                onClick={() => { void handleGenerate(); }}
              >
                {aiBusy ? '生成中…' : 'AI 生成'}
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
