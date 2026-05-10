import { useStore } from '../stores';
import type { Agent } from '../types';
import { RoleCard } from './RoleCard';
import type { XingyeTabId } from './xingye-tabs';
import styles from './XingyeShell.module.css';

interface RoleListPanelProps {
  onNavigate: (tabId: XingyeTabId) => void;
}

export function RoleListPanel({ onNavigate }: RoleListPanelProps) {
  const agents = useStore(state => state.agents);
  const currentAgentId = useStore(state => state.currentAgentId);
  const avatarVersion = Date.now();

  const logRoleAction = (action: string, agent: Agent) => {
    console.log(`[xingye-role] ${action}`, { agentId: agent.id, agentName: agent.name });
  };

  if (!agents.length) {
    return (
      <div className={styles.emptyState}>
        <h2 className={styles.panelTitle}>角色</h2>
        <p className={styles.panelDescription}>
          还没有从 OpenHanako store 读取到 Agent。请先在原 Agent 设置里创建角色。
        </p>
      </div>
    );
  }

  return (
    <div className={styles.roleListPanel}>
      <div className={styles.panelHeading}>
        <div>
          <h2 className={styles.panelTitle}>角色</h2>
          <p className={styles.panelDescription}>
            使用 OpenHanako 现有 Agent 数据展示星野角色列表，当前不创建新资料或后端数据。
          </p>
        </div>
        <span className={styles.roleCount}>{agents.length} 个角色</span>
      </div>

      <div className={styles.roleGrid}>
        {agents.map(agent => (
          <RoleCard
            key={agent.id}
            agent={agent}
            isCurrent={agent.id === currentAgentId}
            avatarVersion={avatarVersion}
            onDetails={(selectedAgent) => logRoleAction('details', selectedAgent)}
            onChat={(selectedAgent) => {
              logRoleAction('chat', selectedAgent);
              onNavigate('chat');
            }}
            onPhone={(selectedAgent) => {
              logRoleAction('phone', selectedAgent);
              onNavigate('phone');
            }}
          />
        ))}
      </div>
    </div>
  );
}
