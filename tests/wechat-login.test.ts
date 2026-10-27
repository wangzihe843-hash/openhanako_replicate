import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWechatQrcode, pollWechatQrcodeStatus } from '../lib/bridge/wechat-login.ts';

const base = 'https://ilinkai.weixin.qq.com';
const json = (body: unknown) => new Response(JSON.stringify(body));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('WeChat fixed 2.4.10 login transport', () => {
  it('uses POST with an agent scoped token list and no bot Authorization or upstream app identity', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ qrcode: 'synthetic-qr', qrcode_img_content: 'synthetic-content' }));
    vi.stubGlobal('fetch', fetch);
    expect((await getWechatQrcode({ localTokenList: ['SYN_LOCAL_TOKEN'] })).ok).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(base + '/ilink/bot/get_bot_qrcode?bot_type=3');
    const init = fetch.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ local_token_list: ['SYN_LOCAL_TOKEN'] });
    expect(init.redirect).toBe('manual');
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['iLink-App-Id']).toBeUndefined();
    expect(init.headers['iLink-App-ClientVersion']).toBe('1');
    expect(init.headers.AuthorizationType).toBe('ilink_bot_token');
    expect(init.headers['X-WECHAT-UIN']).toBeTruthy();
  });
  it('encodes a verification code without adding authorization to status GET', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ status: 'scaned' })); vi.stubGlobal('fetch', fetch);
    expect(await pollWechatQrcodeStatus('synthetic qr', { verifyCode: '1234' })).toEqual({ status: 'scanned' });
    expect(fetch.mock.calls[0][0]).toBe(base + '/ilink/bot/get_qrcode_status?qrcode=synthetic%20qr&verify_code=1234');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it('rejects an untrusted confirmed baseUrl without returning its credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ status: 'confirmed', bot_token: 'SYN_PRIVATE_TOKEN', ilink_bot_id: 'bot', baseurl: 'https://attacker.invalid' })));
    const result = await pollWechatQrcodeStatus('qr');
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SYN_PRIVATE_TOKEN');
  });
  it('does not reflect server bodies or arbitrary errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('qrcode=SYN_PRIVATE_QR', { status: 500 })));
    expect(JSON.stringify(await getWechatQrcode())).not.toContain('SYN_PRIVATE_QR');
  });
});

import { WechatLoginSessions } from '../lib/bridge/wechat-login.ts';
import { normalizeWechatBaseUrl } from '../shared/wechat-endpoint.ts';
const loginId = 'synthetic-login-session-001';
const startResponse = () => json({ qrcode: 'qr', qrcode_img_content: 'synthetic-content' });

describe('trusted endpoints and all eight login states', () => {
  it.each([undefined, null, '', base, base + '/', 'https://ILINKAI.WEIXIN.QQ.COM:443/'])('defaults or canonicalizes %s', value => {
    expect(normalizeWechatBaseUrl(value)).toBe(base);
  });
  it.each(['http://ilinkai.weixin.qq.com', base + ':444', base + '/ilink', base + '/..', base + '?token=secret', base + '#x',
    'https://ilinkai.weixin.qq.com.attacker.invalid', 'https://evil.weixin.qq.com', 'https://user@ilinkai.weixin.qq.com',
    'https://127.0.0.1', 'https://[::1]', 'https://ilinkai.weixin.qq.com.', 3, {}, ' https://ilinkai.weixin.qq.com'])('rejects %s without transport', value => {
    expect(() => normalizeWechatBaseUrl(value)).toThrow('wechat_base_url_not_trusted');
  });
  it.each([
    ['wait', 'waiting'], ['scaned', 'scanned'], ['expired', 'expired'], ['need_verifycode', 'need_verifycode'],
    ['verify_code_blocked', 'verify_code_blocked'], ['binded_redirect', 'binded_redirect'],
  ])('maps %s and does not echo extra fields', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ status, bot_token: 'SYN_SECRET', arbitrary: 'SYN_EXTRA' })));
    expect(await pollWechatQrcodeStatus('qr')).toEqual({ status: expected });
  });
  it('validates a protocol redirect, then confirms with a canonical baseUrl', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(startResponse()).mockResolvedValueOnce(json({ status: 'scaned_but_redirect', redirect_host: 'ilinkai.weixin.qq.com' }))
      .mockResolvedValueOnce(json({ status: 'confirmed', bot_token: 'SYN_TOKEN', ilink_bot_id: 'bot', baseurl: base + '/' }));
    vi.stubGlobal('fetch', fetch);
    const sessions = new WechatLoginSessions(); await sessions.start(loginId, 'a', 'owner');
    expect(await sessions.poll(loginId, 'a', 'owner')).toMatchObject({ status: 'scaned_but_redirect', baseUrl: base });
    const confirmed = await sessions.poll(loginId, 'a', 'owner');
    expect(confirmed).toMatchObject({ status: 'confirmed', baseUrl: base, botToken: 'SYN_TOKEN' });
    expect(sessions.consume(loginId, 'b', 'owner', confirmed)).toBe(false);
    expect(sessions.consume(loginId, 'a', 'other', confirmed)).toBe(false);
    expect(sessions.consume(loginId, 'a', 'owner', confirmed)).toBe(true);
    expect(sessions.consume(loginId, 'a', 'owner', confirmed)).toBe(false);
  });
  it.each(['attacker.invalid', 'evil.weixin.qq.com', 'ilinkai.weixin.qq.com/path', 'ilinkai.weixin.qq.com:443', undefined])('rejects unverified redirect_host %s', async host => {
    const fetch = vi.fn().mockResolvedValue(json({ status: 'scaned_but_redirect', redirect_host: host })); vi.stubGlobal('fetch', fetch);
    expect(await pollWechatQrcodeStatus('qr')).toMatchObject({ status: 'error' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('caps verification attempts, pauses for input, and does not auto-replay codes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(startResponse()).mockImplementation(async () => json({ status: 'need_verifycode' })); vi.stubGlobal('fetch', fetch);
    const sessions = new WechatLoginSessions(); await sessions.start(loginId, 'a', 'owner');
    expect((await sessions.poll(loginId, 'a', 'owner', '1234')).status).toBe('error');
    expect((await sessions.poll(loginId, 'a', 'owner')).status).toBe('need_verifycode');
    await sessions.poll(loginId, 'a', 'owner'); expect(fetch).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 3; i++) expect((await sessions.poll(loginId, 'a', 'owner', '1234')).status).toBe(i === 2 ? 'verify_code_blocked' : 'need_verifycode');
    expect((await sessions.poll(loginId, 'a', 'owner', '5678')).status).toBe('verify_code_blocked');
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.slice(2).every(([url]) => String(url).endsWith('&verify_code=1234'))).toBe(true);
  });
  it('isolates agents and owners and cancels a pending status with zero credential results', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(startResponse()).mockImplementation(() => new Promise(() => {})); vi.stubGlobal('fetch', fetch);
    const sessions = new WechatLoginSessions(); await sessions.start(loginId, 'a', 'owner', { botToken: 'SYN_A_TOKEN' });
    expect((await sessions.poll(loginId, 'b', 'owner')).status).toBe('expired');
    expect((await sessions.poll(loginId, 'a', 'other')).status).toBe('expired');
    const pending = sessions.poll(loginId, 'a', 'owner');
    expect((await sessions.poll(loginId, 'a', 'owner')).error).toBe('login_session_busy');
    sessions.cancel(loginId, 'a', 'owner');
    expect(await pending).toEqual({ status: 'expired' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
  });
  it('expires without further outbound calls and rejects late QR acquisition after cancellation', async () => {
    vi.useFakeTimers(); const fetch = vi.fn().mockResolvedValueOnce(startResponse()).mockImplementation(() => new Promise(() => {})); vi.stubGlobal('fetch', fetch);
    const sessions = new WechatLoginSessions(); await sessions.start(loginId, 'a', 'owner');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await sessions.poll(loginId, 'a', 'owner')).toEqual({ status: 'expired' });
    const pending = sessions.start(loginId, 'a', 'owner'); sessions.cancel(loginId, 'a', 'owner');
    expect(await pending).toMatchObject({ ok: false });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects HTTP redirects, malformed/oversized responses and never includes secrets', async () => {
    for (const response of [new Response(null, { status: 307, headers: { location: 'https://sink.invalid' } }),
      new Response('SYN_BROKEN_JSON'), new Response('x'.repeat(1024 * 1024 + 1))]) {
      const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetch);
      expect(await pollWechatQrcodeStatus('qr')).toEqual({ status: 'error', error: 'wechat_login_request_failed' });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
});
