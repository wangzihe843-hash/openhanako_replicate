import styles from './XingyeShell.module.css';

export function GroupChatPanel() {
  return (
    <div className={styles.entryPanel}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Xingye Group Chat Entry</p>
          <h2 className={styles.panelTitle}>群聊</h2>
          <p className={styles.panelDescription}>
            当前是星野群聊入口占位，只说明产品语义，不实现真正群聊，不读取 OpenHanako Channel 数据，也不创建群聊记录。
          </p>
        </div>
      </div>

      <section className={styles.entryNotice} aria-label="群聊占位说明">
        <h3 className={styles.entryNoticeTitle}>星野群聊还不是 OpenHanako Channel</h3>
        <p>
          OpenHanako Channel 目前应视为共享频道、留言板或记录空间；它可以承载多人可见的消息记录，但不等于微信式即时群聊。
        </p>
        <p>
          后续需要新增 Xingye Group Chat Orchestrator，由它负责选择群成员、唤醒多个 Agent、编排发言顺序，并把结果接回合适的 OpenHanako 原生能力。
        </p>
      </section>

      <div className={styles.placeholderGrid}>
        <div className={styles.placeholderItem}>群聊入口占位</div>
        <div className={styles.placeholderItem}>成员与角色关系占位</div>
        <div className={styles.placeholderItem}>Orchestrator 路线图占位</div>
      </div>
    </div>
  );
}
