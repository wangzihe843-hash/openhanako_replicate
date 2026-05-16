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
const consumeEventLogMock = vi.hoisted(() =>
  vi.fn(async () => ({ summary: '', consumedCount: 0 })),
);

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: fetchMock,
}));

vi.mock('./xingye-heartbeat-event-consumer', () => ({
  consumeXingyeEventLogForHeartbeat: consumeEventLogMock,
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
  chatBackgroundDataUrl: undefined,
  allowAutoMoments: false,
  allowProactiveDM: false,
};

function renderPhoneHome() {
  const onOpenSchedule = vi.fn();
  return render(
    <PhoneHome
      agent={agent}
      display={display}
      onNavigate={vi.fn()}
      onOpenSms={vi.fn()}
      onOpenContacts={vi.fn()}
      onOpenMmChat={vi.fn()}
      onOpenJournal={vi.fn()}
      onOpenSchedule={onOpenSchedule}
      onOpenDivination={vi.fn()}
      onOpenFiles={vi.fn()}
      onOpenShopping={vi.fn()}
      onOpenMail={vi.fn()}
    />,
  );
}

describe('PhoneHome heartbeat trigger', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    consumeEventLogMock.mockReset();
    consumeEventLogMock.mockResolvedValue({ summary: '', consumedCount: 0 });
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

  it('shows the event-log summary in the heartbeat status line on a real trigger', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, triggered: true, cooldown: false }),
    } as Response);
    consumeEventLogMock.mockResolvedValueOnce({
      summary: '自上次巡检以来：通讯录变更×1、短信×2（共 3 条）',
      consumedCount: 3,
    });

    renderPhoneHome();
    fireEvent.click(screen.getByRole('button', { name: '立即巡检' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检已触发');
    });
    expect(screen.getByRole('status')).toHaveTextContent('自上次巡检以来：通讯录变更×1、短信×2（共 3 条）');
    expect(consumeEventLogMock).toHaveBeenCalledWith('agent-a');
  });

  it('does not consume the event log when the heartbeat is on cooldown', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, triggered: false, cooldown: true }),
    } as Response);

    renderPhoneHome();
    fireEvent.click(screen.getByRole('button', { name: '立即巡检' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('冷却中');
    });
    expect(consumeEventLogMock).not.toHaveBeenCalled();
  });

  it('opens the schedule app from the phone home grid', () => {
    const onOpenSchedule = vi.fn();
    render(
      <PhoneHome
        agent={agent}
        display={display}
        onNavigate={vi.fn()}
        onOpenSms={vi.fn()}
        onOpenContacts={vi.fn()}
        onOpenMmChat={vi.fn()}
        onOpenJournal={vi.fn()}
        onOpenSchedule={onOpenSchedule}
        onOpenDivination={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenShopping={vi.fn()}
        onOpenMail={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /日程/ }));

    expect(onOpenSchedule).toHaveBeenCalledTimes(1);
  });

  it('opens the divination app from the phone home grid', () => {
    const onOpenDivination = vi.fn();
    render(
      <PhoneHome
        agent={agent}
        display={display}
        onNavigate={vi.fn()}
        onOpenSms={vi.fn()}
        onOpenContacts={vi.fn()}
        onOpenMmChat={vi.fn()}
        onOpenJournal={vi.fn()}
        onOpenSchedule={vi.fn()}
        onOpenDivination={onOpenDivination}
        onOpenFiles={vi.fn()}
        onOpenShopping={vi.fn()}
        onOpenMail={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /占卜/ }));

    expect(onOpenDivination).toHaveBeenCalledTimes(1);
  });

  it('opens the files app from the phone home grid', () => {
    const onOpenFiles = vi.fn();
    render(
      <PhoneHome
        agent={agent}
        display={display}
        onNavigate={vi.fn()}
        onOpenSms={vi.fn()}
        onOpenContacts={vi.fn()}
        onOpenMmChat={vi.fn()}
        onOpenJournal={vi.fn()}
        onOpenSchedule={vi.fn()}
        onOpenDivination={vi.fn()}
        onOpenFiles={onOpenFiles}
        onOpenShopping={vi.fn()}
        onOpenMail={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^文件，资料柜与发现记录$/ }));

    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });

  it('opens the shopping app from the phone home grid', () => {
    const onOpenShopping = vi.fn();
    render(
      <PhoneHome
        agent={agent}
        display={display}
        onNavigate={vi.fn()}
        onOpenSms={vi.fn()}
        onOpenContacts={vi.fn()}
        onOpenMmChat={vi.fn()}
        onOpenJournal={vi.fn()}
        onOpenSchedule={vi.fn()}
        onOpenDivination={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenShopping={onOpenShopping}
        onOpenMail={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /购物/ }));

    expect(onOpenShopping).toHaveBeenCalledTimes(1);
  });

  it('opens the mail app from the phone home grid', () => {
    const onOpenMail = vi.fn();
    render(
      <PhoneHome
        agent={agent}
        display={display}
        onNavigate={vi.fn()}
        onOpenSms={vi.fn()}
        onOpenContacts={vi.fn()}
        onOpenMmChat={vi.fn()}
        onOpenJournal={vi.fn()}
        onOpenSchedule={vi.fn()}
        onOpenDivination={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenShopping={vi.fn()}
        onOpenMail={onOpenMail}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^邮箱，TA 的私人邮箱$/ }));

    expect(onOpenMail).toHaveBeenCalledTimes(1);
  });

  it('opens the reading notes app from the phone home grid', () => {
    const onOpenReadingNotes = vi.fn();
    render(
      <PhoneHome
        agent={agent}
        display={display}
        onNavigate={vi.fn()}
        onOpenSms={vi.fn()}
        onOpenContacts={vi.fn()}
        onOpenMmChat={vi.fn()}
        onOpenJournal={vi.fn()}
        onOpenSchedule={vi.fn()}
        onOpenDivination={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenShopping={vi.fn()}
        onOpenMail={vi.fn()}
        onOpenReadingNotes={onOpenReadingNotes}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /阅读笔记/ }));

    expect(onOpenReadingNotes).toHaveBeenCalledTimes(1);
  });
});
