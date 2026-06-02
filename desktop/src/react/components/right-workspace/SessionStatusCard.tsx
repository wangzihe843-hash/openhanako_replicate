/**
 * SessionStatusCard — 右侧「本次对话」状态卡（可收纳）
 *
 * desk 卡限高后填充下方，显示当前对话的工作目录 / 模型 / 文件数。
 * 无当前对话时返回 null（welcome 态不显示）。
 */
import { useState } from 'react';
import { useStore } from '../../stores';
import styles from './SessionStatusCard.module.css';
// @ts-expect-error — shared JS module
import { workspaceDisplayName } from '../../../../../shared/workspace-history.js';

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function SessionStatusCard() {
  const [collapsed, setCollapsed] = useState(false);
  const sessionPath = useStore((s) => s.currentSessionPath);
  const deskBasePath = useStore((s) => s.deskBasePath);
  const currentModel = useStore((s) => s.currentModel);
  const sessionModel = useStore((s) => (sessionPath ? s.sessionModelsByPath[sessionPath] : null));
  const filesCount = useStore((s) => (sessionPath ? (s.sessionRegistryFilesByPath[sessionPath]?.length ?? 0) : 0));
  const t = window.t ?? ((k: string) => k);

  if (!sessionPath) return null;

  const modelId = sessionModel?.id || currentModel?.id || '—';
  const cwd = deskBasePath ? workspaceDisplayName(deskBasePath, '—') : '—';

  return (
    <section className={`jian-card ${styles.card}`} aria-label={t('rightWorkspace.session.title')}>
      <button className={styles.header} type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
        <span className={styles.title}>{t('rightWorkspace.session.title')}</span>
        <Chevron open={!collapsed} />
      </button>
      {!collapsed && (
        <dl className={styles.body}>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.cwd')}</dt>
            <dd className={styles.value} title={deskBasePath || undefined}>{cwd}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.model')}</dt>
            <dd className={styles.value} title={modelId}>{modelId}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.files')}</dt>
            <dd className={styles.value}>{filesCount}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
