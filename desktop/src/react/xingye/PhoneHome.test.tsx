/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity, Agent } from '../types';
import { PhoneHome } from './PhoneHome';
import { useStore } from '../stores';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: fetchMock,
}));

vi.mock('./XingyeAgentAvatar', () => ({
  XingyeAgentAvatar: ({ alt }: { alt: string }) => <div>{alt}</div>,
}));

vi.mock('./xingye-files-secret-heartbeat', () => ({
  tryRelockHiddenFolderAfterHeartbeat: vi.fn().mockResolvedValue({ relocked: false, state: null }),
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

/** 模拟一次 beat 完成：scheduler 经 activity_update 把带 summaryZh 的 heartbeat 活动推进 store。 */
function pushHeartbeatActivity(overrides: Partial<Activity> = {}): void {
  const activity: Activity = {
    id: `hb_${Date.now()}`,
    type: 'heartbeat',
    title: '日常巡检',
    timestamp: new Date().toISOString(),
    agentId: 'agent-a',
    agentName: 'Agent A',
    startedAt: Date.now(),
    finishedAt: Date.now() + 60_000, // 确保晚于触发水位线
    summary: '日常巡检',
    status: 'done',
    error: null,
    ...overrides,
  };
  useStore.setState((s) => ({ activities: [activity, ...(s.activities as Activity[])] }));
}

describe('PhoneHome heartbeat trigger', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useStore.setState({ activities: [] });
  });

  afterEach(() => {
    cleanup();
    useStore.setState({ activities: [] });
  });

  it('fire-and-forget 触发后等 activity_update 经 store 回填 summaryZh，并处理 cooldown / 失败', async () => {
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

    // 1) 触发成功：先停在「触发中」，beat 完成（store 推活动）后回填 summaryZh
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检触发中');
    });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/desk/heartbeat?agentId=agent-a', { method: 'POST' });

    pushHeartbeatActivity({ summaryZh: '自上次巡检以来：短信×2（共 2 条）' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检完毕');
    });
    expect(screen.getByRole('status')).toHaveTextContent('自上次巡检以来：短信×2（共 2 条）');

    // 2) 冷却中：路由回 cooldown，不依赖 activity_update
    fireEvent.click(screen.getByRole('button', { name: '立即巡检' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('冷却中');
    });

    // 3) 路由本身报错：直接显示失败
    fireEvent.click(screen.getByRole('button', { name: '立即巡检' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检失败：Heartbeat not initialized');
    });
  });

  it('只回填属于本 agent、且晚于触发水位线的 heartbeat 活动', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, triggered: true, cooldown: false }),
    } as Response);

    renderPhoneHome();
    fireEvent.click(screen.getByRole('button', { name: '立即巡检' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检触发中');
    });

    // 别的 agent 的活动：忽略
    pushHeartbeatActivity({ agentId: 'agent-b', summaryZh: '不该显示的别人' });
    // 触发前就结束的旧活动（finishedAt 早于水位线）：忽略
    pushHeartbeatActivity({ finishedAt: Date.now() - 60_000, summaryZh: '过期旧活动' });
    expect(screen.getByRole('status')).not.toHaveTextContent('不该显示的别人');
    expect(screen.getByRole('status')).not.toHaveTextContent('过期旧活动');
    expect(screen.getByRole('status')).toHaveTextContent('巡检触发中');

    // 本 agent、晚于水位线：回填
    pushHeartbeatActivity({ summaryZh: '通讯录变更×1、短信×2（共 3 条）' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('通讯录变更×1、短信×2（共 3 条）');
    });
  });

  it('巡检完成但无 summaryZh 时只显示「巡检完毕」', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, triggered: true, cooldown: false }),
    } as Response);

    renderPhoneHome();
    fireEvent.click(screen.getByRole('button', { name: '立即巡检' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检触发中');
    });

    pushHeartbeatActivity({ summaryZh: '' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检完毕');
    });
    expect(screen.getByRole('status')).not.toHaveTextContent('自上次巡检以来');
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
