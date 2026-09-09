import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { subscribeStreamKey } from '../../services/stream-key-dispatcher';
import { renderMarkdown } from '../../utils/markdown';
import { findOpenToolIndex, toolCallFromStartEvent, toolCallIdFromEvent } from '../../utils/tool-call-identity';
import type { ChatListItem, ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import { loadMessages } from '../../stores/session-actions';
import { requestStreamResume } from '../../services/stream-resume';
import { useContinuousBottomScroll } from '../../hooks/use-continuous-bottom-scroll';
import { ChatTranscript } from './ChatTranscript';
import styles from './Chat.module.css';

const EMPTY_ITEMS: ChatListItem[] = [];
const EMPTY_SESSION_RETRY_DELAY_MS = 800;

interface Props {
  taskId: string;
  sessionId?: string | null;
  sessionPath: string | null;
  agentId?: string | null;
  streamStatus: 'running' | 'done' | 'failed' | 'aborted';
  summary?: string | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}

const PREVIEW_STICKY_THRESHOLD = 32;
const STREAM_MESSAGE_ID_PREFIX = 'subagent-preview-stream';

function normalizePreviewString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolvePreviewSessionPath(state: any, sessionId?: string | null, sessionPath?: string | null): string | null {
  const normalizedSessionId = normalizePreviewString(sessionId);
  const normalizedSessionPath = normalizePreviewString(sessionPath);
  if (!normalizedSessionId) return normalizedSessionPath;
  if (state.currentSessionId === normalizedSessionId) {
    return normalizePreviewString(state.currentSessionPath)
      || normalizePreviewString(state.sessionLocatorsById?.[normalizedSessionId]?.path)
      || normalizedSessionPath;
  }
  return normalizePreviewString(state.sessionLocatorsById?.[normalizedSessionId]?.path)
    || normalizePreviewString((state.sessions || []).find((item: any) => item?.sessionId === normalizedSessionId)?.path)
    || normalizedSessionPath;
}

function hasAssistantHistory(items: ChatListItem[]): boolean {
  return items.some((item) => item.type === 'message' && item.data.role === 'assistant');
}

function createStreamMessage(taskId: string, turnToken: number): ChatMessage {
  return {
    id: `${STREAM_MESSAGE_ID_PREFIX}-${taskId}-${turnToken}`,
    role: 'assistant',
    blocks: [],
  };
}

function upsertBlock(
  blocks: ContentBlock[],
  match: (block: ContentBlock) => boolean,
  nextBlock: ContentBlock,
  insertAtStart = false,
): ContentBlock[] {
  const idx = blocks.findIndex(match);
  if (idx >= 0) {
    const next = [...blocks];
    next[idx] = nextBlock;
    return next;
  }
  return insertAtStart ? [nextBlock, ...blocks] : [...blocks, nextBlock];
}

export function SubagentSessionPreview({ taskId, sessionId = null, sessionPath, agentId, streamStatus, summary, scrollContainerRef }: Props) {
  const entry = useStore(s => s.subagentPreviewByTaskId[taskId]);
  const resolvedSessionPath = useStore(s => resolvePreviewSessionPath(s, sessionId, sessionPath));
  const session = useStore(s => (resolvedSessionPath ? sessionScopedValue(s, s.chatSessions, resolvedSessionPath) ?? null : null));
  const items = session?.items ?? EMPTY_ITEMS;
  const [retryNonce, setRetryNonce] = useState(0);
  const [streamMessage, setStreamMessage] = useState<ChatMessage | null>(null);
  const [streamRevision, setStreamRevision] = useState(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const bottomScroll = useContinuousBottomScroll({
    scrollRef: scrollContainerRef,
    contentRef,
    active: !!resolvedSessionPath,
    stickyThreshold: PREVIEW_STICKY_THRESHOLD,
  });
  const activeStreamTurnRef = useRef(0);
  const pendingCleanupTurnRef = useRef<number | null>(null);
  const pendingLoadRef = useRef<{
    taskId: string;
    sessionPath: string;
    promise: Promise<void>;
  } | null>(null);

  const beginNextStreamTurn = useCallback(() => {
    activeStreamTurnRef.current += 1;
    pendingCleanupTurnRef.current = null;
    return activeStreamTurnRef.current;
  }, []);

  // Switch landing in the layout phase (pre-paint). Only arm an instant landing when the target
  // session has no messages yet, so the first async hydrate (0 -> N) snaps without animating;
  // an already-loaded session lands via the instant scroll and later growth = streaming (smooth follow).
  useLayoutEffect(() => {
    const alreadyHydrated = !!resolvedSessionPath
      && ((sessionScopedValue(useStore.getState(), useStore.getState().chatSessions, resolvedSessionPath)?.items?.length ?? 0) > 0);
    if (resolvedSessionPath && !alreadyHydrated) bottomScroll.armInstantLanding();
    bottomScroll.scrollToBottom({ mode: 'instant', forceSticky: true });
    activeStreamTurnRef.current = 0;
    pendingCleanupTurnRef.current = null;
    setStreamMessage(null);
    setStreamRevision(0);
  }, [bottomScroll, resolvedSessionPath]);

  useEffect(() => {
    bottomScroll.followBottom();
  }, [bottomScroll, items.length, entry?.loading, streamStatus, streamRevision]);

  // streamMessage 的清理完全交给 turn_end 事件（下方 subscribeStreamKey 分支中处理）。
  // 不能用 hasAssistantHistory(items) 做被动推断：多轮 turn 场景下 items 永远有上一轮的
  // assistant 记录，被动清理会把刚开始的新一轮 streamMessage 立刻抹掉。

  useEffect(() => {
    if (!resolvedSessionPath) return;
    if (items.length > 0) {
      useStore.getState().markSubagentPreviewLoaded(taskId);
      return;
    }
    let cancelled = false;
    let retryTimer: number | null = null;

    const finishLoading = useStore.getState().beginSubagentPreviewLoad(taskId);

    // Loading is a display state, not a lock: an earlier mount/effect may have
    // owned it. Keep the actual request across status changes, and give each
    // effect its own completion handler so it uses the current stream status.
    let request = pendingLoadRef.current;
    if (!request || request.taskId !== taskId || request.sessionPath !== resolvedSessionPath) {
      request = { taskId, sessionPath: resolvedSessionPath, promise: loadMessages(resolvedSessionPath) };
      pendingLoadRef.current = request;
    }
    const releaseRequest = () => {
      if (pendingLoadRef.current === request) pendingLoadRef.current = null;
    };

    void request.promise
      .then(() => {
        releaseRequest();
        if (cancelled) return;
        const latestState = useStore.getState();

        const latestItems = sessionScopedValue(latestState, latestState.chatSessions, resolvedSessionPath)?.items ?? EMPTY_ITEMS;
        if (latestItems.length > 0) {
          finishLoading(true);
          return;
        }

        if (streamStatus === 'running') {
          finishLoading();
          retryTimer = window.setTimeout(() => {
            if (!cancelled) setRetryNonce((n) => n + 1);
          }, EMPTY_SESSION_RETRY_DELAY_MS);
          return;
        }

        finishLoading(true);
      })
      .catch(() => {
        releaseRequest();
        if (cancelled) return;
        finishLoading();
      });

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      finishLoading();
    };
  }, [taskId, resolvedSessionPath, items.length, retryNonce, streamStatus]);

  useEffect(() => {
    if (!resolvedSessionPath || streamStatus !== 'running') return;
    const resumeRef = sessionId ? { sessionId, sessionPath: resolvedSessionPath } : resolvedSessionPath;
    requestStreamResume(resumeRef);

    const updateStreamMessage = (updater: (message: ChatMessage) => ChatMessage) => {
      setStreamMessage((prev) => {
        let base = prev;
        if (!base || pendingCleanupTurnRef.current === activeStreamTurnRef.current) {
          base = createStreamMessage(taskId, beginNextStreamTurn());
        }
        const next = updater(base);
        return next;
      });
      setStreamRevision((v) => v + 1);
    };

    const unsubscribe = subscribeStreamKey(resolvedSessionPath, (event: any) => {
      switch (event.type) {
        case 'thinking_start':
          updateStreamMessage((message) => ({
            ...message,
            blocks: upsertBlock(
              message.blocks || [],
              (block) => block.type === 'thinking',
              { type: 'thinking', content: '', sealed: false },
              true,
            ),
          }));
          break;

        case 'thinking_delta':
          updateStreamMessage((message) => {
            const blocks = message.blocks || [];
            const thinking = blocks.find((block) => block.type === 'thinking') as Extract<ContentBlock, { type: 'thinking' }> | undefined;
            return {
              ...message,
              blocks: upsertBlock(
                blocks,
                (block) => block.type === 'thinking',
                {
                  type: 'thinking',
                  content: `${thinking?.content || ''}${event.delta || ''}`,
                  sealed: false,
                },
                true,
              ),
            };
          });
          break;

        case 'thinking_end':
          updateStreamMessage((message) => {
            const blocks = message.blocks || [];
            const thinking = blocks.find((block) => block.type === 'thinking') as Extract<ContentBlock, { type: 'thinking' }> | undefined;
            return {
              ...message,
              blocks: upsertBlock(
                blocks,
                (block) => block.type === 'thinking',
                {
                  type: 'thinking',
                  content: thinking?.content || '',
                  sealed: true,
                },
                true,
              ),
            };
          });
          break;

        case 'text_delta':
          updateStreamMessage((message) => {
            const blocks = message.blocks || [];
            const textBlock = blocks.find((block) => block.type === 'text') as (Extract<ContentBlock, { type: 'text' }> & { _raw?: string }) | undefined;
            const prevText = textBlock?.source ?? textBlock?._raw ?? '';
            const nextText = prevText + (event.delta || '');
            return {
              ...message,
              blocks: upsertBlock(
                blocks,
                (block) => block.type === 'text',
                { type: 'text', html: renderMarkdown(nextText), source: nextText },
              ),
            };
          });
          break;

        case 'tool_start':
          updateStreamMessage((message) => {
            const blocks = [...(message.blocks || [])];
            const groupIndex = [...blocks]
              .reverse()
              .findIndex((block) => block.type === 'tool_group' && block.tools.some((tool) => !tool.done));
            const actualIndex = groupIndex >= 0 ? blocks.length - 1 - groupIndex : -1;
            if (actualIndex >= 0) {
              const group = blocks[actualIndex] as Extract<ContentBlock, { type: 'tool_group' }>;
              blocks[actualIndex] = {
                ...group,
                tools: [...group.tools, toolCallFromStartEvent(event)],
              };
            } else {
              blocks.push({
                type: 'tool_group',
                tools: [toolCallFromStartEvent(event)],
                collapsed: false,
              });
            }
            return { ...message, blocks };
          });
          break;

        case 'tool_end':
          updateStreamMessage((message) => {
            const blocks = [...(message.blocks || [])];
            for (let i = blocks.length - 1; i >= 0; i -= 1) {
              const block = blocks[i];
              if (block.type !== 'tool_group') continue;
              const toolIndex = findOpenToolIndex(block.tools, event);
              if (toolIndex < 0) continue;
              const tools = [...block.tools];
              const id = toolCallIdFromEvent(event);
              tools[toolIndex] = {
                ...tools[toolIndex],
                ...(id ? { id } : {}),
                done: true,
                success: !!event.success,
                details: event.details,
              };
              blocks[i] = {
                ...block,
                tools,
                collapsed: tools.length > 1 && tools.every((tool) => tool.done),
              };
              break;
            }
            return { ...message, blocks };
          });
          break;

        case 'content_block':
          updateStreamMessage((message) => ({
            ...message,
            blocks: [...(message.blocks || []), event.block],
          }));
          break;

        case 'turn_end':
          pendingCleanupTurnRef.current = activeStreamTurnRef.current || null;
          {
            const cleanupTurn = pendingCleanupTurnRef.current;
            if (!cleanupTurn) break;
            void loadMessages(resolvedSessionPath)
              .then(() => {
                if (pendingCleanupTurnRef.current !== cleanupTurn) return;
                if (activeStreamTurnRef.current !== cleanupTurn) return;
                const latestState = useStore.getState();
                const latestItems = sessionScopedValue(latestState, latestState.chatSessions, resolvedSessionPath)?.items ?? EMPTY_ITEMS;
                if (!hasAssistantHistory(latestItems)) return;
                pendingCleanupTurnRef.current = null;
                setStreamMessage((prev) => {
                  if (activeStreamTurnRef.current !== cleanupTurn) return prev;
                  return null;
                });
              })
              .catch(() => {});
          }
          break;

        default:
          break;
      }
    });

    return unsubscribe;
  }, [beginNextStreamTurn, resolvedSessionPath, sessionId, streamStatus, taskId]);

  const mergedItems = streamMessage
    ? [...items, { type: 'message' as const, data: streamMessage }]
    : items;

  const t = window.t ?? ((k: string) => k);

  if (!resolvedSessionPath) {
    if (streamStatus !== 'running') {
      return <div>{summary || (streamStatus === 'failed' ? t('chat.subagentPreview.historyUnrecoverable') : t('chat.subagentPreview.noSession'))}</div>;
    }
    return <div>{t('chat.subagentPreview.connecting')}</div>;
  }

  return (
    <div ref={contentRef} className={styles.subagentPreviewTranscript}>
      {entry?.loading && mergedItems.length === 0 ? (
        <div>{t('chat.subagentPreview.loadingSession')}</div>
      ) : streamStatus === 'running' && mergedItems.length === 0 ? (
        <div>{t('chat.subagentPreview.waitingContent')}</div>
      ) : mergedItems.length === 0 ? (
        <div>{t('chat.subagentPreview.noContent')}</div>
      ) : (
        <ChatTranscript
          items={mergedItems}
          sessionPath={resolvedSessionPath}
          agentId={agentId}
          readOnly
          hideUserIdentity
        />
      )}
    </div>
  );
}
