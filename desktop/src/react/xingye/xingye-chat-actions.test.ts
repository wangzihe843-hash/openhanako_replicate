import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types';
import { useStore } from '../stores';
import { enterXingyeAgentChat, findLatestSessionForAgent } from './xingye-chat-actions';

const sessionActionMocks = vi.hoisted(() => ({
  createNewSessionMock: vi.fn(async () => {}),
  ensureSessionMock: vi.fn(async () => true),
  loadSessionsMock: vi.fn(async () => {}),
  switchSessionMock: vi.fn(async () => {}),
}));

vi.mock('../stores/session-actions', () => ({
  createNewSession: sessionActionMocks.createNewSessionMock,
  ensureSession: sessionActionMocks.ensureSessionMock,
  loadSessions: sessionActionMocks.loadSessionsMock,
  switchSession: sessionActionMocks.switchSessionMock,
}));

const {
  createNewSessionMock,
  ensureSessionMock,
  loadSessionsMock,
  switchSessionMock,
} = sessionActionMocks;

const session = (patch: Partial<Session>): Session => ({
  path: patch.path ?? 'session.jsonl',
  title: patch.title ?? null,
  firstMessage: patch.firstMessage ?? '',
  modified: patch.modified ?? '2026-05-10T00:00:00.000Z',
  messageCount: patch.messageCount ?? 0,
  agentId: patch.agentId ?? null,
  agentName: patch.agentName ?? null,
  cwd: patch.cwd ?? null,
  pinnedAt: patch.pinnedAt,
  hasSummary: patch.hasSummary,
});

describe('xingye chat actions', () => {
  beforeEach(() => {
    createNewSessionMock.mockClear();
    ensureSessionMock.mockClear();
    loadSessionsMock.mockClear();
    switchSessionMock.mockClear();
    useStore.setState({
      sessions: [],
      currentAgentId: 'hanako',
      selectedAgentId: null,
      currentSessionPath: null,
      pendingNewSession: false,
    });
  });

  it('finds the latest existing native session for an agent', () => {
    const sessions = [
      session({ path: 'agents/a/sessions/old.jsonl', agentId: 'a', modified: '2026-05-09T00:00:00.000Z' }),
      session({ path: 'agents/b/sessions/latest.jsonl', agentId: 'b', modified: '2026-05-11T00:00:00.000Z' }),
      session({ path: 'agents/a/sessions/latest.jsonl', agentId: 'a', modified: '2026-05-10T00:00:00.000Z' }),
    ];

    expect(findLatestSessionForAgent(sessions, 'a')?.path).toBe('agents/a/sessions/latest.jsonl');
  });

  it('switches to an existing native session for the selected Xingye agent', async () => {
    useStore.setState({
      sessions: [
        session({ path: 'agents/hanako/sessions/current.jsonl', agentId: 'hanako' }),
        session({ path: 'agents/a/sessions/latest.jsonl', agentId: 'a' }),
      ],
    });

    await enterXingyeAgentChat('a');

    expect(switchSessionMock).toHaveBeenCalledWith('agents/a/sessions/latest.jsonl');
    expect(createNewSessionMock).not.toHaveBeenCalled();
    expect(ensureSessionMock).not.toHaveBeenCalled();
  });

  it('creates a native pending session for the Xingye agent when no session exists', async () => {
    await enterXingyeAgentChat('a');

    expect(createNewSessionMock).toHaveBeenCalledTimes(1);
    expect(useStore.getState().selectedAgentId).toBe('a');
    expect(ensureSessionMock).toHaveBeenCalledTimes(1);
    expect(loadSessionsMock).toHaveBeenCalledTimes(1);
    expect(switchSessionMock).not.toHaveBeenCalled();
  });
});
