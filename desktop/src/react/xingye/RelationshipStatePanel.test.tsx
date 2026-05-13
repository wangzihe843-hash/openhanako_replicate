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

vi.mock('./xingye-profile-store', () => ({
  saveXingyeRoleProfile: vi.fn(async () => ({})),
}));

vi.mock('./xingye-recent-context', () => ({
  collectRecentContextForAgent: vi.fn(() => ({ sourceNotes: ['recent chat'] })),
  describeRecentContextForPrompt: vi.fn(() => 'recent chat summary'),
}));

vi.mock('./xingye-state-ai', () => ({
  generateRelationshipStateSuggestion: vi.fn(async () => ({
    affectionDelta: 5,
    trustDelta: -3,
    loyaltyDelta: 2,
    jealousyDelta: 0,
    corruptionDelta: 0,
    mood: 'steady',
    stateSummary: 'accepted summary',
    reason: 'accepted from recent chat',
  })),
}));

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
});
