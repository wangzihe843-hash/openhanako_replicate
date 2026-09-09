import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { useStore } from '../stores';
import { sessionScopedListIncludes, sessionScopedValue } from '../stores/session-slice';
import { usePanel } from '../hooks/use-panel';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { formatSessionDate } from '../utils/format';
import { renderMarkdown } from '../utils/markdown';
import { AgentAvatar, resolveAgentDisplayInfo } from '../utils/agent-display';
import { displayInitial } from '../utils/grapheme';
import {
  BRIDGE_PANEL_PLATFORMS,
  bridgePlatformLabel,
  isBridgePlatform,
  type BridgePlatform,
} from '../utils/bridge-platforms';
import { openSettingsModal } from '../stores/settings-modal-actions';
import { loadMessages } from '../stores/session-actions';
import { clearSessionStreamMeta } from '../stores/stream-invalidator';
import { sanitizeBridgeVisibleText } from '../../../../shared/bridge-visible-text';
import { useContinuousBottomScroll } from '../hooks/use-continuous-bottom-scroll';
import type { ChatListItem } from '../stores/chat-types';
import { ChatTranscript } from './chat/ChatTranscript';
import fp from './FloatingPanels.module.css';
import chatStyles from './chat/Chat.module.css';

interface BridgeSession {
  sessionKey: string;
  chatId: string;
  sessionPath?: string;
  displayName?: string;
  avatarUrl?: string;
  lastActive?: number;
  isOwner?: boolean;
}

interface StatusData {
  [key: string]: { status: string; configured?: boolean } | undefined;
}

function initialBridgePlatform(): BridgePlatform {
  const saved = localStorage.getItem('hana_bridge_tab');
  return isBridgePlatform(saved) ? saved : 'feishu';
}

function getBridgeSessionIdentity(
  session: BridgeSession,
  systemName: string,
  systemAvatarUrl: string | null,
) {
  if (session.isOwner) {
    return { name: systemName, avatarUrl: systemAvatarUrl };
  }
  return {
    name: session.displayName || session.chatId,
    avatarUrl: session.avatarUrl || null,
  };
}

export function BridgePanel() {

  const [platform, setPlatform] = useState<BridgePlatform>(initialBridgePlatform);
  const [sessions, setSessions] = useState<BridgeSession[]>([]);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState('');
  const [currentAvatarUrl, setCurrentAvatarUrl] = useState<string | null>(null);
  const [currentIsOwner, setCurrentIsOwner] = useState(false);
  const [currentSessionPath, setCurrentSessionPath] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [statusData, setStatusData] = useState<StatusData>({});
  const [bridgeAgentId, setBridgeAgentId] = useState<string | null>(null);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);

  const agentMenuRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelActive = useStore(s => s.activePanel === 'bridge');
  const contextRef = useRef({ agentId: bridgeAgentId, platform, visible: panelActive });
  const platformRequestRef = useRef(0);
  const statusRequestRef = useRef(0);
  const selectionRequestRef = useRef(0);

  // A fresh identity also invalidates A -> B -> A and close/reopen responses.
  // Layout cleanup retires requests before passive loading effects run.
  useLayoutEffect(() => {
    contextRef.current = { agentId: bridgeAgentId, platform, visible: panelActive };
    return () => {
      contextRef.current = { ...contextRef.current, visible: false };
    };
  }, [bridgeAgentId, platform, panelActive]);

  // 加载状态（按 agent 过滤，stale-guard via ref）
  // bridgeAgentId 由 store 播种，播种前不发请求：bridge 读接口只回答指名道姓的
  // agent，没有 id 的请求没有正确答案可给。
  const loadStatus = useCallback(async () => {
    const snapshotId = bridgeAgentId;
    if (!snapshotId) return;
    const context = contextRef.current;
    const request = ++statusRequestRef.current;
    const isCurrent = () => contextRef.current === context && request === statusRequestRef.current;
    try {
      const res = await hanaFetch(`/api/bridge/status?agentId=${encodeURIComponent(snapshotId)}`);
      if (!isCurrent()) return;
      const data = await res.json();
      if (!isCurrent()) return;
      setStatusData(data);
      updateSidebarDot(data);
      if (context.visible) setShowOverlay(!data[context.platform]?.configured);
    } catch {}
  }, [bridgeAgentId]);

  // 加载平台数据（按 agent 过滤，stale-guard via ref）
  const loadPlatformData = useCallback(async () => {
    const snapshotId = bridgeAgentId;
    const context = contextRef.current;
    if (!snapshotId || !context.visible || context.agentId !== snapshotId || context.platform !== platform) return;
    const request = ++platformRequestRef.current;
    const statusRequest = ++statusRequestRef.current;
    const isCurrent = () => contextRef.current === context && request === platformRequestRef.current;
    try {
      const agentQuery = `&agentId=${encodeURIComponent(snapshotId)}`;
      const [statusRes, sessionsRes] = await Promise.all([
        hanaFetch(`/api/bridge/status?agentId=${encodeURIComponent(snapshotId)}`),
        hanaFetch(`/api/bridge/sessions?platform=${platform}${agentQuery}`),
      ]);
      if (!isCurrent()) return;
      const sData = await statusRes.json();
      const sessData = await sessionsRes.json();
      if (!isCurrent()) return;
      if (statusRequest === statusRequestRef.current) {
        setStatusData(sData);
        updateSidebarDot(sData);
        setShowOverlay(!sData[platform]?.configured);
      }
      setSessions(sessData.sessions || []);
    } catch (err) {
      console.error('[bridge] load platform data failed:', err);
    }
  }, [bridgeAgentId, platform]);

  const loadData = useCallback(() => {
    loadPlatformData();
    ++selectionRequestRef.current;
    setSessions([]);
    setShowOverlay(false);
    setChatOpen(false);
    setCurrentKey(null);
    setCurrentName('');
    setCurrentAvatarUrl(null);
    setCurrentIsOwner(false);
    setCurrentSessionPath(null);
  }, [loadPlatformData]);

  const currentAgentId = useStore(s => s.currentAgentId);
  const agents = useStore(s => s.agents);
  const userName = useStore(s => s.userName);
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const t = window.t ?? ((p: string) => p);
  const systemUserName = userName || t('common.me');
  const systemUserAvatarUrl = userAvatarUrl || null;

  // Init bridgeAgentId from store
  useEffect(() => {
    if (!bridgeAgentId && currentAgentId) setBridgeAgentId(currentAgentId);
  }, [bridgeAgentId, currentAgentId]);

  // Close agent menu on click outside
  useEffect(() => {
    if (!agentMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (agentMenuRef.current?.contains(e.target as Node)) return;
      setAgentMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [agentMenuOpen]);

  const { visible, close } = usePanel('bridge', loadData, [currentAgentId, bridgeAgentId, platform]);

  // 订阅 bridge status 变化（代替 window.__hanaBridgeLoadStatus）
  const bridgeStatusTrigger = useStore(s => s.bridgeStatusTrigger);
  useEffect(() => {
    if (bridgeStatusTrigger > 0) loadStatus();
  }, [bridgeStatusTrigger, loadStatus]);

  // 订阅 bridge 消息（代替 window.__hanaBridgeOnMessage）— 按 agent 过滤
  const bridgeLatestMessage = useStore(s => s.bridgeLatestMessage);
  const handledMessageRef = useRef(bridgeLatestMessage);
  // The cooldown survives individual messages; only a new context or unmount cancels it.
  useEffect(() => () => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, [bridgeAgentId, platform, visible]);

  useEffect(() => {
    if (handledMessageRef.current === bridgeLatestMessage) return;
    handledMessageRef.current = bridgeLatestMessage;
    if (!bridgeLatestMessage || !visible) return;
    const msg = bridgeLatestMessage;
    // 只响应当前选中 agent 的消息（无 agentId 的旧消息始终通过）
    if (msg.agentId && bridgeAgentId && msg.agentId !== bridgeAgentId) return;
    // Leading + trailing debounce：第一条消息立即刷新，后续 500ms 内攒着，到期再刷一次
    if (!refreshTimerRef.current) {
      // leading：立即刷新
      loadPlatformData();
    } else {
      clearTimeout(refreshTimerRef.current);
    }
    // trailing：500ms 后再刷一次（捕获期间的变化）
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      loadPlatformData();
    }, 500);
  }, [bridgeLatestMessage, visible, bridgeAgentId, loadPlatformData]);

  const switchTab = useCallback((plat: BridgePlatform) => {
    if (plat === platform) loadData();
    else setPlatform(plat);
    localStorage.setItem('hana_bridge_tab', plat);
  }, [loadData, platform]);

  const openSession = useCallback(async (session: BridgeSession) => {
    const context = contextRef.current;
    const request = ++selectionRequestRef.current;
    const isCurrent = () => contextRef.current === context && request === selectionRequestRef.current;
    const identity = getBridgeSessionIdentity(session, systemUserName, systemUserAvatarUrl);
    setCurrentKey(session.sessionKey);
    setCurrentName(identity.name);
    setCurrentAvatarUrl(identity.avatarUrl);
    setCurrentIsOwner(!!session.isOwner);
    setCurrentSessionPath(session.sessionPath || null);
    try {
      if (!session.sessionPath) throw new Error('bridge sessionPath missing');
      await loadMessages(session.sessionPath);
      if (!isCurrent()) return;
      setChatOpen(true);
    } catch (err) {
      console.error('[bridge] open session failed:', err);
      if (isCurrent()) setChatOpen(false);
    }
  }, [systemUserName, systemUserAvatarUrl]);

  const resetSession = useCallback(async () => {
    if (!currentKey) return;
    const snapshotId = bridgeAgentId;
    if (!snapshotId) return;
    const context = contextRef.current;
    const request = ++selectionRequestRef.current;
    try {
      await hanaFetch(`/api/bridge/sessions/${encodeURIComponent(currentKey)}/reset?agentId=${encodeURIComponent(snapshotId)}`, { method: 'POST' });
      if (currentSessionPath) {
        // The server reset belongs to the captured session even if the user has moved on.
        useStore.getState().clearSession(currentSessionPath);
        // 桥接重置永久退役该 session：clearSession 不碰 stream-resume 元数据，显式清掉避免泄漏。
        clearSessionStreamMeta(currentSessionPath);
      }
      if (contextRef.current !== context || request !== selectionRequestRef.current) return;
      setChatOpen(false);
      setCurrentKey(null);
      setCurrentName('');
      setCurrentAvatarUrl(null);
      setCurrentIsOwner(false);
      setCurrentSessionPath(null);
      await loadPlatformData();
    } catch (err) {
      console.error('[bridge] reset session failed:', err);
    }
  }, [currentKey, currentSessionPath, loadPlatformData, bridgeAgentId]);

  if (!visible) return null;

  return (
    <div className={`${fp.floatingPanel} ${fp.bridgePanelWide}`} id="bridgePanel">
      <div className={fp.floatingPanelInner}>
        <div className={fp.floatingPanelHeader}>
          {agents.length > 1 && (
            <div className={fp.bridgeAgentRow} ref={agentMenuRef}>
              <button
                className={fp.bridgeAgentBtn}
                onClick={() => setAgentMenuOpen(!agentMenuOpen)}
              >
                {(() => {
                  const agent = agents.find(a => a.id === bridgeAgentId);
                  const info = resolveAgentDisplayInfo({
                    id: agent?.id || bridgeAgentId,
                    agents,
                    fallbackAgentName: agent?.name || '—',
                    fallbackAgentYuan: agent?.yuan,
                  });
                  return (
                    <>
                      <AgentAvatar
                        info={info}
                        className={fp.bridgeAgentAvatar}
                      />
                      <span className={fp.bridgeAgentName}>{info.displayName}</span>
                      <span className={fp.bridgeAgentArrow}>▾</span>
                    </>
                  );
                })()}
              </button>
              {agentMenuOpen && (
                <div className={fp.bridgeAgentMenu}>
                  {agents.map(agent => (
                    <button
                      key={agent.id}
                      className={`${fp.bridgeAgentMenuItem}${agent.id === bridgeAgentId ? ` ${fp.bridgeAgentMenuItemActive}` : ''}`}
                      onClick={() => { setBridgeAgentId(agent.id); setAgentMenuOpen(false); }}
                    >
                      <AgentAvatar
                        info={resolveAgentDisplayInfo({
                          id: agent.id,
                          agents,
                          fallbackAgentName: agent.name,
                          fallbackAgentYuan: agent.yuan,
                        })}
                        className={fp.bridgeAgentAvatar}
                      />
                      <span>{agent.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className={fp.bridgeTabs} id="bridgeTabs">
            {BRIDGE_PANEL_PLATFORMS.map((descriptor) => (
              <button
                key={descriptor.id}
                className={`${fp.bridgeTab}${platform === descriptor.id ? ` ${fp.bridgeTabActive}` : ''}`}
                onClick={() => switchTab(descriptor.id)}
              >
                <span className={`${fp.bridgeTabDot}${dotClass(statusData[descriptor.id]?.status)}`} />
                <span>{bridgePlatformLabel(descriptor, t)}</span>
              </button>
            ))}
          </div>
          <button className={fp.floatingPanelClose} onClick={close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={fp.bridgeBody}>
          {showOverlay && (
            <div className={fp.bridgeOverlay} id="bridgeOverlay">
              <div className={fp.bridgeOverlayContent}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div className={fp.bridgeOverlayText}>
                  {t('bridge.notConfigured', { platform: bridgePlatformLabel(platform, t) })}
                </div>
                <button className={fp.bridgeOverlayBtn} onClick={() => openSettingsModal('bridge')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>{t('bridge.goToSettings')}</span>
                </button>
              </div>
            </div>
          )}
          <div className={fp.bridgeSidebar} id="bridgeSidebar">
            <div className={fp.bridgeContactList} id="bridgeContactList">
              {sessions.length === 0 ? (
                <div className={fp.bridgeContactEmpty}>{t('bridge.noSessions')}</div>
              ) : (
                sessions.map(s => {
                  const identity = getBridgeSessionIdentity(s, systemUserName, systemUserAvatarUrl);
                  return (
                    <div
                      key={s.sessionKey}
                      className={`${fp.bridgeContactItem}${s.sessionKey === currentKey ? ` ${fp.bridgeContactItemActive}` : ''}`}
                      onClick={() => openSession(s)}
                    >
                      <ContactAvatar name={identity.name} avatarUrl={identity.avatarUrl || undefined} />
                      <div className={fp.bridgeContactInfo}>
                        <div className={fp.bridgeContactName}>{identity.name}</div>
                        {s.lastActive && (
                          <div className={fp.bridgeContactTime}>
                            {formatSessionDate(new Date(s.lastActive).toISOString())}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className={fp.bridgeChat} id="bridgeChat">
            {chatOpen ? (
              <>
                <div className={fp.bridgeChatHeader} id="bridgeChatHeader">
                  <span className={fp.bridgeChatHeaderName}>{currentName}</span>
                  <button className={fp.bridgeChatReset} title={t('bridge.resetContext')} onClick={resetSession}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                    {t('bridge.resetContext')}
                  </button>
                </div>
                {currentSessionPath ? (
                  <BridgeChatTranscript
                    sessionPath={currentSessionPath}
                    agentId={bridgeAgentId}
                    contactName={currentName}
                    contactAvatarUrl={currentAvatarUrl}
                    useSystemUserIdentity={currentIsOwner}
                    emptyLabel={t('bridge.noMessages')}
                  />
                ) : (
                  <div className={fp.bridgeChatMessages} id="bridgeChatMessages">
                    <div className={fp.bridgeChatNoMsg}>{t('bridge.noMessages')}</div>
                  </div>
                )}
              </>
            ) : (
              <div className={fp.bridgeChatEmpty} id="bridgeChatEmpty">
                <span>{t('bridge.selectChat')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function dotClass(status?: string): string {
  if (status === 'connected') return ' bridge-dot-ok';
  if (status === 'error') return ' bridge-dot-err';
  return ' bridge-dot-off';
}

function updateSidebarDot(data: Record<string, { status: string } | undefined>) {
  const anyConnected = BRIDGE_PANEL_PLATFORMS
    .filter((platform) => platform.statusAffectsSidebarDot !== false)
    .some((platform) => data[platform.id]?.status === 'connected');
  useStore.setState({ bridgeDotConnected: anyConnected });
}

function ContactAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const [showImg, setShowImg] = useState(!!avatarUrl);
  useEffect(() => {
    setShowImg(!!avatarUrl);
  }, [avatarUrl]);

  return (
    <div className={fp.bridgeContactAvatar}>
      {showImg && avatarUrl ? (
        <img
          className={fp.bridgeContactAvatarImg}
          src={avatarUrl}
          alt={name}
          onError={() => setShowImg(false)}
        />
      ) : (
        displayInitial(name, '?')
      )}
    </div>
  );
}

const EMPTY_ITEMS: ChatListItem[] = [];
const BRIDGE_SCROLL_THRESHOLD = 50;

export function BridgeChatTranscript({
  sessionPath,
  agentId,
  contactName,
  contactAvatarUrl,
  useSystemUserIdentity,
  emptyLabel,
}: {
  sessionPath: string;
  agentId?: string | null;
  contactName: string;
  contactAvatarUrl?: string | null;
  useSystemUserIdentity?: boolean;
  emptyLabel: string;
}) {
  const items = useStore(s => sessionScopedValue(s, s.chatSessions, sessionPath)?.items || EMPTY_ITEMS);
  const isStreaming = useStore(s => sessionScopedListIncludes(s, s.streamingSessions, sessionPath));
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomScroll = useContinuousBottomScroll({
    scrollRef,
    contentRef,
    active: true,
    stickyThreshold: BRIDGE_SCROLL_THRESHOLD,
  });

  // Switch landing in the layout phase (pre-paint). Only arm an instant landing when the target
  // session has no messages yet, so the first async hydrate (0 -> N) snaps without animating;
  // an already-loaded session lands via the instant scroll and later growth = streaming (smooth follow).
  useLayoutEffect(() => {
    const alreadyHydrated = (sessionScopedValue(useStore.getState(), useStore.getState().chatSessions, sessionPath)?.items?.length ?? 0) > 0;
    if (!alreadyHydrated) bottomScroll.armInstantLanding();
    bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
  }, [bottomScroll, sessionPath]);

  useEffect(() => {
    bottomScroll.followBottom();
  }, [bottomScroll, items.length, isStreaming]);

  const userIdentity = useSystemUserIdentity
    ? undefined
    : { name: contactName, avatarUrl: contactAvatarUrl || null };
  const visibleItems = useMemo(() => sanitizeBridgeVisibleItems(items), [items]);

  return (
    <div className={fp.bridgeChatMessages} ref={scrollRef} id="bridgeChatMessages">
      <div ref={contentRef} className={chatStyles.sessionMessages}>
        {items.length === 0 ? (
          <div className={fp.bridgeChatNoMsg}>{emptyLabel}</div>
        ) : (
          <ChatTranscript
            items={visibleItems}
            sessionPath={sessionPath}
            agentId={agentId}
            readOnly
            userIdentity={userIdentity}
          />
        )}
        {isStreaming && (
          <div className={chatStyles.typingIndicator} />
        )}
      </div>
    </div>
  );
}

function sanitizeBridgeVisibleItems(items: ChatListItem[]): ChatListItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.type !== 'message' || item.data.role !== 'user' || !item.data.text) return item;
    const text = sanitizeBridgeVisibleText(item.data.text);
    if (text === item.data.text) return item;
    changed = true;
    return {
      ...item,
      data: {
        ...item.data,
        text,
        textHtml: text ? renderMarkdown(text) : undefined,
      },
    };
  });
  return changed ? next : items;
}
