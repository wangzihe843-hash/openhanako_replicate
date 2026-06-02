/**
 * WorkflowInlineCard — 聊天流里的 workflow 概览块（信息架构：inline 只给「大概状态」）
 *
 * 复刻 subagent inline 块「状态随 block_update 翻」的机制，但刻意精简：只显示
 * workflow 名 + 状态图标 + 时长，不订阅 streamKey、不展开实时流（详细节点分布在右侧 WorkflowCard）。
 */
import { memo, useEffect, useState } from 'react';
import { formatElapsed } from '../../utils/format-duration';
import styles from './WorkflowInlineCard.module.css';

interface WorkflowInlineCardProps {
  block: {
    taskId: string;
    taskTitle: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted';
    summary?: string;
    startedAt?: number | null;
    finishedAt?: number | null;
  };
}

const STATUS_ICON: Record<string, string> = {
  running: '◐',
  done: '✓',
  failed: '✗',
  aborted: '⊘',
};

export const WorkflowInlineCard = memo(function WorkflowInlineCard({ block }: WorkflowInlineCardProps) {
  const t: (k: string, v?: Record<string, string | number>) => string = window.t ?? ((k: string) => k);
  const running = block.streamStatus === 'running';
  const [now, setNow] = useState(() => Date.now());

  // running 时每秒刷新「已运行」时长；终态不开定时器，卸载即清理。
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  let duration = '';
  if (running && block.startedAt) {
    duration = t('rightWorkspace.workflow.running', { text: formatElapsed(now - block.startedAt) });
  } else if (block.finishedAt && block.startedAt) {
    duration = t('activity.duration', { text: formatElapsed(block.finishedAt - block.startedAt) });
  }

  return (
    <div className={styles.card}>
      <span className={`${styles.icon} ${styles[block.streamStatus] ?? ''}`} aria-hidden="true">
        {STATUS_ICON[block.streamStatus] ?? '◦'}
      </span>
      <span className={styles.title}>{block.taskTitle || t('rightWorkspace.workflow.title')}</span>
      {duration && <span className={styles.duration}>{duration}</span>}
    </div>
  );
});
