import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent as RuntimeAgent } from '../core/agent';
import { AgentManager } from '../core/agent-manager';
import { HanaEngine as Engine } from '../core/engine';
import { PreferencesManager } from '../core/preferences-manager';
import { createConfigRoute } from '../server/routes/config';
import { createChannelsRoute } from '../server/routes/channels';
import { createXingyeRoute } from '../server/routes/xingye.js';
import { createXingyeStorageRoute } from '../server/routes/xingye-storage.js';
import { createChannel, parseChannel } from '../lib/channels/channel-store';
import { useStore } from '../desktop/src/react/stores';
import { invalidateConfigCache } from '../desktop/src/react/hooks/use-config';
import { triggerGroupChatReply } from '../desktop/src/react/xingye/xingye-group-chat-orchestrator';
import { generateGroupChatReplyWithAI } from '../desktop/src/react/xingye/xingye-group-chat-ai';
import type { Agent } from '../desktop/src/react/types';

const h = vi.hoisted(() => ({
  bridge: null as null | ((url: string, init?: RequestInit) => Response | Promise<Response>), generate: vi.fn(), afterConfig: null as null | (() => void),
  configOverride: undefined as unknown,
  calls: [] as Array<{ path: string; body: { prompt: string; agentId: string } }>,
}));
vi.mock('../desktop/src/react/hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn(async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  h.calls.push({ path: url, body });
  if (url === '/api/xingye/phone-generate') return new Response(JSON.stringify(await h.generate(body)));
  if (url === '/api/config' && h.configOverride !== undefined) return new Response(JSON.stringify(h.configOverride));
  if (!h.bridge) throw new Error('No synthetic HTTP bridge');
  const response = await h.bridge(url, init);
  if (url === '/api/config') h.afterConfig?.();
  return response;
}) }));
vi.mock('../core/llm-client', () => ({ callText: () => { throw new Error('real provider forbidden'); } }));
vi.mock('../desktop/src/react/xingye/xingye-recent-context', () => ({ collectRecentContextForAgent: () => ({ summaryText: '' }), describeRecentContextForPrompt: () => '' }));
vi.mock('../desktop/src/react/xingye/xingye-state-store', () => ({ getRelationshipState: () => null }));
vi.mock('../desktop/src/react/xingye/xingye-persistence', () => ({ getXingyePersistenceStorage: () => ({}) }));
vi.mock('../desktop/src/react/xingye/xingye-lore-store', () => ({ listLoreEntries: () => [], XINGYE_LORE_CATEGORY_LABELS: {} }));
vi.mock('../desktop/src/react/xingye/xingye-lore-runtime-context', () => ({ buildXingyeLoreRuntimeQueryText: () => '', collectXingyeLoreRuntimeContext: () => ({}), formatXingyeLoreRuntimeContextBlock: () => '' }));

let root: string;
let app: Hono;
let agent: Agent;
let runtimeAgent: RuntimeAgent;
let engine: Omit<Engine, 'agent'> & { agent: RuntimeAgent | undefined };
const quote = 'A转述B：「C说『我把吉他借给你，别告诉他们。』」 👩🏽‍💻';
const channelFile = () => path.join(root, 'channels', 'ch_room.md');
const rows = () => parseChannel(fs.readFileSync(channelFile(), 'utf8')).messages;
const generated = () => h.calls.filter(c => c.path.endsWith('/phone-generate'));
const posted = () => h.calls.filter(c => c.path.endsWith('/post-as-agent'));
const runFile = () => path.join(root, 'agents', agent.id, 'xingye', 'group-chat', 'runs.jsonl');
const trigger = () => triggerGroupChatReply({ agent, channelId: 'ch_room' });

async function setup(opts: { name?: unknown; locale?: string; agentLocale?: string; id?: string; constructorDefault?: boolean } = {}) {
  agent = { id: opts.id || 'role-17', name: '同名', yuan: 'synthetic', isPrimary: true };
  const agentsDir = path.join(root, 'agents'), userDir = path.join(root, 'user');
  fs.mkdirSync(userDir, { recursive: true });
  for (const id of [agent.id, 'peer']) fs.mkdirSync(path.join(agentsDir, id), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'preferences.json'), JSON.stringify({ _defaultsRelaxedMigrated: true, ...(opts.name !== undefined ? { userName: opts.name } : {}), ...(opts.locale !== undefined ? { locale: opts.locale } : {}) }));
  const prefs = new PreferencesManager({ userDir, agentsDir });
  runtimeAgent = new RuntimeAgent({ id: agent.id, agentsDir, userDir, productDir: path.join(root, 'product') } as unknown as ConstructorParameters<typeof RuntimeAgent>[0]);
  runtimeAgent._config = { ...(opts.agentLocale !== undefined ? { locale: opts.agentLocale } : {}), user: { name: 'IGNORED_AGENT_OVERRIDE' } };
  runtimeAgent._cb = { getUserName: () => prefs.getUserName(), getLocale: () => prefs.getLocale() };
  // Exercise both real constructor defaults and the loadConfigOnly/init resolution path.
  if (!opts.constructorDefault) runtimeAgent.userName = runtimeAgent.resolveUserName();
  const manager = {
    _agents: new Map([[agent.id, runtimeAgent]]),
    invalidateAgentListCache: vi.fn(), _rebuildAllAgentSystemPrompts: vi.fn(),
    refreshResolvedUserNames: AgentManager.prototype.refreshResolvedUserNames,
  };
  engine = {
    _prefs: prefs, _agentMgr: manager, agent: runtimeAgent,
    agentsDir, userDir, channelsDir: path.join(root, 'channels'),
    getUserName: Engine.prototype.getUserName, setUserName: Engine.prototype.setUserName,
    getLocale: Engine.prototype.getLocale, setLocale: Engine.prototype.setLocale,
    providerRegistry: { getAllProvidersRaw: () => ({}) }, emitEvent: vi.fn(),
    getAgent: (id: string) => [agent.id, 'peer'].includes(id) ? { id, name: '同名', agentDir: path.join(agentsDir, id) } : null,
    listAgents: () => [{ id: agent.id, name: '同名' }, { id: 'peer', name: '同名' }],
  } as unknown as typeof engine;
  Object.defineProperty(engine, 'userName', Object.getOwnPropertyDescriptor(Engine.prototype, 'userName')!);
  fs.mkdirSync(engine.channelsDir, { recursive: true });
  await createChannel(engine.channelsDir, { id: 'room', name: 'Synthetic', members: [agent.id, 'peer'] });
  app = new Hono();
  app.route('/api', createConfigRoute(engine));
  app.route('/api', createChannelsRoute(engine, { triggerChannelDelivery: () => Promise.resolve() }));
  app.route('/api', createXingyeRoute(engine));
  app.route('/api', createXingyeStorageRoute(engine));
  h.bridge = (url: string, init?: RequestInit) => app.request(url, init);
}
async function userSend() {
  const response = await app.request('/api/channels/ch_room/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: quote }) });
  expect(response.status).toBe(200);
  return rows().at(-1)!;
}
async function setName(name: unknown) {
  const res = await app.request('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: { name } }) });
  expect(res.status).toBe(200);
}
function expectPrompt(sender: string, timestamp: string) {
  const tag = sender === agent.id || sender === 'peer' || sender === 'system' ? '身份不明' : 'user 本人';
  const prompt = generated().at(-1)!.body.prompt;
  expect(prompt).toContain(`currentUserName=${sender}；`);
  expect(prompt).toContain(`[${sender}（${tag}） · ${timestamp}]\n${quote}`);
  expect(prompt.split('【你自己在本群最近说过的话')[1].split('【最近发生的事')[0]).not.toContain(quote);
  expect(generated().at(-1)!.body.agentId).toBe(agent.id);
}

const cases = [
  { label: 'missing preferences', sender: 'User', id: 'User' },
  { label: 'empty preferences', name: '', locale: '', sender: 'User', id: 'User' },
  { label: 'whitespace preferences', name: ' \t ', locale: ' \t ', sender: 'User', id: 'User' },
  { label: 'null preference', name: null, locale: 'en', sender: 'User', id: 'User' },
  { label: 'English fallback', name: '', locale: 'en', sender: 'User', id: 'User' },
  { label: 'simplified Chinese fallback', name: '', locale: 'zh-CN', sender: '用户' },
  { label: 'traditional Chinese fallback', name: ' ', locale: 'zh-TW', sender: '用户' },
  { label: 'Hong Kong Chinese fallback', locale: ' zh-HK ', sender: '用户' },
  { label: 'Japanese fallback', locale: 'ja', sender: 'User', id: 'User' },
  { label: 'Korean fallback', locale: 'ko', sender: 'User', id: 'User' },
  { label: 'runtime explicit locale over global Chinese', locale: 'zh-CN', agentLocale: 'en', sender: 'User', id: 'User' },
  { label: 'runtime explicit locale over global English', locale: 'en', agentLocale: 'zh-CN', sender: '用户' },
  { label: 'runtime constructor default before resolution', locale: 'zh-CN', constructorDefault: true, sender: 'User', id: 'User' },
  { label: 'explicit User is a name', name: 'User', locale: 'zh-CN', sender: 'User', id: 'User' },
  { label: 'explicit user is a name', name: 'user', locale: 'zh-CN', sender: 'user', id: 'user' },
  { label: 'explicit 用户 is a name', name: '用户', locale: 'en', sender: '用户' },
  { label: 'trimmed custom ID collision', name: ' role-17 ', locale: 'en', sender: 'role-17' },
  { label: 'display name does not become agent ID', name: ' 同名 ', locale: 'en', sender: '同名' },
  { label: 'peer ID collision', name: 'peer', locale: 'en', sender: 'peer' },
  { label: 'system collision', name: 'system', locale: 'en', sender: 'system', id: 'system' },
];

describe('PC01 channel user identity from production preferences/runtime through entry and prompt', () => {
  beforeEach(() => {
    const parent = process.env.HANAKO_HOME!; fs.mkdirSync(parent, { recursive: true });
    root = fs.mkdtempSync(path.join(parent, 'group-user-'));
    h.calls = []; h.bridge = null; h.afterConfig = null; h.configOverride = undefined;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    h.generate.mockReset().mockImplementation(() => { vi.setSystemTime(new Date(Date.now() + 2000)); return { ok: true, result: { decision: 'reply', reply: '合成回答 👩🏽‍💻' } }; });
    invalidateConfigCache();
    useStore.setState({ userName: 'WRONG_UI_NAME', serverPort: '17333', serverToken: 'synthetic', activeServerConnection: null, activeServerConnectionId: null, serverConnections: {} });
  });
  afterEach(() => { h.bridge = null; vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

  it.each(cases)('$label keeps the source, replies once and blocks its acknowledged self post', async ({ sender, ...opts }) => {
    await setup(opts); const source = await userSend();
    expect(source.sender).toBe(sender);
    const config = await (await app.request('/api/config')).json();
    expect(config.user.name).toBe(engine.getUserName());
    const original = fs.readFileSync(channelFile(), 'utf8');
    expect((await trigger()).status).toBe('replied'); expectPrompt(sender, source.timestamp);
    expect(generated()).toHaveLength(1); expect(posted()).toHaveLength(1);
    expect(h.calls.filter(c => c.path === '/api/config')).toHaveLength(1);
    expect(rows()[0]).toEqual(source); expect(fs.readFileSync(channelFile(), 'utf8').startsWith(original.trim())).toBe(true);
    expect((await trigger()).status).toBe('skipped'); expect((await trigger()).status).toBe('noop');
    expect(generated()).toHaveLength(1); expect(posted()).toHaveLength(1);
  });

  it.each(cases.filter(c => !c.constructorDefault))('standalone generator uses the same production identity: $label', async ({ sender, ...opts }) => {
    await setup(opts); const source = await userSend();
    await generateGroupChatReplyWithAI({ agent, channelId: 'ch_room', channelName: 'Synthetic', channelMembers: [agent.id, 'peer'], recentMessages: [source] });
    expectPrompt(sender, source.timestamp); expect(posted()).toHaveLength(0);
    expect(rows()).toEqual([source]); expect(fs.existsSync(runFile())).toBe(false);
  });

  it('uses the actual channel fallback when the runtime sender is temporarily empty', async () => {
    await setup({ name: 'ignored raw name', id: 'user' }); runtimeAgent.userName = '';
    const source = await userSend(); expect(source.sender).toBe('user');
    expect((await trigger()).status).toBe('replied'); expectPrompt('user', source.timestamp);
  });

  it('refreshes renamed users through real PUT/config and Engine/AgentManager without a stale config cache', async () => {
    await setup({ name: 'before' });
    for (const name of ['before', 'role-17', ' User ', '用户', '']) {
      await setName(name); const source = await userSend();
      expect((await trigger()).status).toBe('replied'); expectPrompt(engine.userName, source.timestamp);
    }
    expect(posted()).toHaveLength(5);
    expect(engine._agentMgr.invalidateAgentListCache).toHaveBeenCalledTimes(5);
    expect(rows().filter((_, i) => i % 2 === 0).map(r => r.sender)).toEqual(['before', 'role-17', 'User', '用户', 'User']);
  });

  it('keeps the entry identity snapshot when a config edit occurs after the identity response', async () => {
    await setup({ id: 'User' }); const source = await userSend();
    h.afterConfig = () => engine.setUserName('renamed after snapshot');
    expect((await trigger()).status).toBe('replied'); expectPrompt('User', source.timestamp);
    expect(h.calls.filter(c => c.path === '/api/config')).toHaveLength(1);
    expect(engine.userName).toBe('renamed after snapshot');
  });

  it.each(['visitor', 'user', '用户'])('does not treat a real User agent message as user when current user is %s', async name => {
    await setup({ name, id: 'User' });
    const res = await app.request('/api/xingye/group-chat/post-as-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: 'ch_room', agentId: agent.id, body: 'self' }) });
    expect(res.status).toBe(200);
    expect((await trigger()).status).toBe('skipped'); expect(generated()).toHaveLength(0);
  });

  it.each([{}, { user: { name: '' }, locale: 'zh-CN' }, { channelUserName: null, user: { name: 'User' } }, { channelUserName: 42 }, { channelUserName: '' }, { channelUserName: '   ' }])('refuses missing or malformed effective identity without a guessed skip: %j', async config => {
    await setup({ id: 'User' }); await userSend(); h.configOverride = config;
    expect((await trigger()).status).toBe('error'); expect(generated()).toHaveLength(0); expect(fs.existsSync(runFile())).toBe(false);
    h.configOverride = undefined; expect((await trigger()).status).toBe('replied');
  });

  it('keeps global settings readable before an agent exists and refuses a guessed sender', async () => {
    await setup(); engine.agent = undefined;
    const response = await app.request('/api/config'); expect(response.status).toBe(200);
    expect((await response.json()).channelUserName).toBeNull();
  });

  it('exposes a read-only effective sender separately from raw settings and rejects attempts to persist it', async () => {
    await setup({ locale: 'zh-CN' });
    const before = fs.readFileSync(path.join(root, 'user', 'preferences.json'), 'utf8');
    const config = await (await app.request('/api/config')).json();
    expect(config.user.name).toBe(''); expect(config.channelUserName).toBe('用户');
    const res = await app.request('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelUserName: 'spoofed', user: { name: 'also rejected' } }) });
    expect(res.status).toBe(400); expect(engine.userName).toBe('用户');
    expect(fs.readFileSync(path.join(root, 'user', 'preferences.json'), 'utf8')).toBe(before);
  });
});
