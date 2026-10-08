import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOutboundProxyRuntime,
  getNodeProxyAgentForUrl,
  telegramBotOptions,
  webSocketOptionsForUrl,
} from "../lib/net/outbound-proxy.ts";

const runtime = createOutboundProxyRuntime({ env: {}, log: () => {}, warn: () => {} });
const target = "https://remote.invalid/data";

afterEach(() => {
  runtime.reset();
  vi.unstubAllEnvs();
});

describe("Node outbound proxy policy", () => {
  it.each(["pac+ftp://untrusted.invalid/proxy.pac", "http://untrusted.invalid:8080"])(
    "uses the configured proxy instead of inherited %s", async inherited => {
      vi.stubEnv("https_proxy", inherited);
      runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:7890", noProxy: "" });
      const env = {};
      const agent = getNodeProxyAgentForUrl(target, env);
      expect(await agent.getProxyForUrl(target, undefined)).toBe("http://127.0.0.1:7890");
      expect(getNodeProxyAgentForUrl(target, env)).toBe(agent);
    },
  );

  it("re-evaluates redirects for noProxy, loopback and scheme-specific routing", async () => {
    runtime.apply({
      mode: "manual", httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "socks5://127.0.0.1:1080", wssProxy: "http://127.0.0.1:7891",
      noProxy: ".internal.invalid",
    });
    const agent = getNodeProxyAgentForUrl(target, {});
    expect(await agent.getProxyForUrl("http://127.9.8.7/private", undefined)).toBe("");
    expect(await agent.getProxyForUrl("https://service.internal.invalid/private", undefined)).toBe("");
    expect(await agent.getProxyForUrl("http://remote.invalid", undefined)).toBe("http://127.0.0.1:7890");
    expect(await agent.getProxyForUrl("wss://remote.invalid/socket", undefined)).toBe("http://127.0.0.1:7891");
  });

  it("keeps distinct environment policies separate when they share a proxy URL", async () => {
    runtime.apply({ mode: "system" });
    const first = getNodeProxyAgentForUrl(target, { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "first.invalid" });
    const second = getNodeProxyAgentForUrl(target, { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "second.invalid" });
    expect(await first.getProxyForUrl("https://first.invalid", undefined)).toBe("");
    expect(await second.getProxyForUrl("https://first.invalid", undefined)).toBe("http://127.0.0.1:7890");
    expect(await second.getProxyForUrl("https://second.invalid", undefined)).toBe("");
  });

  it("rejects PAC and FTP environment proxies before creating an agent", () => {
    runtime.apply({ mode: "system" });
    for (const proxy of ["pac+http://untrusted.invalid/pac", "pac+ftp://untrusted.invalid/pac", "ftp://untrusted.invalid"]) {
      expect(getNodeProxyAgentForUrl(target, { HTTPS_PROXY: proxy })).toBeNull();
    }
  });

  it("routes WebSocket and Telegram agents through the same policy", async () => {
    vi.stubEnv("https_proxy", "pac+ftp://untrusted.invalid/proxy.pac");
    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:7890" });
    const ws = webSocketOptionsForUrl("wss://remote.invalid/socket");
    const telegram = telegramBotOptions({ polling: true, request: { timeout: 5000 } });
    expect(await ws.agent.getProxyForUrl("wss://remote.invalid/socket", undefined)).toBe("http://127.0.0.1:7890");
    expect(await telegram.request.agent.getProxyForUrl(target, undefined)).toBe("http://127.0.0.1:7890");
    expect(telegram).toMatchObject({ polling: true, request: { timeout: 5000, proxy: false } });
  });

  it("disables Telegram request's independent environment routing in direct mode", async () => {
    vi.stubEnv("https_proxy", "http://untrusted.invalid:8080");
    runtime.apply({ mode: "direct" });
    expect(webSocketOptionsForUrl("wss://remote.invalid")).toEqual({});
    const options = telegramBotOptions({ request: { timeout: 5000 } });
    expect(options.request.proxy).toBe(false);
    expect(await options.request.agent.getProxyForUrl(target, undefined)).toBe("");
    expect(options.request.timeout).toBe(5000);
  });

  it.each(["direct", "manual"])("updates retained Telegram agents after starting in %s mode", async mode => {
    runtime.apply(mode === "direct" ? { mode } : { mode, httpsProxy: "http://127.0.0.1:7890" });
    const options = telegramBotOptions().request;
    expect(options.agent).toBeDefined();
    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:7891" });
    expect(await options.agent.getProxyForUrl(target, undefined)).toBe("http://127.0.0.1:7891");
    runtime.apply({ mode: "direct" });
    expect(await options.agent.getProxyForUrl(target, undefined)).toBe("");
  });
});
