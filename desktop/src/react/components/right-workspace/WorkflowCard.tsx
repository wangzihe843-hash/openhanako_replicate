/**
 * WorkflowCard — 右侧「Workflow」卡（学 Claude 进度感）
 *
 * 从统一 Agent Activity 真相源筛 kind=workflow，按当前对话展示后台 workflow 任务。
 * running 状态圈旋转，done/failed 定格。无 workflow 时返回 null。
 */
import { useStore } from '../../stores';
import { selectAgentActivities, type AgentActivityEntry } from '../../stores/agent-activity-slice';
import styles from './WorkflowCard.module.css';

const STATUS_ICON: Record<AgentActivityEntry['status'], string> = {
  running: '◐',
  done: '✓',
  failed: '✗',
  aborted: '⊘',
};

function rank(status: AgentActivityEntry['status']): number {
  return status === 'running' ? 0 : 1;
}

export function WorkflowCard() {
  const sessionPath = useStore((s) => s.currentSessionPath);
  const all = useStore(selectAgentActivities(sessionPath));

  const workflows = all.filter((a) => a.kind === 'workflow');
  if (!workflows.length) return null;

  const sorted = [...workflows].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  return (
    <section className={`jian-card ${styles.card}`} aria-label="Workflow">
      <div className={styles.header}>
        <span className={styles.title}>Workflow</span>
        <span className={styles.count}>{sorted.length}</span>
      </div>
      <div className={styles.list}>
        {sorted.map((w) => (
          <div key={w.id} className={styles.row} data-status={w.status}>
            <span className={`${styles.statusIcon} ${styles[`status-${w.status}`] ?? ''}`} aria-hidden="true">
              {STATUS_ICON[w.status]}
            </span>
            <span className={styles.name} title={w.summary || ''}>{w.summary || w.id}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
