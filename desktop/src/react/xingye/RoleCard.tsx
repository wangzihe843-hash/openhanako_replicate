import type { Agent } from '../types';
import { hanaUrl } from '../hooks/use-hana-fetch';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import styles from './XingyeShell.module.css';

interface RoleCardProps {
  agent: Agent;
  isCurrent: boolean;
  avatarVersion: number;
  onDetails: (agent: Agent) => void;
  onChat: (agent: Agent) => void;
  onPhone: (agent: Agent) => void;
}

export function RoleCard({ agent, isCurrent, avatarVersion, onDetails, onChat, onPhone }: RoleCardProps) {
  const avatarSrc = agent.hasAvatar
    ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${avatarVersion}`)
    : yuanFallbackAvatar(agent.yuan);

  return (
    <article className={`${styles.roleCard}${isCurrent ? ` ${styles.roleCardCurrent}` : ''}`}>
      <div className={styles.roleAvatar}>
        <img
          src={avatarSrc}
          alt=""
          draggable={false}
          onError={(event) => {
            const img = event.currentTarget;
            img.onerror = null;
            img.src = yuanFallbackAvatar(agent.yuan);
          }}
        />
      </div>

      <div className={styles.roleBody}>
        <div className={styles.roleHeader}>
          <div className={styles.roleTitleBlock}>
            <h3 className={styles.roleName}>{agent.name}</h3>
            <p className={styles.roleId}>{agent.id}</p>
          </div>
          <span className={styles.roleStatus}>{isCurrent ? '当前选中' : '未选中'}</span>
        </div>

        <p className={styles.roleIntro}>
          简介占位：后续可接入角色资料、人格设定或星野侧展示文案。
        </p>

        <div className={styles.roleMeta}>
          <span>Yuan: {agent.yuan}</span>
          {agent.isPrimary && <span>主角色</span>}
        </div>

        <div className={styles.roleActions}>
          <button type="button" onClick={() => onDetails(agent)}>
            详情
          </button>
          <button type="button" onClick={() => onChat(agent)}>
            聊天
          </button>
          <button type="button" onClick={() => onPhone(agent)}>
            TA 的手机
          </button>
        </div>
      </div>
    </article>
  );
}
