import { useStore } from '../stores';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  requireServerConnection,
} from '../services/server-connection';

const DEFAULT_TIMEOUT = 30_000;

/**
 * 构建带认证的 Hana Server URL
 */
export function hanaUrl(path: string): string {
  const connection = requireServerConnection(
    useStore.getState(),
    `hanaUrl ${path}: server connection not ready`,
  );
  return buildConnectionUrl(connection, path, { includeTokenQuery: true });
}

/**
 * 带认证的 fetch 封装（**不抛错**版本，非 2xx 不会 throw，调用方自行检查 `res.ok`/body）。
 * 用于需要读取服务端错误信封（`{ ok: false, error }`）的场景。
 */
export async function hanaFetchAllowingErrors(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const connection = requireServerConnection(
    useStore.getState(),
    `hanaFetch ${path}: server connection not ready`,
  );
  const headers = appendConnectionAuth(connection, opts.headers);

  const { timeout = DEFAULT_TIMEOUT, signal: callerSignal, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(buildConnectionUrl(connection, path), {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带认证的 fetch 封装
 * - 默认 30s 超时
 * - 默认校验 res.ok，非 2xx 抛错；传 `throwOnHttpError: false` 可禁用以读取错误体
 */
export async function hanaFetch(
  path: string,
  opts: RequestInit & { timeout?: number; throwOnHttpError?: boolean } = {},
): Promise<Response> {
  const { throwOnHttpError = true, ...rest } = opts;
  const res = await hanaFetchAllowingErrors(path, rest);
  if (throwOnHttpError && !res.ok) {
    throw new Error(`hanaFetch ${path}: ${res.status} ${res.statusText}`);
  }
  return res;
}
