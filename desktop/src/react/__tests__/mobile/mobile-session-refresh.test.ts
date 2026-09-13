import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMobileSessions } from '../../mobile/mobile-init';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';

vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn() }));
vi.mock('../../stores/desk-actions', () => ({ activateWorkspaceDesk: vi.fn() }));
vi.mock('../../stores/agent-actions', () => ({ applyAgentIdentity: vi.fn(), loadAvatars: vi.fn() }));

describe('mobile foreground refresh', () => {
  beforeEach(() => {
    vi.mocked(hanaFetch).mockReset();
    useStore.setState({ sessions: [], currentSessionPath: null, currentSessionId: null, pendingSessionSwitchPath: null, pendingNewSession: true, pendingDraftId: 'draft-A' });
  });
  it('REVIEW discards a list from a replaced connection with unchanged navigation', async () => {
    useStore.setState({ activeServerConnection: null, activeServerConnectionId: null, serverConnections: {}, serverPort: '3210' });
    let release!: (value: Response) => void;
    vi.mocked(hanaFetch).mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));
    const pending = loadMobileSessions();
    useStore.setState({ serverPort: '4321', sessions: [{ path: '/current-server' }] as any });
    release({ json: async () => [{ path: '/old-server' }] } as Response);
    await pending;
    expect(useStore.getState().sessions.map(item => item.path)).toEqual(['/current-server']);
  });

  it('F10 preserves a session activated after the list request started', async () => {
    let release!: (value: Response) => void;
    vi.mocked(hanaFetch).mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));
    const pending = loadMobileSessions();
    useStore.setState({ currentSessionPath: '/new', currentSessionId: 'id-new', pendingNewSession: false, pendingDraftId: null });
    release({ json: async () => [] } as Response);
    await pending;
    expect(useStore.getState()).toMatchObject({ currentSessionPath: '/new', currentSessionId: 'id-new', pendingNewSession: false });
  });
  it('F10 leaves a pending composer identity unchanged during ordinary refresh', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({ json: async () => [] } as Response);
    await loadMobileSessions();
    expect(useStore.getState().pendingDraftId).toBe('draft-A');
  });
});
