import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../types';
import { getXingyeRoleProfileDisplay, useXingyeRoleProfile } from './xingye-profile-store';
import { RelationshipStatePanel } from './RelationshipStatePanel';
import {
  listSecretSpaceRecords,
  type SecretSpaceCategoryId,
  type SecretSpaceRecordRef,
} from './xingye-secret-space-store';
import styles from './XingyeShell.module.css';

interface SecretSpacePanelProps {
  agent: Agent | null;
}

const CATEGORIES: { id: SecretSpaceCategoryId; title: string; description: string }[] = [
  { id: 'draft_reply', title: 'TA 的草稿箱', description: 'draft_reply 类生成记录，保存在当前工作区 .xingye 下。' },
  { id: 'dream', title: 'TA 的梦境', description: '象征化梦境碎片等历史记录。' },
  { id: 'saved_item', title: 'TA 收藏的东西', description: '收藏类历史记录。' },
  { id: 'unsent_moment', title: 'TA 未发送的朋友圈', description: '未发送动态草稿历史。' },
  { id: 'memory_fragment', title: '私藏回忆', description: '回忆碎片类历史记录。' },
];

function emptyByCategory(): Record<SecretSpaceCategoryId, SecretSpaceRecordRef[]> {
  return {
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
