/**
 * AgentActivityCard — 右侧「后台动态」卡片（可收纳）
 *
 * 消费统一 Agent Activity 真相源（agentActivitiesBySession），按当前对话 sessionPath
 * 展示 subagent / workflow / 巡检 的实时状态。无活动时返回 null（desk 撑满）。
 */
import { useState } from 'react';
import { useStore } from '../../stores';
import { selectAgentActivities, type AgentActivityEntry } from '../../stores/agent-activity-slice';
import styles from './AgentActivityCard.module.css';

const KIND_LABEL: Record<AgentActivityEntry['kind'], string> = {
  subagent: '子助手',
  workflow: 'Workflow',
  heartbeat: '巡检',
  cron: '定时',
};

function rank(status: AgentActivityEntry['status']): number {
  return status === 'running' ? 0 : 1; // 运行中优先
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function AgentActivityCard() {
  const [collapsed, setCollapsed] = useState(false);
  const sessionPath = useStore((s) => s.currentSessionPath);
  const all = useStore(selectAgentActivities(sessionPath));
  const t = window.t ?? ((k: string) => k);

  // 这张卡只管 subagent；workflow 已拆到 WorkflowCard，巡检不进当前对话。
  const activities = all.filter((a) => a.kind === 'subagent');
  if (!activities.length) return null;

  const sorted = [...activities].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  return (
    <section className={`jian-card ${styles.card}`} aria-label={t('rightWorkspace.subagent.title')}>
      <button className={styles.header} type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
        <span className={styles.title}>{t('rightWorkspace.subagent.title')}</span>
        <span className={styles.count}>{sorted.length}</span>
        <Chevron open={!collapsed} />
      </button>
      {!collapsed && (
        <div className={styles.list}>
          {sorted.map((a) => (
            <div key={a.id} className={styles.row} data-status={a.status}>
              <span className={`${styles.dot} ${styles[`dot-${a.status}`] ?? ''}`} aria-hidden="true" />
              <span className={styles.name} title={a.agentName || a.agentId || ''}>
                {a.agentName || a.agentId || KIND_LABEL[a.kind] || a.kind}
              </span>
              <span className={styles.summary} title={a.summary || ''}>{a.summary || ''}</span>
              <span className={styles.kind}>{KIND_LABEL[a.kind] || a.kind}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
