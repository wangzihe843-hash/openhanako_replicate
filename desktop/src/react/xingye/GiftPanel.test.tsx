// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { GiftPanel } from './GiftPanel';
import { grantInitGiftInventory } from './xingye-gift-store';

const giftMocks = vi.hoisted(() => ({
  grantInitGiftInventory: vi.fn(async () => ({})),
  loadGiftState: vi.fn(async () => ({
    initializedAt: '2026-07-02T00:00:00.000Z',
    eraSetId: 'modern',
    favoriteGiftId: 'modern/coffee',
    temperament: 'calm',
    stances: {},
    replies: {},
  })),
}));

vi.mock('./xingye-profile-store', () => ({
  useXingyeRoleProfile: () => null,
}));

vi.mock('./xingye-gift-store', () => ({
  appendGiftLog: vi.fn(),
  consumeGiftFromInventory: vi.fn(),
  grantInitGiftInventory: giftMocks.grantInitGiftInventory,
  hasFavoriteHit: vi.fn(() => false),
  listGiftLog: vi.fn(async () => []),
  loadGiftState: giftMocks.loadGiftState,
  loadSharedGiftInventory: vi.fn(async () => ({})),
  saveGiftState: vi.fn(),
}));

describe('GiftPanel initialization inventory reconciliation', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('retries the idempotent inventory grant when an initialized agent is loaded', async () => {
    const agent = { id: 'agent-a', name: 'Agent A' } as Agent;

    render(<GiftPanel agent={agent} />);

    await waitFor(() => {
      expect(grantInitGiftInventory).toHaveBeenCalledWith('agent-a');
    });
  });
});
