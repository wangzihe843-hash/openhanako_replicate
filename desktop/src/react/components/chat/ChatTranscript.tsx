import { memo, useCallback, useMemo } from 'react';
import type { ChatListItem, ChatMessage } from '../../stores/chat-types';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ProcessFoldBlock } from './ProcessFoldBlock';
import { buildTranscriptRenderItems, type TranscriptRenderItem } from './process-fold';
import { useStore } from '../../stores';
import { selectIsStreamingSession } from '../../stores/session-selectors';

interface Props {
  items: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
  hideUserIdentity?: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
  enableProcessFold?: boolean;
}

export const ChatTranscript = memo(function ChatTranscript({
  items,
  sessionPath,
  agentId,
  readOnly = false,
  hideUserIdentity = false,
  userIdentity,
  registerMessageElement,
  enableProcessFold = false,
}: Props) {
  const isStreaming = useStore(s => selectIsStreamingSession(s, sessionPath));
  const renderItems = useMemo(
    () => enableProcessFold
      ? buildTranscriptRenderItems(items, { isStreaming })
      : items.map((item, originalIndex) => ({ type: 'source' as const, item, originalIndex })),
    [enableProcessFold, isStreaming, items],
  );
  const latestTurn = useMemo(() => {
    let latestUserIndex = -1;
    let latestAssistantIndex = -1;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.type !== 'message') continue;
      if (latestUserIndex < 0 && item.data.role === 'user') latestUserIndex = i;
      if (latestAssistantIndex < 0 && item.data.role === 'assistant') latestAssistantIndex = i;
      if (latestUserIndex >= 0 && latestAssistantIndex >= 0) break;
    }
    const latestUserItem = latestUserIndex >= 0 ? items[latestUserIndex] : null;
    return {
      latestUserIndex,
      latestAssistantIndex,
      latestUserMessage: latestUserItem?.type === 'message' && latestUserItem.data.role === 'user'
        ? latestUserItem.data
        : null,
    };
  }, [items]);

  return (
    <>
      {renderItems.map((renderItem) => (
        <TranscriptRenderItemView
          key={renderItemKey(renderItem)}
          renderItem={renderItem}
          sourceItems={items}
          sessionPath={sessionPath}
          agentId={agentId}
          readOnly={readOnly}
          hideUserIdentity={hideUserIdentity}
          userIdentity={userIdentity}
          latestUserMessage={latestTurn.latestUserMessage}
          latestUserIndex={latestTurn.latestUserIndex}
          latestAssistantIndex={latestTurn.latestAssistantIndex}
          registerMessageElement={registerMessageElement}
        />
      ))}
    </>
  );
});

function renderItemKey(renderItem: TranscriptRenderItem): string {
  if (renderItem.type === 'process_fold') return renderItem.id;
  const item = renderItem.item;
  return item.type === 'message' ? item.data.id : `c-${renderItem.originalIndex}`;
}

const TranscriptRenderItemView = memo(function TranscriptRenderItemView({
  renderItem,
  sourceItems,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  latestUserMessage,
  latestUserIndex,
  latestAssistantIndex,
  registerMessageElement,
}: {
  renderItem: TranscriptRenderItem;
  sourceItems: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  latestUserMessage?: ChatMessage | null;
  latestUserIndex: number;
  latestAssistantIndex: number;
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
}) {
  const originalIndex = renderItem.originalIndex;
  const prevItem = originalIndex > 0 ? sourceItems[originalIndex - 1] : undefined;

  if (renderItem.type === 'process_fold') {
    const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
    return (
      <ProcessFoldBlock
        group={renderItem}
        showAvatar={prevRole !== 'assistant'}
        sessionPath={sessionPath}
        agentId={agentId}
        readOnly={readOnly}
        registerMessageElement={registerMessageElement}
      />
    );
  }

  return (
    <TranscriptItemView
      item={renderItem.item}
      prevItem={prevItem}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      hideUserIdentity={hideUserIdentity}
      userIdentity={userIdentity}
      latestUserMessage={latestUserMessage}
      isLatestUserMessage={originalIndex === latestUserIndex}
      isLatestAssistantMessage={
        originalIndex === latestAssistantIndex
        && latestAssistantIndex > latestUserIndex
      }
      registerMessageElement={registerMessageElement}
    />
  );
});

const TranscriptItemView = memo(function TranscriptItemView({
  item,
  prevItem,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  latestUserMessage,
  isLatestUserMessage,
  isLatestAssistantMessage,
  registerMessageElement,
}: {
  item: ChatListItem;
  prevItem?: ChatListItem;
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  latestUserMessage?: ChatMessage | null;
  isLatestUserMessage: boolean;
  isLatestAssistantMessage: boolean;
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
}) {
  const messageId = item.type === 'message' ? item.data.id : null;
  const messageRef = useCallback((element: HTMLDivElement | null) => {
    if (messageId) registerMessageElement?.(messageId, element);
  }, [messageId, registerMessageElement]);

  if (item.type === 'compaction') return null;

  const msg = item.data;
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;

  if (msg.role === 'user') {
    return (
      <UserMessage
        message={msg}
        showAvatar={showAvatar}
        sessionPath={sessionPath}
        readOnly={readOnly}
        hideIdentity={hideUserIdentity}
        userIdentity={userIdentity}
        isLatestUserMessage={isLatestUserMessage}
        messageRef={messageRef}
      />
    );
  }

  return (
    <AssistantMessage
      message={msg}
      showAvatar={showAvatar}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      isLatestAssistantMessage={isLatestAssistantMessage}
      retrySourceMessage={latestUserMessage}
      messageRef={messageRef}
    />
  );
});
