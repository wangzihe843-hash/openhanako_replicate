import type { Agent } from '../types';
import {
  getXingyeRoleProfileDisplay,
  type XingyeRoleProfile,
} from './xingye-profile-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

interface RoleCardProps {
  agent: Agent;
  profile?: XingyeRoleProfile | null;
  isSelected: boolean;
  isOpenHanakoCurrent: boolean;
  avatarVersion: number;
  onSelect: (agent: Agent) => void;
  onDetails: (agent: Agent) => void;
  onChat: (agent: Agent) => void;
  onPhone: (agent: Agent) => void;
}

export function RoleCard({
  agent,
  profile,
  isSelected,
  isOpenHanakoCurrent,
  onSelect,
  onDetails,
  onChat,
  onPhone,
}: RoleCardProps) {
  const display = getXingyeRoleProfileDisplay(agent, profile);

  return (
    <article
      className={`${styles.roleCard}${isSelected ? ` ${styles.roleCardCurrent}` : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      onClick={() => onSelect(agent)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(agent);
        }
      }}
    >
      <div className={styles.roleAvatar}>
        <XingyeAgentAvatar agent={agent} />
      </div>

      <div className={styles.roleBody}>
        <div className={styles.roleHeader}>
          <div className={styles.roleTitleBlock}>
            <h3 className={styles.roleName}>{display.displayName}</h3>
            <p className={styles.roleId}>{agent.id}</p>
          </div>
          <span className={styles.roleStatus}>
            {isSelected ? '星野选中' : isOpenHanakoCurrent ? 'OpenHanako 当前' : '未选中'}
          </span>
        </div>

        <p className={styles.roleIntro}>{display.shortBio}</p>

        <div className={styles.roleMeta}>
          {display.relationshipLabel && <span>{display.relationshipLabel}</span>}
          {display.speakingStyle && <span>{display.speakingStyle}</span>}
          <span>Yuan: {agent.yuan}</span>
          {agent.isPrimary && <span>主角色</span>}
        </div>

        <div className={styles.roleActions}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDetails(agent);
            }}
          >
            详情
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onChat(agent);
            }}
          >
            聊天
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPhone(agent);
            }}
          >
            TA 的手机
          </button>
        </div>
      </div>
    </article>
  );
}
