import type { Agent } from '../types';
import {
  getXingyeRoleProfileDisplay,
  useXingyeRoleProfile,
} from './xingye-profile-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
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
  const selectedProfile = useXingyeRoleProfile(selectedAgentId);
  const currentProfile = useXingyeRoleProfile(currentAgent?.id);
  const selectedDisplay = selectedAgent ? getXingyeRoleProfileDisplay(selectedAgent, selectedProfile) : null;
  const currentDisplay = currentAgent ? getXingyeRoleProfileDisplay(currentAgent, currentProfile) : null;
  const isSameAgent = !!selectedAgentId && selectedAgentId === currentAgentId;
  const previewDisplay = selectedDisplay ?? currentDisplay;
  const previewBackgroundDataUrl = previewDisplay?.chatBackgroundDataUrl;

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
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {selectedAgent && (
              <XingyeAgentAvatar
                agent={selectedAgent}
                style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }}
              />
            )}
            <span>selectedXingyeAgentId</span>
          </span>
          <strong>{selectedAgentId ?? 'null'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>星野选中角色</span>
          <strong>{selectedDisplay?.displayName ?? '未选择角色'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>星野简介</span>
          <strong>{selectedDisplay?.shortBio ?? '未选择角色'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>关系标签</span>
          <strong>{selectedDisplay?.relationshipLabel ?? '未设置'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>OpenHanako currentAgentId</span>
          <strong>{currentAgentId ?? 'null'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>OpenHanako 当前聊天角色</span>
          <strong>{currentDisplay?.displayName ?? '未设置当前角色'}</strong>
        </div>
        <div className={styles.detailRow}>
          <span>二者是否一致</span>
          <strong>{isSameAgent ? '是' : '否'}</strong>
        </div>
      </section>

      <section className={styles.detailSection} aria-label="当前角色聊天背景预览">
        <h3 className={styles.detailSectionTitle}>当前角色聊天背景预览</h3>
        <div className={styles.chatBackgroundPreview}>
          <div
            className={styles.chatBackgroundSurface}
            style={previewBackgroundDataUrl ? { backgroundImage: `url("${previewBackgroundDataUrl}")` } : undefined}
          >
            <div className={styles.chatBackgroundScrim} />
            <div className={styles.chatBackgroundMessages}>
              <div className={styles.previewBubbleLeft}>
                {previewDisplay
                  ? `${previewDisplay.displayName} 的聊天背景会只显示在星野模式预览中。`
                  : '请选择一个星野角色查看聊天背景。'}
              </div>
              <div className={styles.previewBubbleRight}>
                不修改 OpenHanako 原生 ChatArea
              </div>
            </div>
          </div>
          <p className={styles.detailCopy}>
            {previewBackgroundDataUrl
              ? '这张背景来自 XingyeRoleProfile.chatBackgroundDataUrl，仅用于星野模式 UI。'
              : '当前角色还没有设置聊天背景。'}
          </p>
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
