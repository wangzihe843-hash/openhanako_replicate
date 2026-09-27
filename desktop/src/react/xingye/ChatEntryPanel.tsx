import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { MemoryCandidatePanel } from './MemoryCandidatePanel';
import { navigateXingyeSceneSource } from './xingye-scene-navigation';
import {
  createXingyeMemoryCandidate,
  sceneSummaryContent,
  type XingyeSceneSection,
  type XingyeSceneSummary,
} from './xingye-memory-candidate-store';
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

type SceneSourceRow = {
  entryId: string;
  role: 'user' | 'assistant';
  preview: string;
  hash: string;
  timestamp: string | null;
  ordinal: number;
};

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
  const sessions = useStore(s => s.sessions);
  const agentSessions = useMemo(
    () => sessions.filter(s => s.agentId === selectedAgentId && !!s.sessionId && !s.agentDeleted),
    [sessions, selectedAgentId],
  );
  const [sceneSessionId, setSceneSessionId] = useState('');
  const [sources, setSources] = useState<SceneSourceRow[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [startEntryId, setStartEntryId] = useState('');
  const [endEntryId, setEndEntryId] = useState('');
  const [sceneBusy, setSceneBusy] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [sceneFlash, setSceneFlash] = useState<string | null>(null);
  const sceneRequestVersion = useRef(0);
  const currentSceneSelection = useRef({ agentId: selectedAgentId, sessionId: sceneSessionId });
  currentSceneSelection.current = { agentId: selectedAgentId, sessionId: sceneSessionId };
  const startOrdinal = sources.find(row => row.entryId === startEntryId)?.ordinal ?? -1;
  const endOrdinal = sources.find(row => row.entryId === endEntryId)?.ordinal ?? -1;
  const rangeCount = startOrdinal >= 0 && endOrdinal >= startOrdinal ? endOrdinal - startOrdinal + 1 : 0;
  const rangeSelectable = rangeCount > 0 && rangeCount <= 30;

  useEffect(() => {
    if (!agentSessions.some(s => s.sessionId === sceneSessionId)) {
      setSceneSessionId(agentSessions[0]?.sessionId ?? '');
    }
  }, [agentSessions, sceneSessionId]);

  useEffect(() => {
    const version = ++sceneRequestVersion.current;
    setSceneBusy(false);
    setSceneFlash(null);
    if (!selectedAgentId || !sceneSessionId) {
      setSources([]);
      setNextBefore(null);
      return;
    }
    let active = true;
    setSceneError(null);
    setSources([]);
    setNextBefore(null);
    void (async () => {
      try {
        const url = `/api/xingye/scene-summary/sources?agentId=${encodeURIComponent(selectedAgentId)}&sessionId=${encodeURIComponent(sceneSessionId)}`;
        const response = await hanaFetch(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || '无法读取场景原文');
        if (!active || version !== sceneRequestVersion.current) return;
        const rows = Array.isArray(data.rows) ? data.rows as SceneSourceRow[] : [];
        setSources(rows);
        setNextBefore(typeof data.nextBefore === 'number' ? data.nextBefore : null);
        setStartEntryId(rows[Math.max(0, rows.length - 10)]?.entryId ?? '');
        setEndEntryId(rows.at(-1)?.entryId ?? '');
      } catch (error) {
        if (active && version === sceneRequestVersion.current) setSceneError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { active = false; };
  }, [selectedAgentId, sceneSessionId]);

  const loadEarlierSources = async () => {
    if (!selectedAgentId || !sceneSessionId || nextBefore === null) return;
    const version = sceneRequestVersion.current;
    setSceneBusy(true);
    try {
      const url = `/api/xingye/scene-summary/sources?agentId=${encodeURIComponent(selectedAgentId)}&sessionId=${encodeURIComponent(sceneSessionId)}&before=${nextBefore}`;
      const response = await hanaFetch(url);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || '无法读取更早消息');
      if (version !== sceneRequestVersion.current) return;
      setSources(prev => [...(Array.isArray(data.rows) ? data.rows as SceneSourceRow[] : []), ...prev]);
      setNextBefore(typeof data.nextBefore === 'number' ? data.nextBefore : null);
    } catch (error) {
      if (version === sceneRequestVersion.current) setSceneError(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === sceneRequestVersion.current) setSceneBusy(false);
    }
  };

  const generateSceneDraft = async (generator: 'local' | 'model') => {
    if (!selectedAgentId || !sceneSessionId || !rangeSelectable) return;
    const version = sceneRequestVersion.current;
    const isCurrentSelection = () => version === sceneRequestVersion.current
      && currentSceneSelection.current.agentId === selectedAgentId
      && currentSceneSelection.current.sessionId === sceneSessionId;
    setSceneBusy(true);
    setSceneError(null);
    setSceneFlash(null);
    try {
      const response = await hanaFetch('/api/xingye/scene-summary/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId,
          sessionId: sceneSessionId,
          startEntryId,
          endEntryId,
          generator,
          ...(generator === 'model' ? { providerConsent: true } : {}),
        }),
      });
      const data = await response.json();
      if (!isCurrentSelection()) return;
      if (!response.ok || !data?.ok) throw new Error(data?.error || '生成场景草稿失败');
      const sceneSummary: XingyeSceneSummary = {
        sessionId: sceneSessionId,
        branchHeadId: data.branchHeadId ?? undefined,
        sourceRefs: data.sourceRefs,
        sections: data.sections as XingyeSceneSection[],
        validity: 'unknown',
      };
      createXingyeMemoryCandidate(selectedAgentId, {
        sourceDomain: 'scene_summary',
        sourceId: sceneSessionId,
        target: 'scene_archive',
        content: sceneSummaryContent(sceneSummary.sections),
        reason: generator === 'model' ? '模型根据选定对话生成，等待逐条复核。' : '从选定对话提取的原文证据草稿。',
        sceneSummary,
      });
      setSceneFlash(generator === 'model'
        ? '模型摘要草稿已生成。请在下方核对直接引用与推断，再决定是否采纳。'
        : '已生成本地原文证据草稿。请在下方核对、编辑或放弃。');
    } catch (error) {
      if (isCurrentSelection()) setSceneError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentSelection()) setSceneBusy(false);
    }
  };

  const navigateSceneSource = async (sessionId: string, entryId: string) => {
    if (!selectedAgentId) throw new Error('请选择角色');
    await navigateXingyeSceneSource(selectedAgentId, sessionId, entryId, onExit);
  };

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
              ? '这张背景来自 XingyeRoleProfile.chatBackgroundDataUrl，会同步显示在星野预览与 OpenHanako 真实聊天中。'
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

      <section className={styles.detailSection} aria-label="场景摘要候选">
        <h3 className={styles.detailSectionTitle}>场景摘要候选</h3>
        <p className={styles.detailCopy}>选择同一会话中的原消息范围，生成可逐条复核的草稿。采纳后仅留在场景档案，不自动进入对话记忆。</p>
        <label className={styles.memoryCandidateField}>
          <span>会话</span>
          <select value={sceneSessionId} onChange={event => setSceneSessionId(event.target.value)} aria-label="场景会话">
            {agentSessions.map(session => (
              <option key={session.sessionId!} value={session.sessionId!}>{session.title || session.firstMessage || session.sessionId}</option>
            ))}
          </select>
        </label>
        {agentSessions.length === 0 ? <p>当前角色还没有可选的会话。</p> : null}
        {sources.length > 0 ? (
          <>
            <div className={styles.detailRow}>
              <label>起始消息 <select value={startEntryId} onChange={event => setStartEntryId(event.target.value)} aria-label="场景起始消息">
                {sources.map(row => <option key={row.entryId} value={row.entryId}>#{row.ordinal + 1} {row.role === 'user' ? '我' : 'TA'} · {row.preview.slice(0, 45)}</option>)}
              </select></label>
              <label>结束消息 <select value={endEntryId} onChange={event => setEndEntryId(event.target.value)} aria-label="场景结束消息">
                {sources.map(row => <option key={row.entryId} value={row.entryId}>#{row.ordinal + 1} {row.role === 'user' ? '我' : 'TA'} · {row.preview.slice(0, 45)}</option>)}
              </select></label>
            </div>
            <div className={styles.detailActions}>
              {nextBefore !== null ? <button type="button" onClick={() => void loadEarlierSources()} disabled={sceneBusy}>加载更早消息</button> : null}
              <button type="button" onClick={() => void generateSceneDraft('local')} disabled={sceneBusy || !rangeSelectable}>生成本地证据草稿</button>
            </div>
            <p className={styles.detailCopy}>只有点击下方按钮时，所选消息原文和消息 ID 才会发送给当前配置的模型提供商。优先使用实用模型；未配置时使用角色或当前聊天模型。一次操作只发送给一个模型，失败不会自动转发给另一提供商。</p>
            <div className={styles.detailActions}>
              <button type="button" onClick={() => void generateSceneDraft('model')} disabled={sceneBusy || !rangeSelectable}>发送所选消息给模型并生成摘要</button>
            </div>
            <p className={styles.detailCopy}>当前选择 {rangeCount} 条；一次最多 30 条、18,000 字。{!rangeSelectable ? '请调整起止消息。' : ''}</p>
          </>
        ) : null}
        {sceneError ? <p role="alert" className={styles.syncError}>{sceneError}</p> : null}
        {sceneFlash ? <p role="status">{sceneFlash}</p> : null}
      </section>
      <MemoryCandidatePanel agentId={selectedAgentId} agentName={selectedAgent?.name} onNavigateSceneSource={navigateSceneSource} />
    </div>
  );
}
