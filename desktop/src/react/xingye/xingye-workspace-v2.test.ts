/**
 * Workspace v2 tests（含 SMS monolith persist/load）。本轮改动仅限 xingye-workspace-v2 / xingye-phone-store；
 * 不涉及 ChatArea、OpenHanako memory、/api/memories/import、memory ticker、SMS AI prompt。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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

function testSafeThreadId(threadKey: string): string {
  return `t_${createHash('sha256').update(threadKey, 'utf8').digest('hex')}`;
}

function testThreadFile(threadKey: string): string {
  return `threads/${testSafeThreadId(threadKey)}.json`;
}

function testManifest(agentIds: string[]) {
  return {
    schemaVersion: 2,
    layoutVersion: XINGYE_LAYOUT_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceRoot: '/w',
    workspaceRootHash: 'w1',
    agentIds,
  };
}

function testSmsThread(
  ownerAgentId: string,
  targetType: string,
  targetId: string,
  id: string,
  content = 'hi',
) {
  return {
    ownerAgentId,
    targetType,
    targetId,
    id,
    messages: [{
      id: `${id}-m1`,
      threadId: id,
      fromAgentId: ownerAgentId,
      toAgentId: targetId,
      content,
      source: 'mock',
      createdAt: '2026-01-02T00:00:00.000Z',
    }],
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function testSmsIndex(ownerAgentId: string, threadMap: Record<string, ReturnType<typeof testSmsThread>>) {
  const threads: Record<string, Record<string, unknown>> = {};
  for (const [threadKey, thread] of Object.entries(threadMap)) {
    const safeThreadId = testSafeThreadId(threadKey);
    threads[threadKey] = {
      threadKey,
      safeThreadId,
      file: `threads/${safeThreadId}.json`,
      threadId: thread.id,
      ownerAgentId: thread.ownerAgentId,
      targetType: thread.targetType,
      targetId: thread.targetId,
      updatedAt: thread.updatedAt,
      messageCount: thread.messages.length,
    };
  }
  return {
    schemaVersion: 1,
    ownerAgentId,
    updatedAt: '2026-01-02T00:00:00.000Z',
    threads,
  };
}

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

describe('xingye-workspace-v2 SMS per-thread persist/load', () => {
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

  it('loads old monolith-only sms-threads.json', async () => {
    const key = 'ownerA::agent::p1';
    const thread = testSmsThread('ownerA', 'agent', 'p1', 'th-a', 'monolith');
    files.set('manifest.json', JSON.stringify(testManifest(['ownerA'])));
    files.set('agents/ownerA/phone/sms-threads.json', JSON.stringify({ [key]: thread }));

    const loaded = new Map<string, string>();
    await loadWorkspaceV2IntoMemoryMap(loaded);

    const sms = JSON.parse(loaded.get('xingye.phoneSmsThreads') || '{}') as Record<string, unknown>;
    expect(sms[key]).toEqual(thread);
  });

  it('loads per-thread index and thread files without monolith', async () => {
    const key = 'ownerA::agent::p1';
    const thread = testSmsThread('ownerA', 'agent', 'p1', 'th-a', 'per-thread');
    files.set('manifest.json', JSON.stringify(testManifest(['ownerA'])));
    files.set('agents/ownerA/phone/sms/index.json', JSON.stringify(testSmsIndex('ownerA', { [key]: thread })));
    files.set('agents/ownerA/phone/sms/threads.json', 'not used');
    files.set('agents/ownerA/phone/sms/threads/' + `${testSafeThreadId(key)}.json`, JSON.stringify({
      ...thread,
      schemaVersion: 1,
      threadKey: key,
    }));

    const loaded = new Map<string, string>();
    await loadWorkspaceV2IntoMemoryMap(loaded);

    const sms = JSON.parse(loaded.get('xingye.phoneSmsThreads') || '{}') as Record<string, unknown>;
    expect(sms[key]).toEqual(thread);
  });

  it('loads per-thread first and lets monolith fill missing keys', async () => {
    const sharedKey = 'ownerA::agent::p1';
    const monolithOnlyKey = 'ownerA::virtual_contact::vc1';
    const perThread = testSmsThread('ownerA', 'agent', 'p1', 'th-per', 'per-thread wins');
    const monolithShared = testSmsThread('ownerA', 'agent', 'p1', 'th-mono', 'monolith loses');
    const monolithOnly = testSmsThread('ownerA', 'virtual_contact', 'vc1', 'th-vc', 'monolith fills');
    files.set('manifest.json', JSON.stringify(testManifest(['ownerA'])));
    files.set('agents/ownerA/phone/sms/index.json', JSON.stringify(testSmsIndex('ownerA', { [sharedKey]: perThread })));
    files.set(`agents/ownerA/phone/sms/${testThreadFile(sharedKey)}`, JSON.stringify({
      ...perThread,
      schemaVersion: 1,
      threadKey: sharedKey,
    }));
    files.set('agents/ownerA/phone/sms-threads.json', JSON.stringify({
      [sharedKey]: monolithShared,
      [monolithOnlyKey]: monolithOnly,
    }));

    const loaded = new Map<string, string>();
    await loadWorkspaceV2IntoMemoryMap(loaded);

    const sms = JSON.parse(loaded.get('xingye.phoneSmsThreads') || '{}') as Record<string, unknown>;
    expect(sms[sharedKey]).toEqual(perThread);
    expect(sms[monolithOnlyKey]).toEqual(monolithOnly);
  });

  it('corrupted or mismatched thread files do not override monolith fallback', async () => {
    const key = 'ownerA::agent::p1';
    const perThread = testSmsThread('ownerA', 'agent', 'p1', 'th-per', 'bad per-thread');
    const monolith = testSmsThread('ownerA', 'agent', 'p1', 'th-mono', 'fallback');
    files.set('manifest.json', JSON.stringify(testManifest(['ownerA'])));
    files.set('agents/ownerA/phone/sms/index.json', JSON.stringify(testSmsIndex('ownerA', { [key]: perThread })));
    files.set(`agents/ownerA/phone/sms/${testThreadFile(key)}`, JSON.stringify({
      ...perThread,
      schemaVersion: 1,
      threadKey: 'ownerA::agent::different',
    }));
    files.set('agents/ownerA/phone/sms-threads.json', JSON.stringify({ [key]: monolith }));

    const loaded = new Map<string, string>();
    await loadWorkspaceV2IntoMemoryMap(loaded);

    const sms = JSON.parse(loaded.get('xingye.phoneSmsThreads') || '{}') as Record<string, unknown>;
    expect(sms[key]).toEqual(monolith);
  });

  it('persist writes monolith, index, and per-thread files with composite keys (multi-agent)', async () => {
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
    const smsAIndexPath = 'agents/ownerA/phone/sms/index.json';
    const smsBIndexPath = 'agents/ownerB/phone/sms/index.json';
    const smsAThreadPath = `agents/ownerA/phone/sms/${testThreadFile('ownerA::agent::p1')}`;
    const smsBThreadPath = `agents/ownerB/phone/sms/${testThreadFile('ownerB::virtual_contact::vc1')}`;
    expect(files.get(smsAPath)).toBeTruthy();
    expect(files.get(smsBPath)).toBeTruthy();
    expect(JSON.parse(files.get(smsAPath)!)).toEqual({ 'ownerA::agent::p1': smsMap['ownerA::agent::p1'] });
    expect(JSON.parse(files.get(smsBPath)!)).toEqual({ 'ownerB::virtual_contact::vc1': smsMap['ownerB::virtual_contact::vc1'] });
    expect(files.get(smsAIndexPath)).toBeTruthy();
    expect(files.get(smsBIndexPath)).toBeTruthy();
    expect(files.get(smsAThreadPath)).toBeTruthy();
    expect(files.get(smsBThreadPath)).toBeTruthy();

    const smsAIndex = JSON.parse(files.get(smsAIndexPath)!);
    const smsAEntry = smsAIndex.threads['ownerA::agent::p1'];
    expect(smsAEntry).toMatchObject({
      threadKey: 'ownerA::agent::p1',
      safeThreadId: testSafeThreadId('ownerA::agent::p1'),
      file: testThreadFile('ownerA::agent::p1'),
      threadId: 'th-a',
      ownerAgentId: 'ownerA',
      targetType: 'agent',
      targetId: 'p1',
      messageCount: 1,
    });
    expect(JSON.parse(files.get(smsAThreadPath)!)).toMatchObject({
      schemaVersion: 1,
      threadKey: 'ownerA::agent::p1',
      ...smsMap['ownerA::agent::p1'],
    });

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

  it('safeThreadId is a sha256 filename and does not contain raw key or path characters', async () => {
    const key = 'owner/path::agent::peer/..\\x';
    const thread = testSmsThread('owner/path', 'agent', 'peer/..\\x', 'th-path', 'path chars');
    const memory = new Map<string, string>([
      ['xingye.phoneSmsThreads', JSON.stringify({ [key]: thread })],
    ]);

    await persistMemoryMapToWorkspaceV2(memory, '/w');

    const index = JSON.parse(files.get('agents/owner_path/phone/sms/index.json') || '{}');
    const entry = index.threads[key];
    expect(entry.threadKey).toBe(key);
    expect(entry.safeThreadId).toMatch(/^t_[a-f0-9]{64}$/);
    expect(entry.safeThreadId).not.toContain('owner');
    expect(entry.safeThreadId).not.toContain('peer');
    expect(entry.file).toBe(`threads/${entry.safeThreadId}.json`);
    expect(entry.file).not.toContain('..');
    expect(entry.file).not.toContain('\\');
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
