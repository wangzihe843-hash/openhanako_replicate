import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { createBridgeRoute } from '../server/routes/bridge.ts';
import { MASKED_SECRET } from '../shared/secret-custody.ts';

const base = 'https://ilinkai.weixin.qq.com';
const sessionId = 'synthetic-login-session-001';
const json = (body: unknown) => new Response(JSON.stringify(body));
function fixture(scopes = ['bridge.manage', 'secrets.write'], saved: Record<string, unknown> = {}) {
  type Agent = { id: string; config: { bridge: { wechat: Record<string, unknown> } }; updateConfig: (patch: { bridge: { wechat: Record<string, unknown> } }) => void };
  const agents: Record<string, Agent> = Object.fromEntries(['a', 'b'].map(id => [id, {
    id, config: { bridge: { wechat: { botToken: `SYN_${id}_TOKEN`, enabled: false, ...saved } } },
    updateConfig: vi.fn(function (this: Agent, patch: { bridge: { wechat: Record<string, unknown> } }) { Object.assign(this.config.bridge.wechat, patch.bridge.wechat); }),
  }]));
  const manager = { stopPlatform: vi.fn(), startPlatformFromConfig: vi.fn(), getStatus: () => ({}) };
  const app = new Hono<{ Variables: { authPrincipal: unknown } }>();
  app.use('*', async (c, next) => { c.set('authPrincipal', { principalId: c.req.header('test-owner') || 'owner', kind: 'device', scopes }); await next(); });
  app.route('/api', createBridgeRoute({ getAgent: id => agents[id] }, manager));
  const request = (route: string, body: object = {}, agent = 'a', owner = 'owner') => app.request(`/api/bridge/${route}${agent ? `?agentId=${agent}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'test-owner': owner }, body: JSON.stringify(body),
  });
  return { request, agents, manager };
}
afterEach(() => vi.unstubAllGlobals());

it('requires agent, bridge.manage and secrets.write for every QR operation before fetch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const scopes of [[], ['bridge.manage'], ['secrets.write']]) for (const action of ['qrcode', 'qrcode-status', 'qrcode-cancel']) {
    const f = fixture(scopes); expect((await f.request(`wechat/${action}`, { sessionId })).status).toBe(403);
  }
  const f = fixture(); expect((await f.request('wechat/qrcode', { sessionId }, '')).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});

it('binds QR/token list to one agent and principal and guards late saves after cancel', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json({ qrcode: 'qr', qrcode_img_content: 'synthetic' }))
    .mockResolvedValueOnce(json({ status: 'confirmed', bot_token: 'SYN_NEW_TOKEN', ilink_bot_id: 'bot', baseurl: base }));
  vi.stubGlobal('fetch', fetch); const f = fixture();
  const qr = await f.request('wechat/qrcode', { sessionId }); expect(qr.headers.get('cache-control')).toBe('no-store');
  expect(await qr.json()).toMatchObject({ ok: true, sessionId });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ local_token_list: ['SYN_a_TOKEN'] });
  expect(await (await f.request('wechat/qrcode-status', { sessionId }, 'b')).json()).toEqual({ status: 'expired' });
  expect(await (await f.request('wechat/qrcode-status', { sessionId }, 'a', 'other')).json()).toEqual({ status: 'expired' });
  const result = await (await f.request('wechat/qrcode-status', { sessionId })).json();
  expect(result.status).toBe('confirmed');
  await f.request('wechat/qrcode-cancel', { sessionId });
  expect((await f.request('config', { platform: 'wechat', loginSessionId: sessionId, credentials: { botToken: result.botToken, baseUrl: result.baseUrl }, enabled: true })).status).toBe(409);
  expect(f.agents.a.updateConfig).not.toHaveBeenCalled(); expect(f.manager.startPlatformFromConfig).not.toHaveBeenCalled();
});

it('saves a confirmed endpoint and uses the same destination for saved credential getconfig', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json({ qrcode: 'qr', qrcode_img_content: 'synthetic' }))
    .mockResolvedValueOnce(json({ status: 'confirmed', bot_token: 'SYN_NEW_TOKEN', ilink_bot_id: 'bot', baseurl: base + '/' }))
    .mockResolvedValueOnce(json({ ret: 0 })); vi.stubGlobal('fetch', fetch); const f = fixture();
  await f.request('wechat/qrcode', { sessionId });
  const result = await (await f.request('wechat/qrcode-status', { sessionId })).json();
  const saved = await f.request('config', { platform: 'wechat', loginSessionId: sessionId, credentials: { botToken: result.botToken, baseUrl: result.baseUrl }, enabled: true });
  expect((await saved.json()).ok).toBe(true);
  expect(f.agents.a.config.bridge.wechat).toMatchObject({ botToken: 'SYN_NEW_TOKEN', baseUrl: base });
  expect((await (await f.request('test', { platform: 'wechat', useSavedCredentials: true })).json()).ok).toBe(true);
  expect(fetch.mock.calls[2][0]).toBe(base + '/ilink/bot/getconfig');
  expect(fetch.mock.calls[2][1]).toMatchObject({ redirect: 'manual', headers: { Authorization: 'Bearer SYN_NEW_TOKEN' } });
  expect(f.agents.b.updateConfig).not.toHaveBeenCalled();
});

it('keeps credentials on already-bound responses and does not leak a token', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ qrcode: 'qr' })).mockResolvedValueOnce(json({ status: 'binded_redirect', bot_token: 'SYN_UNEXPECTED' })));
  const f = fixture(); await f.request('wechat/qrcode', { sessionId });
  expect(await (await f.request('wechat/qrcode-status', { sessionId })).json()).toEqual({ status: 'binded_redirect' });
  expect(f.agents.a.config.bridge.wechat.botToken).toBe('SYN_a_TOKEN'); expect(f.agents.a.updateConfig).not.toHaveBeenCalled();
});

it.each(['config', 'test'])('%s guards retained-token destination changes including omitted/masked credentials', async action => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const patch of [{ baseUrl: 'https://sink.invalid' }, { baseUrl: 'https://sink.invalid', botToken: MASKED_SECRET }]) {
    const f = fixture(['bridge.manage']);
    expect((await f.request(action, { platform: 'wechat', credentials: patch, useSavedCredentials: true })).status).toBe(403);
    expect(f.agents.a.updateConfig).not.toHaveBeenCalled();
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['config', 'test'])('%s rejects untrusted endpoints even with secret scope', async action => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const f = fixture();
  const result = await f.request(action, { platform: 'wechat', credentials: { baseUrl: 'https://sink.invalid', botToken: 'SYN_TOKEN' } });
  expect((await result.json()).ok).toBe(false); expect(fetch).not.toHaveBeenCalled(); expect(f.agents.a.updateConfig).not.toHaveBeenCalled();
});
