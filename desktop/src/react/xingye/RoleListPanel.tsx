import { useStore } from '../stores';
import type { Agent } from '../types';
import { RoleCard } from './RoleCard';
import { useXingyeRoleProfiles } from './xingye-profile-store';
import type { XingyeTabId } from './xingye-tabs';
import styles from './XingyeShell.module.css';

interface RoleListPanelProps {
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onShowDetails: () => void;
  onEnterChat: (agentId: string) => void;
  onNavigate: (tabId: XingyeTabId) => void;
}

export function RoleListPanel({
  selectedAgentId,
  onSelectAgent,
  onShowDetails,
  onEnterChat,
  onNavigate,
}: RoleListPanelProps) {
  const agents = useStore(state => state.agents);
  const currentAgentId = useStore(state => state.currentAgentId);
  const profiles = useXingyeRoleProfiles();
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
            点击卡片只更新星野本地选择，不会切换 OpenHanako 当前 Agent。
          </p>
        </div>
        <span className={styles.roleCount}>{agents.length} 个角色</span>
      </div>

      <div className={styles.roleGrid}>
        {agents.map(agent => (
          <RoleCard
            key={agent.id}
            agent={agent}
            profile={profiles[agent.id]}
            isSelected={agent.id === selectedAgentId}
            isOpenHanakoCurrent={agent.id === currentAgentId}
            avatarVersion={avatarVersion}
            onSelect={(selectedAgent) => onSelectAgent(selectedAgent.id)}
            onDetails={(selectedAgent) => {
              onSelectAgent(selectedAgent.id);
              logRoleAction('details', selectedAgent);
              onShowDetails();
            }}
            onChat={(selectedAgent) => {
              onSelectAgent(selectedAgent.id);
              logRoleAction('chat', selectedAgent);
              onEnterChat(selectedAgent.id);
            }}
            onPhone={(selectedAgent) => {
              onSelectAgent(selectedAgent.id);
              logRoleAction('phone', selectedAgent);
              onNavigate('phone');
            }}
          />
        ))}
      </div>
    </div>
  );
}
