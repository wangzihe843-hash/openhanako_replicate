// lib/net/outbound-proxy.ts

import {
  Agent as UndiciAgent,
  ProxyAgent as UndiciProxyAgent,
  Socks5ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import {
  normalizeNetworkProxyConfig,
  proxyConfigFromEnvironment,
  resolveProxyForUrl,
} from "../../shared/network-proxy.ts";

const originalGlobalDispatcher = getGlobalDispatcher();
let currentConfig = normalizeNetworkProxyConfig(undefined);
let currentDispatcher: any = null;
const nodeProxyAgentCache = new Map<NodeJS.ProcessEnv, NodeProxyAgent>();
let undiciProxyDispatcherCache: Map<string, any> = new Map();

function proxyProtocol(proxyUrl: any) {
  try {
    return new URL(proxyUrl).protocol;
  } catch {
    return "";
  }
}

function createUndiciProxyDispatcher(proxyUrl: any) {
  const protocol = proxyProtocol(proxyUrl);
  if (protocol === "http:" || protocol === "https:") {
    return new UndiciProxyAgent(proxyUrl);
  }
  if (protocol === "socks:" || protocol === "socks5:") {
    return new Socks5ProxyAgent(proxyUrl);
  }
  throw new Error(`unsupported proxy protocol: ${protocol || "(unknown)"}`);
}

function collectUnique(values: any[]) {
  return [...new Set(values.filter(Boolean))];
}

function buildEffectiveProxyConfig(config: any, env: any) {
  const normalized = normalizeNetworkProxyConfig(config);
  if (normalized.mode === "system") return proxyConfigFromEnvironment(env);
  return normalized;
}

function hasUsableProxy(config: any) {
  return !!(config.httpProxy || config.httpsProxy || config.wsProxy || config.wssProxy);
}

function createGlobalDispatcher(config: any, env = process.env) {
  const effective = buildEffectiveProxyConfig(config, env);
  if (effective.mode === "direct" || !hasUsableProxy(effective)) return null;

  const direct = new UndiciAgent();
  const proxyUrls = collectUnique([effective.httpProxy, effective.httpsProxy]);
  const proxyDispatchers = new Map(proxyUrls.map(url => [url, createUndiciProxyDispatcher(url)]));

  return {
    dispatch(opts: any, handler: any) {
      const origin = opts?.origin ? String(opts.origin) : "";
      const proxyUrl = origin ? resolveProxyForUrl(origin, effective, env) : "";
      const dispatcher = proxyUrl ? proxyDispatchers.get(proxyUrl) : null;
      return (dispatcher || direct).dispatch(opts, handler);
    },
    async close() {
      await Promise.allSettled([
        direct.close?.(),
        ...[...proxyDispatchers.values()].map(dispatcher => dispatcher.close?.()),
      ]);
    },
    destroy(err: any) {
      direct.destroy?.(err);
      for (const dispatcher of proxyDispatchers.values()) {
        dispatcher.destroy?.(err);
      }
    },
  };
}

function resetNodeProxyAgentCache(retainAgents = false) {
  for (const agent of nodeProxyAgentCache.values()) {
    agent.cache.clear();
    agent.httpAgent.destroy();
    agent.httpsAgent.destroy();
    agent.destroy();
  }
  if (!retainAgents) nodeProxyAgentCache.clear();
}

function resetUndiciProxyDispatcherCache() {
  for (const dispatcher of undiciProxyDispatcherCache.values()) {
    closeDispatcher(dispatcher);
  }
  undiciProxyDispatcherCache = new Map();
}

function closeDispatcher(dispatcher: any) {
  if (!dispatcher) return;
  try {
    dispatcher.close?.().catch?.(() => {});
  } catch {}
}

function describeProxyMode(config: any, env = process.env) {
  const effective = buildEffectiveProxyConfig(config, env);
  if (config.mode === "system") {
    return hasUsableProxy(effective) ? "system-env" : "system";
  }
  return config.mode;
}

export function createOutboundProxyRuntime({ log = (..._args: any[]) => {}, warn = (..._args: any[]) => {}, env = process.env }: { log?: (...args: any[]) => void; warn?: (...args: any[]) => void; env?: any } = {}) {
  return {
    apply(config: any) {
      const normalized = normalizeNetworkProxyConfig(config, { strict: true });
      const nextDispatcher = createGlobalDispatcher(normalized, env);
      closeDispatcher(currentDispatcher);
      resetNodeProxyAgentCache(true);
      resetUndiciProxyDispatcherCache();
      currentConfig = normalized;
      currentDispatcher = nextDispatcher;
      setGlobalDispatcher((nextDispatcher || originalGlobalDispatcher) as any);
      const modeDesc = describeProxyMode(normalized, env);
      log(`[proxy] outbound mode=${modeDesc}`);
      if (modeDesc === "system-env") {
        const effective = buildEffectiveProxyConfig(normalized, env);
        const proxyAddr = effective.httpsProxy || effective.httpProxy || effective.wsProxy || "";
        warn(
          `[proxy] 出站流量正经由系统代理 ${proxyAddr}；若需直连，请在设置 > 网络中切换为「直连」模式。` +
          ` (Outbound is routed via system proxy ${proxyAddr}; switch to "direct" in Settings > Network to bypass it.)`
        );
      }
      return normalized;
    },
    getConfig() {
      return currentConfig;
    },
    reset() {
      closeDispatcher(currentDispatcher);
      resetNodeProxyAgentCache();
      resetUndiciProxyDispatcherCache();
      currentConfig = normalizeNetworkProxyConfig(undefined);
      currentDispatcher = null;
      setGlobalDispatcher(originalGlobalDispatcher);
    },
  };
}

export function getOutboundProxyConfig() {
  return currentConfig;
}

function getNodeProxyAgent(env = process.env) {
  let agent = nodeProxyAgentCache.get(env);
  if (!agent) {
    // proxy-agent 6 takes options, not a URL. Resolve every actual request
    // (including redirects) through our validated policy, never its raw env fallback.
    agent = new NodeProxyAgent({
      getProxyForUrl: url => resolveProxyForUrl(url, buildEffectiveProxyConfig(currentConfig, env), {}),
    });
    nodeProxyAgentCache.set(env, agent);
  }
  return agent;
}

export function getNodeProxyAgentForUrl(targetUrl, env = process.env) {
  const effective = buildEffectiveProxyConfig(currentConfig, env);
  return resolveProxyForUrl(targetUrl, effective, {}) ? getNodeProxyAgent(env) : null;
}

/**
 * npm undici fetch 用的 per-URL 代理 dispatcher（与 WS 的 webSocketOptionsForUrl
 * 共享同一份 apply() 注入的代理配置）。
 *
 * 为什么不依赖 setGlobalDispatcher：Node 内建 fetch 与 npm undici 是两份拷贝，
 * 内建 fetch 不读取 npm 拷贝的 global dispatcher registry（Node v24 实测），
 * 上面 apply() 设置的 global dispatcher 只对 npm undici 的 fetch/request 生效。
 * 任何需要走代理的出站 fetch 必须显式拿这里的 dispatcher，并配合 npm undici
 * 的 fetch 使用（同一拷贝，dispatcher 契约锁定）。
 */
export function fetchDispatcherForUrl(targetUrl: any, env = process.env) {
  const proxyUrl = resolveProxyForUrl(targetUrl, currentConfig, env);
  if (!proxyUrl) return { dispatcher: null, proxyUrl: "" };
  let dispatcher = undiciProxyDispatcherCache.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = createUndiciProxyDispatcher(proxyUrl);
    undiciProxyDispatcherCache.set(proxyUrl, dispatcher);
  }
  return { dispatcher, proxyUrl };
}

export function webSocketOptionsForUrl(targetUrl: any) {
  const agent = getNodeProxyAgentForUrl(targetUrl);
  return agent ? { agent } : {};
}

export function telegramBotOptions(baseOptions: any = {}) {
  // Telegram retains these options for its lifetime, including direct -> proxy switches.
  const agent = getNodeProxyAgent();
  return {
    ...baseOptions,
    request: {
      ...(baseOptions.request || {}),
      // request otherwise resolves raw proxy environment variables before using
      // the agent, overriding both manual routing and explicit direct mode.
      proxy: false,
      agent,
    },
  };
}
