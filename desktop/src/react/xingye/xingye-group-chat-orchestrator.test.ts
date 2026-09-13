import { useStore } from '../stores';
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
  const runConnections: unknown[] = [];
  let fetchHandler: FetchHandler = () => ({ ok: false, status: 500, json: { error: 'no handler' } });
  let aiHandler: () => Promise<{ decision: 'reply' | 'skip'; reply: string; reason?: string }> = async () => ({
    decision: 'skip',
    reply: '',
    reason: 'default',
  });
  // Lazy state-backend slot; populated after the hoisted block runs.
  type AnyStorageBackend = {
    compareAndSwapJsonlRecord<T>(agentId: string, relativePath: string, recordId: string, expected: T, data: T): Promise<{ updated: boolean; record: T | null }>;
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
    runConnections,
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
    appendGroupChatRun: (input: Parameters<typeof original.appendGroupChatRun>[0], connection?: unknown) => { mocks.runConnections.push(connection); return getStore().appendRun(input); },
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
    mocks.runConnections.length = 0;
    useStore.setState({ serverPort: '17333', activeServerConnection: null });
    await stateBackend.writeJsonl('agent-a', XINGYE_GROUP_CHAT_RUNS_PATH, []);
    await stateBackend.writeJsonl('agent-b', XINGYE_GROUP_CHAT_RUNS_PATH, []);
    mocks.setAiHandler(async () => ({ decision: 'skip', reply: '', reason: 'default' }));
  });

  it('review X10 coalesces simultaneous reminders for the same channel', async () => {
    setChannel([{ sender: 'user', timestamp: 'same', body: 'hello' }]);
    let release!: (value: { decision: 'reply'; reply: string }) => void;
    const answer = new Promise<{ decision: 'reply'; reply: string }>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    mocks.setAiHandler(() => { started(); return answer; });
    const first = triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    await ready;
    const second = triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    await new Promise(resolve => setTimeout(resolve, 0));
    release({ decision: 'reply', reply: 'one reply' });
    await Promise.all([first, second]);
    expect(mocks.fetchCalls.filter(call => call.path.includes('post-as-agent'))).toHaveLength(1);
    expect(await listRunsForAgentA()).toHaveLength(1);
  });

  it('review X10 retains the original connection for a run after posting has started', async () => {
    mocks.setFetchHandler(path => {
      if (path.includes('post-as-agent')) {
        useStore.setState({ serverPort: '17334' });
        return { ok: true, json: { ok: true, timestamp: '2026-09-13T00:00:00Z' } };
      }
      return { ok: true, json: { id: 'ch_crew', members: ['agent-a'], messages: [{ sender: 'user', timestamp: 't', body: 'hello' }] } };
    });
    mocks.setAiHandler(async () => ({ decision: 'reply', reply: 'confirmed reply' }));
    const result = await triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    expect(result.status).toBe('error');
    expect(await listRunsForAgentA()).toHaveLength(1);
    expect(mocks.runConnections[0]).toMatchObject({ baseUrl: 'http://127.0.0.1:17333' });
  });

  it('review X10 cancels before posting when connection changes during generation', async () => {
    useStore.setState({ serverPort: '17333', activeServerConnection: null });
    setChannel([{ sender: 'user', timestamp: '2026-05-15 09:00', body: 'hello' }]);
    let release!: (value: { decision: 'reply'; reply: string }) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    mocks.setAiHandler(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const running = triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    await ready;
    useStore.setState({ serverPort: '17334' });
    release({ decision: 'reply', reply: 'A private reply' });
    const result = await running;
    expect(result.status).toBe('error');
    expect(mocks.fetchCalls.filter(call => call.path.includes('post-as-agent'))).toHaveLength(0);
    expect(await listRunsForAgentA()).toHaveLength(0);
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

  it('retries a failed generation and still deduplicates the successful retry', async () => {
    setChannel([{ sender: 'liyu', timestamp: '2026-05-15 09:00', body: '在吗？' }]);
    let attempts = 0;
    mocks.setAiHandler(async () => {
      if (++attempts === 1) throw new Error('temporary generation failure');
      return { decision: 'reply', reply: '在的。' };
    });

    expect((await triggerGroupChatReply({ agent, channelId: 'ch_crew' })).status).toBe('error');
    expect((await triggerGroupChatReply({ agent, channelId: 'ch_crew' })).status).toBe('replied');
    expect((await triggerGroupChatReply({ agent, channelId: 'ch_crew' })).status).toBe('noop');
    expect(attempts).toBe(2);
    expect(mocks.fetchCalls.filter(c => c.path === '/api/xingye/group-chat/post-as-agent')).toHaveLength(1);
  });

  it('does not retry an unacknowledged post after the connection recovers', async () => {
    setChannel([{ sender: 'liyu', timestamp: '2026-05-15 09:00', body: '在吗？' }]);
    mocks.setAiHandler(async () => ({ decision: 'reply', reply: '在的。' }));
    const { hanaFetch } = await import('../hooks/use-hana-fetch');
    const original = vi.mocked(hanaFetch).getMockImplementation()!;
    vi.mocked(hanaFetch).mockImplementation(async (...args) => {
      if (args[0] === '/api/xingye/group-chat/post-as-agent') throw new Error('response lost after submission');
      return original(...args);
    });
    try {
      expect((await triggerGroupChatReply({ agent, channelId: 'ch_crew' })).status).toBe('error');
    } finally {
      vi.mocked(hanaFetch).mockImplementation(original);
    }
    const retry = await triggerGroupChatReply({ agent, channelId: 'ch_crew' });
    expect(retry.status).toBe('noop');
    expect(mocks.fetchCalls.filter(c => c.path === '/api/xingye/group-chat/post-as-agent')).toHaveLength(0);
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
