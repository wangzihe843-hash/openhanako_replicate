import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import { generateMmChatRoundWithAI } from './xingye-mm-chat-ai';
import {
  appendMmChatTurnsToSession,
  createEmptyMmChatPersisted,
  createMmChatSession,
  deleteMmChatSession,
  readMmChatPersistence,
  saveMmChatPersistence,
  sortMmChatSessionsByUpdatedAtDesc,
  type XingyeMmChatSession,
  type XingyeMmChatTurn,
} from './xingye-mm-chat-store';
import type { XingyeRoleProfile } from './xingye-profile-store';

interface PhoneMmChatAppProps {
  ownerAgent: Agent | null;
  ownerProfile: XingyeRoleProfile | null | undefined;
  displayName: string;
  onBack: () => void;
}

function newLocalMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function previewFromUserText(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '尚无消息';
  return one.length > 48 ? `${one.slice(0, 47)}…` : one;
}

function formatSessionTime(iso: string | undefined): string {
  if (!iso || !iso.trim()) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  try {
    return new Date(t).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

type MmChatView = 'list' | 'detail';

type MmChatGeneratePhase = 'idle' | 'new_chat' | 'followup';

export function PhoneMmChatApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneMmChatAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [sessions, setSessions] = useState<XingyeMmChatSession[]>(() => createEmptyMmChatPersisted().sessions);
  const [sessionId, setSessionId] = useState('');
  const [view, setView] = useState<MmChatView>('list');
  const [persistReady, setPersistReady] = useState(!ownerAgentId);
  const [generatePhase, setGeneratePhase] = useState<MmChatGeneratePhase>('idle');
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [followUpDraft, setFollowUpDraft] = useState('');
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const generateRunning = generatePhase !== 'idle';

  useEffect(() => {
    if (!ownerAgentId) {
      setSessions(createEmptyMmChatPersisted().sessions);
      setSessionId('');
      setView('list');
      setPersistReady(true);
      return;
    }
    setPersistReady(false);
    let cancelled = false;
    void (async () => {
      try {
        const fromDisk = await readMmChatPersistence(ownerAgentId);
        if (cancelled) return;
        if (fromDisk) {
          setSessions(fromDisk.sessions);
        } else {
          const empty = createEmptyMmChatPersisted();
          setSessions(empty.sessions);
          await saveMmChatPersistence(ownerAgentId, empty);
        }
      } catch {
        if (!cancelled) {
          setSessions(createEmptyMmChatPersisted().sessions);
        }
      } finally {
        if (!cancelled) setPersistReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerAgentId]);

  useEffect(() => {
    if (!ownerAgentId || !persistReady) return;
    const t = window.setTimeout(() => {
      void saveMmChatPersistence(ownerAgentId, {
        version: 1,
        activeSessionId: '',
        sessions: sessionsRef.current,
      }).catch((err) => {
        console.warn('[xingye-mm-chat] save failed:', err);
      });
    }, 450);
    return () => window.clearTimeout(t);
  }, [ownerAgentId, persistReady, sessions]);

  const sortedSessions = useMemo(() => sortMmChatSessionsByUpdatedAtDesc(sessions), [sessions]);

  const session = useMemo(() => {
    if (!sessionId) return null;
    return sessions.find((x) => x.id === sessionId) ?? null;
  }, [sessions, sessionId]);

  const taLabel = displayName || 'TA';
  const roleLine = ownerAgent ? `当前角色：${taLabel}` : '未选择角色';

  const canNewChat = Boolean(ownerAgent && ownerAgentId && persistReady && !generateRunning);

  const flushPersist = async () => {
    if (!ownerAgentId || !persistReady) return;
    await saveMmChatPersistence(ownerAgentId, {
      version: 1,
      activeSessionId: '',
      sessions: sessionsRef.current,
    });
  };

  const handleNewChat = async () => {
    if (!ownerAgent || !ownerAgentId || !persistReady || generateRunning) return;
    setGenerateError(null);
    setGeneratePhase('new_chat');
    try {
      await flushPersist();
      const round = await generateMmChatRoundWithAI({ agent: ownerAgent, ownerProfile });
      const now = new Date().toISOString();
      const turns: XingyeMmChatTurn[] = [
        { id: newLocalMessageId(), role: 'ta', text: round.question, createdAt: now },
        { id: newLocalMessageId(), role: 'ai', text: round.answer, createdAt: now },
      ];
      const created = await createMmChatSession(ownerAgentId, {
        title: round.title.slice(0, 200),
        preview: previewFromUserText(round.answer),
        messages: turns,
      });
      const row = await readMmChatPersistence(ownerAgentId);
      setSessions(row?.sessions ?? []);
      setSessionId(created.id);
      setView('detail');
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratePhase('idle');
    }
  };

  const lastTurn = session?.messages.length ? session.messages[session.messages.length - 1] : null;
  const canFollowUpBase = Boolean(
    session && session.messages.length > 0 && lastTurn?.role === 'ai' && String(lastTurn.text ?? '').trim(),
  );
  const canFollowUpSend = Boolean(
    ownerAgent && ownerAgentId && persistReady && session && canFollowUpBase && !generateRunning,
  );

  const handleFollowUp = async () => {
    if (!ownerAgent || !ownerAgentId || !persistReady || !session || generateRunning) return;
    if (!canFollowUpBase) {
      setGenerateError('追问须接在助手回复之后。');
      return;
    }
    const directionHint = followUpDraft.trim() || undefined;
    setGenerateError(null);
    setGeneratePhase('followup');
    try {
      await flushPersist();
      const round = await generateMmChatRoundWithAI({
        agent: ownerAgent,
        ownerProfile,
        mode: 'followup',
        followUp: {
          sessionTitle: session.title,
          sessionMessages: session.messages,
          directionHint,
        },
      });
      const now = new Date().toISOString();
      const taMeta = directionHint ? { followUpUserHint: directionHint } : undefined;
      const turns: XingyeMmChatTurn[] = [
        {
          id: newLocalMessageId(),
          role: 'ta',
          text: round.question,
          createdAt: now,
          ...(taMeta ? { meta: taMeta } : {}),
        },
        { id: newLocalMessageId(), role: 'ai', text: round.answer, createdAt: now },
      ];
      await appendMmChatTurnsToSession(ownerAgentId, session.id, turns, {
        preview: previewFromUserText(round.answer),
      });
      const row = await readMmChatPersistence(ownerAgentId);
      setSessions(row?.sessions ?? []);
      setFollowUpDraft('');
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratePhase('idle');
    }
  };

  const openSession = (id: string) => {
    setGenerateError(null);
    setFollowUpDraft('');
    setSessionId(id);
    setView('detail');
  };

  const backToList = () => {
    setGenerateError(null);
    setFollowUpDraft('');
    setView('list');
    setSessionId('');
  };

  const handleDeleteSession = async () => {
    if (!ownerAgentId || !sessionId || !session) return;
    if (!window.confirm('确定删除这条咨询会话？删除后无法恢复。')) return;
    try {
      await flushPersist();
      await deleteMmChatSession(ownerAgentId, sessionId);
      const row = await readMmChatPersistence(ownerAgentId);
      setSessions(row?.sessions ?? []);
      backToList();
    } catch (err) {
      console.warn('[xingye-mm-chat] delete failed:', err);
      setGenerateError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={styles.phoneShell} aria-label="MM Chat：TA 咨询 AI 助手">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={onBack}>
          返回首页
        </button>
        <span>MM Chat</span>
      </div>

      <div className={styles.phoneBody}>
        <p className={styles.mmChatIntro}>
          <strong>TA 咨询 AI 助手</strong>：{roleLine}。每条记录是一次独立咨询，不是短信、不是群聊，也不是您与角色的对话。
        </p>

        {view === 'list' ? (
          <div className={styles.mmChatListRoot}>
            <button
              type="button"
              className={canNewChat ? styles.mmChatNewChatButton : styles.mmChatSendDisabled}
              disabled={!canNewChat}
              onClick={() => void handleNewChat()}
            >
              {generatePhase === 'new_chat'
                ? '正在生成新会话…'
                : generatePhase === 'followup'
                  ? '其它生成任务进行中…'
                  : '+ 新聊天'}
            </button>
            {generateError ? (
              <p className={styles.mmChatComposerHint} role="alert">
                {generateError}
              </p>
            ) : null}
            <p className={styles.mmChatListHint}>以下为历史咨询，点按进入查看；在详情页可删除。</p>
            <div className={styles.mmChatListScroll} role="list" aria-label="历史咨询列表">
              {sortedSessions.length === 0 ? (
                <div className={styles.mmChatEmpty} data-testid="mm-chat-list-empty">
                  <p className={styles.mmChatEmptyTitle}>暂无咨询记录</p>
                  <p className={styles.mmChatEmptyBody}>点击上方「新聊天」生成一轮角色向通用助手的问答，并保存为独立会话。</p>
                </div>
              ) : (
                sortedSessions.map((s) => {
                  const timeLabel = formatSessionTime(s.updatedAt ?? s.createdAt);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="listitem"
                      className={styles.mmChatHistoryRow}
                      onClick={() => openSession(s.id)}
                    >
                      <p className={styles.mmChatHistoryRowTitle}>{s.title || '未命名'}</p>
                      <p className={styles.mmChatHistoryRowPreview}>{s.preview}</p>
                      {timeLabel ? <p className={styles.mmChatHistoryRowTime}>{timeLabel}</p> : null}
                    </button>
                  );
                })
              )}
            </div>
            <p className={styles.mmChatComposerHint}>
              数据保存在当前角色目录下的{' '}
              <code className={styles.inlineCode}>xingye/mm-chat/sessions.json</code>，与其它 agent 隔离。
            </p>
          </div>
        ) : (
          <div className={styles.mmChatDetailRoot}>
            <div className={styles.mmChatDetailToolbar}>
              <button type="button" className={styles.mmChatDetailBack} onClick={backToList}>
                ← 返回列表
              </button>
              <button type="button" className={styles.mmChatDetailDelete} onClick={() => void handleDeleteSession()}>
                删除会话
              </button>
            </div>
            {!session ? (
              <div className={styles.mmChatEmpty} data-testid="mm-chat-detail-missing">
                <p className={styles.mmChatEmptyTitle}>找不到该会话</p>
                <button type="button" className={styles.phoneJournalPrimaryButton} onClick={backToList}>
                  返回列表
                </button>
              </div>
            ) : session.messages.length === 0 ? (
              <div className={styles.mmChatEmpty} data-testid="mm-chat-thread-empty">
                <p className={styles.mmChatEmptyTitle}>这条会话没有内容</p>
                <p className={styles.mmChatEmptyBody}>可返回列表删除此条，或重新「新聊天」生成。</p>
              </div>
            ) : (
              <div className={styles.mmChatDetailBody}>
                <div className={styles.mmChatDetailThreadScroll}>
                  <div className={styles.mmChatThread} aria-live="polite">
                    {session.messages.map((turn) => (
                      <div
                        key={turn.id}
                        className={`${styles.mmChatBubbleRow} ${
                          turn.role === 'ta' ? styles.mmChatBubbleRowTa : styles.mmChatBubbleRowAi
                        }`}
                      >
                        <div
                          className={`${styles.mmChatBubble} ${
                            turn.role === 'ta' ? styles.mmChatBubbleTa : styles.mmChatBubbleAi
                          }`}
                        >
                          {turn.role === 'ta' ? (
                            <span className={styles.mmChatBubbleLabel}>{taLabel} · 提问</span>
                          ) : (
                            <span className={styles.mmChatBubbleLabel}>AI 助手 · 回复</span>
                          )}
                          {turn.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.mmChatDetailFollowup}>
                  <p className={styles.mmChatDetailFollowupLabel}>继续追问（同一会话）</p>
                  <p className={styles.mmChatComposerHint}>
                    选择或填写<strong>追问方向</strong>（可选）；系统会代入当前角色自己继续向助手提问，并生成助手回复。
                  </p>
                  <div className={styles.mmChatChipsRow} aria-label="追问方向快捷填入">
                    {(
                      [
                        '想要更具体的话术',
                        '担心这样显得太低姿态',
                        '没理解第二步',
                        '希望更像当前角色会说的话',
                      ] as const
                    ).map((label) => (
                      <button
                        key={label}
                        type="button"
                        className={styles.mmChatChip}
                        disabled={!canFollowUpBase || generateRunning}
                        onClick={() => setFollowUpDraft(label)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className={styles.mmChatComposer}>
                    <textarea
                      data-testid="mm-chat-followup-input"
                      value={followUpDraft}
                      onChange={(e) => setFollowUpDraft(e.target.value)}
                      placeholder={
                        canFollowUpBase
                          ? '例如：想要更具体的话术 / 担心这样显得太低姿态 / 没理解第二步 / 希望更像当前角色会说的话（可留空直接追问）'
                          : '请等待上一条为助手回复后再追问。'
                      }
                      disabled={!canFollowUpBase || generateRunning}
                      rows={3}
                      aria-label="追问方向提示（可选）"
                    />
                  </div>
                  <div className={styles.mmChatDetailFollowupActions}>
                    <button
                      type="button"
                      className={canFollowUpSend ? styles.mmChatFollowupButton : styles.mmChatSendDisabled}
                      disabled={!canFollowUpSend}
                      data-testid="mm-chat-followup-send"
                      onClick={() => void handleFollowUp()}
                    >
                      {generatePhase === 'followup' ? '正在生成追问…' : '继续追问'}
                    </button>
                  </div>
                  {generateError ? (
                    <p className={styles.mmChatComposerHint} role="alert">
                      {generateError}
                    </p>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
