// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelAgentSettingsPanel } from '../../components/ChannelsPanel';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(hanaFetch);

function seedDmState() {
  useStore.setState({
    locale: 'en',
    serverPort: '3210',
    currentChannel: 'dm:agent-b',
    channelIsDM: true,
    channels: [{
      id: 'dm:agent-b',
      name: 'Agent B',
      members: ['agent-b'],
      lastMessage: '',
      lastSender: '',
      lastTimestamp: '',
      newMessageCount: 0,
      isDM: true,
      peerId: 'agent-b',
      peerName: 'Agent B',
      dmOwnerId: 'agent-a',
    }],
    models: [{ id: 'model-1', provider: 'test', name: 'Model 1' }],
    channelAgentPhoneToolMode: 'read_only',
    channelAgentReplyMinChars: null,
    channelAgentReplyMaxChars: null,
    channelAgentProactiveEnabled: true,
    channelAgentReminderIntervalMinutes: 31,
    channelAgentGuardLimit: 36,
    channelAgentSocialFallbackMode: 'auto',
    channelAgentSocialFallbackTurnInterval: null,
    channelAgentModelOverrideEnabled: false,
    channelAgentModelOverrideModel: null,
  } as never);
}

describe('ChannelAgentSettingsPanel DM social fallback', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    vi.stubGlobal('alert', vi.fn());
    mockedFetch.mockReset();
    seedDmState();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows per-peer fallback controls only for DMs and saves through the owner-scoped endpoint', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        mode: 'read_only',
        replyMinChars: null,
        replyMaxChars: null,
        proactiveEnabled: true,
        reminderIntervalMinutes: 31,
        guardLimit: 36,
        socialFallbackMode: 'enabled',
        socialFallbackTurnInterval: 120,
        modelOverrideEnabled: false,
        modelOverrideModel: null,
      }),
    } as Response);

    render(<ChannelAgentSettingsPanel />);
    expect(screen.getByText('channel.socialFallbackMode')).toBeInTheDocument();
    const intervalInput = screen.getByPlaceholderText('channel.socialFallbackIntervalPlaceholder');
    expect(intervalInput).toBeInTheDocument();

    fireEvent.change(intervalInput, { target: { value: '120' } });
    const enabledButton = screen.getByText('channel.socialFallbackEnabled');
    fireEvent.pointerDown(enabledButton);
    fireEvent.blur(intervalInput);
    fireEvent.click(enabledButton);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledOnce());
    expect(mockedFetch.mock.calls[0][0]).toBe(
      '/api/conversations/dm%3Aagent-b/agent-phone-settings?agentId=agent-a',
    );
    const body = JSON.parse(String((mockedFetch.mock.calls[0][1] as RequestInit).body));
    expect(body.socialFallbackMode).toBe('enabled');
    expect(body.socialFallbackTurnInterval).toBe(120);

    cleanup();
    useStore.setState({ currentChannel: 'ch_crew', channelIsDM: false } as never);
    render(<ChannelAgentSettingsPanel />);
    expect(screen.queryByText('channel.socialFallbackMode')).not.toBeInTheDocument();
  });

  it('saves a later interval edit after changing mode without focusing the interval', async () => {
    mockedFetch.mockImplementation(async (_url, options) => ({
      ok: true,
      json: async () => JSON.parse(String(options?.body)),
    }) as Response);

    render(<ChannelAgentSettingsPanel />);
    const enabledButton = screen.getByText('channel.socialFallbackEnabled');
    fireEvent.pointerDown(enabledButton);
    fireEvent.click(enabledButton);
    await waitFor(() => expect(enabledButton).not.toBeDisabled());
    expect(mockedFetch).toHaveBeenCalledOnce();

    const intervalInput = screen.getByPlaceholderText('channel.socialFallbackIntervalPlaceholder');
    fireEvent.change(intervalInput, { target: { value: '240' } });
    fireEvent.blur(intervalInput);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String((mockedFetch.mock.calls[1][1] as RequestInit).body));
    expect(body.socialFallbackMode).toBe('enabled');
    expect(body.socialFallbackTurnInterval).toBe(240);
  });
});
