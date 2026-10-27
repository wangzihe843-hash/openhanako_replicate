import type { Context } from 'hono';
import { normalizeWechatBaseUrl } from '../../shared/wechat-endpoint.ts';
import { denySecretMutationWithoutScope } from './capability-guard.ts';

type Config = { botToken?: unknown; baseUrl?: unknown } | null | undefined;
function destination(value: unknown) {
  try { return normalizeWechatBaseUrl(value); } catch { return value; }
}

/** A masked/omitted token cannot grant authority to move a retained secret. */
export function denyWechatDestinationChange(c: Context, saved: Config, effective: Config, prefix = 'credentials') {
  if (typeof saved?.botToken !== 'string' || !saved.botToken || effective?.botToken !== saved.botToken) return null;
  if (destination(saved.baseUrl) === destination(effective.baseUrl)) return null;
  return denySecretMutationWithoutScope(c, [`${prefix}.baseUrl`]);
}
