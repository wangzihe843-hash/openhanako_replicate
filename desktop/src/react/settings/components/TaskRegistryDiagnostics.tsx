import React from 'react';
import { t } from '../helpers';
import styles from './TaskRegistryDiagnostics.module.css';

export interface RegistryTaskSnapshot {
  taskId: string;
  type: string;
  status?: string;
  error?: string | null;
  updatedAt?: number;
  progress?: { current?: number; total?: number; percent?: number; message?: string } | null;
  meta?: { summary?: unknown };
}

const STATUS_KEYS: Record<string, string> = {
  pending: 'taskPending', running: 'taskRunning', paused: 'taskPaused',
  blocked: 'taskBlocked', recovering: 'taskRecovering', completed: 'taskCompleted',
  failed: 'taskFailed', canceled: 'taskCanceled', aborted: 'taskAborted',
};

function timestamp(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return t('settings.plugins.taskUnknownTime');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t('settings.plugins.taskUnknownTime') : date.toLocaleString();
}

function progressText(progress: RegistryTaskSnapshot['progress']): string {
  if (!progress) return '';
  if (Number.isFinite(progress.current) && Number.isFinite(progress.total)) {
    return `${progress.current} / ${progress.total}`;
  }
  if (Number.isFinite(progress.percent)) return `${progress.percent}%`;
  return '';
}

export function TaskRegistryDiagnostics({ tasks, fetchedAt, refreshFailed }: {
  tasks: RegistryTaskSnapshot[];
  fetchedAt: number | null;
  refreshFailed: boolean;
}) {
  return (
    <section className={styles.tasks} aria-label={t('settings.plugins.taskTitle')}>
      <h3 className={styles.title}>{t('settings.plugins.taskTitle')}</h3>
      <p className={styles.note}>{t('settings.plugins.taskScope')}</p>
      <p className={styles.note}>{t('settings.plugins.taskSnapshot', { time: timestamp(fetchedAt ?? undefined) })}</p>
      {refreshFailed && <p role="alert" className={styles.error}>{t('settings.plugins.taskRefreshFailed')}</p>}
      {tasks.length === 0 ? <p className={styles.note}>{t('settings.plugins.taskEmpty')}</p> : (
        <ul className={styles.list}>
          {tasks.map(task => {
            const knownStatus = Object.hasOwn(STATUS_KEYS, task.status ?? '') ? STATUS_KEYS[task.status!] : 'taskUnknown';
            const progress = progressText(task.progress);
            const summary = typeof task.meta?.summary === 'string' && task.meta.summary.trim()
              ? task.meta.summary : task.taskId;
            return (
              <li key={task.taskId} className={styles.task}>
                <div className={styles.heading}>
                  <strong>{summary}</strong>
                  <span className={styles.status} data-status={task.status}>{t(`settings.plugins.${knownStatus}`)}</span>
                </div>
                <p className={styles.note}>{task.taskId} · {task.type}{knownStatus === 'taskUnknown' && task.status ? ` · ${task.status}` : ''}</p>
                <p className={styles.note}>{t('settings.plugins.taskUpdated', { time: timestamp(task.updatedAt) })}</p>
                {progress && <p>{t('settings.plugins.taskProgress', { progress })}</p>}
                {task.progress?.message && <p>{task.progress.message}</p>}
                {task.error && <p className={task.status === 'failed' ? styles.error : undefined}>{task.error}</p>}
                {task.status === 'blocked' && !task.error && !task.progress?.message && <p>{t('settings.plugins.taskNoReason')}</p>}
                {task.status === 'completed' && <p className={styles.note}>{t('settings.plugins.taskCompletionNote')}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
