import { describe, expect, it, vi } from 'vitest';

const fetchProbe = vi.hoisted(() => vi.fn());
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: fetchProbe }));

import { createPeerAgent } from './lore-studio-peer-create';

describe('Lore Studio peer persona creation contract', () => {
  it('sends authored persona through the canonical AGENTS field', async () => {
    // Stop at the transport boundary, before any unrelated profile/state writes.
    fetchProbe.mockResolvedValue({ ok: false, json: async () => ({ error: 'transport probe complete' }) });
    await expect(createPeerAgent({
      source: { agentId: 'source', name: 'Source', yuan: 'hanako' },
      candidate: { name: 'Peer', roleInWorld: 'Harbor keeper', whyUpgrade: 'Patient and careful', suggestedRelationshipToCurrent: 'Old friend' },
      worldviewEntries: [], userName: 'User',
    })).rejects.toThrow('transport probe complete');
    expect(fetchProbe).toHaveBeenCalledTimes(1);
    const [endpoint, options] = fetchProbe.mock.calls[0];
    expect(endpoint).toBe('/api/agents');
    expect(JSON.parse(options.body)).toMatchObject({
      name: 'Peer', yuan: 'hanako',
      initialFiles: { identity: '# Peer\n\nHarbor keeper', agents: 'Patient and careful\n\nOld friend' },
    });
    expect(JSON.parse(options.body).initialFiles).not.toHaveProperty('ishiki');
  });
});
