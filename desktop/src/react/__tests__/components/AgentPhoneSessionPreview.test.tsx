// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

let streamSubscriber: ((event: any) => void) | null = null;

vi.mock('../../components/chat/ChatTranscript', () => ({
  ChatTranscript: ({ items }: { items: any[] }) => (
    <pre data-testid="phone-items">{JSON.stringify(items)}</pre>
  ),
}));

vi.mock('../../stores/session-actions', () => ({
  loadMessages: vi.fn(async () => {}),
}));

vi.mock('../../services/stream-key-dispatcher', () => ({
  subscribeStreamKey: vi.fn((_key: string, cb: (event: any) => void) => {
    streamSubscriber = cb;
    return () => { streamSubscriber = null; };
  }),
}));

import { AgentPhoneSessionPreview } from '../../components/ChannelsPanel';

describe('AgentPhoneSessionPreview', () => {
  beforeEach(() => {
    streamSubscriber = null;
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      locale: 'zh',
      chatSessions: {},
      streamingSessions: [],
      selectedMessageIdsBySession: {},
      agents: [
        { id: 'butter-agent', name: 'butter', yuan: 'butter', hasAvatar: false },
      ],
      agentName: 'Hanako',
      agentYuan: 'hanako',
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('uses the agent yuan as the mood block owner instead of the agent id', () => {
    render(
      <AgentPhoneSessionPreview
        sessionPath="/tmp/butter-phone.jsonl"
        agentId="butter-agent"
        agentYuan="butter"
      />,
    );

    act(() => {
      streamSubscriber?.({ type: 'mood_start' });
      streamSubscriber?.({ type: 'mood_text', delta: 'PULSE text' });
    });

    const items = JSON.parse(screen.getByTestId('phone-items').textContent || '[]');
    const mood = items[0].data.blocks.find((block: any) => block.type === 'mood');
    expect(mood).toMatchObject({
      yuan: 'butter',
      text: 'PULSE text',
    });
  });
});
