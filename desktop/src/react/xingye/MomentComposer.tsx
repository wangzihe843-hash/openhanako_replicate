import { useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

interface MomentComposerProps {
  agent: Agent | null;
  display: XingyeRoleProfileDisplay | null;
  onSubmit: (content: string) => void;
}

export function MomentComposer({ agent, display, onSubmit }: MomentComposerProps) {
  const [content, setContent] = useState('');
  const trimmedContent = content.trim();
  const canSubmit = Boolean(agent && trimmedContent);

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(trimmedContent);
    setContent('');
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
          disabled={!agent}
          className={styles.momentComposerInput}
        />

        <div className={styles.momentComposerFooter}>
          <span>图片上传暂未接入，imageUrls 字段已预留</span>
          <button type="button" disabled={!canSubmit} onClick={handleSubmit}>
            发表
          </button>
        </div>
      </div>
    </section>
  );
}
