// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from '../../components/chat/ChatTranscript';
import { useStore } from '../../stores';
import type { ChatListItem, ContentBlock } from '../../stores/chat-types';

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

const sessionPath = '/session/turn-time.jsonl';

function user(id: string, timestamp: number, text: string): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      role: 'user',
      timestamp,
      text,
      textHtml: `<p>${text}</p>`,
    },
  };
}

function assistant(id: string, timestamp: number, blocks: ContentBlock[]): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      role: 'assistant',
      timestamp,
      blocks,
    },
  };
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', html: `<p>${text}</p>`, source: text };
}

function thinking(content: string): ContentBlock {
  return { type: 'thinking', content, sealed: true };
}

describe('ChatTranscript turn timestamps', () => {
  beforeEach(() => {
    window.t = ((key: string) => ({
      'thinking.done': '思考完成',
      'common.regenerate': '重新生成',
    }[key] || key)) as typeof window.t;
    useStore.setState({
      agents: [],
      agentName: 'Hana',
      agentYuan: 'hana',
      streamingSessions: [],
      selectedIdsBySession: {},
      chatSessions: {
        [sessionPath]: {
          hasMore: false,
          loadingMore: false,
          items: [],
        },
      },
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows time on user messages and the final assistant message of each turn only', () => {
    const items: ChatListItem[] = [
      user('u1', new Date(2026, 4, 7, 8, 0).getTime(), '第一轮'),
      assistant('a1-tool', new Date(2026, 4, 7, 8, 1).getTime(), [thinking('读文件')]),
      assistant('a1-final', new Date(2026, 4, 7, 8, 2).getTime(), [textBlock('第一轮完成')]),
      user('u2', new Date(2026, 4, 7, 9, 0).getTime(), '第二轮'),
      assistant('a2-tool', new Date(2026, 4, 7, 9, 1).getTime(), [thinking('跑命令')]),
      assistant('a2-final', new Date(2026, 4, 7, 9, 2).getTime(), [textBlock('第二轮完成')]),
    ];

    render(
      <ChatTranscript
        items={items}
        sessionPath={sessionPath}
      />,
    );

    expect(screen.getByText('08:00')).toBeInTheDocument();
    expect(screen.queryByText('08:01')).not.toBeInTheDocument();
    expect(screen.getByText('08:02')).toBeInTheDocument();
    expect(screen.getByText('09:00')).toBeInTheDocument();
    expect(screen.queryByText('09:01')).not.toBeInTheDocument();
    expect(screen.getByText('09:02')).toBeInTheDocument();
  });
});
