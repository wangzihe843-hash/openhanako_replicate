/**
 * SubagentCard — 子 Agent 静态预览状态卡片
 *
 * 订阅 streamKey 上的实时事件，互斥显示当前状态：
 * 思考 / 文字输出 / 工具调用 / 已完成 / 失败 / 已中断
 */

import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { subscribeStreamKey } from '../../services/stream-key-dispatcher';
import { hanaUrl } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { ChatResourceCard } from './ChatResourceCard';
import type { ChatResourceCardStatusTone } from './ChatResourceCard';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SubagentCardProps {
  block: {
    taskId: string;
    task: string;
    taskTitle: string;
    agentId?: string;
    agentName?: string;
    requestedAgentId?: string;
    requestedAgentName?: string;
    executorAgentId?: string;
    executorAgentNameSnapshot?: string;
    streamKey: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted';
    summary?: string;
    label?: string | null;
    reuseInstance?: string | null;
  };
}

export const SubagentCard = memo(function SubagentCard({ block }: SubagentCardProps) {
  const [status, setStatus] = useState(block.streamStatus);
  const [display, setDisplay] = useState<string>(() => {
    if (block.streamStatus === 'done') return block.summary || '已完成';
    if (block.streamStatus === 'failed') return block.summary || '失败';
    if (block.streamStatus === 'aborted') return block.summary || '已终止';
    return '准备中...';
  });
  const textRef = useRef('');

  // 头像：优先用 agent 头像 API，fallback 到 yuan 剪影头像
  const currentAgentId = useStore(s => s.currentAgentId);
  const agents = useStore(s => s.agents);
  const agentId = block.agentId || block.executorAgentId || currentAgentId || '';
  const displayInfo = resolveAgentDisplayInfo({
    id: agentId || null,
    agents,
    fallbackAgentName: block.agentName || block.executorAgentNameSnapshot || block.agentId || 'Subagent',
  });
  const agentName = displayInfo.displayName;

  // Sync block prop changes (from block_update patch)
  useEffect(() => {
    setStatus(block.streamStatus);
    if (block.streamStatus === 'done') setDisplay(block.summary || '已完成');
    if (block.streamStatus === 'failed') setDisplay(block.summary || '失败');
    if (block.streamStatus === 'aborted') setDisplay(block.summary || '已终止');
  }, [block.streamStatus, block.summary]);

  // Subscribe to live events
  useEffect(() => {
    if (status !== 'running' || !block.streamKey) return;

    const unsub = subscribeStreamKey(block.streamKey, (event: any) => {
      if (event.type === 'text_delta') {
        textRef.current += event.delta || '';
        if (textRef.current.length > 100) textRef.current = textRef.current.slice(-100);
        setDisplay(textRef.current);
      } else if (event.type === 'thinking_start') {
        setDisplay('正在思考...');
      } else if (event.type === 'thinking_end') {
        if (textRef.current) setDisplay(textRef.current);
      } else if (event.type === 'tool_start') {
        setDisplay(`正在调用 ${event.name}...`);
      } else if (event.type === 'tool_end') {
        if (textRef.current) setDisplay(textRef.current);
        else setDisplay('执行中...');
      }
    });

    return unsub;
  }, [block.streamKey, status]);

  // "已中断" 仅在历史加载时判断：组件首次 mount 时如果 streamKey 为空且 status=running，
  // 等待一小段时间让 block_update 到达。如果一直没到才标记中断。
  const [waitedForKey, setWaitedForKey] = useState(false);
  useEffect(() => {
    if (block.streamKey || status !== 'running') return;
    const timer = setTimeout(() => setWaitedForKey(true), 3000);
    return () => clearTimeout(timer);
  }, [block.streamKey, status]);

  const isInterrupted = status === 'running' && !block.streamKey && waitedForKey;

  const handleAbort = useCallback(async () => {
    try {
      const res = await fetch(hanaUrl(`/api/task/${block.taskId}/abort`), { method: 'POST' });
      if (res.ok) {
        setStatus('aborted');
        setDisplay(window.t?.('subagentAborted') || '已终止');
      }
    } catch { /* user-initiated abort; silent on network failure */ }
  }, [block.taskId]);

  const headerDisplay = status === 'running' && display ? display : block.taskTitle;
  const displayLabel = block.label || block.reuseInstance || null;
  const statusLabel = isInterrupted
    ? '已中断'
    : status === 'aborted'
      ? '已终止'
      : status === 'done'
        ? '已完成'
        : status === 'failed'
          ? '失败'
          : '已派出';
  const statusTone: ChatResourceCardStatusTone = status === 'done'
    ? 'success'
    : status === 'failed'
      ? 'danger'
      : status === 'running' && !isInterrupted
        ? 'accent'
        : 'muted';

  return (
    <ChatResourceCard
      className={`${styles.subagentResourceCard} ${styles[`subagent-${status}`]}`}
      icon={(
        <AgentAvatar
          info={displayInfo}
          className={styles.subagentAvatar}
          alt={agentName}
        />
      )}
      title={agentName}
      titleMeta={displayLabel ? `· ${displayLabel}` : undefined}
      subtitle={headerDisplay}
      statusLabel={statusLabel}
      statusTone={statusTone}
      actionSlot={status === 'running' && !isInterrupted && (
        <button
          type="button"
          className={styles.subagentAbortBtn}
          onClick={(event) => {
            event.stopPropagation();
            void handleAbort();
          }}
          title={window.t?.('subagentAbort') || '终止'}
        >
          ✕
        </button>
      )}
    />
  );
});
