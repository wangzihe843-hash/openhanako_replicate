import type { Agent } from '../types';
import {
  getXingyeRoleProfileDisplay,
  useXingyeRoleProfile,
} from './xingye-profile-store';
import type { XingyeTabId } from './xingye-tabs';
import { PhoneHome } from './PhoneHome';
import styles from './XingyeShell.module.css';

interface AgentPhonePanelProps {
  agent: Agent | null;
  onNavigate: (tabId: XingyeTabId) => void;
}

export function AgentPhonePanel({ agent, onNavigate }: AgentPhonePanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);
  const display = agent ? getXingyeRoleProfileDisplay(agent, profile) : null;

  return (
    <div className={styles.phonePanel}>
      <h2 className={styles.panelTitle}>小手机</h2>
      <p className={styles.panelDescription}>
        当前只展示星野本地角色资料，不连接 desk 后端，不写入聊天存储。
      </p>
      <PhoneHome agent={agent} display={display} onNavigate={onNavigate} />
    </div>
  );
}
