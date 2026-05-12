import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../types';
import { getXingyeRoleProfileDisplay, useXingyeRoleProfile } from './xingye-profile-store';
import { MemoryCandidatePanel } from './MemoryCandidatePanel';
import { RelationshipStatePanel } from './RelationshipStatePanel';
import {
  listSecretSpaceRecords,
  type SecretSpaceCategoryId,
  type SecretSpaceRecordRef,
} from './xingye-secret-space-store';
import {
  createXingyeMemoryCandidate,
  importanceNumberFromLevel,
  XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS,
  XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT,
} from './xingye-memory-candidate-store';
import styles from './XingyeShell.module.css';

interface SecretSpacePanelProps {
  agent: Agent | null;
}

const CATEGORIES: { id: SecretSpaceCategoryId; title: string; description: string }[] = [
  { id: 'state', title: 'TA 的状态记录', description: '与情绪、关系快照相关的历史 JSON（主编辑仍使用上方关系模块）。' },
  { id: 'draft_reply', title: 'TA 的草稿箱', description: 'draft_reply 类记录，保存在当前工作区 .xingye 下。' },
  { id: 'dream', title: 'TA 的梦境', description: '象征化梦境碎片等历史记录。' },
  { id: 'saved_item', title: 'TA 收藏的东西', description: '收藏类历史记录。' },
  { id: 'unsent_moment', title: 'TA 未发送的朋友圈', description: '未发送动态草稿历史。' },
  { id: 'memory_fragment', title: '私藏回忆', description: '回忆碎片类历史记录。' },
];

function emptyByCategory(): Record<SecretSpaceCategoryId, SecretSpaceRecordRef[]> {
  return {
    state: [],
    draft_reply: [],
    dream: [],
    saved_item: [],
    unsent_moment: [],
    memory_fragment: [],
  };
}

export function SecretSpacePanel({ agent }: SecretSpacePanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);
  const [byCategory, setByCategory] = useState<Record<SecretSpaceCategoryId, SecretSpaceRecordRef[]>>(emptyByCategory);
  const [loading, setLoading] = useState(false);
  const [manualContent, setManualContent] = useState('');
  const [manualReason, setManualReason] = useState(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
  const [manualLevel, setManualLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [manualError, setManualError] = useState<string | null>(null);

  const loadRecords = useCallback(async () => {
    if (!agent?.id) {
      setByCategory(emptyByCategory());
      return;
    }
    setLoading(true);
    try {
      const next = emptyByCategory();
      await Promise.all(CATEGORIES.map(async (c) => {
        next[c.id] = await listSecretSpaceRecords(agent.id, c.id);
      }));
      setByCategory(next);
    } catch (err) {
      console.warn('[SecretSpacePanel] load records failed:', err);
      setByCategory(emptyByCategory());
    } finally {
      setLoading(false);
    }
  }, [agent?.id]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    const onRefresh = () => { void loadRecords(); };
    window.addEventListener('xingye-secret-space-changed', onRefresh);
    window.addEventListener('xingye-persistence-changed', onRefresh);
    return () => {
      window.removeEventListener('xingye-secret-space-changed', onRefresh);
      window.removeEventListener('xingye-persistence-changed', onRefresh);
    };
  }, [loadRecords]);

  useEffect(() => {
    if (!agent?.id) {
      setManualContent('');
      setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
      setManualLevel('medium');
      setManualError(null);
    }
  }, [agent?.id]);

  const handleCreateManualCandidate = () => {
    if (!agent?.id) return;
    setManualError(null);
    const content = manualContent.trim();
    if (!content) {
      setManualError('请填写候选记忆内容。');
      return;
    }
    try {
      createXingyeMemoryCandidate(agent.id, {
        content,
        reason: manualReason.trim() || XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT,
        importance: importanceNumberFromLevel(manualLevel),
        sourceDomain: 'secret_space',
        sourceId: 'manual-secret-space',
        target: 'pinned',
      });
      setManualContent('');
      setManualReason(XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT);
      setManualLevel('medium');
    } catch (e) {
      setManualError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!agent) {
    return (
      <div className={styles.panelInner}>
        <h2 className={styles.panelTitle}>秘密空间</h2>
        <p className={styles.panelDescription}>
          请在「角色」页选择一个角色后，再查看 TA 的状态与秘密空间占位内容。
        </p>
      </div>
    );
  }

  const displayProfile = getXingyeRoleProfileDisplay(agent, profile);

  return (
    <div className={styles.panelInner}>
      <h2 className={styles.panelTitle}>秘密空间</h2>
      <p className={styles.panelDescription}>
        角色侧隐藏内容：TA 的状态仍来自关系状态；下列分类展示已写入当前工作区 <code className={styles.inlineCode}>.xingye/</code> 的历史 JSON 记录（不经 OpenHanako 聊天管线）。
      </p>

      <div className={styles.secretSpaceStack}>
        <section className={styles.secretSpaceSection} aria-labelledby="secret-space-state-heading">
          <h3 id="secret-space-state-heading" className={styles.secretSpaceSectionTitle}>TA 的状态</h3>
          <RelationshipStatePanel agent={agent} profile={displayProfile} />
        </section>

        {CATEGORIES.map((cat) => (
          <section key={cat.id} className={styles.secretSpaceSection} aria-labelledby={`secret-cat-${cat.id}`}>
            <h3 id={`secret-cat-${cat.id}`} className={styles.secretSpaceSectionTitle}>{cat.title}</h3>
            <p className={styles.secretSpacePlaceholder}>{cat.description}</p>
            {cat.id === 'memory_fragment' ? (
              <div className={styles.profileForm} data-testid="secret-space-manual-candidate">
                <p className={styles.secretSpacePlaceholder} style={{ marginTop: 0 }}>
                  手动保存为「重要记忆候选」（仅工作区与列表；确认后写入 OpenHanako <code className={styles.inlineCode}>pinned.md</code>）。
                </p>
                <label className={styles.profileField}>
                  <span>候选记忆内容</span>
                  <textarea
                    value={manualContent}
                    onChange={(e) => setManualContent(e.target.value)}
                    rows={3}
                    placeholder="输入一条你希望记住的要点…"
                    aria-label="候选记忆内容"
                  />
                </label>
                <label className={styles.profileField}>
                  <span>重要度</span>
                  <select
                    value={manualLevel}
                    onChange={(e) => setManualLevel(e.target.value as 'low' | 'medium' | 'high')}
                    aria-label="候选记忆重要度"
                  >
                    {XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS.map((opt) => (
                      <option key={opt.level} value={opt.level}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.profileField}>
                  <span>理由</span>
                  <textarea
                    value={manualReason}
                    onChange={(e) => setManualReason(e.target.value)}
                    rows={2}
                    aria-label="候选记忆理由"
                  />
                </label>
                {manualError ? <p className={styles.saveStatus}>{manualError}</p> : null}
                <button type="button" className={styles.secondaryButton} onClick={handleCreateManualCandidate}>
                  创建候选记忆
                </button>
                <MemoryCandidatePanel agentId={agent.id} />
              </div>
            ) : null}
            {loading ? (
              <p className={styles.secretSpacePlaceholder}>加载中…</p>
            ) : byCategory[cat.id].length === 0 ? (
              <p className={styles.secretSpacePlaceholder}>暂无历史记录。</p>
            ) : (
              <ul className={styles.secretSpaceRecordList}>
                {byCategory[cat.id].map((rec) => (
                  <li key={rec.relativePath} className={styles.secretSpaceRecordItem}>
                    <span className={styles.secretSpaceRecordTitle}>{rec.title}</span>
                    <span className={styles.secretSpaceRecordMeta}>{rec.createdAt || ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
