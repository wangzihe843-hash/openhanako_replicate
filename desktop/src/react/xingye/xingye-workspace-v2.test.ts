/**
 * Workspace v2 tests（含 SMS monolith persist/load）。本轮改动仅限 xingye-workspace-v2 / xingye-phone-store；
 * 不涉及 ChatArea、OpenHanako memory、/api/memories/import、memory ticker、SMS AI prompt。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectXingyeAgentIds,
  loadWorkspaceV2IntoMemoryMap,
  persistMemoryMapToWorkspaceV2,
  XINGYE_LAYOUT_VERSION,
} from './xingye-workspace-v2';

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(),
}));

import { postXingyeStorage } from './xingye-storage-api';

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

describe('xingye-workspace-v2 SMS monolith persist/load', () => {
  const files = new Map<string, string>();

  beforeEach(() => {
    files.clear();
    vi.mocked(postXingyeStorage).mockImplementation(async (body: Record<string, unknown>) => {
      const action = body.action as string;
      const rel = body.relativePath as string;
      if (action === 'write') {
        const content = typeof body.content === 'string' ? body.content : '';
        files.set(rel, content);
        return {};
      }
      if (action === 'read') {
        const content = files.get(rel);
        if (content == null) return { missing: true };
        return { content };
      }
      return {};
    });
  });

  it('persist then load restores xingye.phoneSmsThreads with composite keys (multi-agent)', async () => {
    const smsMap = {
      'ownerA::agent::p1': {
        ownerAgentId: 'ownerA',
        targetType: 'agent',
        targetId: 'p1',
        id: 'th-a',
        messages: [{ id: 'm1', threadId: 'th-a', fromAgentId: 'ownerA', toAgentId: 'p1', content: 'hi', source: 'mock', createdAt: '2026-01-02T00:00:00.000Z' }],
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      'ownerB::virtual_contact::vc1': {
        ownerAgentId: 'ownerB',
        targetType: 'virtual_contact',
        targetId: 'vc1',
        id: 'th-b',
        messages: [],
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    };
    const memory = new Map<string, string>([
      ['xingye.phoneSmsThreads', JSON.stringify(smsMap)],
    ]);

    await persistMemoryMapToWorkspaceV2(memory, '/workspace/root');

    const smsAPath = 'agents/ownerA/phone/sms-threads.json';
    const smsBPath = 'agents/ownerB/phone/sms-threads.json';
    expect(files.get(smsAPath)).toBeTruthy();
    expect(files.get(smsBPath)).toBeTruthy();
    expect(JSON.parse(files.get(smsAPath)!)).toEqual({ 'ownerA::agent::p1': smsMap['ownerA::agent::p1'] });
    expect(JSON.parse(files.get(smsBPath)!)).toEqual({ 'ownerB::virtual_contact::vc1': smsMap['ownerB::virtual_contact::vc1'] });

    const loaded = new Map<string, string>();
    await loadWorkspaceV2IntoMemoryMap(loaded);

    const roundTrip = JSON.parse(loaded.get('xingye.phoneSmsThreads') || '{}') as Record<string, unknown>;
    expect(roundTrip['ownerA::agent::p1']).toEqual(smsMap['ownerA::agent::p1']);
    expect(roundTrip['ownerB::virtual_contact::vc1']).toEqual(smsMap['ownerB::virtual_contact::vc1']);

    const manifest = JSON.parse(files.get('manifest.json') || '{}');
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.layoutVersion).toBe(XINGYE_LAYOUT_VERSION);
    expect(manifest.agentIds.sort()).toEqual(['ownerA', 'ownerB']);
  });

  it('manifest lists SMS-only agent when phoneSmsThreads is the only xingye phone data', async () => {
    const memory = new Map<string, string>([
      ['xingye.phoneSmsThreads', JSON.stringify({
        'solo::agent::x': {
          ownerAgentId: 'solo',
          targetType: 'agent',
          targetId: 'x',
          id: 't1',
          messages: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      })],
    ]);
    await persistMemoryMapToWorkspaceV2(memory, '/w');
    const manifest = JSON.parse(files.get('manifest.json') || '{}');
    expect(manifest.agentIds).toContain('solo');
  });
});
