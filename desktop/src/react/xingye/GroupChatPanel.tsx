import { useCallback, useEffect, useMemo, useState } from 'react';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import type { Agent, ChannelMessage } from '../types';
import {
  triggerGroupChatReply,
  type TriggerGroupChatReplyOutcome,
} from './xingye-group-chat-orchestrator';
import styles from './XingyeShell.module.css';

type ChannelSummary = {
  id: string;
  name: string;
  members: string[];
  lastTimestamp: string;
  messageCount: number;
};

type ChannelDetail = {
  id: string;
  name: string;
  description: string;
  members: string[];
  messages: ChannelMessage[];
};

type LastTriggerResult = {
  status: 'replied' | 'skipped' | 'noop' | 'error';
  message: string;
};

type GroupChatPanelProps = {
  selectedAgent: Agent | null;
};

async function fetchChannelsForAgent(agentId: string): Promise<ChannelSummary[]> {
  try {
    const res = await hanaFetch('/api/channels');
    if (!res.ok) return [];
    const data = (await res.json()) as { channels?: Array<Record<string, unknown>> };
    const list = Array.isArray(data.channels) ? data.channels : [];
    return list
      .map((ch): ChannelSummary => {
        const members = Array.isArray(ch.members)
          ? (ch.members as unknown[]).filter((m): m is string => typeof m === 'string')
          : [];
        return {
          id: typeof ch.id === 'string' ? ch.id : '',
          name: typeof ch.name === 'string' && ch.name ? ch.name : String(ch.id ?? ''),
          members,
          lastTimestamp: typeof ch.lastTimestamp === 'string' ? ch.lastTimestamp : '',
          messageCount: typeof ch.messageCount === 'number' ? ch.messageCount : 0,
        };
      })
      .filter((ch) => ch.id && ch.members.includes(agentId));
  } catch {
    return [];
  }
}

async function fetchChannelDetail(channelId: string): Promise<ChannelDetail | null> {
  try {
    const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const messages = Array.isArray(data.messages)
      ? (data.messages as Array<Record<string, unknown>>)
          .filter((m) => typeof m.sender === 'string' && typeof m.timestamp === 'string' && typeof m.body === 'string')
          .map((m) => ({
            sender: m.sender as string,
            timestamp: m.timestamp as string,
            body: m.body as string,
          }))
      : [];
    return {
      id: typeof data.id === 'string' ? data.id : channelId,
      name: typeof data.name === 'string' ? data.name : channelId,
      description: typeof data.description === 'string' ? data.description : '',
      members: Array.isArray(data.members)
        ? (data.members as unknown[]).filter((m): m is string => typeof m === 'string')
        : [],
      messages,
    };
  } catch {
    return null;
  }
}

function describeOutcome(outcome: TriggerGroupChatReplyOutcome): LastTriggerResult {
  switch (outcome.status) {
    case 'replied':
      return { status: 'replied', message: 'TA 已回复一条群聊消息' };
    case 'skipped':
      return {
        status: 'skipped',
        message: `TA 看过了，暂时没有要回复的内容${outcome.reason ? ` · ${outcome.reason}` : ''}`,
      };
    case 'noop':
      return { status: 'noop', message: outcome.reason };
    case 'error':
      return { status: 'error', message: `出错了：${outcome.error}` };
    default:
      return { status: 'error', message: '未知结果' };
  }
}

export function GroupChatPanel({ selectedAgent }: GroupChatPanelProps) {
  const userName = useStore((s) => s.userName) || 'user';
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [channelDetail, setChannelDetail] = useState<ChannelDetail | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [lastResult, setLastResult] = useState<LastTriggerResult | null>(null);
  const [messagesExpanded, setMessagesExpanded] = useState(false);

  const refreshChannelList = useCallback(async () => {
    if (!selectedAgent) {
      setChannels([]);
      setSelectedChannelId(null);
      return;
    }
    setLoadingChannels(true);
    try {
      const list = await fetchChannelsForAgent(selectedAgent.id);
      setChannels(list);
      setSelectedChannelId((current) => {
        if (current && list.some((c) => c.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } finally {
      setLoadingChannels(false);
    }
  }, [selectedAgent]);

  useEffect(() => {
    void refreshChannelList();
  }, [refreshChannelList]);

  // Reset result + collapse messages when switching agent or channel
  useEffect(() => {
    setLastResult(null);
    setMessagesExpanded(false);
  }, [selectedAgent?.id, selectedChannelId]);

  const refreshChannelDetail = useCallback(async () => {
    if (!selectedChannelId) {
      setChannelDetail(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const detail = await fetchChannelDetail(selectedChannelId);
      setChannelDetail(detail);
    } finally {
      setLoadingDetail(false);
    }
  }, [selectedChannelId]);

  useEffect(() => {
    void refreshChannelDetail();
  }, [refreshChannelDetail]);

  const onTrigger = useCallback(async () => {
    if (!selectedAgent || !selectedChannelId) return;
    setTriggering(true);
    setLastResult(null);
    try {
      const outcome = await triggerGroupChatReply({
        agent: selectedAgent,
        channelId: selectedChannelId,
      });
      setLastResult(describeOutcome(outcome));
      if (outcome.status === 'replied') {
        // Refresh messages so the user sees the new reply
        await refreshChannelDetail();
        await refreshChannelList();
      }
    } catch (err) {
      setLastResult({
        status: 'error',
        message: `触发失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setTriggering(false);
    }
  }, [refreshChannelDetail, refreshChannelList, selectedAgent, selectedChannelId]);

  const headerSubtitle = useMemo(() => {
    if (!selectedAgent) return '请先在角色列表里选择当前 agent';
    const count = channels.length;
    if (count === 0) return `${selectedAgent.name} 当前还没有加入任何 OpenHanako Channel`;
    return `${selectedAgent.name} 加入的群聊 · ${count} 个`;
  }, [channels.length, selectedAgent]);

  return (
    <div className={styles.entryPanel}>
      <div className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>Xingye Group Chat · 手动提醒回复 MVP</p>
          <h2 className={styles.panelTitle}>群聊</h2>
          <p className={styles.panelDescription}>{headerSubtitle}</p>
        </div>
      </div>

      <section className={styles.xyGroupChat} aria-label="星野群聊面板">
        <div className={styles.xyGroupChatList}>
          <div className={styles.xyGroupChatListHeader}>
            <h3 className={styles.xyGroupChatListTitle}>群聊列表</h3>
            <button
              type="button"
              className={styles.xyGroupChatRefreshButton}
              onClick={() => void refreshChannelList()}
              disabled={loadingChannels || !selectedAgent}
            >
              刷新
            </button>
          </div>
          {!selectedAgent ? (
            <p className={styles.xyGroupChatHint}>需要先选择一个当前 agent。</p>
          ) : loadingChannels ? (
            <p className={styles.xyGroupChatHint}>正在加载…</p>
          ) : channels.length === 0 ? (
            <p className={styles.xyGroupChatHint}>当前 agent 还没有加入任何 OpenHanako Channel。可以在 OpenHanako 主体创建群聊，再回来这里手动提醒 TA。</p>
          ) : (
            <ul className={styles.xyGroupChatChannelList}>
              {channels.map((ch) => {
                const isActive = ch.id === selectedChannelId;
                return (
                  <li key={ch.id}>
                    <button
                      type="button"
                      className={`${styles.xyGroupChatChannelButton}${isActive ? ` ${styles.xyGroupChatChannelButtonActive}` : ''}`}
                      onClick={() => setSelectedChannelId(ch.id)}
                    >
                      <span className={styles.xyGroupChatChannelName}># {ch.name}</span>
                      <span className={styles.xyGroupChatChannelMeta}>
                        {ch.messageCount} 条 · {ch.members.length + 1} 成员
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className={styles.xyGroupChatDetail}>
          {!selectedAgent ? (
            <p className={styles.xyGroupChatHint}>选择 agent 后才能查看群聊。</p>
          ) : !selectedChannelId ? (
            <p className={styles.xyGroupChatHint}>选择左侧群聊查看消息。</p>
          ) : loadingDetail ? (
            <p className={styles.xyGroupChatHint}>正在加载群聊消息…</p>
          ) : channelDetail ? (
            <>
              <div className={styles.xyGroupChatDetailHeader}>
                <div>
                  <h3 className={styles.xyGroupChatDetailTitle}># {channelDetail.name}</h3>
                  <p className={styles.xyGroupChatDetailMeta}>
                    成员：{[userName, ...channelDetail.members.filter((m) => m !== userName)].join('、')}
                  </p>
                  {channelDetail.description ? (
                    <p className={styles.xyGroupChatDetailDesc}>{channelDetail.description}</p>
                  ) : null}
                </div>
                <div className={styles.xyGroupChatDetailActions}>
                  <button
                    type="button"
                    className={styles.xyGroupChatTriggerButton}
                    onClick={() => void onTrigger()}
                    disabled={triggering}
                  >
                    {triggering ? '让 TA 看看…' : '提醒 TA 看群聊'}
                  </button>
                </div>
              </div>

              {lastResult ? (
                <div
                  className={`${styles.xyGroupChatResult} ${
                    lastResult.status === 'error'
                      ? styles.xyGroupChatResultError
                      : lastResult.status === 'replied'
                        ? styles.xyGroupChatResultReplied
                        : styles.xyGroupChatResultSkipped
                  }`}
                  role="status"
                >
                  {lastResult.message}
                </div>
              ) : null}

              <div className={styles.xyGroupChatMessagesSection}>
                <button
                  type="button"
                  className={styles.xyGroupChatMessagesToggle}
                  onClick={() => setMessagesExpanded((v) => !v)}
                  aria-expanded={messagesExpanded}
                  aria-controls="xy-group-chat-messages"
                >
                  <span className={styles.xyGroupChatMessagesToggleLabel}>
                    聊天记录
                    <span className={styles.xyGroupChatMessagesToggleCount}>
                      · {channelDetail.messages.length} 条
                    </span>
                  </span>
                  <span className={styles.xyGroupChatMessagesToggleHint}>
                    {messagesExpanded ? '收起' : '展开'}
                  </span>
                  <svg
                    className={`${styles.xyGroupChatMessagesToggleChevron}${
                      messagesExpanded ? ` ${styles.xyGroupChatMessagesToggleChevronOpen}` : ''
                    }`}
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {messagesExpanded ? (
                  <ul
                    id="xy-group-chat-messages"
                    className={styles.xyGroupChatMessageList}
                    aria-label="群聊消息列表"
                  >
                    {channelDetail.messages.length === 0 ? (
                      <li className={styles.xyGroupChatHint}>这个频道还没有任何消息。</li>
                    ) : (
                      channelDetail.messages.map((m) => {
                        const isUser = m.sender === userName;
                        const isSelfAgent = !!selectedAgent && m.sender === selectedAgent.id;
                        const isSystem = m.sender === 'system';
                        const rowAlign = isSystem
                          ? styles.xyGroupChatMessageRowSystem
                          : isUser
                            ? styles.xyGroupChatMessageRowUser
                            : styles.xyGroupChatMessageRowOther;
                        const cls = [
                          styles.xyGroupChatMessage,
                          rowAlign,
                          isUser ? styles.xyGroupChatMessageUser : '',
                          isSelfAgent ? styles.xyGroupChatMessageSelfAgent : '',
                          isSystem ? styles.xyGroupChatMessageSystem : '',
                        ]
                          .filter(Boolean)
                          .join(' ');
                        const tag = isUser
                          ? `${m.sender} · user`
                          : isSelfAgent
                            ? `${m.sender} · 当前 agent`
                            : isSystem
                              ? `${m.sender} · 频道系统`
                              : `${m.sender} · 其他成员`;
                        return (
                          <li key={`${m.sender}@${m.timestamp}`} className={cls}>
                            <div className={styles.xyGroupChatMessageHeader}>
                              <span className={styles.xyGroupChatMessageSender}>{tag}</span>
                              <span className={styles.xyGroupChatMessageTimestamp}>
                                {m.timestamp}
                              </span>
                            </div>
                            <div className={styles.xyGroupChatMessageBody}>{m.body}</div>
                          </li>
                        );
                      })
                    )}
                  </ul>
                ) : (
                  <p className={styles.xyGroupChatMessagesCollapsedHint}>
                    {channelDetail.messages.length === 0
                      ? '这个频道还没有任何消息。'
                      : '点开「频道」标签即可查看完整聊天记录。'}
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className={styles.xyGroupChatHint}>读取群聊消息失败，点击刷新重试。</p>
          )}
        </div>
      </section>

      <section className={styles.entryNotice} aria-label="MVP 说明">
        <h3 className={styles.entryNoticeTitle}>关于这个 MVP</h3>
        <p>
          这是星野群聊「手动提醒直接回复」最小可行实现：你点击「提醒 TA 看群聊」后，当前 agent 会读取该 OpenHanako Channel 的最近消息，并由模型决定是否要发言；如果决定回复，就以该 agent 的身份直接写入一条新的群聊消息。
        </p>
        <p>
          目前不做候选确认、不会自动巡检、不会让其他 agent 抢答；同一条最新消息重复点击不会刷屏。
        </p>
      </section>
    </div>
  );
}
