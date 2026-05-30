/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(),
}));

import { hanaFetch } from '../hooks/use-hana-fetch';
import { postXingyeStorage } from './xingye-storage-api';
import { generateTripsHistoryWithAI, normalizeTripsHistoryResults } from './xingye-trips-ai';

const oneTrip = {
  from: { name: 'A地' },
  to: { name: 'B地' },
  chapter: 'c1',
  mode: 'boat',
  modeLabel: '摆渡',
  route: [],
};

describe('normalizeTripsHistoryResults', () => {
  it('accepts { trips: [...] } envelope', () => {
    const r = normalizeTripsHistoryResults({ trips: [oneTrip, { ...oneTrip, chapter: 'c2' }] });
    expect(r).toHaveLength(2);
    expect(r[0]!.from.name).toBe('A地');
    expect(r[0]!.mode).toBe('boat');
  });

  it('accepts entries / drafts / bare-array fallbacks', () => {
    expect(normalizeTripsHistoryResults({ entries: [oneTrip] })).toHaveLength(1);
    expect(normalizeTripsHistoryResults({ drafts: [oneTrip] })).toHaveLength(1);
    expect(normalizeTripsHistoryResults([oneTrip])).toHaveLength(1);
  });

  it('drops invalid trips and de-dupes by from→to + chapter', () => {
    const r = normalizeTripsHistoryResults({ trips: [oneTrip, oneTrip, { to: { name: 'x' } }] });
    expect(r).toHaveLength(1);
  });
});

describe('generateTripsHistoryWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { trips: [oneTrip, { ...oneTrip, chapter: 'c2', from: { name: 'C地' } }] },
      }),
    } as Response);
  });

  it('posts phone-generate with kind trips_history and returns normalized drafts', async () => {
    const agent = { id: 'agent-t', name: 'Lin', yuan: 'y' as const };
    const drafts = await generateTripsHistoryWithAI({ agent: agent as never, ownerProfile: null, desiredCount: 4 });
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(hanaFetch).toHaveBeenCalledWith('/api/xingye/phone-generate', expect.objectContaining({ method: 'POST' }));
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('trips_history');
    expect(body.prompt).toContain('行程');
    expect(body.prompt).toContain('过去');
  });

  it('throws when model returns zero usable trips', async () => {
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { trips: [] } }),
    } as Response);
    const agent = { id: 'agent-t', name: 'Lin', yuan: 'y' as const };
    await expect(
      generateTripsHistoryWithAI({ agent: agent as never, ownerProfile: null, desiredCount: 4 }),
    ).rejects.toThrow();
  });
});
