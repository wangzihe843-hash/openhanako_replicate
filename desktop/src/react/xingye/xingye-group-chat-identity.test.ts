import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../stores';
import type { Agent, ChannelMessage } from '../types';
import { triggerGroupChatReply } from './xingye-group-chat-orchestrator';

const h = vi.hoisted(() => ({
  config: vi.fn(), generate: vi.fn(),
  channels: new Map<string, { members: string[]; messages: ChannelMessage[] }>(),
  runs: [] as Record<string, unknown>[],
  calls: [] as Array<{ path: string; body: Record<string, unknown> }>,
  appendPostedMessage: false,
}));
vi.mock('../hooks/use-config', () => ({ fetchConfig: h.config }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn(async (path: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  h.calls.push({ path, body });
  let out: unknown = { ok: true };
  if (path.startsWith('/api/channels/')) {
    const id = decodeURIComponent(path.slice('/api/channels/'.length));
    out = { id, name: '合成群', ...h.channels.get(id) };
  } else if (path.endsWith('/phone-generate')) out = await h.generate();
  else if (path.endsWith('/post-as-agent')) {
    const timestamp = 'synthetic-post-' + h.calls.filter(c => c.path.endsWith('/post-as-agent')).length;
    out = { ok: true, timestamp };
    if (h.appendPostedMessage) h.channels.get(body.channelId)?.messages.push({ sender: body.agentId, timestamp, body: body.body });
  } else if (body.action === 'listJsonl') out = { records: h.runs };
  else if (body.action === 'appendJsonl') h.runs.push(structuredClone(body.data));
  else if (body.action === 'read') out = { content: '合成角色设定' };
  else if (body.action === 'readJson') out = { data: null };
  return new Response(JSON.stringify(out));
}) }));
vi.mock('./xingye-recent-context', () => ({ collectRecentContextForAgent: () => ({ summaryText: '' }), describeRecentContextForPrompt: () => '' }));
vi.mock('./xingye-state-store', () => ({ getRelationshipState: () => null }));
vi.mock('./xingye-persistence', () => ({ getXingyePersistenceStorage: () => ({}) }));
vi.mock('./xingye-lore-store', () => ({ listLoreEntries: () => [], XINGYE_LORE_CATEGORY_LABELS: {} }));
vi.mock('./xingye-lore-runtime-context', () => ({ buildXingyeLoreRuntimeQueryText: () => '', collectXingyeLoreRuntimeContext: () => ({}), formatXingyeLoreRuntimeContextBlock: () => '' }));

const agent: Agent = { id: 'role-17', name: '同名', yuan: 'synthetic', isPrimary: true };
const selfSkipReason = '最新一条消息是当前 agent 自己刚发的，不再追发';
const generated = () => h.calls.filter(c => c.path.endsWith('/phone-generate'));
const posts = () => h.calls.filter(c => c.path.endsWith('/post-as-agent'));
function setChannel(id = 'room', sender = agent.id, body = '用户问「我把吉他借给你了吗？」') {
  const messages = [{ sender, timestamp: 'source-t', body }];
  h.channels.set(id, { members: [agent.id, 'peer'], messages });
  return messages;
}
function runRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'old-run', agentId: agent.id, channelId: 'room', latestMessageId: agent.id + '@source-t',
    sourceMessageIds: [agent.id + '@source-t'], dedupeKey: agent.id + '::room::' + agent.id + '@source-t',
    status: 'skipped', reason: selfSkipReason, createdAt: '2026-01-01T00:00:00Z', ...overrides,
  };
}

describe('group-chat identity through the actual orchestration and persisted run selection', () => {
  beforeEach(() => {
    useStore.setState({ serverPort: '17333', serverToken: 'synthetic', activeServerConnection: null, activeServerConnectionId: null, serverConnections: {} });
    h.channels.clear(); h.runs.length = 0; h.calls.length = 0; h.appendPostedMessage = false;
    h.config.mockReset().mockResolvedValue({ user: { name: agent.id } });
    h.generate.mockReset().mockResolvedValue({ ok: true, result: { decision: 'reply', reply: '合成回答。' } });
    setChannel();
  });

  it('responds to a user-name/agent-ID collision exactly once and keeps the stored source intact', async () => {
    const before = structuredClone(h.channels.get('room'));
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('replied');
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('noop');
    expect(generated()).toHaveLength(1); expect(posts()).toHaveLength(1);
    expect(generated()[0].body.prompt).toContain('[role-17（身份不明） · source-t]');
    expect(h.channels.get('room')).toEqual(before);
  });

  it.each(['同名', '改名后的角色'])('does not use the role display name %s as a stored sender ID', async name => {
    h.config.mockResolvedValue({ user: { name } }); setChannel('room', name);
    expect((await triggerGroupChatReply({ agent: { ...agent, name }, channelId: 'room' })).status).toBe('replied');
    expect(generated()[0].body.prompt).toContain(`[${name}（user 本人） · source-t]`);
    expect(posts()).toHaveLength(1);
  });

  it('uses the acknowledged own reply to prevent a loop even while the user name equals the agent ID', async () => {
    h.appendPostedMessage = true;
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('replied');
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('skipped');
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('noop');
    expect(generated()).toHaveLength(1); expect(posts()).toHaveLength(1); expect(h.runs).toHaveLength(2);
  });

  it('rechecks a legacy mistaken self skip, retries a generation failure, and then deduplicates success', async () => {
    h.runs.push(runRecord());
    h.generate.mockRejectedValueOnce(new Error('synthetic temporary failure'));
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('error');
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('replied');
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('noop');
    expect(generated()).toHaveLength(2); expect(posts()).toHaveLength(1);
    expect(h.runs.map(r => r.status)).toEqual(['skipped', 'error', 'replied']);
  });

  it('keeps a prior terminal reply authoritative over a newer mistaken self skip', async () => {
    h.runs.push(runRecord({ id: 'success', status: 'replied', replyContent: 'sent', replyMessageId: agent.id + '@sent-t' }), runRecord());
    const result = await triggerGroupChatReply({ agent, channelId: 'room' });
    expect(result.status).toBe('noop');
    if (result.status === 'noop') expect(result.previousRun.id).toBe('success');
    expect(generated()).toHaveLength(0); expect(posts()).toHaveLength(0);
  });

  it.each([
    { reason: 'AI 判断当前无需回复' },
    { status: 'error', reason: 'post result unknown', replyContent: 'possibly sent', retryable: false },
    { replyMessageId: agent.id + '@sent-t' },
  ])('does not reinterpret a terminal run as a retryable identity check: %j', async fields => {
    h.runs.push(runRecord(fields));
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('noop');
    expect(generated()).toHaveLength(0); expect(posts()).toHaveLength(0); expect(h.runs).toHaveLength(1);
  });

  it.each(['没有合适的话', selfSkipReason])('deduplicates a model skip after processing an ambiguous user row: %s', async reason => {
    h.generate.mockResolvedValue({ ok: true, result: { decision: 'skip', reply: '', reason } });
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('skipped');
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('noop');
    expect(generated()).toHaveLength(1); expect(posts()).toHaveLength(0); expect(h.runs).toHaveLength(1);
  });

  it.each(['other-channel', 'other-body', 'other-agent'])('does not treat an unrelated receipt as evidence of a self message: %s', async difference => {
    h.runs.push(runRecord({
      latestMessageId: 'user@older', dedupeKey: agent.id + '::room::user@older', status: 'replied',
      channelId: difference === 'other-channel' ? 'elsewhere' : 'room',
      agentId: difference === 'other-agent' ? 'peer' : agent.id,
      replyMessageId: agent.id + '@source-t',
      replyContent: difference === 'other-body' ? 'unrelated' : h.channels.get('room')!.messages[0].body,
    }));
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('replied');
    expect(generated()).toHaveLength(1); expect(posts()).toHaveLength(1);
  });

  it('isolates deduplication for identical sender/timestamp rows in different groups', async () => {
    setChannel('second');
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('replied');
    expect((await triggerGroupChatReply({ agent, channelId: 'second' })).status).toBe('replied');
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('noop');
    expect(posts().map(c => c.body.channelId)).toEqual(['room', 'second']);
  });

  it('still skips an unambiguous current-agent message without generation or repeated receipts', async () => {
    h.config.mockResolvedValue({ user: { name: '访客' } });
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('skipped');
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('noop');
    expect(generated()).toHaveLength(0); expect(posts()).toHaveLength(0); expect(h.runs).toHaveLength(1);
  });

  it('does not persist a self-skip when the user identity read fails, and permits a later retry', async () => {
    h.config.mockRejectedValueOnce(new Error('config unavailable'));
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('error');
    expect(h.runs).toHaveLength(0); expect(posts()).toHaveLength(0);
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('replied');
  });

  it('uses one user identity snapshot for the entry guard and the generated prompt', async () => {
    h.config.mockResolvedValueOnce({ user: { name: agent.id } }).mockResolvedValue({ user: { name: 'renamed' } });
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('replied');
    expect(h.config).toHaveBeenCalledTimes(1);
    expect(h.config).toHaveBeenCalledWith(expect.objectContaining({ force: true, cacheKey: expect.any(String) }));
    expect(generated()[0].body.prompt).toContain('[role-17（身份不明） · source-t]');
  });

  it('does not generate or write after A to B to A while resolving user identity', async () => {
    let started!: () => void;
    let finish!: (value: unknown) => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    h.config.mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = triggerGroupChatReply({ agent, channelId: 'room' });
    expect(await Promise.race([ready.then(() => 'identity-read'), pending.then(() => 'completed')])).toBe('identity-read');
    useStore.setState({ serverPort: '17334' }); useStore.setState({ serverPort: '17333' });
    finish({ user: { name: agent.id } });
    expect((await pending).status).toBe('error');
    expect(generated()).toHaveLength(0); expect(posts()).toHaveLength(0); expect(h.runs).toHaveLength(0);
  });

  it('keeps identity-error responses retryable without persisting a self skip', async () => {
    h.config.mockResolvedValueOnce({ error: 'synthetic read error' });
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('error');
    expect(h.runs).toHaveLength(0);
    expect((await triggerGroupChatReply({ agent, channelId: 'room' })).status).toBe('replied');
  });

  it('recognizes the channel route default user sender when no custom name is configured', async () => {
    h.config.mockResolvedValue({ user: { name: '' }, channelUserName: 'user' });
    h.channels.set('default-name', { members: ['user'], messages: [{ sender: 'user', timestamp: 't', body: '用户输入' }] });
    expect((await triggerGroupChatReply({ agent: { ...agent, id: 'user' }, channelId: 'default-name' })).status).toBe('replied');
    expect(generated()[0].body.prompt).toContain('[user（身份不明） · t]');
  });

  it.each(['user', 'User', 'system'])('uses the actual channel user sender %s instead of the speaker display fallback', async id => {
    const a = { ...agent, id };
    h.config.mockResolvedValue({ user: { name: id } });
    h.channels.set('reserved', { members: [id], messages: [{ sender: id, timestamp: 't', body: '用户输入' }] });
    expect((await triggerGroupChatReply({ agent: a, channelId: 'reserved' })).status).toBe('replied');
    expect(generated()[0].body.prompt).toContain(`[${id}（身份不明） · t]`);
  });

  it.each(['', '   ', '../role', ' role-17 ', 17, null])('rejects malformed identity %j even when a malformed membership list contains it', async id => {
    h.channels.set('invalid', { members: [id as string], messages: [{ sender: '访客', timestamp: 't', body: 'hello' }] });
    expect((await triggerGroupChatReply({ agent: { ...agent, id: id as string }, channelId: 'invalid' })).status).toBe('error');
    expect(generated()).toHaveLength(0); expect(posts()).toHaveLength(0); expect(h.runs).toHaveLength(0);
  });
});
