import type { Agent } from '../types';
import styles from './XingyeShell.module.css';

interface RoleDetailPanelProps {
  agent: Agent | null;
  isOpenHanakoCurrent: boolean;
  onBack: () => void;
  onChat: () => void;
  onPhone: () => void;
}

export function RoleDetailPanel({ agent, isOpenHanakoCurrent, onBack, onChat, onPhone }: RoleDetailPanelProps) {
  if (!agent) {
    return (
      <div className={styles.emptyState}>
        <h2 className={styles.panelTitle}>角色详情</h2>
        <p className={styles.panelDescription}>请选择一个角色查看基础信息。</p>
        <button className={styles.secondaryButton} type="button" onClick={onBack}>
          返回角色列表
        </button>
      </div>
    );
  }

  return (
    <div className={styles.detailPanel}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Xingye Role Detail</p>
          <h2 className={styles.panelTitle}>{agent.name}</h2>
          <p className={styles.panelDescription}>
            这里只读展示 OpenHanako Agent 的基础字段，不保存资料，不上传头像，也不创建聊天数据。
          </p>
        </div>
        <button className={styles.secondaryButton} type="button" onClick={onBack}>
          返回列表
        </button>
      </div>

      <section className={styles.detailSection} aria-label="角色基础信息">
        <div className={styles.detailRow}>
          <span>Agent ID</span>
          <strong>{agent.id}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>名称</span>
          <strong>{agent.name}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>Yuan</span>
          <strong>{agent.yuan || '未设置'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>头像</span>
          <strong>{agent.hasAvatar ? '已设置' : '使用占位头像'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>主角色</span>
          <strong>{agent.isPrimary ? '是' : '否'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>OpenHanako 当前角色</span>
          <strong>{isOpenHanakoCurrent ? '是' : '否'}</strong>
        </div>
      </section>

      <section className={styles.detailSection} aria-label="简介占位">
        <h3 className={styles.detailSectionTitle}>简介</h3>
        <p className={styles.detailCopy}>
          简介占位：后续可以在不改动 OpenHanako 原聊天系统的前提下接入只读角色资料。
        </p>
      </section>

      <div className={styles.detailActions}>
        <button type="button" onClick={onChat}>聊天</button>
        <button type="button" onClick={onPhone}>TA 的手机</button>
      </div>
    </div>
  );
}
