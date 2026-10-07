import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: { clear: vi.fn(), handle: vi.fn(), beginTurn: vi.fn(), finishTurn: vi.fn() },
}));
vi.mock('../../stores/session-actions', () => ({ loadMessages: vi.fn(), loadSessions: vi.fn() }));
vi.mock('../../stores/agent-actions', () => ({ clearChat: vi.fn() }));
vi.mock('../../stores/channel-actions', () => ({ loadChannels: vi.fn(), openChannel: vi.fn() }));
vi.mock('../../stores/preview-actions', () => ({ handleLegacyArtifactBlock: vi.fn() }));
vi.mock('../../services/app-event-actions', () => ({ handleAppEvent: vi.fn() }));

import { useStore } from '../../stores';
import { loadMessages } from '../../stores/session-actions';
import { applyStreamingStatus, handleServerMessage } from '../../services/ws-message-handler';
import {
  clearSessionStreamMeta, injectHandlers, injectWebSocketGetter,
  isStreamResumeRebuilding, replayStreamResume,
} from '../../services/stream-resume';
import { resetSessionRefreshSchedulerForTest } from '../../services/session-refresh-scheduler';

const A = '/fixture/a.jsonl';
const B = '/fixture/b.jsonl';
let finishHistory: () => void;

describe('status routing while another session rebuilds its history', () => {
  beforeEach(() => {
    clearSessionStreamMeta(A);
    clearSessionStreamMeta(B);
    useStore.setState({
      currentSessionPath: A, currentSessionId: null, sessionLocatorsById: {},
      pendingNewSession: false, sessions: [], chatSessions: {}, inlineErrors: {},
      streamingSessions: [], activeSessionStreams: {}, unreadOutputSessionPaths: [],
    });
    useStore.getState().addStreamingSession(A, { streamId: 'a-current' });
    useStore.getState().addStreamingSession(B, { streamId: 'b-current' });
    vi.mocked(loadMessages).mockImplementation(() => new Promise<void>(resolve => { finishHistory = resolve; }));
    injectHandlers(handleServerMessage, applyStreamingStatus);
    injectWebSocketGetter(() => null);
    replayStreamResume({
      type: 'stream_resume', sessionPath: A, streamId: 'a-current',
      reset: true, isStreaming: true, nextSeq: 1, events: [],
    });
    expect(isStreamResumeRebuilding()).toBe(A);
  });

  afterEach(async () => {
    finishHistory();
    await vi.waitFor(() => expect(isStreamResumeRebuilding()).toBeNull());
    clearSessionStreamMeta(A);
    clearSessionStreamMeta(B);
    resetSessionRefreshSchedulerForTest();
    vi.clearAllMocks();
  });

  it('applies B terminal status while A is waiting for history', () => {
    handleServerMessage({ type: 'status', sessionPath: B, streamId: 'b-current', isStreaming: false });
    expect(useStore.getState().streamingSessions).toEqual([A]);
    expect(useStore.getState().unreadOutputSessionPaths).toEqual([B]);
  });

  it('still ignores a terminal status for an older B stream generation', () => {
    handleServerMessage({ type: 'status', sessionPath: B, streamId: 'b-old', isStreaming: false });
    expect(useStore.getState().streamingSessions).toEqual([A, B]);
    expect(useStore.getState().activeSessionStreams[B]?.streamId).toBe('b-current');
    expect(useStore.getState().unreadOutputSessionPaths).toEqual([]);
    handleServerMessage({ type: 'status', sessionPath: B, streamId: 'b-current', isStreaming: false });
    expect(useStore.getState().streamingSessions).toEqual([A]);
  });

  it('suppresses A status during its rebuild even when focus has moved to B', () => {
    useStore.setState({ currentSessionPath: B });
    handleServerMessage({ type: 'status', sessionPath: A, isStreaming: false });
    expect(useStore.getState().streamingSessions).toEqual([A, B]);
    handleServerMessage({ type: 'status', sessionPath: B, streamId: 'b-current', isStreaming: false });
    expect(useStore.getState().streamingSessions).toEqual([A]);
  });
});
