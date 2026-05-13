import { describe, expect, it, vi } from 'vitest';
import {
  collectXingyeAgentIds,
  loadWorkspaceV2IntoMemoryMap,
  persistMemoryMapToWorkspaceV2,
} from './xingye-workspace-v2';
import { postXingyeStorage } from './xingye-storage-api';

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(),
}));

describe('xingye-workspace-v2 collectXingyeAgentIds', () => {
  it('collects ids from profiles lore phone and relationship maps', () => {
    const memory = new Map<string, string>([
      ['xingye.roleProfiles', JSON.stringify({
        'agent-a': { agentId: 'agent-a', updatedAt: '2026-01-01T00:00:00.000Z' },
      })],
      ['xingye.loreEntries', JSON.stringify({
        l1: {
          id: 'l1', agentId: 'agent-b', title: 't', content: 'c', category: 'rule', keywords: [],
          enabled: true, priority: 1, insertionMode: 'manual', visibility: 'canonical',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      })],
      ['xingye.relationshipStates', JSON.stringify({
        'agent-c': { agentId: 'agent-c', affection: 0, updatedAt: '2026-01-01T00:00:00.000Z' },
      })],
      ['xingye.phoneContacts', JSON.stringify({
        'agent-a::agent::x': {
          ownerAgentId: 'agent-a',
          targetType: 'agent',
          targetId: 'x',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      })],
      ['xingye.phoneAiGenerationState', JSON.stringify({
        'agent-d::contacts': {
          ownerAgentId: 'agent-d',
          kind: 'contacts',
          status: 'idle',
          profileFingerprint: 'fp',
          version: 1,
        },
      })],
      ['xingye.memoryCandidates', JSON.stringify({
        mc1: {
          id: 'mc1',
          agentId: 'agent-e',
          content: 'note',
          target: 'pinned',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      })],
    ]);

    expect(collectXingyeAgentIds(memory).sort()).toEqual(['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e']);
  });

  it('includes SMS-only owners from xingye.phoneSmsThreads', () => {
    const memory = new Map<string, string>([
      ['xingye.phoneSmsThreads', JSON.stringify({
        'sms_only_owner::agent::peer': {
          ownerAgentId: 'sms_only_owner',
          targetType: 'agent',
          targetId: 'peer',
          id: 'thread-1',
          messages: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      })],
    ]);

    expect(collectXingyeAgentIds(memory)).toContain('sms_only_owner');
  });
});

describe('xingye-workspace-v2 legacy business entrypoints', () => {
  it('rejects legacy workspace persistence instead of issuing unscoped storage calls', async () => {
    await expect(persistMemoryMapToWorkspaceV2(new Map(), '/workspace/root'))
      .rejects
      .toThrow('workspace v2 storage is disabled');
    await expect(loadWorkspaceV2IntoMemoryMap(new Map()))
      .rejects
      .toThrow('workspace v2 storage is disabled');
    expect(vi.mocked(postXingyeStorage)).not.toHaveBeenCalled();
  });
});
