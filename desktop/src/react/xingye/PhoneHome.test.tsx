/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { PhoneHome } from './PhoneHome';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: fetchMock,
}));

vi.mock('./XingyeAgentAvatar', () => ({
  XingyeAgentAvatar: ({ alt }: { alt: string }) => <div>{alt}</div>,
}));

const agent: Agent = {
  id: 'agent-a',
  name: 'Agent A',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

const display = {
  displayName: 'Agent A',
  shortBio: 'bio',
  relationshipLabel: 'friend',
  speakingStyle: 'calm',
  chatBackgroundDataUrl: null,
};

function renderPhoneHome() {
  return render(
    <PhoneHome
      agent={agent}
      display={display}
      onNavigate={vi.fn()}
      onOpenSms={vi.fn()}
      onOpenContacts={vi.fn()}
      onOpenMmChat={vi.fn()}
      onOpenJournal={vi.fn()}
    />,
  );
}

describe('PhoneHome heartbeat trigger', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('calls the existing desk heartbeat route and shows success, cooldown, and failure states', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, triggered: true, cooldown: false }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, triggered: false, cooldown: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        statusText: 'Server Error',
        json: async () => ({ error: 'Heartbeat not initialized' }),
      } as Response);

    renderPhoneHome();
    const button = screen.getByRole('button', { name: '立即巡检' });

    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检已触发');
    });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/desk/heartbeat?agentId=agent-a', { method: 'POST' });

    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('冷却中');
    });

    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检失败：Heartbeat not initialized');
    });
  });
});
