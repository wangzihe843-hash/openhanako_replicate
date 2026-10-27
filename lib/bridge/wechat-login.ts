/**
 * Hanako QR protocol adaptation. Reference: Tencent/openclaw-weixin 2.4.10,
 * c6643f6f0ac03574eb126f2d69569ea4267cc3c6, src/auth/login-qr.ts (MIT).
 * See lib/wechat-LICENSE.txt, also shipped in both server distributions.
 * No OpenClaw account store or host code is used.
 */
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { normalizeWechatBaseUrl, WECHAT_DEFAULT_BASE_URL, wechatRedirectBaseUrl } from '../../shared/wechat-endpoint.ts';
import { awaitWechatAbort, cancelWechatBody, readWechatBody, withWechatDeadline, WechatTransferError } from './wechat-media.ts';

export type WechatLoginResult = {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect' | 'error';
  botToken?: string; botId?: string; userId?: string; baseUrl?: string; error?: string;
};
const LOGIN_TTL = 5 * 60_000;
// Local safety budget, not a documented Tencent limit.
const MAX_VERIFY_ATTEMPTS = 3;

// 1 is the existing Hanako login adapter revision, not Tencent's plugin version.
// iLink-App-Id is deliberately omitted until an applicable Hanako identity is verified.
function loginHeaders(post: boolean): Record<string, string> {
  return {
    'iLink-App-ClientVersion': '1',
    ...(post ? {
      'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString('base64'),
    } : {}),
  };
}

async function requestLogin(url: string, body?: object, parent?: AbortSignal): Promise<Record<string, unknown>> {
  return withWechatDeadline(parent, body ? 15_000 : 40_000, async signal => {
    let res: Response | undefined;
    try {
      const request = fetch(url, {
        method: body ? 'POST' : 'GET', headers: loginHeaders(!!body),
        ...(body ? { body: JSON.stringify(body) } : {}), signal, redirect: 'manual',
      });
      void request.then(late => { if (signal.aborted) cancelWechatBody(late.body); }, () => {});
      res = await awaitWechatAbort(request, signal);
      signal.throwIfAborted();
      if (!res.ok) throw new Error('login_http_failure');
      const text = (await readWechatBody(res, 1024 * 1024, signal)).toString('utf8');
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || (data.ret !== undefined && data.ret !== 0)) throw new Error('login_invalid_response');
      return data;
    } finally {
      if (res && !res.bodyUsed && !res.body?.locked) cancelWechatBody(res.body);
    }
  });
}

export async function getWechatQrcode({ localTokenList = [], signal }: { localTokenList?: string[]; signal?: AbortSignal } = {}) {
  try {
    const data = await requestLogin(`${WECHAT_DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      local_token_list: [...new Set(localTokenList.filter(token => typeof token === 'string' && token.trim()).map(token => token.trim()))].slice(0, 10),
    }, signal);
    if (typeof data.qrcode !== 'string' || !data.qrcode || data.qrcode.length > 4096) throw new Error('missing_qrcode');
    const qrText = typeof data.qrcode_img_content === 'string' ? data.qrcode_img_content : data.qrcode;
    if (!qrText || qrText.length > 4096) throw new Error('invalid_qrcode');
    const qrcodeUrl = await QRCode.toDataURL(qrText, { width: 280, margin: 2 });
    signal?.throwIfAborted();
    return { ok: true, qrcodeUrl, qrcodeId: data.qrcode };
  } catch {
    // No upstream body/URL/error text: QR ids, verify codes and tokens are secrets.
    return { ok: false, error: 'wechat_qrcode_request_failed' };
  }
}

export async function pollWechatQrcodeStatus(qrcodeId: string, {
  baseUrl, verifyCode, signal,
}: { baseUrl?: string; verifyCode?: string; signal?: AbortSignal } = {}): Promise<WechatLoginResult> {
  try {
    if (typeof qrcodeId !== 'string' || !qrcodeId || qrcodeId.length > 4096) throw new Error('invalid_qrcode');
    if (verifyCode !== undefined && !/^\d{1,16}$/.test(verifyCode)) throw new Error('invalid_verify_code');
    const query = `qrcode=${encodeURIComponent(qrcodeId)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`;
    const data = await requestLogin(`${normalizeWechatBaseUrl(baseUrl)}/ilink/bot/get_qrcode_status?${query}`, undefined, signal);
    switch (data.status) {
      case 'wait': return { status: 'waiting' };
      case 'scaned': return { status: 'scanned' };
      case 'need_verifycode': case 'verify_code_blocked': case 'expired': case 'binded_redirect':
        return { status: data.status };
      case 'scaned_but_redirect':
        return { status: 'scaned_but_redirect', baseUrl: wechatRedirectBaseUrl(data.redirect_host) };
      case 'confirmed': {
        if (typeof data.bot_token !== 'string' || !data.bot_token.trim() || typeof data.ilink_bot_id !== 'string' || !data.ilink_bot_id) throw new Error('missing_credentials');
        return {
          status: 'confirmed', botToken: data.bot_token, botId: data.ilink_bot_id,
          ...(typeof data.ilink_user_id === 'string' ? { userId: data.ilink_user_id } : {}),
          baseUrl: normalizeWechatBaseUrl(data.baseurl),
        };
      }
      default: throw new Error('unknown_login_state');
    }
  } catch (err) {
    if (!verifyCode && !signal?.aborted && err instanceof WechatTransferError && err.code === 'timeout') return { status: 'waiting' };
    return { status: 'error', error: 'wechat_login_request_failed' };
  }
}

type Login = {
  agentId: string; owner: string; controller: AbortController; expires: number;
  qrcodeId?: string; baseUrl: string; attempts: number; redirects: number;
  busy: boolean; result: WechatLoginResult;
};

/** In-memory, per-route sessions; no credentials from other agents are collected. */
export class WechatLoginSessions {
  private sessions = new Map<string, Login>();

  private purge() {
    for (const [id, session] of this.sessions) {
      if (Date.now() >= session.expires) { session.controller.abort(); this.sessions.delete(id); }
    }
  }
  private current(id: string, agentId: string, owner: string) {
    this.purge();
    const session = this.sessions.get(id);
    return session?.agentId === agentId && session.owner === owner ? session : undefined;
  }
  cancel(id: string, agentId: string, owner: string) {
    const session = this.current(id, agentId, owner);
    if (session) { session.controller.abort(); this.sessions.delete(id); }
  }
  async start(id: string, agentId: string, owner: string, saved: { botToken?: string; baseUrl?: string } = {}) {
    this.purge();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(id) || this.sessions.has(id)) {
      return { ok: false, error: 'invalid_login_session' };
    }
    for (const [oldId, old] of this.sessions) {
      if (old.agentId === agentId && old.owner === owner) this.cancel(oldId, agentId, owner);
    }
    if (this.sessions.size >= 64) return { ok: false, error: 'login_session_limit' };
    const localTokenList = saved.botToken && normalizeWechatBaseUrl(saved.baseUrl) === WECHAT_DEFAULT_BASE_URL ? [saved.botToken] : [];
    const session: Login = {
      agentId, owner, controller: new AbortController(), expires: Date.now() + LOGIN_TTL,
      baseUrl: WECHAT_DEFAULT_BASE_URL, attempts: 0, redirects: 0, busy: true, result: { status: 'waiting' },
    };
    this.sessions.set(id, session);
    // A retained token is sent only to its verified original destination.
    const result = await getWechatQrcode({ localTokenList, signal: session.controller.signal });
    if (this.current(id, agentId, owner) !== session) return { ok: false, error: 'login_session_expired' };
    session.busy = false;
    if (!result.ok) { this.cancel(id, agentId, owner); return result; }
    session.qrcodeId = result.qrcodeId;
    return { ok: true, sessionId: id, qrcodeUrl: result.qrcodeUrl };
  }
  async poll(id: string, agentId: string, owner: string, verifyCode?: unknown): Promise<WechatLoginResult> {
    const session = this.current(id, agentId, owner);
    if (!session) return { status: 'expired' };
    if (session.busy || !session.qrcodeId) return { status: 'error', error: 'login_session_busy' };
    if (['confirmed', 'binded_redirect', 'verify_code_blocked', 'error', 'expired'].includes(session.result.status)) return session.result;
    if (verifyCode !== undefined) {
      if (session.result.status !== 'need_verifycode' || typeof verifyCode !== 'string' || !/^\d{1,16}$/.test(verifyCode)) {
        return { status: 'error', error: 'invalid_verify_code' };
      }
      if (++session.attempts > MAX_VERIFY_ATTEMPTS) return (session.result = { status: 'verify_code_blocked' });
    } else if (session.result.status === 'need_verifycode') return session.result;
    session.busy = true;
    try {
      const result = await pollWechatQrcodeStatus(session.qrcodeId, { baseUrl: session.baseUrl, verifyCode: verifyCode as string | undefined, signal: session.controller.signal });
      if (this.current(id, agentId, owner) !== session) return { status: 'expired' };
      if (result.status === 'scaned_but_redirect') {
        if (++session.redirects > 3) return (session.result = { status: 'error', error: 'login_redirect_limit' });
        session.baseUrl = result.baseUrl!;
      }
      if (result.status === 'need_verifycode' && session.attempts >= MAX_VERIFY_ATTEMPTS) return (session.result = { status: 'verify_code_blocked' });
      return (session.result = result);
    } finally { session.busy = false; }
  }
  consume(id: string, agentId: string, owner: string, credentials: { botToken?: string; baseUrl?: string }) {
    const session = this.current(id, agentId, owner);
    if (!session || session.result.status !== 'confirmed'
      || session.result.botToken !== credentials.botToken || session.result.baseUrl !== normalizeWechatBaseUrl(credentials.baseUrl)) return false;
    this.cancel(id, agentId, owner);
    return true;
  }
}
