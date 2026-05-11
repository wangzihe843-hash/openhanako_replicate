import type { Agent } from '../types';
import styles from './XingyeShell.module.css';

interface PhoneMmChatAppProps {
  ownerAgent: Agent | null;
  displayName: string;
  onBack: () => void;
}

export function PhoneMmChatApp({ ownerAgent, displayName, onBack }: PhoneMmChatAppProps) {
  return (
    <div className={styles.phoneShell} aria-label="MM Chat 占位页">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={onBack}>
          返回首页
        </button>
        <span>MM Chat</span>
      </div>

      <div className={styles.phoneBody}>
        <section className={styles.phoneAppCard}>
          <h3 className={styles.phoneAppTitle}>MM Chat</h3>
          <p className={styles.phoneAppHint}>
            当前角色：{ownerAgent ? displayName : '未选择角色'}
          </p>
          <p className={styles.phoneAppParagraph}>
            这是 TA 自己咨询 AI 助手的地方，类似人类使用 ChatGPT / DeepSeek。
          </p>
          <p className={styles.phoneAppParagraph}>
            这里不是短信，也不是群聊，更不是用户和角色聊天。
          </p>
        </section>

        <section className={styles.phoneEmptyStateCard}>
          以后这里会展示 TA 向 AI 助手咨询问题、整理思路、写计划的记录。
        </section>
      </div>
    </div>
  );
}
