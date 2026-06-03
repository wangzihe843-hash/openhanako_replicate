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

let hbSeq = 0;

/** 模拟一次 beat 完成：scheduler 经 activity_update 把带 summaryZh 的 heartbeat 活动推进 store。 */
function pushHeartbeatActivity(overrides: Partial<Activity> = {}): void {
  // id 必须每条唯一且单调（服务端有序）——完成检测靠「id 不同于触发基线」而非时钟比较。
  hbSeq += 1;
  const activity: Activity = {
    id: `hb_${hbSeq}`,
    type: 'heartbeat',
    title: '日常巡检',
    timestamp: new Date().toISOString(),
    agentId: 'agent-a',
    agentName: 'Agent A',
    startedAt: Date.now(),
    finishedAt: Date.now() + 60_000,
    summary: '日常巡检',
    status: 'done',
    error: null,
    ...overrides,
  };
  // 新→旧排序（与 store 真实顺序一致）：最新 beat 排在数组最前。
  useStore.setState((s) => ({ activities: [activity, ...(s.activities as Activity[])] }));
}

describe('PhoneHome heartbeat trigger', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    hbSeq = 0;
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

  it('只回填属于本 agent、且 id 不同于触发基线的新 heartbeat 活动', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, triggered: true, cooldown: false }),
    } as Response);

    // 触发前就已存在的上一轮 beat —— 触发时会被快照为基线，绝不能被当成本次结果。
    pushHeartbeatActivity({ summaryZh: '上一轮旧结果' });

    renderPhoneHome();
    fireEvent.click(screen.getByRole('button', { name: '立即巡检' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('巡检触发中');
    });
    // 基线那条不会被回填（id 与基线相同）。
    expect(screen.getByRole('status')).not.toHaveTextContent('上一轮旧结果');

    // 别的 agent 的新活动：selector 直接过滤掉，忽略。
    pushHeartbeatActivity({ agentId: 'agent-b', summaryZh: '不该显示的别人' });
    expect(screen.getByRole('status')).not.toHaveTextContent('不该显示的别人');
    expect(screen.getByRole('status')).toHaveTextContent('巡检触发中');

    // 本 agent、id 不同于基线的新一轮 beat：回填。
    // 关键：finishedAt 故意早于客户端 now（模拟服务端时钟落后整整一个 beat），
    // 旧的时钟比较会误丢这条；id 比较不受时钟差影响，仍能正确收尾。
    pushHeartbeatActivity({
      finishedAt: Date.now() - 10 * 60_000,
      summaryZh: '通讯录变更×1、短信×2（共 3 条）',
    });
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

  it('原地切换角色时复位在途触发，不把新角色已存在的 heartbeat 误判为完成（regression）', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, triggered: true, cooldown: false }),
    } as Response);

    const agentB: Agent = { id: 'agent-b', name: 'Agent B', yuan: 'hanako', isPrimary: false, hasAvatar: false };
    const common = {
      display,
      onNavigate: vi.fn(), onOpenSms: vi.fn(), onOpenContacts: vi.fn(), onOpenMmChat: vi.fn(),
      onOpenJournal: vi.fn(), onOpenSchedule: vi.fn(), onOpenDivination: vi.fn(),
      onOpenFiles: vi.fn(), onOpenShopping: vi.fn(), onOpenMail: vi.fn(),
    };

    // agent-b 早就存在一条旧 beat —— 它的 id 必然 ≠ agent-a 触发时的基线，绝不能被
    // agent-a 的在途触发误判为「本次完成」。
    pushHeartbeatActivity({ agentId: 'agent-b', agentName: 'Agent B', summaryZh: 'B 的旧巡检结果' });

    const { rerender } = render(<PhoneHome agent={agent} {...common} />);
    fireEvent.click(screen.getByRole('button', { name: '立即巡检' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('巡检触发中'));

    // 无 key、就地把 agent prop 换成 agent-b（XingyeShell 在当前角色掉出列表时的 fallback 路径）。
    rerender(<PhoneHome agent={agentB} {...common} />);

    // 复位生效：状态回到 idle，不把 agent-b 的旧 beat 误收尾为「巡检完毕」。
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('等待手动巡检'));
    expect(screen.getByRole('status')).not.toHaveTextContent('巡检完毕');
    expect(screen.getByRole('status')).not.toHaveTextContent('B 的旧巡检结果');
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
