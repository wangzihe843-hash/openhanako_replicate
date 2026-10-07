// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskOutcomeCard } from '../../components/chat/TaskOutcomeCard';
import { useStore } from '../../stores';
import { createLocalServerConnection } from '../../services/server-connection';
import { loadChannels, openChannel } from '../../stores/channel-actions';
import { switchTab } from '../../components/channels/ChannelTabBar';
import { openInternalLink } from '../../utils/link-open';
import type { TaskOutcome } from '../../../../../lib/task-outcome/task-outcome';
import { projectChannelPostOutcome } from '../../../../../lib/task-outcome/task-outcome';
import en from '../../../locales/en.json';
import zh from '../../../locales/zh.json';
import zhTW from '../../../locales/zh-TW.json';
import ja from '../../../locales/ja.json';
import ko from '../../../locales/ko.json';

vi.mock('../../stores/channel-actions', () => ({ loadChannels: vi.fn(async () => {}), openChannel: vi.fn(async () => true) }));
vi.mock('../../components/channels/ChannelTabBar', () => ({ switchTab: vi.fn() }));
vi.mock('../../utils/link-open', () => ({ openInternalLink: vi.fn(async () => {}) }));

const effectId = 'b'.repeat(64);
const mockFetch = vi.fn<typeof fetch>();
const receipt = { channel: 'ch_team', sender: 'alice', timestamp: '2026-09-27 19:00:00' };
const channelOutcome: TaskOutcome = {
  taskId: `effect:${effectId}`, revision: 1, kind: 'channel_post', lifecycle: 'completed',
  goalResult: 'verified', goalScope: 'local_channel_append',
  actions: [{ id: effectId, label: 'channel.post', status: 'committed' }],
  evidence: [{ kind: 'channel_receipt', reference: receipt.channel, status: 'confirmed', sender: receipt.sender, timestamp: receipt.timestamp }],
  pendingDecisions: [],
};

describe('TaskOutcomeCard evidence entry', () => {
  beforeEach(() => {
    vi.stubGlobal('t', (key: string) => key);
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    useStore.setState({ activeServerConnection: createLocalServerConnection({
      serverPort: 3210, serverToken: 'synthetic-receipt-token',
    }) });
    vi.mocked(openChannel).mockResolvedValue(true);
    useStore.setState({ currentAgentId: 'agent-a', currentSessionPath: '/session-a', channels: [{
      id: 'ch_team', name: 'Team', members: ['alice', 'bob'],
      lastMessage: '', lastSender: '', lastTimestamp: '', newMessageCount: 0, isDM: false,
    }] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('verifies the stored receipt before opening the existing channel UI', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'confirmed', receipt }), { status: 200 }));
    render(<TaskOutcomeCard block={{ outcome: channelOutcome }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify receipt and open channel' }));
    await waitFor(() => expect(openChannel).toHaveBeenCalledWith('ch_team', false, {
      stillCurrent: expect.any(Function),
    }));
    expect(mockFetch).toHaveBeenCalledWith(`http://127.0.0.1:3210/api/channels/ch_team/effects/${effectId}/receipt`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-receipt-token' }),
      signal: expect.any(AbortSignal),
    }));
    expect(loadChannels).toHaveBeenCalled();
    expect(switchTab).toHaveBeenCalledWith('channels');
    expect(screen.getByText(/recipient reading is unverified/)).toBeInTheDocument();
  });

  it('shows a visible failure when receipt verification cannot reach the server', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    render(<TaskOutcomeCard block={{ outcome: channelOutcome }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify receipt and open channel' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Channel is unavailable');
    expect(openChannel).not.toHaveBeenCalled();
  });

  it.each([404, 409])('reports a missing receipt for HTTP %s through the real fetch wrapper', async (status) => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'unverified' }), { status }));
    render(<TaskOutcomeCard block={{ outcome: channelOutcome }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify receipt and open channel' }));
    expect(await screen.findByRole('status')).toHaveTextContent('receipt could not be found');
    expect(openChannel).not.toHaveBeenCalled();
    expect(switchTab).not.toHaveBeenCalled();
  });

  it('reports a channel navigation failure after the receipt was verified', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'confirmed', receipt }), { status: 200 }));
    vi.mocked(openChannel).mockResolvedValue(false);
    render(<TaskOutcomeCard block={{ outcome: channelOutcome }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify receipt and open channel' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Channel is unavailable');
    expect(switchTab).not.toHaveBeenCalled();
  });

  it('does not open the old receipt after the user switches sessions while verification is pending', async () => {
    let finishVerification!: (value: Response) => void;
    mockFetch.mockImplementation(() => new Promise(resolve => { finishVerification = resolve; }));
    render(<TaskOutcomeCard block={{ outcome: channelOutcome }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify receipt and open channel' }));
    act(() => useStore.setState({ currentSessionPath: '/session-b' }));
    await act(async () => {
      finishVerification(new Response(JSON.stringify({ status: 'confirmed', receipt }), { status: 200 }));
    });
    expect(loadChannels).not.toHaveBeenCalled();
    expect(openChannel).not.toHaveBeenCalled();
    expect(switchTab).not.toHaveBeenCalled();
  });

  it('does not navigate from a receipt card that was closed during channel loading', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'confirmed', receipt }), { status: 200 }));
    let finishChannels!: () => void;
    vi.mocked(loadChannels).mockImplementation(() => new Promise(resolve => { finishChannels = resolve; }));
    const view = render(<TaskOutcomeCard block={{ outcome: channelOutcome }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify receipt and open channel' }));
    await waitFor(() => expect(loadChannels).toHaveBeenCalled());
    view.unmount();
    await act(async () => { finishChannels(); });
    expect(openChannel).not.toHaveBeenCalled();
    expect(switchTab).not.toHaveBeenCalled();
  });

  it('opens an evidenced web source and displays unread media coverage', async () => {
    const outcome: TaskOutcome = {
      taskId: 'tool:read-1', revision: 1, kind: 'web_read', lifecycle: 'completed',
      goalResult: 'partial', goalScope: 'single_response_text',
      actions: [{ id: 'read-1', label: 'web_fetch', status: 'partial' }],
      evidence: [{ kind: 'read_coverage', reference: 'https://example.org/article', sourceUrl: 'https://example.org/article', status: 'partial', missingReasons: ['media_not_read'] }],
      pendingDecisions: ['review_missing_coverage'],
    };
    render(<TaskOutcomeCard block={{ outcome }} />);
    expect(screen.getByText(/media not read/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Source: https:\/\/example.org\/article/ }));
    await waitFor(() => expect(openInternalLink).toHaveBeenCalledWith('https://example.org/article', { origin: 'session' }));
  });

  it.each([403, 500])('keeps other HTTP %s failures separate from missing receipts', async (status) => {
    mockFetch.mockResolvedValue(new Response('{}', { status }));
    render(<TaskOutcomeCard block={{ outcome: channelOutcome }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify receipt and open channel' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Channel is unavailable');
    expect(openChannel).not.toHaveBeenCalled();
    expect(switchTab).not.toHaveBeenCalled();
  });

  it.each([
    ['en', en], ['zh', zh], ['zh-TW', zhTW], ['ja', ja], ['ko', ko],
    ['missing translation', null],
  ] as const)('claims a local write only for confirmed receipts in %s', (_locale, pack) => {
    const translate = (key: string) => key.split('.').reduce<unknown>((value, part) => (
      value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
    ), pack) as string || key;
    vi.stubGlobal('t', translate);
    const confirmedLabel = pack?.taskOutcome.scopeChannel || en.taskOutcome.scopeChannel;
    const view = render(<TaskOutcomeCard block={{ outcome: channelOutcome }} />);
    expect(screen.getByText(confirmedLabel)).toBeInTheDocument();

    for (const status of ['unknown', 'failed', 'prepared', 'committed'] as const) {
      const outcome = projectChannelPostOutcome({ effectId, status, attempts: 1 })!;
      view.rerender(<TaskOutcomeCard block={{ outcome }} />);
      expect(screen.queryByText(confirmedLabel)).not.toBeInTheDocument();
      expect(screen.queryByText('taskOutcome.scopeChannelUnverified')).not.toBeInTheDocument();
      expect(screen.getByText(pack?.taskOutcome.scopeChannelUnverified || en.taskOutcome.scopeChannelUnverified)).toBeInTheDocument();
      expect(screen.getByText(`${pack?.taskOutcome.goal || en.taskOutcome.goal}: ${pack?.taskOutcome[outcome.goalResult] || en.taskOutcome[outcome.goalResult]}`)).toBeInTheDocument();
    }
    for (const evidence of [[], [{ ...channelOutcome.evidence[0], status: 'unverified' }]]) {
      view.rerender(<TaskOutcomeCard block={{ outcome: { ...channelOutcome, evidence } }} />);
      expect(screen.queryByText(confirmedLabel)).not.toBeInTheDocument();
    }
  });
});
