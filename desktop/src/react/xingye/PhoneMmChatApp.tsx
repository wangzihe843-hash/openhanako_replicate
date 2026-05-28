import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import {
  distributeMmChatBacklogTimestamps,
  generateMmChatInitialBacklogWithAI,
  generateMmChatRoundsWithAI,
  pickRandomMmChatInitialBacklogSize,
  type XingyeMmChatAiRoundQA,
  type XingyeMmChatBacklogTimestampedSession,
} from './xingye-mm-chat-ai';
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

/**
 * 把 LLM 一次性返回的多轮 rounds 摊平成存储用的 turn 数组，依次 ta/ai/ta/ai…。
 *
 * - 同一批 turn 共享一个 createdAt（一次写盘的语义边界）；
 * - 仅第一轮的 ta 提问允许携带 followUpUserHint meta（对应用户填的 directionHint），
 *   后续轮是模型自然延展，不该挂用户提示。
 */
function flattenRoundsToTurns(
  rounds: XingyeMmChatAiRoundQA[],
  opts?: { firstTaMeta?: XingyeMmChatTurn['meta'] },
): XingyeMmChatTurn[] {
  const now = new Date().toISOString();
  const turns: XingyeMmChatTurn[] = [];
  rounds.forEach((round, i) => {
    const isFirst = i === 0;
    const taTurn: XingyeMmChatTurn = {
      id: newLocalMessageId(),
      role: 'ta',
      text: round.question,
      createdAt: now,
    };
    if (isFirst && opts?.firstTaMeta) {
      taTurn.meta = opts.firstTaMeta;
    }
    turns.push(taTurn);
    turns.push({
      id: newLocalMessageId(),
      role: 'ai',
      text: round.answer,
      createdAt: now,
    });
  });
  return turns;
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

type MmChatGeneratePhase = 'idle' | 'new_chat' | 'followup' | 'bootstrap';

/**
 * 把 backlog 一条 session（带 occurredAt 与 rounds[]）落到 XingyeMmChatSession 形态。
 * session.createdAt / updatedAt 与所有 turn.createdAt 共用同一个 occurredAt——
 * 列表里 formatSessionTime 也只取一个时间点。
 */
function buildBacklogSessionRecord(
  s: XingyeMmChatBacklogTimestampedSession,
): XingyeMmChatSession {
  const occurredAt = s.occurredAt;
  const messages: XingyeMmChatTurn[] = [];
  s.rounds.forEach((round) => {
    messages.push({
      id: newLocalMessageId(),
      role: 'ta',
      text: round.question,
      createdAt: occurredAt,
    });
    messages.push({
      id: newLocalMessageId(),
      role: 'ai',
      text: round.answer,
      createdAt: occurredAt,
    });
  });
  const lastAnswer = s.rounds[s.rounds.length - 1]?.answer ?? '';
  return {
    id: newLocalMessageId(),
    title: s.title.slice(0, 200) || '咨询',
    preview: previewFromUserText(lastAnswer),
    messages,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

export function PhoneMmChatApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneMmChatAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [sessions, setSessions] = useState<XingyeMmChatSession[]>(() => createEmptyMmChatPersisted().sessions);
  const [sessionId, setSessionId] = useState('');
  const [view, setView] = useState<MmChatView>('list');
  const [persistReady, setPersistReady] = useState(!ownerAgentId);
  const [generatePhase, setGeneratePhase] = useState<MmChatGeneratePhase>('idle');
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [followUpDraft, setFollowUpDraft] = useState('');
  /**
   * 与 sessions.json 顶层 initializedAt 同步；null 表示 backlog 还没 bootstrap 过。
   * 写盘时与 sessions 一起序列化（auto-save / flushPersist 都要带上），否则会被擦掉。
   */
  const [initializedAt, setInitializedAt] = useState<string | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const initializedAtRef = useRef<string | null>(initializedAt);
  initializedAtRef.current = initializedAt;
  /** 防止 bootstrap 同一 agent 多次触发；切角色后置空。 */
  const initialBootstrapTriedRef = useRef<string | null>(null);

  const generateRunning = generatePhase !== 'idle';

  useEffect(() => {
    if (!ownerAgentId) {
      setSessions(createEmptyMmChatPersisted().sessions);
      setSessionId('');
      setView('list');
      setInitializedAt(null);
      initialBootstrapTriedRef.current = null;
      setPersistReady(true);
      return;
    }
    setPersistReady(false);
    initialBootstrapTriedRef.current = null;
    let cancelled = false;
    void (async () => {
      try {
        const fromDisk = await readMmChatPersistence(ownerAgentId);
        if (cancelled) return;
        if (fromDisk) {
          setSessions(fromDisk.sessions);
          setInitializedAt(fromDisk.initializedAt ?? null);
        } else {
          const empty = createEmptyMmChatPersisted();
          setSessions(empty.sessions);
          setInitializedAt(null);
          await saveMmChatPersistence(ownerAgentId, empty);
        }
      } catch {
        if (!cancelled) {
          setSessions(createEmptyMmChatPersisted().sessions);
          setInitializedAt(null);
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
      const initAt = initializedAtRef.current;
      void saveMmChatPersistence(ownerAgentId, {
        version: 1,
        activeSessionId: '',
        sessions: sessionsRef.current,
        ...(initAt ? { initializedAt: initAt } : {}),
      }).catch((err) => {
        console.warn('[xingye-mm-chat] save failed:', err);
      });
    }, 450);
    return () => window.clearTimeout(t);
  }, [ownerAgentId, persistReady, sessions, initializedAt]);

  /**
   * 首次打开 MM Chat：sessions 空 + initializedAt 缺失 → 跑一次 backlog 生成。
   *
   * 已 init 或已经有 sessions（含用户手动建过又删剩） → 跳过；
   * 防止"删光后又自动重灌"——与 PhoneShoppingApp 同名 useEffect 同语义。
   *
   * generateRunning 期间不发起；失败不写 initializedAt，下次进入再试；
   * initialBootstrapTriedRef 防本次 mount 内反复触发（避免 sessions 触发的 re-render 重入）。
   */
  useEffect(() => {
    if (!ownerAgent || !ownerAgentId || !persistReady) return;
    if (initialBootstrapTriedRef.current === ownerAgentId) return;
    if (generateRunning) return;
    if (initializedAt) {
      initialBootstrapTriedRef.current = ownerAgentId;
      return;
    }
    if (sessions.length > 0) {
      initialBootstrapTriedRef.current = ownerAgentId;
      return;
    }
    initialBootstrapTriedRef.current = ownerAgentId;
    const agentForBootstrap = ownerAgent;
    const aidForBootstrap = ownerAgentId;
    setGeneratePhase('bootstrap');
    setGenerateError(null);
    void (async () => {
      try {
        const backlog = await generateMmChatInitialBacklogWithAI({
          agent: agentForBootstrap,
          ownerProfile,
          sessionCount: pickRandomMmChatInitialBacklogSize(),
        });
        const dated = distributeMmChatBacklogTimestamps(backlog.sessions);
        const sessionRecords = dated.map(buildBacklogSessionRecord);
        const now = new Date().toISOString();
        // 单次写盘：sessions + initializedAt 原子落盘。
        // 注意：不复用 createMmChatSession（它强制写 now 当 createdAt）。
        await saveMmChatPersistence(aidForBootstrap, {
          version: 1,
          activeSessionId: '',
          sessions: sessionRecords,
          initializedAt: now,
        });
        // 回读一次，让 React state 与盘上 normalize 后结果一致。
        const row = await readMmChatPersistence(aidForBootstrap);
        setSessions(row?.sessions ?? sessionRecords);
        setInitializedAt(row?.initializedAt ?? now);
      } catch (err) {
        // 不写 initializedAt → 下次进入会重试；同时让用户能看到错误。
        setGenerateError(err instanceof Error ? err.message : String(err));
        // 允许下次 mount 再试一次（清掉 tried 标记）。
        initialBootstrapTriedRef.current = null;
      } finally {
        setGeneratePhase('idle');
      }
    })();
  }, [ownerAgent, ownerAgentId, persistReady, sessions.length, initializedAt, ownerProfile, generateRunning]);

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
    const initAt = initializedAtRef.current;
    await saveMmChatPersistence(ownerAgentId, {
      version: 1,
      activeSessionId: '',
      sessions: sessionsRef.current,
      ...(initAt ? { initializedAt: initAt } : {}),
    });
  };

  const handleNewChat = async () => {
    if (!ownerAgent || !ownerAgentId || !persistReady || generateRunning) return;
    setGenerateError(null);
    setGeneratePhase('new_chat');
    try {
      await flushPersist();
      const result = await generateMmChatRoundsWithAI({ agent: ownerAgent, ownerProfile });
      const turns = flattenRoundsToTurns(result.rounds);
      const lastAnswer = result.rounds[result.rounds.length - 1]?.answer ?? '';
      const created = await createMmChatSession(ownerAgentId, {
        title: result.title.slice(0, 200),
        preview: previewFromUserText(lastAnswer),
        messages: turns,
      });
      const row = await readMmChatPersistence(ownerAgentId);
      setSessions(row?.sessions ?? []);
      setInitializedAt(row?.initializedAt ?? initializedAtRef.current);
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
      const result = await generateMmChatRoundsWithAI({
        agent: ownerAgent,
        ownerProfile,
        mode: 'followup',
        followUp: {
          sessionTitle: session.title,
          sessionMessages: session.messages,
          directionHint,
        },
      });
      // 仅第一轮的 ta 提问携带 followUpUserHint meta（与用户填的 directionHint 对应）。
      const turns = flattenRoundsToTurns(result.rounds, {
        firstTaMeta: directionHint ? { followUpUserHint: directionHint } : undefined,
      });
      const lastAnswer = result.rounds[result.rounds.length - 1]?.answer ?? '';
      await appendMmChatTurnsToSession(ownerAgentId, session.id, turns, {
        preview: previewFromUserText(lastAnswer),
      });
      const row = await readMmChatPersistence(ownerAgentId);
      setSessions(row?.sessions ?? []);
      setInitializedAt(row?.initializedAt ?? initializedAtRef.current);
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
      setInitializedAt(row?.initializedAt ?? initializedAtRef.current);
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
                  : generatePhase === 'bootstrap'
                    ? '正在为 TA 铺历史咨询…'
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
                  <p className={styles.mmChatEmptyTitle}>
                    {generatePhase === 'bootstrap' ? '正在为 TA 生成历史咨询…' : '暂无咨询记录'}
                  </p>
                  <p className={styles.mmChatEmptyBody}>
                    {generatePhase === 'bootstrap'
                      ? '首次打开会一次性铺 3–5 条历史会话（每条按话题重要度生成 1–5 轮）；完成后可在此查看，也可继续追问或新聊天。'
                      : '点击上方「新聊天」一次性生成数轮角色向通用助手的问答（系统随机 3–5 轮），并保存为独立会话。'}
                  </p>
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
                <button type="button" className={styles.phonePrimaryAction} onClick={backToList}>
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
                    选择或填写<strong>追问方向</strong>（可选；仅影响首轮）；系统会代入当前角色，自然延展数轮（随机 3–5 轮）追问与助手回复，一次性追加进同一会话。
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
