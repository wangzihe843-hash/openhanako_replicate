import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverMcpOAuth } from "../core/mcp/clients/oauth.ts";
import { McpManager } from "../core/mcp/manager.ts";

const ISSUER = "https://as.example/tenant";
const RESOURCE = "https://mcp.example/mcp";
const RESOURCE_METADATA = "https://mcp.example/resource-metadata";
const REDIRECT_URI = "http://127.0.0.1:3210/api/mcp/oauth/callback";
const ROOT_URLS = [
  "https://as.example/.well-known/oauth-authorization-server",
  "https://as.example/.well-known/openid-configuration",
];
const TENANT_URLS = [
  "https://as.example/.well-known/oauth-authorization-server/tenant",
  "https://as.example/.well-known/openid-configuration/tenant",
  "https://as.example/tenant/.well-known/openid-configuration",
];
const DISCOVERY_CASES = [
  { name: "root OAuth", issuer: "https://as.example", urls: ROOT_URLS, index: 0 },
  { name: "root OIDC", issuer: "https://as.example", urls: ROOT_URLS, index: 1 },
  { name: "tenant OAuth", issuer: ISSUER, urls: TENANT_URLS, index: 0 },
  { name: "tenant OIDC insertion", issuer: ISSUER, urls: TENANT_URLS, index: 1 },
  { name: "tenant OIDC appending", issuer: ISSUER, urls: TENANT_URLS, index: 2 },
];

function metadataFor(issuer: unknown) {
  return {
    issuer,
    // Valid endpoints need not share the issuer's origin.
    authorization_endpoint: "https://login.example/authorize",
    token_endpoint: "https://tokens.example/token",
    registration_endpoint: "https://registration.example/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["files:read", "offline_access"],
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function fixture({ issuer = ISSUER, urls = TENANT_URLS, index = 0,
  metadata = metadataFor(issuer), manual = false, escapedJson = false }: {
    issuer?: string;
    urls?: string[];
    index?: number;
    metadata?: unknown;
    manual?: boolean;
    escapedJson?: boolean;
  } = {}) {
  let stored = { enabled: true, connectors: [{
    id: "synthetic", url: RESOURCE, authType: "oauth",
    oauthClientId: manual ? "manual-client" : "",
  }] };
  const before = structuredClone(stored);
  const setConfig = vi.fn((_key, value) => { stored = value; });
  const register = vi.fn(() => jsonResponse({ client_id: "synthetic-client" }));
  const token = vi.fn(() => { throw new Error("Unexpected token request during discovery"); });
  const fetchImpl = vi.fn(async (url, _init?: RequestInit) => {
    const target = String(url);
    if (target === RESOURCE) return new Response("", {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA}", scope="files:read"` },
    });
    if (target === RESOURCE_METADATA) return jsonResponse({
      authorization_servers: [null, 7, "", issuer, "https://unused.example"],
    });
    const candidate = urls.indexOf(target);
    if (candidate >= 0) {
      if (candidate < index) return new Response("", { status: 404 });
      // A later valid document must not hide a successful but invalid response.
      const body = candidate === index ? metadata : metadataFor(issuer);
      return escapedJson
        ? new Response(JSON.stringify(body).replaceAll("/", "\\/"))
        : jsonResponse(body);
    }
    if (target === "https://registration.example/register") return register();
    if (target === "https://tokens.example/token") return token();
    throw new Error(`Unexpected fetch blocked: ${target}`);
  });
  // Exercise the same default-fetch seam used by Engine; no real network calls.
  vi.stubGlobal("fetch", fetchImpl);
  const manager = new McpManager({ dataDir: "/unused-in-memory", log: console }, {
    configStore: { get: () => stored, set: setConfig },
  });
  const insertSession = vi.spyOn(manager.oauthSessions, "set");
  const saveCredentials = vi.spyOn(manager, "saveConnectorOAuth");
  return { manager, fetchImpl, register, token, insertSession, saveCredentials,
    setConfig, before, getStored: () => stored };
}

function expectNoEffects(f: ReturnType<typeof fixture>) {
  expect(f.register).not.toHaveBeenCalled();
  expect(f.insertSession).not.toHaveBeenCalled();
  expect(f.manager.oauthSessions.size).toBe(0);
  expect(f.token).not.toHaveBeenCalled();
  expect(f.saveCredentials).not.toHaveBeenCalled();
  expect(f.setConfig).not.toHaveBeenCalled();
  expect(f.getStored()).toEqual(f.before);
}

afterEach(() => vi.unstubAllGlobals());

describe("MCP OAuth metadata issuer validation", () => {
  it.each(DISCOVERY_CASES)("rejects a mismatched issuer at $name before DCR or session creation", async (discovery) => {
    const f = fixture({ ...discovery, metadata: metadataFor("https://other.example") });
    await expect(f.manager.startOAuth("synthetic", REDIRECT_URI)).rejects.toThrow(/metadata issuer/i);
    expectNoEffects(f);
    expect(f.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      RESOURCE, RESOURCE_METADATA, ...discovery.urls.slice(0, discovery.index + 1),
    ]);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["null", null],
    ["number", 7],
    ["boolean", true],
    ["array", [ISSUER]],
    ["object", { issuer: ISSUER }],
    ["same-origin different tenant", "https://as.example/other"],
    ["trailing slash", `${ISSUER}/`],
    ["surrounding whitespace", ` ${ISSUER} `],
    ["URL-equivalent host case", "https://AS.example/tenant"],
    ["URL-equivalent explicit port", "https://as.example:443/tenant"],
    ["encoded path", "https://as.example/%74enant"],
  ])("rejects %s issuer even with a manual client", async (_label, issuer) => {
    const f = fixture({ metadata: metadataFor(issuer), manual: true });
    await expect(f.manager.startOAuth("synthetic", REDIRECT_URI)).rejects.toThrow(/metadata issuer/i);
    expectNoEffects(f);
  });

  it.each([null, "metadata", 7, [metadataFor(ISSUER)]])("rejects malformed metadata %j at the public discovery boundary", async (metadata) => {
    const f = fixture({ metadata });
    await expect(discoverMcpOAuth({ connectorUrl: RESOURCE })).rejects.toThrow(/metadata issuer/i);
    expectNoEffects(f);
  });

  it("compares against the original selected issuer, not the serialized discovery URL", async () => {
    const f = fixture({ issuer: "https://AS.example:443/tenant/", metadata: metadataFor(ISSUER) });
    await expect(f.manager.startOAuth("synthetic", REDIRECT_URI)).rejects.toThrow(/metadata issuer/i);
    expectNoEffects(f);
  });

  it.each(["authorization_endpoint", "token_endpoint"])("still rejects exact-issuer metadata missing %s", async (endpoint) => {
    const f = fixture({ metadata: { ...metadataFor(ISSUER), [endpoint]: undefined } });
    await expect(f.manager.startOAuth("synthetic", REDIRECT_URI)).rejects.toThrow(/missing authorization_endpoint or token_endpoint/);
    expectNoEffects(f);
  });

  it.each(DISCOVERY_CASES)("accepts an exact issuer at $name with PKCE, state, DCR and offline_access", async (discovery) => {
    const f = fixture(discovery);
    const result = await f.manager.startOAuth("synthetic", REDIRECT_URI);
    const session = f.manager.oauthSessions.get(result.sessionId);
    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe("https://login.example/authorize");
    expect(url.searchParams.get("client_id")).toBe("synthetic-client");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("resource")).toBe(RESOURCE);
    expect(url.searchParams.get("scope")).toBe("files:read offline_access");
    expect(url.searchParams.get("state")).toBe(session.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      crypto.createHash("sha256").update(session.codeVerifier).digest("base64url"),
    );
    expect(session).toMatchObject({ status: "pending", clientIdSource: "dcr", tokenEndpoint: "https://tokens.example/token" });
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.insertSession).toHaveBeenCalledTimes(1);
    expect(f.token).not.toHaveBeenCalled();
    expect(f.saveCredentials).not.toHaveBeenCalled();
    expect(f.setConfig).not.toHaveBeenCalled();
    expect(f.getStored()).toEqual(f.before);
    expect(f.fetchImpl.mock.calls.map(([target]) => String(target))).toEqual([
      RESOURCE, RESOURCE_METADATA, ...discovery.urls.slice(0, discovery.index + 1),
      "https://registration.example/register",
    ]);
  });

  it("accepts JSON-escaped exact issuer strings and preserves manual-client priority", async () => {
    const f = fixture({ issuer: "https://AS.example:443/tenant/", manual: true, escapedJson: true });
    const result = await f.manager.startOAuth("synthetic", REDIRECT_URI);
    expect(new URL(result.url).searchParams.get("client_id")).toBe("manual-client");
    expect(f.register).not.toHaveBeenCalled();
    expect(f.insertSession).toHaveBeenCalledTimes(1);
    expect(f.manager.oauthSessions.get(result.sessionId).clientIdSource).toBe("manual");
    expect(f.setConfig).not.toHaveBeenCalled();
    expect(f.getStored()).toEqual(f.before);
  });
});
