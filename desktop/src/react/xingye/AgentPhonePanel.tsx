import type { Agent } from '../types';
import {
  getXingyeRoleProfileDisplay,
  useXingyeRoleProfile,
} from './xingye-profile-store';
import styles from './XingyeShell.module.css';

interface AgentPhonePanelProps {
  agent: Agent | null;
}

export function AgentPhonePanel({ agent }: AgentPhonePanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);
  const display = agent ? getXingyeRoleProfileDisplay(agent, profile) : null;

  return (
    <div className={styles.phonePanel}>
      <h2 className={styles.panelTitle}>小手机</h2>
      <p className={styles.panelDescription}>
        当前只接收星野本地选中的 Agent，不读取朋友圈，不创建群聊调度，也不写入聊天存储。
      </p>

      <div
        className={styles.phoneShell}
        style={display?.chatBackgroundDataUrl ? { backgroundImage: `url(${display.chatBackgroundDataUrl})` } : undefined}
      >
        <div className={styles.phoneHeader}>
          <span>TA 的手机</span>
          <strong>{display?.displayName ?? '未选择角色'}</strong>
        </div>

        <div className={styles.phoneContent}>
          <div className={styles.phoneRow}>
            <span className={styles.phoneLabel}>selectedXingyeAgentId</span>
            <strong className={styles.phoneValue}>{agent?.id ?? 'null'}</strong>
          </div>
          <div className={styles.phoneRow}>
            <span className={styles.phoneLabel}>角色来源</span>
            <strong className={styles.phoneValue}>OpenHanako Agent store + XingyeRoleProfile</strong>
          </div>
          <div className={styles.phoneRow}>
            <span className={styles.phoneLabel}>简介</span>
            <strong className={styles.phoneValue}>{display?.shortBio ?? '未选择角色'}</strong>
          </div>
          <div className={styles.phoneRow}>
            <span className={styles.phoneLabel}>关系标签</span>
            <strong className={styles.phoneValue}>{display?.relationshipLabel ?? '未设置'}</strong>
          </div>
          <div className={styles.phoneRow}>
            <span className={styles.phoneLabel}>说话风格</span>
            <strong className={styles.phoneValue}>{display?.speakingStyle ?? '未设置'}</strong>
          </div>
          <div className={styles.phoneRow}>
            <span className={styles.phoneLabel}>主动动态</span>
            <strong className={styles.phoneValue}>{display?.allowAutoMoments ? '允许' : '不允许'}</strong>
          </div>
          <div className={styles.phoneRow}>
            <span className={styles.phoneLabel}>主动私聊</span>
            <strong className={styles.phoneValue}>{display?.allowProactiveDM ? '允许' : '不允许'}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
