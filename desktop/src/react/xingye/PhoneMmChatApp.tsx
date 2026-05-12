import { useMemo, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';

interface PhoneMmChatAppProps {
  ownerAgent: Agent | null;
  displayName: string;
  onBack: () => void;
}

type MmChatRole = 'ta' | 'ai';

interface MmChatTurn {
  id: string;
  role: MmChatRole;
  text: string;
}

interface MmChatSessionMock {
  id: string;
  title: string;
  preview: string;
  /** 空数组则展示「尚无消息」占位 */
  messages: MmChatTurn[];
}

/** 本地展示用 mock，不接 LLM */
const MM_CHAT_MOCK_SESSIONS: MmChatSessionMock[] = [
  {
    id: 's1',
    title: '今晚的安排',
    preview: 'AI：可以把目标拆成三步…',
    messages: [
      { id: 'm1', role: 'ta', text: '明天要交小组作业，我现在脑子很乱，帮我排个顺序。' },
      {
        id: 'm2',
        role: 'ai',
        text:
          '可以先把「必须交付」列出来，再估时间。\n' +
          '1) 确认题目与分工\n' +
          '2) 各自草稿\n' +
          '3) 合并与检查引用格式',
      },
      { id: 'm3', role: 'ta', text: '如果只有三小时呢？' },
      {
        id: 'm4',
        role: 'ai',
        text: '三小时就只做合并版：先写结论段，再补证据与图表占位，最后统一术语。',
      },
    ],
  },
  {
    id: 's2',
    title: '新建咨询',
    preview: '尚无消息',
    messages: [],
  },
];

const MM_CHAT_QUICK_CHIPS = [
  '帮我把焦虑写成可执行清单',
  '用三个问题澄清我的目标',
  '用更温柔的语气改写这段话',
  '给我一版「拒绝」话术，不伤关系',
];

export function PhoneMmChatApp({ ownerAgent, displayName, onBack }: PhoneMmChatAppProps) {
  const [sessionId, setSessionId] = useState(MM_CHAT_MOCK_SESSIONS[0].id);
  const [composer, setComposer] = useState('');

  const session = useMemo(
    () => MM_CHAT_MOCK_SESSIONS.find((s) => s.id === sessionId) ?? MM_CHAT_MOCK_SESSIONS[0],
    [sessionId],
  );

  const taLabel = displayName || 'TA';
  const roleLine = ownerAgent ? `当前角色：${taLabel}` : '未选择角色';

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
            {MM_CHAT_MOCK_SESSIONS.map((s) => {
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
                  真实版本里会展示 TA 与助手的历史消息。当前为纯前端 mock，不连接模型。
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
              placeholder="输入区仅作展示；不向真实模型发送。"
              aria-label="咨询输入框（展示用）"
              rows={2}
            />
            <p className={styles.mmChatComposerHint}>演示壳：无网络请求、无工作区写入、不触发 OpenHanako 聊天。</p>
            <div className={styles.mmChatComposerActions}>
              <button type="button" className={styles.mmChatSendDisabled} disabled>
                发送（未接模型）
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
