import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import { generateMmChatRoundWithAI } from './xingye-mm-chat-ai';
import {
  cloneDefaultMmChatPersisted,
  readMmChatPersistence,
  saveMmChatPersistence,
  type XingyeMmChatSession,
} from './xingye-mm-chat-store';
import type { XingyeRoleProfile } from './xingye-profile-store';

interface PhoneMmChatAppProps {
  ownerAgent: Agent | null;
  ownerProfile: XingyeRoleProfile | null | undefined;
  displayName: string;
  onBack: () => void;
}

const MM_CHAT_QUICK_CHIPS = [
  '帮我把焦虑写成可执行清单',
  '用三个问题澄清我的目标',
  '用更温柔的语气改写这段话',
  '给我一版「拒绝」话术，不伤关系',
];

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

export function PhoneMmChatApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneMmChatAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [sessions, setSessions] = useState<XingyeMmChatSession[]>(() => cloneDefaultMmChatPersisted().sessions);
  const [sessionId, setSessionId] = useState(() => cloneDefaultMmChatPersisted().activeSessionId);
  const [composer, setComposer] = useState('');
  const [persistReady, setPersistReady] = useState(!ownerAgentId);
  const [generateRunning, setGenerateRunning] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  useEffect(() => {
    if (!ownerAgentId) {
      const d = cloneDefaultMmChatPersisted();
      setSessions(d.sessions);
      setSessionId(d.activeSessionId);
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
          setSessionId(fromDisk.activeSessionId);
        } else {
          const seed = cloneDefaultMmChatPersisted();
          setSessions(seed.sessions);
          setSessionId(seed.activeSessionId);
          await saveMmChatPersistence(ownerAgentId, seed);
        }
      } catch {
        if (!cancelled) {
          const d = cloneDefaultMmChatPersisted();
          setSessions(d.sessions);
          setSessionId(d.activeSessionId);
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
      void saveMmChatPersistence(ownerAgentId, { version: 1, activeSessionId: sessionId, sessions }).catch((err) => {
        console.warn('[xingye-mm-chat] save failed:', err);
      });
    }, 450);
    return () => window.clearTimeout(t);
  }, [ownerAgentId, persistReady, sessionId, sessions]);

  const session = useMemo(() => {
    const s = sessions.find((x) => x.id === sessionId) ?? sessions[0];
    return s ?? cloneDefaultMmChatPersisted().sessions[0]!;
  }, [sessions, sessionId]);

  const taLabel = displayName || 'TA';
  const roleLine = ownerAgent ? `当前角色：${taLabel}` : '未选择角色';

  const canSendLocalTa = Boolean(ownerAgentId && persistReady && composer.trim());
  const canGenerateAi = Boolean(ownerAgent && ownerAgentId && persistReady && !generateRunning);

  const appendLocalTaMessage = () => {
    const text = composer.trim();
    if (!ownerAgentId || !text || !persistReady) return;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          messages: [...s.messages, { id: newLocalMessageId(), role: 'ta' as const, text }],
          preview: previewFromUserText(text),
        };
      }),
    );
    setComposer('');
  };

  const appendGeneratedRound = async () => {
    if (!ownerAgent || !ownerAgentId || !persistReady || generateRunning) return;
    setGenerateError(null);
    setGenerateRunning(true);
    try {
      const round = await generateMmChatRoundWithAI({ agent: ownerAgent, ownerProfile });
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const wasEmpty = s.messages.length === 0;
          const taId = newLocalMessageId();
          const aiId = newLocalMessageId();
          return {
            ...s,
            title: wasEmpty ? round.title.slice(0, 200) : s.title,
            preview: previewFromUserText(round.answer),
            messages: [
              ...s.messages,
              { id: taId, role: 'ta' as const, text: round.question },
              { id: aiId, role: 'ai' as const, text: round.answer },
            ],
          };
        }),
      );
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerateRunning(false);
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
          <strong>TA 咨询 AI 助手</strong>：{roleLine}。这里是 TA 自己向独立助手提问的文本壳，不是短信、不是群聊，也不是您与角色的对话。
        </p>

        <div className={styles.mmChatLayout}>
          <div className={styles.mmChatSessionStrip} role="list" aria-label="咨询会话列表">
            {sessions.map((s) => {
              const active = s.id === session.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="listitem"
                  className={`${styles.mmChatSessionChip} ${active ? styles.mmChatSessionChipActive : ''}`}
                  onClick={() => setSessionId(s.id)}
                >
                  <p className={styles.mmChatSessionChipTitle}>{s.title}</p>
                  <p className={styles.mmChatSessionChipPreview}>{s.preview}</p>
                </button>
              );
            })}
          </div>

          <div className={styles.mmChatThread} aria-live="polite">
            {session.messages.length === 0 ? (
              <div className={styles.mmChatEmpty} data-testid="mm-chat-thread-empty">
                <p className={styles.mmChatEmptyTitle}>这条会话还没有记录</p>
                <p className={styles.mmChatEmptyBody}>
                  真实版本里会展示 TA 与助手的历史消息。会话列表已按角色写入星野目录；尚未连接真实模型。
                </p>
              </div>
            ) : (
              session.messages.map((turn) => (
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
              ))
            )}
          </div>

          <div aria-label="快捷问题">
            <p className={styles.phoneSectionTitle} style={{ marginBottom: 6 }}>
              快捷问题（仅填入输入框）
            </p>
            <div className={styles.mmChatChipsRow}>
              {MM_CHAT_QUICK_CHIPS.map((q) => (
                <button key={q} type="button" className={styles.mmChatChip} onClick={() => setComposer(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.mmChatComposer}>
            <textarea
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              placeholder={
                ownerAgentId
                  ? '可手动输入后点「发送」追加为 TA 消息；或点「生成对话」由模型补一轮问答。'
                  : '未选择角色时无法写入；请先选择角色。'
              }
              aria-label="咨询输入框"
              rows={2}
            />
            <p className={styles.mmChatComposerHint}>
              点「生成对话」会请求模型生成一轮「角色提问 + 通用助手回答」并写入当前会话；点「发送」仅把输入框内容作为 TA
              的一条本地消息追加（不请求模型）。已连接服务时随{' '}
              <code className={styles.inlineCode}>xingye/mm-chat/sessions.json</code>
              保存；换角色后各自独立。
            </p>
            {generateError ? (
              <p className={styles.mmChatComposerHint} role="alert">
                {generateError}
              </p>
            ) : null}
            <div className={styles.mmChatComposerActions}>
              <button
                type="button"
                className={canGenerateAi ? styles.phoneJournalPrimaryButton : styles.mmChatSendDisabled}
                disabled={!canGenerateAi}
                onClick={() => void appendGeneratedRound()}
              >
                {generateRunning ? '生成中…' : ownerAgentId ? '生成对话' : '生成对话（需选择角色）'}
              </button>
              <button
                type="button"
                className={canSendLocalTa ? styles.phoneJournalPrimaryButton : styles.mmChatSendDisabled}
                disabled={!canSendLocalTa}
                onClick={appendLocalTaMessage}
              >
                {ownerAgentId ? '发送（仅本地）' : '发送（需选择角色）'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
