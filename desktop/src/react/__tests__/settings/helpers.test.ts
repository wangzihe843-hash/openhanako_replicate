/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, any>;

const mockState: MockState = {};

vi.mock('../../settings/store', () => ({
  useSettingsStore: {
    getState: () => mockState,
    setState: (patch: MockState | ((s: MockState) => MockState)) => {
      const next = typeof patch === 'function' ? patch(mockState) : patch;
      Object.assign(mockState, next);
    },
  },
}));

const mockFetch = vi.fn();

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mockFetch(...args),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

function resetState() {
  Object.keys(mockState).forEach((key) => delete mockState[key]);
  Object.assign(mockState, {
    settingsAgentId: null,
    currentAgentId: 'agent-a',
    settingsConfig: null,
    getSettingsAgentId: () => mockState.settingsAgentId || mockState.currentAgentId,
    showToast: vi.fn(),
  });
}

describe('refreshSettingsConfigSnapshot', () => {
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    resetState();
  });

  it('REVIEW pins drains the newer queued edit after an older save fails', async () => {
    vi.useFakeTimers();
    let rejectFirst!: (error: Error) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue(jsonResponse({ ok: true }));
    const { savePins } = await import('../../settings/helpers');
    mockState.currentPins = ['first']; savePins();
    await vi.advanceTimersByTimeAsync(300);
    mockState.currentPins = ['latest']; savePins();
    await vi.advanceTimersByTimeAsync(300);
    rejectFirst(new Error('first request failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).pins).toEqual(['latest']);
  });

  it('F3 saves the scheduled agent snapshot even after another agent starts loading', async () => {
    vi.useFakeTimers();
    mockState.currentPins = ['A edited'];
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const { savePins } = await import('../../settings/helpers');
    savePins();
    mockState.settingsAgentId = 'agent-b';
    mockState.currentPins = [];
    await vi.advanceTimersByTimeAsync(300);
    expect(mockFetch).toHaveBeenCalledWith('/api/agents/agent-a/pinned', expect.objectContaining({ body: JSON.stringify({ pins: ['A edited'] }) }));
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('agent-b/pinned'))).toBe(false);
  });

  it('保留 _identity/_agents/_publicAgents/_userProfile/_experience 下划线键', async () => {
    mockState.settingsConfig = {
      _identity: 'identity-content',
      _agents: 'agents-md-content',
      _publicAgents: 'public-agents-md-content',
      _userProfile: 'profile-content',
      _experience: 'experience-content',
      desk: { home_folder: '/old-home' },
    };
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/agents/agent-a/config') {
        return Promise.resolve(jsonResponse({ desk: { home_folder: '/new-home' } }));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const { refreshSettingsConfigSnapshot } = await import('../../settings/helpers');
    await refreshSettingsConfigSnapshot();

    expect(mockState.settingsConfig).toEqual({
      _identity: 'identity-content',
      _agents: 'agents-md-content',
      _publicAgents: 'public-agents-md-content',
      _userProfile: 'profile-content',
      _experience: 'experience-content',
      desk: { home_folder: '/new-home' },
    });
  });

  it('刷新期间 owner 切换，晚到的响应不覆盖新 owner 的快照', async () => {
    mockState.settingsConfig = { desk: { home_folder: '/agent-a-home' } };
    let resolveGet: (value: Response) => void = () => {};
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/agents/agent-a/config') {
        return new Promise<Response>((resolve) => { resolveGet = resolve; });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const { refreshSettingsConfigSnapshot } = await import('../../settings/helpers');
    const pending = refreshSettingsConfigSnapshot();

    // GET 尚未返回期间，settings owner 切到了另一个 agent
    mockState.settingsAgentId = 'agent-b';
    const snapshotBeforeResolve = mockState.settingsConfig;

    resolveGet(jsonResponse({ desk: { home_folder: '/late-response-home' } }));
    await pending;

    expect(mockState.settingsConfig).toBe(snapshotBeforeResolve);
  });
});
