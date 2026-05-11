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
  enteringAgentId: string | null;
  enterChatError: string | null;
  onEnterChat: (agentId: string) => void;
  onExit: () => void;
}

export function ChatEntryPanel({
  selectedAgent,
  currentAgent,
  currentAgentId,
  enteringAgentId,
  enterChatError,
  onEnterChat,
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
  const isEnteringSelectedAgent = !!selectedAgentId && enteringAgentId === selectedAgentId;

  return (
    <div className={styles.entryPanel}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>OpenHanako Native Chat Entry</p>
          <h2 className={styles.panelTitle}>聊天</h2>
          <p className={styles.panelDescription}>
            这里是 OpenHanako 原生聊天系统的入口包装层。星野模式只选择目标 Agent，然后复用原生 session action 切换或创建对应聊天上下文。
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
                  ? `${previewDisplay.displayName} 的聊天背景会显示在星野预览和真实聊天区中。`
                  : '请选择一个星野角色查看聊天背景。'}
              </div>
              <div className={styles.previewBubbleRight}>
                已通过最小显示层接入 OpenHanako 原生 ChatArea
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
            : '当前星野角色尚未切到 OpenHanako 原生聊天上下文'}
        </h3>
        <p>
          {isSameAgent
            ? '可以返回 OpenHanako 主界面，继续使用原生 ChatArea、InputArea、session 与 WebSocket 聊天流程。'
            : '点击进入聊天会优先切换到该 Agent 的已有原生 session；没有时创建 OpenHanako 原生 session，不调用独立聊天 API。'}
        </p>
      </section>

      <div className={styles.detailActions}>
        {enterChatError && <span className={styles.syncError}>{enterChatError}</span>}
        {isSameAgent ? (
          <button type="button" onClick={onExit}>返回 OpenHanako 聊天</button>
        ) : (
          <button
            type="button"
            onClick={() => selectedAgentId && onEnterChat(selectedAgentId)}
            disabled={!selectedAgentId || isEnteringSelectedAgent}
          >
            {isEnteringSelectedAgent ? '进入中...' : '进入聊天'}
          </button>
        )}
      </div>
    </div>
  );
}
