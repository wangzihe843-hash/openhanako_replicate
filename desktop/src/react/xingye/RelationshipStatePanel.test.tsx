/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { RelationshipStatePanel } from './RelationshipStatePanel';
import { saveRelationshipState } from './xingye-state-store';

const appendEventOnceMock = vi.hoisted(() => vi.fn(async () => ({ id: 'event-1' })));
const generateSuggestionMock = vi.hoisted(() => vi.fn(async () => ({
  affectionDelta: 5,
  trustDelta: -3,
  loyaltyDelta: 2,
  jealousyDelta: 0,
  corruptionDelta: 0,
  mood: 'steady',
  stateSummary: 'accepted summary',
  reason: 'accepted from recent chat',
})));

vi.mock('./xingye-profile-store', () => ({
  saveXingyeRoleProfile: vi.fn(async () => ({})),
}));

vi.mock('./xingye-recent-context', () => ({
  collectRecentContextForAgent: vi.fn(() => ({ sourceNotes: ['recent chat'] })),
  describeRecentContextForPrompt: vi.fn(() => 'recent chat summary'),
}));

vi.mock('./xingye-state-ai', () => ({
  generateRelationshipStateSuggestion: generateSuggestionMock,
}));

vi.mock('./xingye-event-log', () => ({
  appendXingyeEventOnce: appendEventOnceMock,
}));

vi.mock('./xingye-relationship-state-drafts', () => ({
  listRelationshipStateDrafts: vi.fn(async () => []),
  confirmRelationshipStateDraft: vi.fn(async () => ({})),
  discardRelationshipStateDraft: vi.fn(async () => true),
}));

const rsDraftsModule = await import('./xingye-relationship-state-drafts');

describe('RelationshipStatePanel', () => {
  const agent: Agent = {
    id: 'agent-1',
    name: 'Hanako',
    yuan: 'hanako',
    isPrimary: true,
    hasAvatar: false,
  };

  beforeEach(() => {
    (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__ = true;
    window.localStorage.clear();
    appendEventOnceMock.mockReset();
    appendEventOnceMock.mockResolvedValue({ id: 'event-1' });
    generateSuggestionMock.mockClear();
    vi.mocked(rsDraftsModule.listRelationshipStateDrafts).mockReset().mockResolvedValue([]);
    vi.mocked(rsDraftsModule.confirmRelationshipStateDraft).mockReset().mockResolvedValue({} as never);
    vi.mocked(rsDraftsModule.discardRelationshipStateDraft).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps showing the updated state after accepting a recent chat suggestion', async () => {
    saveRelationshipState({
      agentId: 'agent-1',
      targetType: 'user',
      targetId: '__user__',
      affection: 10,
      trust: 1,
      loyalty: 1,
      jealousy: 0,
      corruption: 0,
      mood: 'old mood',
      relationshipKey: 'stranger',
      relationshipLabel: 'old label',
      stateSummary: 'old summary',
      lastReason: 'old reason',
      source: 'manual',
      updatedAt: '2026-05-13T00:00:00.000Z',
    });

    render(<RelationshipStatePanel agent={agent} profile={{ relationshipLabel: 'friend' }} />);

    expect(screen.getByText('old summary')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button')[0]);

    await waitFor(() => {
      expect(screen.getByText('accepted from recent chat')).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/建议变化 \+5/)).toBeInTheDocument();
    expect(screen.getByLabelText(/建议变化 -3/)).toBeInTheDocument();
    expect(screen.getAllByLabelText(/建议变化 0/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole('button')[1]);

    await waitFor(() => {
    expect(screen.getByText('accepted summary')).toBeInTheDocument();
    });
    expect(screen.getByText('steady')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();

    const history = screen.getByRole('group', { name: /old mood/ });
    expect(history).toBeInTheDocument();
    expect(screen.getByText('old summary')).not.toBeVisible();

    fireEvent.click(screen.getByText(/old mood/));

    expect(screen.getByText('old summary')).toBeVisible();
    expect(screen.getByText('old reason')).toBeVisible();
  });

  it('appends relationship_state.suggested after suggestion generation succeeds', async () => {
    saveRelationshipState({
      agentId: 'agent-1',
      targetType: 'user',
      targetId: '__user__',
      affection: 10,
      trust: 1,
      loyalty: 1,
      jealousy: 0,
      corruption: 0,
      mood: 'old mood',
      relationshipKey: 'stranger',
      relationshipLabel: 'old label',
      stateSummary: 'old summary',
      lastReason: 'old reason',
      source: 'manual',
      updatedAt: '2026-05-13T00:00:00.000Z',
    });

    render(<RelationshipStatePanel agent={agent} profile={{ relationshipLabel: 'friend' }} />);
    fireEvent.click(screen.getAllByRole('button')[0]);

    await waitFor(() => {
      expect(screen.getByText('accepted from recent chat')).toBeInTheDocument();
    });

    expect(appendEventOnceMock).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        type: 'relationship_state.suggested',
        source: 'RelationshipStatePanel',
        subjectId: '__user__',
        payload: expect.objectContaining({
          suggestionId: expect.any(String),
          mood: 'steady',
          affectionDelta: 5,
          trustDelta: -3,
          loyaltyDelta: 2,
          jealousyDelta: 0,
          corruptionDelta: 0,
          reasonSummary: 'accepted from recent chat',
          recentContextCount: 1,
        }),
      }),
      expect.stringMatching(/^relationship_state\.suggested:agent-1:/),
    );
  });

  it('appends relationship_state.applied after accepting and saving a suggestion', async () => {
    saveRelationshipState({
      agentId: 'agent-1',
      targetType: 'user',
      targetId: '__user__',
      affection: 10,
      trust: 1,
      loyalty: 1,
      jealousy: 0,
      corruption: 0,
      mood: 'old mood',
      relationshipKey: 'stranger',
      relationshipLabel: 'old label',
      stateSummary: 'old summary',
      lastReason: 'old reason',
      source: 'manual',
      updatedAt: '2026-05-13T00:00:00.000Z',
    });

    render(<RelationshipStatePanel agent={agent} profile={{ relationshipLabel: 'friend' }} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('accepted from recent chat')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button')[1]);

    await waitFor(() => {
      expect(screen.getByText('accepted summary')).toBeInTheDocument();
    });

    expect(appendEventOnceMock).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        type: 'relationship_state.applied',
        source: 'RelationshipStatePanel',
        subjectId: '__user__',
        payload: expect.objectContaining({
          suggestionId: expect.any(String),
          previous: expect.objectContaining({
            affection: 10,
            trust: 1,
            mood: 'old mood',
          }),
          next: expect.objectContaining({
            affection: 15,
            trust: -2,
            mood: 'steady',
          }),
          appliedFields: expect.arrayContaining(['affectionDelta', 'trustDelta', 'loyaltyDelta', 'mood', 'stateSummary', 'reason']),
        }),
      }),
      expect.stringMatching(/^relationship_state\.applied:agent-1:/),
    );
  });

  it('keeps relationship suggestion and apply flows working when event append fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appendEventOnceMock.mockRejectedValue(new Error('event write failed'));
    saveRelationshipState({
      agentId: 'agent-1',
      targetType: 'user',
      targetId: '__user__',
      affection: 10,
      trust: 1,
      loyalty: 1,
      jealousy: 0,
      corruption: 0,
      mood: 'old mood',
      relationshipKey: 'stranger',
      relationshipLabel: 'old label',
      stateSummary: 'old summary',
      lastReason: 'old reason',
      source: 'manual',
      updatedAt: '2026-05-13T00:00:00.000Z',
    });

    render(<RelationshipStatePanel agent={agent} profile={{ relationshipLabel: 'friend' }} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('accepted from recent chat')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button')[1]);

    await waitFor(() => {
      expect(screen.getByText('accepted summary')).toBeInTheDocument();
    });
    expect(screen.getByText('steady')).toBeInTheDocument();
    expect(appendEventOnceMock).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ type: 'relationship_state.applied' }),
      expect.any(String),
    );
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[RelationshipStatePanel] failed to append Xingye event:',
        expect.any(Error),
      );
    });
    warnSpy.mockRestore();
  });

  describe('pending draft section', () => {
    function seedBaseState() {
      saveRelationshipState({
        agentId: 'agent-1',
        targetType: 'user',
        targetId: '__user__',
        affection: 10,
        trust: 0,
        loyalty: 0,
        jealousy: 0,
        corruption: 0,
        mood: '平静',
        relationshipKey: 'stranger',
        relationshipLabel: 'L',
        source: 'manual',
        updatedAt: new Date().toISOString(),
      });
    }

    it('does not render the section when there are no pending drafts', async () => {
      seedBaseState();
      render(<RelationshipStatePanel agent={agent} profile={{ relationshipLabel: 'L' }} />);
      await waitFor(() => {
        expect(rsDraftsModule.listRelationshipStateDrafts).toHaveBeenCalled();
      });
      expect(screen.queryByTestId('relationship-state-pending-drafts')).not.toBeInTheDocument();
    });

    it('renders a draft and apply forwards draftId', async () => {
      seedBaseState();
      vi.mocked(rsDraftsModule.listRelationshipStateDrafts).mockResolvedValueOnce([
        {
          id: 'rsd-1',
          targetType: 'user',
          targetId: '__user__',
          affectionDelta: 5,
          trustDelta: 3,
          loyaltyDelta: 0,
          jealousyDelta: 0,
          corruptionDelta: 0,
          mood: '想他',
          stateSummary: '她今天主动留下来',
          reasonText: '晚饭后她没走',
          source: 'xingye-heartbeat-tool',
          createdAt: new Date().toISOString(),
        },
      ]);
      render(<RelationshipStatePanel agent={agent} profile={{ relationshipLabel: 'L' }} />);

      await waitFor(() => {
        expect(screen.getByTestId('relationship-state-pending-drafts')).toBeInTheDocument();
      });
      expect(screen.getByTestId('relationship-state-draft-row-rsd-1')).toHaveTextContent('晚饭后她没走');

      fireEvent.click(screen.getByTestId('relationship-state-draft-confirm-rsd-1'));
      await waitFor(() => {
        expect(rsDraftsModule.confirmRelationshipStateDraft).toHaveBeenCalledWith('agent-1', 'rsd-1');
      });
      expect(rsDraftsModule.discardRelationshipStateDraft).not.toHaveBeenCalled();
    });

    it('discard calls discard helper after user confirms window.confirm', async () => {
      seedBaseState();
      vi.mocked(rsDraftsModule.listRelationshipStateDrafts).mockResolvedValueOnce([
        {
          id: 'rsd-2',
          targetType: 'user',
          targetId: '__user__',
          affectionDelta: 0,
          trustDelta: 0,
          loyaltyDelta: 0,
          jealousyDelta: 0,
          corruptionDelta: 0,
          mood: '警惕',
          source: 'xingye-heartbeat-tool',
          createdAt: new Date().toISOString(),
        },
      ]);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<RelationshipStatePanel agent={agent} profile={{ relationshipLabel: 'L' }} />);

      await waitFor(() => {
        expect(screen.getByTestId('relationship-state-draft-row-rsd-2')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('relationship-state-draft-discard-rsd-2'));
      await waitFor(() => {
        expect(rsDraftsModule.discardRelationshipStateDraft).toHaveBeenCalledWith('agent-1', 'rsd-2');
      });
      expect(rsDraftsModule.confirmRelationshipStateDraft).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('cancelling window.confirm leaves the draft intact', async () => {
      seedBaseState();
      vi.mocked(rsDraftsModule.listRelationshipStateDrafts).mockResolvedValueOnce([
        {
          id: 'rsd-3',
          targetType: 'user',
          targetId: '__user__',
          affectionDelta: 1,
          trustDelta: 0,
          loyaltyDelta: 0,
          jealousyDelta: 0,
          corruptionDelta: 0,
          source: 'xingye-heartbeat-tool',
          createdAt: new Date().toISOString(),
        },
      ]);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<RelationshipStatePanel agent={agent} profile={{ relationshipLabel: 'L' }} />);

      await waitFor(() => {
        expect(screen.getByTestId('relationship-state-draft-row-rsd-3')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('relationship-state-draft-discard-rsd-3'));
      expect(rsDraftsModule.discardRelationshipStateDraft).not.toHaveBeenCalled();
      expect(screen.getByTestId('relationship-state-draft-row-rsd-3')).toBeInTheDocument();
      confirmSpy.mockRestore();
    });
  });
});
