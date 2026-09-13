import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../stores';
import { resolveServerConnection, type ServerConnection } from '../services/server-connection';
import { generateGroupChatReplyWithAI } from './xingye-group-chat-ai';
import { triggerGroupChatReply } from './xingye-group-chat-orchestrator';
import type { Agent } from '../types';

const mocks = vi.hoisted(() => ({
  config: vi.fn<() => Promise<{ user: { name: string } }>>(),
  lore: vi.fn<() => Promise<{ content: string }>>(),
  calls: [] as Array<{ path: string; origin?: string; action?: string }>,
}));
vi.mock('../hooks/use-config', () => ({ fetchConfig: mocks.config }));
vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async (path: string, init?: RequestInit & { connection?: ServerConnection }) => {
    const connection = init?.connection ?? resolveServerConnection(useStore.getState());
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    mocks.calls.push({ path, origin: connection?.baseUrl, action: typeof body.action === 'string' ? body.action : undefined });
    let data: unknown;
    if (path.startsWith('/api/channels/')) data = { id: 'c', name: 'C', members: ['a'], messages: [{ sender: 'user', timestamp: 't', body: 'A private message' }] };
    else if (path === '/api/xingye/phone-generate') data = { ok: true, result: { decision: 'reply', reply: 'reply' } };
    else if (path.endsWith('/post-as-agent')) data = { ok: true, timestamp: '2026-09-13T00:00:00Z' };
    else if (body.action === 'read') data = await mocks.lore();
    else if (body.action === 'readJson') data = { data: { agentId: 'a', shortBio: 'A private profile', updatedAt: '2026-09-13' } };
    else if (body.action === 'listJsonl') data = { records: [] };
    else data = { ok: true };
    return new Response(JSON.stringify(data));
  }),
}));
vi.mock('./xingye-recent-context', () => ({ collectRecentContextForAgent: () => ({ summaryText: 'A recent scene' }), describeRecentContextForPrompt: () => 'A scene' }));
vi.mock('./xingye-state-store', () => ({ getRelationshipState: () => null }));
vi.mock('./xingye-persistence', () => ({ getXingyePersistenceStorage: () => ({}) }));
vi.mock('./xingye-lore-store', () => ({ listLoreEntries: () => [], XINGYE_LORE_CATEGORY_LABELS: {} }));
vi.mock('./xingye-lore-runtime-context', () => ({ buildXingyeLoreRuntimeQueryText: () => '', collectXingyeLoreRuntimeContext: () => ({}), formatXingyeLoreRuntimeContextBlock: () => '' }));

const agent: Agent = { id: 'a', name: 'A', yuan: 'hanako', isPrimary: true };
const generate = () => generateGroupChatReplyWithAI({ agent, channelId: 'c', channelName: 'C', channelMembers: ['a'], recentMessages: [{ sender: 'user', timestamp: 't', body: 'A private message' }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function writes() { return mocks.calls.filter(call => call.path.endsWith('phone-generate') || call.path.endsWith('post-as-agent') || call.action === 'appendJsonl'); }

describe('MR8 group generation connection ownership', () => {
  beforeEach(() => {
    useStore.setState({ serverPort: '17333', serverToken: 'A', activeServerConnection: null, activeServerConnectionId: null, serverConnections: {} });
    mocks.calls.length = 0;
    mocks.config.mockReset().mockResolvedValue({ user: { name: 'A user' } });
    mocks.lore.mockReset().mockResolvedValue({ content: 'A private lore' });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['username', 'lore'] as const)('MR8 cancels the real orchestrator and generator when %s resolves after switching', async (stage) => {
    const started = deferred<void>();
    const config = deferred<{ user: { name: string } }>();
    const lore = deferred<{ content: string }>();
    if (stage === 'username') mocks.config.mockImplementationOnce(() => { started.resolve(); return config.promise; });
    else mocks.lore.mockImplementationOnce(() => { started.resolve(); return lore.promise; });
    const operation = triggerGroupChatReply({ agent, channelId: 'c' });
    await started.promise;
    useStore.setState({ serverPort: '17334', serverToken: 'B' });
    config.resolve({ user: { name: 'A user' } }); lore.resolve({ content: 'A private lore' });
    const result = await operation;
    expect(result.status).toBe('error');
    expect(writes()).toHaveLength(0);
    expect(mocks.calls.every(call => call.origin === 'http://127.0.0.1:17333')).toBe(true);
  });

  it('MR8 standalone generator rejects a connection round trip during username lookup', async () => {
    const pending = deferred<{ user: { name: string } }>();
    mocks.config.mockReturnValueOnce(pending.promise);
    const operation = generate().then(() => 'generated', () => 'cancelled');
    useStore.setState({ serverPort: '17334' });
    useStore.setState({ serverPort: '17333' });
    pending.resolve({ user: { name: 'A user' } });
    expect(await operation).toBe('cancelled');
    expect(writes()).toHaveLength(0);
  });

  it('MR8 a failed old lore read cannot fall back and send on the new connection', async () => {
    const started = deferred<void>();
    const pending = deferred<{ content: string }>();
    mocks.lore.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const operation = generate().then(() => 'generated', () => 'cancelled');
    await started.promise;
    useStore.setState({ serverPort: '17334' });
    pending.reject(new Error('old lore unavailable'));
    expect(await operation).toBe('cancelled');
    expect(writes()).toHaveLength(0);
  });

  it('MR8 honors an already-cancelled orchestrator guard before reading context', async () => {
    await expect(generateGroupChatReplyWithAI({ agent, channelId: 'c', channelName: 'C', channelMembers: ['a'], recentMessages: [],
      assertCurrent: () => { throw new Error('parent cancelled'); },
    })).rejects.toThrow('parent cancelled');
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.calls).toHaveLength(0);
  });

  it('MR8 keeps ordinary lore-read fallback available on an unchanged connection', async () => {
    mocks.lore.mockRejectedValueOnce(new Error('missing lore'));
    const result = await triggerGroupChatReply({ agent, channelId: 'c' });
    expect(result.status).toBe('replied');
    expect(writes()).toHaveLength(3);
    expect(writes().every(call => call.origin === 'http://127.0.0.1:17333')).toBe(true);
  });

  it('MR8 unchanged connections still generate, post, and persist one run', async () => {
    const result = await triggerGroupChatReply({ agent, channelId: 'c' });
    expect(result.status).toBe('replied');
    expect(writes()).toHaveLength(3);
    expect(writes().every(call => call.origin === 'http://127.0.0.1:17333')).toBe(true);
  });
});
