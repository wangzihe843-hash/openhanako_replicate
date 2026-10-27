/** Fixed protocol reference: Tencent/openclaw-weixin c6643f6 (2.4.10).
 * Only the documented default host is verified for this integration. An IDC
 * hostname must gain explicit provenance before joining this credential boundary.
 */
export const WECHAT_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

export function normalizeWechatBaseUrl(value?: unknown): string {
  if (value === undefined || value === null || value === '') return WECHAT_DEFAULT_BASE_URL;
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(value)) {
    throw new Error('wechat_base_url_not_trusted');
  }
  const url = new URL(value);
  if (url.origin !== WECHAT_DEFAULT_BASE_URL) throw new Error('wechat_base_url_not_trusted');
  return url.origin;
}

export function wechatRedirectBaseUrl(host: unknown): string {
  if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error('wechat_redirect_host_not_trusted');
  }
  return normalizeWechatBaseUrl(`https://${host}`);
}
