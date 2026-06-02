/**
 * WorkflowCard — 右侧「Workflow」卡（两级展开：workflow → 节点列表 → 节点实时流）
 *
 * 从统一 Agent Activity 真相源筛 kind=workflow（父）与 kind=workflow_agent（子节点，按 parentTaskId 归属）。
 * workflow 行：状态 + 名 + agent 数 + 时长，点开列出每个 agent 节点；
 * 节点行：头像 + 名 + 状态 + token，点开复用 SubagentSessionPreview 看实时流。无 workflow 时返回 null。
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { selectAgentActivities, type AgentActivityEntry } from '../../stores/agent-activity-slice';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { SubagentSessionPreview } from '../chat/SubagentSessionPreview';
import { formatElapsed } from '../../utils/format-duration';
import type { Agent } from '../../types';
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

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** running 显示「已运行 Xs」（实时），终态显示「耗时 Xs」（总时长）。 */
function durationLabel(w: AgentActivityEntry, now: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (w.status === 'running' && w.startedAt) {
    return t('rightWorkspace.workflow.running', { text: formatElapsed(now - w.startedAt) });
  }
  if (w.finishedAt && w.startedAt) {
    return t('activity.duration', { text: formatElapsed(w.finishedAt - w.startedAt) });
  }
  return '';
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** 节点行（workflow_agent 子 entry）：头像 + 名 + 状态 + token，可展开实时流。 */
function WorkflowNodeRow({ node, agents, open, onToggle }: {
  node: AgentActivityEntry;
  agents: Agent[];
  open: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const info = resolveAgentDisplayInfo({
    id: node.agentId,
    agents,
    fallbackAgentName: node.label || node.agentName || node.agentId || 'agent',
  });
  const displayName = node.label || info.displayName;
  const tokenText = typeof node.tokens === 'number' ? `${formatTokens(node.tokens)} tok` : '';

  // 展开且子会话就绪时对齐 preview sessionPath（SubagentSessionPreview 内部做 race 校验）。
  useEffect(() => {
    if (open && node.childSessionPath) {
      useStore.getState().setSubagentPreviewSessionPath(node.id, node.childSessionPath);
    }
  }, [open, node.childSessionPath, node.id]);

  return (
    <div className={styles.nodeItem}>
      <button type="button" className={styles.nodeRow} data-status={node.status} onClick={onToggle} aria-expanded={open}>
        <span className={`${styles.statusIcon} ${styles[`status-${node.status}`] ?? ''}`} aria-hidden="true">{STATUS_ICON[node.status]}</span>
        <span className={styles.nodeAvatar}><AgentAvatar info={info} className={styles.nodeAvatarImg} alt={displayName} /></span>
        <span className={styles.nodeName} title={displayName}>{displayName}</span>
        {tokenText && <span className={styles.nodeTokens}>{tokenText}</span>}
      </button>
      {open && (
        <div className={styles.details}>
          <div ref={scrollRef} className={styles.scroll}>
            <SubagentSessionPreview
              taskId={node.id}
              sessionPath={node.childSessionPath}
              agentId={node.agentId}
              streamStatus={node.status}
              summary={node.summary}
              scrollContainerRef={scrollRef}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** workflow 行（父）：状态 + 名 + agent 数 + 时长，可展开节点列表。 */
function WorkflowRow({ wf, nodes, agents, now, open, onToggle, expandedNodes, onToggleNode }: {
  wf: AgentActivityEntry;
  nodes: AgentActivityEntry[];
  agents: Agent[];
  now: number;
  open: boolean;
  onToggle: () => void;
  expandedNodes: Record<string, boolean>;
  onToggleNode: (id: string) => void;
}) {
  const t: (k: string, v?: Record<string, string | number>) => string = window.t ?? ((k: string) => k);
  const dur = durationLabel(wf, now, t);
  return (
    <div className={styles.item}>
      <button type="button" className={styles.row} data-status={wf.status} onClick={onToggle} aria-expanded={open}>
        <span className={`${styles.statusIcon} ${styles[`status-${wf.status}`] ?? ''}`} aria-hidden="true">{STATUS_ICON[wf.status]}</span>
        <span className={styles.name} title={wf.summary || ''}>{wf.summary || wf.id}</span>
        {nodes.length > 0 && <span className={styles.agentCount}>{t('rightWorkspace.workflow.agents', { n: nodes.length })}</span>}
        {dur && <span className={styles.duration}>{dur}</span>}
      </button>
      {open && nodes.length > 0 && (
        <div className={styles.nodeList}>
          {nodes.map((n) => (
            <WorkflowNodeRow
              key={n.id}
              node={n}
              agents={agents}
              open={expandedNodes[n.id] === true}
              onToggle={() => onToggleNode(n.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowCard() {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedWf, setExpandedWf] = useState<Record<string, boolean>>({});
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const sessionPath = useStore((s) => s.currentSessionPath);
  const all = useStore(selectAgentActivities(sessionPath));
  const agents = useStore((s) => s.agents);
  const [now, setNow] = useState(() => Date.now());

  const workflows = all.filter((a) => a.kind === 'workflow');
  const hasRunning = all.some((a) => (a.kind === 'workflow' || a.kind === 'workflow_agent') && a.status === 'running');

  // running 时每秒 tick 刷新「已运行」时长；无 running 不开定时器，卸载/终态清理。
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  if (!workflows.length) return null;

  const t = window.t ?? ((k: string) => k);
  const sorted = [...workflows].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  // 每个 workflow 的子节点（按 parentTaskId 归属，启动序排列）。
  const nodesOf = (wfId: string) =>
    all.filter((a) => a.kind === 'workflow_agent' && a.parentTaskId === wfId)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  return (
    <section className={`jian-card ${styles.card}`} aria-label="Workflow">
      <button className={styles.header} type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
        <span className={styles.title}>{t('rightWorkspace.workflow.title')}</span>
        <span className={styles.count}>{sorted.length}</span>
        <Chevron open={!collapsed} />
      </button>
      {!collapsed && (
        <div className={styles.list}>
          {sorted.map((wf) => (
            <WorkflowRow
              key={wf.id}
              wf={wf}
              nodes={nodesOf(wf.id)}
              agents={agents}
              now={now}
              open={expandedWf[wf.id] === true}
              onToggle={() => setExpandedWf((p) => ({ ...p, [wf.id]: !p[wf.id] }))}
              expandedNodes={expandedNodes}
              onToggleNode={(id) => setExpandedNodes((p) => ({ ...p, [id]: !p[id] }))}
            />
          ))}
        </div>
      )}
    </section>
  );
}
