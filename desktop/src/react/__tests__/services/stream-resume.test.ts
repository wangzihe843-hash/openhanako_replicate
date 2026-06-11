// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadMessages: vi.fn(async () => {}),
  clearChat: vi.fn(),
  streamBufferManager: {
    clear: vi.fn(),
    finishTurn: vi.fn(),
  },
  ws: {
    readyState: 1,
    send: vi.fn(),
  },
}));

vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: mocks.streamBufferManager,
}));

vi.mock('../../stores/session-actions', () => ({
  loadMessages: mocks.loadMessages,
}));

vi.mock('../../stores/agent-actions', () => ({
  clearChat: mocks.clearChat,
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: () => mocks.ws,
}));

import { useStore } from '../../stores';
import { clearSessionStreamMeta, getSessionStreamMeta, injectHandlers, replayStreamResume, updateSessionStreamMeta } from '../../services/stream-resume';

describe('stream-resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentSessionPath: '/focused.jsonl',
      streamingSessions: ['/background.jsonl'],
      activeSessionStreams: {},
      sessions: [
        { path: '/focused.jsonl', title: 'focused' },
        { path: '/background.jsonl', title: 'background' },
      ],
      chatSessions: {
        '/focused.jsonl': { items: [], hasMore: false, loadingMore: false },
        '/background.jsonl': { items: [], hasMore: false, loadingMore: false },
      },
    } as never);
  });

  it('hydrates a completed empty resume for background sessions instead of leaving them stuck streaming', async () => {
    const statuses: Array<{ isStreaming: boolean; sessionPath: string | null }> = [];
    injectHandlers(vi.fn(), (isStreaming, sessionPath) => {
      statuses.push({ isStreaming, sessionPath });
      useStore.setState((state) => ({
        streamingSessions: isStreaming
          ? Array.from(new Set([...state.streamingSessions, sessionPath].filter(Boolean))) as string[]
          : state.streamingSessions.filter((path) => path !== sessionPath),
      }));
    });

    replayStreamResume({
      type: 'stream_resume',
      sessionPath: '/background.jsonl',
      streamId: 'stream_1',
      sinceSeq: 3,
      nextSeq: 4,
      isStreaming: false,
      reset: false,
      truncated: false,
      events: [],
    });

    await vi.waitFor(() => {
      expect(mocks.loadMessages).toHaveBeenCalledWith('/background.jsonl');
    });

    expect(mocks.streamBufferManager.finishTurn).toHaveBeenCalledWith('/background.jsonl');
    expect(mocks.streamBufferManager.clear).not.toHaveBeenCalledWith('/background.jsonl');
    expect(statuses).toContainEqual({ isStreaming: false, sessionPath: '/background.jsonl' });
    expect(useStore.getState().streamingSessions).toEqual([]);
  });

  it('replays background session events to the normal websocket handler', () => {
    const handled: unknown[] = [];
    const statuses: Array<{ isStreaming: boolean; sessionPath: string | null }> = [];
    injectHandlers((msg) => handled.push(msg), (isStreaming, sessionPath) => {
      statuses.push({ isStreaming, sessionPath });
    });

    replayStreamResume({
      type: 'stream_resume',
      sessionPath: '/background.jsonl',
      streamId: 'stream_2',
      sinceSeq: 1,
      nextSeq: 3,
      isStreaming: true,
      reset: false,
      truncated: false,
      events: [
        { seq: 2, event: { type: 'text_delta', delta: 'late text' } },
      ],
    });

    expect(handled).toEqual([
      expect.objectContaining({
        type: 'text_delta',
        delta: 'late text',
        sessionPath: '/background.jsonl',
        streamId: 'stream_2',
        seq: 2,
        __fromReplay: true,
      }),
    ]);
    expect(statuses).toEqual([{ isStreaming: true, sessionPath: '/background.jsonl' }]);
  });

  it('does not replay the same stream sequence twice when a resume response is repeated', () => {
    const handled: unknown[] = [];
    injectHandlers((msg) => handled.push(msg), vi.fn());

    const resume = {
      type: 'stream_resume',
      sessionPath: '/background.jsonl',
      streamId: 'stream_dedupe',
      sinceSeq: 0,
      nextSeq: 3,
      isStreaming: true,
      reset: false,
      truncated: false,
      events: [
        { seq: 1, event: { type: 'tool_start', name: 'echo', args: { value: 'one' } } },
        { seq: 2, event: { type: 'tool_end', name: 'echo', success: true } },
      ],
    };

    replayStreamResume(resume);
    replayStreamResume(resume);

    expect(handled).toHaveLength(2);
    expect(handled).toEqual([
      expect.objectContaining({ type: 'tool_start', seq: 1 }),
      expect.objectContaining({ type: 'tool_end', seq: 2 }),
    ]);
  });

  it('reports duplicate live stream sequences as already consumed', () => {
    expect(updateSessionStreamMeta({
      sessionPath: '/background.jsonl',
      streamId: 'stream_live_dedupe',
      seq: 1,
    })).toBe(true);

    expect(updateSessionStreamMeta({
      sessionPath: '/background.jsonl',
      streamId: 'stream_live_dedupe',
      seq: 1,
    })).toBe(false);
  });

  describe('clearSessionStreamMeta', () => {
    it('drops the per-session meta so a previously consumed seq is accepted again (no unbounded retention)', () => {
      const path = '/evict.jsonl';
      // 第一次 seq 入账，再次重复被判已消费
      expect(updateSessionStreamMeta({ sessionPath: path, streamId: 'sX', seq: 7 })).toBe(true);
      expect(updateSessionStreamMeta({ sessionPath: path, streamId: 'sX', seq: 7 })).toBe(false);

      clearSessionStreamMeta(path);

      // 清后该 path 的 consumedSeqs 重置：同一 seq 被当成全新事件再次入账
      expect(updateSessionStreamMeta({ sessionPath: path, streamId: 'sX', seq: 7 })).toBe(true);
    });

    it('resets the lazily-recreated meta to a fresh empty entry', () => {
      const path = '/evict-2.jsonl';
      const before = getSessionStreamMeta(path);
      before!.streamId = 'old';
      before!.lastSeq = 42;

      clearSessionStreamMeta(path);

      const after = getSessionStreamMeta(path);
      expect(after).not.toBe(before);
      expect(after).toEqual({ streamId: null, lastSeq: 0, consumedSeqs: new Set() });
    });

    it('is a no-op for an empty path', () => {
      expect(() => clearSessionStreamMeta('')).not.toThrow();
    });
  });
});
