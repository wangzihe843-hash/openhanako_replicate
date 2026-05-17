/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const journalStoreMock = vi.hoisted(() => ({
  appendJournalEntry: vi.fn(),
  confirmJournalDraft: vi.fn(),
  deleteJournalEntry: vi.fn(),
  discardJournalDraft: vi.fn(),
  listJournalDrafts: vi.fn(),
  listJournalEntries: vi.fn(),
}));

const journalAiMock = vi.hoisted(() => ({
  generateJournalDraftWithAI: vi.fn(),
}));

const profileMock = vi.hoisted(() => ({
  useXingyeRoleProfile: vi.fn(() => null),
}));

vi.mock('./xingye-journal-store', () => journalStoreMock);
vi.mock('./xingye-journal-ai', () => journalAiMock);
vi.mock('./xingye-profile-store', () => profileMock);

import { PhoneJournalApp } from './PhoneJournalApp';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderJournalApp() {
  return render(
    <PhoneJournalApp
      ownerAgent={agent}
      displayName="林雾"
      onBack={vi.fn()}
    />,
  );
}

beforeEach(() => {
  for (const fn of Object.values(journalStoreMock)) fn.mockReset();
  journalStoreMock.listJournalEntries.mockResolvedValue([]);
  journalStoreMock.listJournalDrafts.mockResolvedValue([]);
  journalStoreMock.appendJournalEntry.mockResolvedValue({
    id: 'entry-1',
    dayKey: '2026-05-17',
    title: 'manual',
    body: 'manual body',
    createdAt: '2026-05-17T10:00:00.000Z',
  });
  journalAiMock.generateJournalDraftWithAI.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('PhoneJournalApp · pending draft section', () => {
  it('does not render the draft section when there are no pending drafts', async () => {
    renderJournalApp();
    await waitFor(() => {
      expect(journalStoreMock.listJournalDrafts).toHaveBeenCalledWith('linwu');
    });
    expect(screen.queryByTestId('phone-journal-pending-drafts')).not.toBeInTheDocument();
    /** Empty state shows because BOTH lists are empty. */
    expect(await screen.findByTestId('phone-journal-empty')).toBeInTheDocument();
  });

  it('renders a draft from listJournalDrafts and confirm moves it into entries', async () => {
    journalStoreMock.listJournalDrafts.mockResolvedValueOnce([
      {
        id: 'd-1',
        dayKey: '2026-05-17',
        title: '小灯塔',
        body: '海风把灯影吹得有点歪。',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
        reason: '巡检里看到最近聊天反复提灯塔',
      },
    ]);
    journalStoreMock.confirmJournalDraft.mockResolvedValueOnce({
      id: 'entry-confirmed',
      dayKey: '2026-05-17',
      title: '小灯塔',
      body: '海风把灯影吹得有点歪，但我想留下这一句。',
      createdAt: '2026-05-17T12:30:00.000Z',
    });

    renderJournalApp();

    const draftCard = await screen.findByTestId('phone-journal-draft-d-1');
    /** Reason is visible — user can see WHY this draft was proposed. */
    expect(within(draftCard).getByText(/巡检里看到最近聊天反复提灯塔/)).toBeInTheDocument();

    /** User edits body in place before confirming. */
    const bodyField = screen.getByTestId('phone-journal-draft-body-d-1');
    fireEvent.change(bodyField, {
      target: { value: '海风把灯影吹得有点歪，但我想留下这一句。' },
    });

    fireEvent.click(screen.getByTestId('phone-journal-draft-confirm-d-1'));

    await waitFor(() => {
      expect(journalStoreMock.confirmJournalDraft).toHaveBeenCalledWith(
        'linwu',
        'd-1',
        expect.objectContaining({
          body: '海风把灯影吹得有点歪，但我想留下这一句。',
          dayKey: '2026-05-17',
          title: '小灯塔',
        }),
      );
    });

    /** Draft is removed from the pending list after confirm; confirmed entry appears in the entry list. */
    await waitFor(() => {
      expect(screen.queryByTestId('phone-journal-draft-d-1')).not.toBeInTheDocument();
    });
    expect(screen.getByText('小灯塔')).toBeInTheDocument();
  });

  it('discard calls discardJournalDraft and removes the draft from the section', async () => {
    journalStoreMock.listJournalDrafts.mockResolvedValueOnce([
      {
        id: 'd-2',
        dayKey: '2026-05-17',
        title: 'maybe',
        body: 'not sure if i want this in my journal',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);
    journalStoreMock.discardJournalDraft.mockResolvedValueOnce(true);
    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);

    try {
      renderJournalApp();
      await screen.findByTestId('phone-journal-draft-d-2');
      fireEvent.click(screen.getByTestId('phone-journal-draft-discard-d-2'));

      await waitFor(() => {
        expect(journalStoreMock.discardJournalDraft).toHaveBeenCalledWith('linwu', 'd-2');
      });
      await waitFor(() => {
        expect(screen.queryByTestId('phone-journal-draft-d-2')).not.toBeInTheDocument();
      });
      /** Importantly, discard MUST NOT call appendJournalEntry (no leakage to "已生成" list). */
      expect(journalStoreMock.appendJournalEntry).not.toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it('inline edits to a draft persist within the page (do not call store until confirm)', async () => {
    journalStoreMock.listJournalDrafts.mockResolvedValueOnce([
      {
        id: 'd-3',
        dayKey: '2026-05-17',
        title: 'first pass',
        body: 'first body',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);

    renderJournalApp();
    const titleField = await screen.findByTestId('phone-journal-draft-title-d-3');
    fireEvent.change(titleField, { target: { value: '改过的标题' } });
    /** The edit lives in component state; no store call happens yet. */
    expect(journalStoreMock.confirmJournalDraft).not.toHaveBeenCalled();
    /** Reading the input back, it reflects the user's edit (lives in state, not lost). */
    expect((titleField as HTMLInputElement).value).toBe('改过的标题');
  });
});
