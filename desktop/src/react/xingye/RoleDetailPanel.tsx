import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import {
  getXingyeRoleProfileDisplay,
  saveXingyeRoleProfile,
  useXingyeRoleProfile,
} from './xingye-profile-store';
import styles from './XingyeShell.module.css';

interface RoleDetailPanelProps {
  agent: Agent | null;
  isOpenHanakoCurrent: boolean;
  onBack: () => void;
  onChat: () => void;
  onPhone: () => void;
}

export function RoleDetailPanel({ agent, isOpenHanakoCurrent, onBack, onChat, onPhone }: RoleDetailPanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);
  const [displayName, setDisplayName] = useState('');
  const [shortBio, setShortBio] = useState('');
  const [relationshipLabel, setRelationshipLabel] = useState('');
  const [speakingStyle, setSpeakingStyle] = useState('');
  const [allowAutoMoments, setAllowAutoMoments] = useState(false);
  const [allowProactiveDM, setAllowProactiveDM] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(profile?.displayName ?? '');
    setShortBio(profile?.shortBio ?? '');
    setRelationshipLabel(profile?.relationshipLabel ?? '');
    setSpeakingStyle(profile?.speakingStyle ?? '');
    setAllowAutoMoments(profile?.allowAutoMoments ?? false);
    setAllowProactiveDM(profile?.allowProactiveDM ?? false);
  }, [agent?.id, profile]);

  useEffect(() => {
    setSavedAt(null);
  }, [agent?.id]);

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

  const resolvedProfile = getXingyeRoleProfileDisplay(agent, profile);
  const handleSave = () => {
    const saved = saveXingyeRoleProfile(agent.id, {
      displayName,
      shortBio,
      relationshipLabel,
      speakingStyle,
      allowAutoMoments,
      allowProactiveDM,
    });
    setSavedAt(saved.updatedAt);
  };

  return (
    <div className={styles.detailPanel}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Xingye Role Detail</p>
          <h2 className={styles.panelTitle}>{resolvedProfile.displayName}</h2>
          <p className={styles.panelDescription}>
            星野资料只保存在当前浏览器的本地资料层，不修改 OpenHanako Agent。
          </p>
        </div>
        <button className={styles.secondaryButton} type="button" onClick={onBack}>
          返回列表
        </button>
      </div>

      <section className={styles.detailSection} aria-label="星野扩展资料">
        <h3 className={styles.detailSectionTitle}>星野资料</h3>
        <div className={styles.profileForm}>
          <label className={styles.profileField}>
            <span>星野昵称</span>
            <input
              type="text"
              value={displayName}
              placeholder={agent.name}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>简介</span>
            <textarea
              value={shortBio}
              placeholder={resolvedProfile.shortBio}
              rows={3}
              onChange={(event) => setShortBio(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>关系标签</span>
            <input
              type="text"
              value={relationshipLabel}
              placeholder="朋友、搭子、老师..."
              onChange={(event) => setRelationshipLabel(event.target.value)}
            />
          </label>
          <label className={styles.profileField}>
            <span>说话风格</span>
            <textarea
              value={speakingStyle}
              placeholder="温柔直接、简短、有分寸..."
              rows={2}
              onChange={(event) => setSpeakingStyle(event.target.value)}
            />
          </label>
          <label className={styles.profileToggle}>
            <input
              type="checkbox"
              checked={allowAutoMoments}
              onChange={(event) => setAllowAutoMoments(event.target.checked)}
            />
            <span>允许主动发动态</span>
          </label>
          <label className={styles.profileToggle}>
            <input
              type="checkbox"
              checked={allowProactiveDM}
              onChange={(event) => setAllowProactiveDM(event.target.checked)}
            />
            <span>允许主动私聊</span>
          </label>
        </div>
      </section>

      <section className={styles.detailSection} aria-label="角色基础信息">
        <div className={styles.detailRow}>
          <span>Agent ID</span>
          <strong>{agent.id}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>OpenHanako 名称</span>
          <strong>{agent.name}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>Yuan</span>
          <strong>{agent.yuan || '未设置'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>头像</span>
          <strong>{profile?.avatarDataUrl ? '使用星野预留头像字段' : agent.hasAvatar ? '使用 OpenHanako 头像' : '使用占位头像'}</strong>
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

      <section className={styles.detailSection} aria-label="显示预览">
        <h3 className={styles.detailSectionTitle}>显示预览</h3>
        <p className={styles.detailCopy}>{resolvedProfile.shortBio}</p>
      </section>

      <div className={styles.detailActions}>
        <button type="button" onClick={handleSave}>保存星野资料</button>
        <button type="button" onClick={onChat}>聊天</button>
        <button type="button" onClick={onPhone}>TA 的手机</button>
        {savedAt && <span className={styles.saveStatus}>已保存 {new Date(savedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}
