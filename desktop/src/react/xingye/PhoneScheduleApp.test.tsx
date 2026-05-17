/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const scheduleStoreMock = vi.hoisted(() => ({
  appendScheduleEntry: vi.fn(),
  deleteScheduleEntry: vi.fn(),
  listScheduleEntries: vi.fn(),
  updateScheduleEntryStatus: vi.fn(),
  listScheduleDrafts: vi.fn(),
  confirmScheduleDraft: vi.fn(),
  discardScheduleDraft: vi.fn(),
}));

const scheduleAiMock = vi.hoisted(() => ({
  generateScheduleDraftWithAI: vi.fn(),
}));

vi.mock('./xingye-schedule-store', () => scheduleStoreMock);
vi.mock('./xingye-schedule-ai', () => scheduleAiMock);

import { PhoneScheduleApp } from './PhoneScheduleApp';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderScheduleApp() {
  return render(
    <PhoneScheduleApp
      ownerAgent={agent}
      ownerProfile={null}
      displayName="林雾"
      onBack={vi.fn()}
    />,
  );
}

describe('PhoneScheduleApp', () => {
  beforeEach(() => {
    scheduleStoreMock.appendScheduleEntry.mockReset();
    scheduleStoreMock.deleteScheduleEntry.mockReset();
    scheduleStoreMock.listScheduleEntries.mockReset();
    scheduleStoreMock.updateScheduleEntryStatus.mockReset();
    scheduleStoreMock.listScheduleDrafts.mockReset();
    scheduleStoreMock.confirmScheduleDraft.mockReset();
    scheduleStoreMock.discardScheduleDraft.mockReset();
    scheduleAiMock.generateScheduleDraftWithAI.mockReset();
    scheduleStoreMock.listScheduleEntries.mockResolvedValue([]);
    scheduleStoreMock.listScheduleDrafts.mockResolvedValue([]);
    scheduleStoreMock.appendScheduleEntry.mockImplementation(async (_agentId, input) => ({
      id: 'created-1',
      agentId: 'linwu',
      status: 'planned',
      createdAt: '2026-05-13T10:00:00.000Z',
      updatedAt: '2026-05-13T10:00:00.000Z',
      ...input,
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the iOS-style day empty state and saves a manual schedule entry', async () => {
    renderScheduleApp();

    expect(await screen.findByText('这一天还没有安排')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '新建日程' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '睡前发消息' } });
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '今晚睡前' } });
    fireEvent.change(screen.getByLabelText('时间'), { target: { value: '睡前' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: '确认她有没有按时休息。' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '别太晚。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(scheduleStoreMock.appendScheduleEntry).toHaveBeenCalledWith('linwu', {
        title: '睡前发消息',
        dateLabel: '今晚睡前',
        timeText: '睡前',
        content: '确认她有没有按时休息。',
        note: '别太晚。',
        source: 'manual',
        status: 'planned',
      });
    });
  });

  it('generates an AI draft from recent chat without saving until the user confirms', async () => {
    scheduleAiMock.generateScheduleDraftWithAI.mockResolvedValueOnce({
      title: '诊所前整理',
      dateLabel: '下次去诊所前',
      timeText: '上午',
      content: '把想问的事写下来。',
      note: '不要硬编。',
      status: 'planned',
    });

    renderScheduleApp();

    await screen.findByText('这一天还没有安排');
    fireEvent.click(screen.getByRole('button', { name: '新建日程' }));
    fireEvent.change(screen.getByLabelText('日程意图'), { target: { value: '诊所前' } });
    fireEvent.click(screen.getByRole('button', { name: '根据最近聊天生成' }));

    await waitFor(() => {
      expect(scheduleAiMock.generateScheduleDraftWithAI).toHaveBeenCalledWith({
        agent,
        ownerProfile: null,
        userIntent: '诊所前',
      });
    });
    expect(scheduleStoreMock.appendScheduleEntry).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('诊所前整理')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(scheduleStoreMock.appendScheduleEntry).toHaveBeenCalledWith('linwu', expect.objectContaining({ source: 'ai' }));
    });
  });

  it('opens details and deletes one schedule entry', async () => {
    scheduleStoreMock.listScheduleEntries.mockResolvedValueOnce([
      {
        id: 'lin-1',
        agentId: 'linwu',
        title: '睡前发消息',
        dateLabel: '今晚睡前',
        timeText: '睡前',
        content: '确认她有没有按时休息。',
        note: '别太晚。',
        source: 'manual',
        status: 'planned',
        createdAt: '2026-05-13T10:00:00.000Z',
        updatedAt: '2026-05-13T10:00:00.000Z',
      },
    ]);
    scheduleStoreMock.deleteScheduleEntry.mockResolvedValueOnce(true);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    renderScheduleApp();

    fireEvent.click(await screen.findByRole('button', { name: /睡前发消息/ }));
    expect(screen.getByText('确认她有没有按时休息。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除这条日程' }));

    await waitFor(() => {
      expect(scheduleStoreMock.deleteScheduleEntry).toHaveBeenCalledWith('linwu', 'lin-1');
    });
  });

  describe('pending drafts section', () => {
    it('does not render drafts section when there are no pending drafts', async () => {
      renderScheduleApp();
      await waitFor(() => {
        expect(scheduleStoreMock.listScheduleDrafts).toHaveBeenCalledWith('linwu');
      });
      expect(screen.queryByTestId('phone-schedule-pending-drafts')).not.toBeInTheDocument();
    });

    it('renders draft from listScheduleDrafts and confirm moves it to entries', async () => {
      scheduleStoreMock.listScheduleDrafts.mockResolvedValueOnce([
        {
          id: 'd-1',
          title: '陪我去诊所',
          dateLabel: '明天上午',
          content: '带社保卡',
          timeText: '上午',
          createdAt: '2026-05-17T12:00:00.000Z',
          source: 'xingye-heartbeat-tool',
          reason: '她答应过',
        },
      ]);
      scheduleStoreMock.confirmScheduleDraft.mockResolvedValueOnce({
        id: 'entry-confirmed',
        agentId: 'linwu',
        title: '陪我去诊所',
        dateLabel: '明天上午',
        content: '带社保卡 + 体检报告',
        source: 'ai',
        status: 'planned',
        createdAt: '2026-05-17T12:30:00.000Z',
        updatedAt: '2026-05-17T12:30:00.000Z',
      });

      renderScheduleApp();
      const card = await screen.findByTestId('phone-schedule-draft-d-1');
      expect(card).toBeInTheDocument();
      /** Reason is visible. */
      expect(screen.getByText(/她答应过/)).toBeInTheDocument();
      /** Edit content in place. */
      fireEvent.change(screen.getByTestId('phone-schedule-draft-content-d-1'), {
        target: { value: '带社保卡 + 体检报告' },
      });
      fireEvent.click(screen.getByTestId('phone-schedule-draft-confirm-d-1'));
      await waitFor(() => {
        expect(scheduleStoreMock.confirmScheduleDraft).toHaveBeenCalledWith(
          'linwu',
          'd-1',
          expect.objectContaining({
            title: '陪我去诊所',
            dateLabel: '明天上午',
            content: '带社保卡 + 体检报告',
          }),
        );
      });
      await waitFor(() => {
        expect(screen.queryByTestId('phone-schedule-draft-d-1')).not.toBeInTheDocument();
      });
    });

    it('discard calls discardScheduleDraft, does NOT call appendScheduleEntry', async () => {
      scheduleStoreMock.listScheduleDrafts.mockResolvedValueOnce([
        {
          id: 'd-2',
          title: 'maybe',
          dateLabel: '某天',
          content: '不确定',
          createdAt: '2026-05-17T12:00:00.000Z',
          source: 'xingye-heartbeat-tool',
        },
      ]);
      scheduleStoreMock.discardScheduleDraft.mockResolvedValueOnce(true);
      /** jsdom's `window.confirm` defaults to "not implemented" and returns false; */
      /** plain `window.confirm = vi.fn()` doesn't take in some jsdom versions. spyOn does. */
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      try {
        renderScheduleApp();
        await screen.findByTestId('phone-schedule-draft-d-2');
        fireEvent.click(screen.getByTestId('phone-schedule-draft-discard-d-2'));
        await waitFor(() => {
          expect(scheduleStoreMock.discardScheduleDraft).toHaveBeenCalledWith('linwu', 'd-2');
        });
        await waitFor(() => {
          expect(screen.queryByTestId('phone-schedule-draft-d-2')).not.toBeInTheDocument();
        });
        /** Discard must not leak into the published entries list. */
        expect(scheduleStoreMock.appendScheduleEntry).not.toHaveBeenCalled();
      } finally {
        confirmSpy.mockRestore();
      }
    });
  });
});
