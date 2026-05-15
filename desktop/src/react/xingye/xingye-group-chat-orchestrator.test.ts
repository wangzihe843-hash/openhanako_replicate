import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';

// Hoist all shared mock state so it's initialized before any vi.mock factories run.
const mocks = vi.hoisted(() => {
  type FetchCall = { path: string; init?: (RequestInit & { timeout?: number }) | undefined };
  type FetchHandler = (
    path: string,
    init?: RequestInit & { timeout?: number },
  ) => { ok: boolean; status?: number; json: unknown } | Promise<{ ok: boolean; status?: number; json: unknown }>;
  const fetchCalls: FetchCall[] = [];
  let fetchHandler: FetchHandler = () => ({ ok: false, status: 500, json: { error: 'no handler' } });
  let aiHandler: () => Promise<{ decision: 'reply' | 'skip'; reply: string; reason?: string }> = async () => ({
    decision: 'skip',
    reply: '',
    reason: 'default',
  });
  // Lazy state-backend slot; populated after the hoisted block runs.
  type AnyStorageBackend = {
    readJson<T>(agentId: string, relativePath: string): Promise<T | null>;
    writeJson<T>(agentId: string, relativePath: string, data: T): Promise<void>;
    appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void>;
    listJsonl<T>(agentId: string, relativePath: string): Promise<T[]>;
    writeJsonl<T>(agentId: string, relativePath: string, records: T[]): Promise<void>;
    deleteJsonlRecord(agentId: string, relativePath: string, recordId: string): Promise<boolean>;
  };
  const state: { backend: AnyStorageBackend | null } = { backend: null };
  return {
    fetchCalls,
    setFetchHandler(handler: FetchHandler) {
      fetchHandler = handler;
    },
    callFetchHandler(path: string, init?: RequestInit & { timeout?: number }) {
      return fetchHandler(path, init);
    },
    setAiHandler(handler: typeof aiHandler) {
      aiHandler = handler;
    },
    callAiHandler() {
      return aiHandler();
    },
    setStateBackend(b: AnyStorageBackend) {
      state.backend = b;
    },
    getStateBackend(): AnyStorageBackend {
      if (!state.backend) throw new Error('state backend not initialized');
      return state.backend;
    },
  };
});

// Eagerly create the in-memory backend (after hoisted block ran).
const stateBackend = createMemoryXingyeStorageBackend();
mocks.setStateBackend(stateBackend);

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async (path: string, init?: RequestInit & { timeout?: number }) => {
    mocks.fetchCalls.push({ path, init });
    const result = await mocks.callFetchHandler(path, init);
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? (result.ok ? 200 : 500),
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

vi.mock('./xingye-group-chat-ai', () => ({
  generateGroupChatReplyWithAI: vi.fn(async () => mocks.callAiHandler()),
}));

vi.mock('./xingye-profile-store', () => ({
  readXingyeRoleProfile: vi.fn(async () => null),
}));

vi.mock('./xingye-group-chat-state-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('./xingye-group-chat-state-store')>();
  let storeRef: ReturnType<typeof original.createXingyeGroupChatStateStore> | null = null;
  const getStore = () => {
    if (storeRef) return storeRef;
    storeRef = original.createXingyeGroupChatStateStore(mocks.getStateBackend(), {
      idFactory: (() => {
        let i = 0;
        return () => `run-${++i}`;
      })(),
      now: () => '2026-05-15T08:00:00.000Z',
    });
    return storeRef;
  };
  return {
    ...original,
    appendGroupChatRun: (input: Parameters<typeof original.appendGroupChatRun>[0]) => getStore().appendRun(input),
    findGroupChatRunByDedupeKey: (agentId: string, dedupeKey: string) =>
      getStore().findRunByDedupeKey(agentId, dedupeKey),
    listGroupChatRuns: (agentId: string) => getStore().listRuns(agentId),
    listGroupChatRunsForChannel: (agentId: string, channelId: string) =>
      getStore().listRunsForChannel(agentId, channelId),
  };
});

import { triggerGroupChatReply } from './xingye-group-chat-orchestrator';
import { XINGYE_GROUP_CHAT_RUNS_PATH } from './xingye-group-chat-state-store';

const agent: Agent = {
  id: 'agent-a',
  name: 'Linwu',
  yuan: 'yuan',
  isPrimary: true,
};

function setChannel(
  messages: Array<{ sender: string; timestamp: string; body: string }>,
  members: string[] = ['agent-a', 'agent-b'],
) {
  mocks.setFetchHandler((path) => {
    if (path.startsWith('/api/channels/')) {
      return {
        ok: true,
        json: {
          id: 'ch_crew',
          name: 'Crew',
          description: '',
          members,
          messages,
        },
      };
    }
    if (path === '/api/xingye/group-chat/post-as-agent') {
      return {
        ok: true,
        json: { ok: true, timestamp: '2026-05-15 09:10', channelId: 'ch_crew', agentId: 'agent-a' },
      };
    }
    return { ok: false, status: 500, json: { error: 'unexpected ' + path } };
  });
}

async function listRunsForAgentA() {
  return stateBackend.listJsonl<{ status: string; dedupeKey: string }>(
    'agent-a',
    XINGYE_GROUP_CHAT_RUNS_PATH,
  );
}

describe('xingye-group-chat-orchestrator', () => {
  beforeEach(async () => {
    mocks.fetchCalls.length = 0;
    await stateBackend.writeJsonl('agent-a', XINGYE_GROUP_CHAT_RUNS_PATH, []);
    await stateBackend.writeJsonl('agent-b', XINGYE_GROUP_CHAT_RUNS_PATH, []);
    mocks.setAiHandler(async () => ({ decision: 'skip', reply: '', reason: 'default' }));
  });

  it('writes a reply via POST /api/xingye/group-chat/post-as-agent when AI decides to reply', async () => {
    setChannel([
      { sender: 'liyu', timestamp: '2026-05-15 09:00', body: 'Linwu 在吗？' },
    ]);
    mocks.setAiHandler(async () => ({ decision: 'reply', reply: '在的。', reason: '回应 user' }));

    const outcome = await triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    expect(outcome.status).toBe('replied');
    if (outcome.status !== 'replied') return;
    expect(outcome.reply.body).toBe('在的。');
    expect(outcome.run.status).toBe('replied');
    expect(outcome.run.dedupeKey).toBe('agent-a::ch_crew::liyu@2026-05-15 09:00');

    const postCall = mocks.fetchCalls.find((c) => c.path === '/api/xingye/group-chat/post-as-agent');
    expect(postCall).toBeDefined();
    expect(postCall?.init?.method).toBe('POST');
    const body = JSON.parse(String(postCall?.init?.body ?? '{}'));
    expect(body).toMatchObject({ channelId: 'ch_crew', agentId: 'agent-a', body: '在的。' });

    const stored = await listRunsForAgentA();
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('replied');
  });

  it('records a skipped run when AI says skip and does not call post-as-agent', async () => {
    setChannel([
      { sender: 'system', timestamp: '2026-05-15 09:00', body: '本频道由 admin 管理' },
    ]);
    mocks.setAiHandler(async () => ({ decision: 'skip', reply: '', reason: '全是 system 公告' }));

    const outcome = await triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    expect(outcome.status).toBe('skipped');
    if (outcome.status !== 'skipped') return;
    expect(outcome.reason).toContain('system');

    expect(mocks.fetchCalls.some((c) => c.path === '/api/xingye/group-chat/post-as-agent')).toBe(false);
    const stored = await listRunsForAgentA();
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('skipped');
  });

  it('skips automatically when the latest message was posted by the current agent', async () => {
    setChannel([
      { sender: 'liyu', timestamp: '2026-05-15 09:00', body: 'Linwu 在吗？' },
      { sender: 'agent-a', timestamp: '2026-05-15 09:01', body: '在的。' },
    ]);
    mocks.setAiHandler(async () => {
      throw new Error('AI should not be called when the latest message is the agent self');
    });

    const outcome = await triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    expect(outcome.status).toBe('skipped');
    if (outcome.status !== 'skipped') return;
    expect(outcome.run.reason).toContain('自己刚发的');
  });

  it('does not re-reply when the same latestMessageId is triggered twice in a row', async () => {
    setChannel([
      { sender: 'liyu', timestamp: '2026-05-15 09:00', body: 'Linwu 在吗？' },
    ]);
    mocks.setAiHandler(async () => ({ decision: 'reply', reply: '在的。' }));

    const first = await triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    expect(first.status).toBe('replied');

    mocks.setAiHandler(async () => {
      throw new Error('AI should not be called the second time — dedupe should kick in');
    });
    const second = await triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    expect(second.status).toBe('noop');
    if (second.status !== 'noop') return;
    expect(second.previousRun.status).toBe('replied');

    const postCalls = mocks.fetchCalls.filter((c) => c.path === '/api/xingye/group-chat/post-as-agent');
    expect(postCalls).toHaveLength(1);
  });

  it('returns error when the agent is not a member of the channel', async () => {
    setChannel(
      [{ sender: 'liyu', timestamp: '2026-05-15 09:00', body: 'hi' }],
      ['agent-b', 'agent-c'],
    );
    const outcome = await triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error).toContain('成员');
    expect(mocks.fetchCalls.some((c) => c.path === '/api/xingye/group-chat/post-as-agent')).toBe(false);
  });

  it('records an error run when posting to the channel fails', async () => {
    setChannel([
      { sender: 'liyu', timestamp: '2026-05-15 09:00', body: 'Linwu 在吗？' },
    ]);
    mocks.setAiHandler(async () => ({ decision: 'reply', reply: '在的。' }));
    mocks.setFetchHandler((path) => {
      if (path.startsWith('/api/channels/')) {
        return {
          ok: true,
          json: {
            id: 'ch_crew',
            name: 'Crew',
            description: '',
            members: ['agent-a', 'agent-b'],
            messages: [{ sender: 'liyu', timestamp: '2026-05-15 09:00', body: 'Linwu 在吗？' }],
          },
        };
      }
      if (path === '/api/xingye/group-chat/post-as-agent') {
        return { ok: false, status: 500, json: { ok: false, error: 'write failed' } };
      }
      return { ok: false, status: 500, json: { error: 'unexpected ' + path } };
    });

    const outcome = await triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error).toContain('write failed');
    const stored = await listRunsForAgentA();
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('error');
  });
});
