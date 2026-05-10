import type { Agent } from '../types';
import styles from './XingyeShell.module.css';

interface AgentPhonePanelProps {
  agent: Agent | null;
}

export function AgentPhonePanel({ agent }: AgentPhonePanelProps) {
  return (
    <div className={styles.panelInner}>
      <h2 className={styles.panelTitle}>小手机</h2>
      <p className={styles.panelDescription}>
        当前只接收星野本地选中的 Agent，不读取朋友圈，不创建群聊调度，也不写入聊天存储。
      </p>

      <div className={styles.phoneShell}>
        <div className={styles.phoneHeader}>
          <span>TA 的手机</span>
          <strong>{agent?.name ?? '未选择角色'}</strong>
        </div>

        <div className={styles.phoneContent}>
          <div className={styles.detailRow}>
            <span>selectedXingyeAgentId</span>
            <strong>{agent?.id ?? 'null'}</strong>
          </div>
          <div className={styles.detailRow}>
            <span>角色来源</span>
            <strong>OpenHanako Agent store</strong>
          </div>
          <div className={styles.detailRow}>
            <span>当前状态</span>
            <strong>占位展示</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
