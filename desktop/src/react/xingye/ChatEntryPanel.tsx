import type { Agent } from '../types';
import styles from './XingyeShell.module.css';

interface ChatEntryPanelProps {
  selectedAgent: Agent | null;
  currentAgent: Agent | null;
  currentAgentId: string | null;
  onExit: () => void;
}

export function ChatEntryPanel({
  selectedAgent,
  currentAgent,
  currentAgentId,
  onExit,
}: ChatEntryPanelProps) {
  const selectedAgentId = selectedAgent?.id ?? null;
  const isSameAgent = !!selectedAgentId && selectedAgentId === currentAgentId;

  return (
    <div className={styles.entryPanel}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>OpenHanako Native Chat Entry</p>
          <h2 className={styles.panelTitle}>聊天</h2>
          <p className={styles.panelDescription}>
            这里是 OpenHanako 原生聊天系统的入口包装层。星野模式只展示当前选择关系，不读取 session，不调用聊天 API，也不创建星野聊天数据。
          </p>
        </div>
      </div>

      <section className={styles.detailSection} aria-label="聊天角色对照">
        <h3 className={styles.detailSectionTitle}>角色对照</h3>
        <div className={styles.detailRow}>
          <span>selectedXingyeAgentId</span>
          <strong>{selectedAgentId ?? 'null'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>星野选中角色</span>
          <strong>{selectedAgent?.name ?? '未选择角色'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>OpenHanako currentAgentId</span>
          <strong>{currentAgentId ?? 'null'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>OpenHanako 当前聊天角色</span>
          <strong>{currentAgent?.name ?? '未设置当前角色'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>二者是否一致</span>
          <strong>{isSameAgent ? '是' : '否'}</strong>
        </div>
      </section>

      <section className={styles.entryNotice} aria-label="聊天入口状态">
        <h3 className={styles.entryNoticeTitle}>
          {isSameAgent
            ? '当前星野角色就是 OpenHanako 当前聊天角色'
            : '当前只是在星野模式中选中了这个角色，尚未切换 OpenHanako 当前 Agent'}
        </h3>
        <p>
          {isSameAgent
            ? '可以返回 OpenHanako 主界面，继续使用原生 ChatArea、InputArea、session 与 WebSocket 聊天流程。'
            : '后续将接入 OpenHanako 原生 Agent 切换 action；当前不会切换 currentAgentId，也不会创建或读取任何聊天 session。'}
        </p>
      </section>

      <div className={styles.detailActions}>
        {isSameAgent ? (
          <button type="button" onClick={onExit}>返回 OpenHanako 聊天</button>
        ) : (
          <button type="button" disabled>等待接入原生 Agent 切换</button>
        )}
      </div>
    </div>
  );
}
