import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMcpOAuthAuthorization, discoverMcpOAuth } from "../core/mcp/clients/oauth.ts";
import { McpManager } from "../core/mcp/manager.ts";
import { createMcpRoute } from "../server/routes/mcp.ts";

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
  const token = vi.fn(() => jsonResponse({
    access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token", token_type: "Bearer",
  }));
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
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const manager = new McpManager({ dataDir: "/unused-in-memory", log }, {
    configStore: { get: () => stored, set: setConfig },
  });
  const app = new Hono();
  app.route("/api", createMcpRoute({ mcp: manager }));
  const insertSession = vi.spyOn(manager.oauthSessions, "set");
  const saveCredentials = vi.spyOn(manager, "saveConnectorOAuth");
  return { manager, app, log, fetchImpl, register, token, insertSession, saveCredentials,
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

const CAPABILITIES = [
  { name: "supported", value: true },
  { name: "unsupported", value: false },
  { name: "undeclared", value: undefined },
];
const CALLBACK_PATHS = ["/api/mcp/oauth/callback", "/api/plugins/mcp/oauth/callback"];
const CODE = "synthetic-authorization-code";
const MISSING_ISSUER = "OAuth authorization response issuer is missing";
const REPEATED_ISSUER = "OAuth authorization response issuer is repeated";
const WRONG_ISSUER = "OAuth authorization response issuer does not match";
const AUTHORIZATION_ERROR = "OAuth authorization failed";

function callbackQuery(state: string, response: string, values: string[]) {
  const query = new URLSearchParams({ state, code: CODE });
  if (response === "error") query.set("error", "access_denied");
  for (const value of values) query.append("iss", value);
  return query;
}

function expectNoCallbackEffects(f: ReturnType<typeof fixture>, fetchCount: number) {
  expect(f.fetchImpl).toHaveBeenCalledTimes(fetchCount);
  expect(f.token).not.toHaveBeenCalled();
  expect(f.saveCredentials).not.toHaveBeenCalled();
  expect(f.setConfig).not.toHaveBeenCalled();
  expect(f.getStored()).toEqual(f.before);
}

async function expectCallbackFailure(f: ReturnType<typeof fixture>, path: string, state: string,
  query: URLSearchParams | string, expected: string) {
  const fetchCount = f.fetchImpl.mock.calls.length;
  const response = await f.app.request(`${path}?${query}`);
  const page = await response.text();
  const poll = await f.app.request(`/api/mcp/oauth/poll/${state}`);
  const status = await poll.json();
  expectNoCallbackEffects(f, fetchCount);
  expect(response.status).toBe(400);
  expect(page).toContain("Connector OAuth failed");
  expect(page).toContain(expected);
  expect(status).toEqual({ status: "error", error: expected });
  const visible = JSON.stringify({ page, status, logs: Object.values(f.log).map((fn) => fn.mock.calls) });
  for (const secret of [CODE, state, "synthetic-access-token", "synthetic-refresh-token", `${path}?${query}`]) {
    expect(visible).not.toContain(secret);
  }
}

describe("MCP OAuth authorization response capability", () => {
  it.each(CAPABILITIES)("snapshots the original issuer and the $name capability", async ({ value }) => {
    const issuer = "https://AS.example:443/tenant/";
    const f = fixture({ issuer, metadata: { ...metadataFor(issuer), authorization_response_iss_parameter_supported: value } });
    const auth = await createMcpOAuthAuthorization({
      connector: { id: "synthetic", url: RESOURCE }, redirectUri: REDIRECT_URI,
    });
    expect(auth.session).toMatchObject({ issuer, authorizationResponseIssParameterSupported: value === true });
    // Later mutation of a discovery object must not change a pending session.
    auth.discovery.authorizationMetadata.issuer = "https://other.example";
    auth.discovery.authorizationMetadata.authorization_response_iss_parameter_supported = value !== true;
    expect(auth.session).toMatchObject({ issuer, authorizationResponseIssParameterSupported: value === true });
    expect(f.token).not.toHaveBeenCalled();
    expect(f.setConfig).not.toHaveBeenCalled();
  });

  describe.each([false, true])("manual client = %s", (manual) => {
    it.each([null, "true", "false", "", 0, 1, [], {}, [true]])("rejects an explicit non-boolean capability %j before DCR/session creation", async (value) => {
      const f = fixture({ manual, metadata: { ...metadataFor(ISSUER), authorization_response_iss_parameter_supported: value } });
      await expect(f.manager.startOAuth("synthetic", REDIRECT_URI)).rejects.toThrow(/authorization_response_iss_parameter_supported must be a boolean/);
      expectNoEffects(f);
      expect(f.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([RESOURCE, RESOURCE_METADATA, TENANT_URLS[0]]);
    });
  });
});

describe.each(CALLBACK_PATHS)("MCP OAuth issuer binding at %s", (path) => {
  describe.each(CAPABILITIES)("$name capability", ({ value }) => {
    describe.each(["success", "error"])("%s response", (response) => {
      it.each([
        { name: "missing", values: [], error: "" },
        { name: "exact", values: [ISSUER], error: "" },
        { name: "empty", values: [""], error: WRONG_ISSUER },
        { name: "wrong", values: ["https://other.example"], error: WRONG_ISSUER },
        { name: "identical duplicates", values: [ISSUER, ISSUER], error: REPEATED_ISSUER },
        { name: "correct then wrong", values: [ISSUER, "https://other.example"], error: REPEATED_ISSUER },
        { name: "wrong then correct", values: ["https://other.example", ISSUER], error: REPEATED_ISSUER },
        { name: "empty then correct", values: ["", ISSUER], error: REPEATED_ISSUER },
        { name: "both empty", values: ["", ""], error: REPEATED_ISSUER },
        { name: "host case", values: ["https://AS.example/tenant"], error: WRONG_ISSUER },
        { name: "scheme case", values: ["HTTPS://as.example/tenant"], error: WRONG_ISSUER },
        { name: "path case", values: ["https://as.example/Tenant"], error: WRONG_ISSUER },
        { name: "trailing slash", values: [`${ISSUER}/`], error: WRONG_ISSUER },
        { name: "default port", values: ["https://as.example:443/tenant"], error: WRONG_ISSUER },
        { name: "leading whitespace", values: [` ${ISSUER}`], error: WRONG_ISSUER },
        { name: "trailing whitespace", values: [`${ISSUER} `], error: WRONG_ISSUER },
        { name: "extra encoded layer", values: [encodeURIComponent(ISSUER)], error: WRONG_ISSUER },
        { name: "encoded path", values: ["https://as.example/%74enant"], error: WRONG_ISSUER },
      ])("handles $name iss without normalization or extra decoding", async (testCase) => {
        const f = fixture({ metadata: { ...metadataFor(ISSUER), authorization_response_iss_parameter_supported: value } });
        const auth = await f.manager.startOAuth("synthetic", REDIRECT_URI);
        const query = callbackQuery(auth.sessionId, response, testCase.values);
        const issuerError = testCase.error || (!testCase.values.length && value === true ? MISSING_ISSUER : "");
        if (issuerError || response === "error") {
          await expectCallbackFailure(f, path, auth.sessionId, query, issuerError || AUTHORIZATION_ERROR);
          return;
        }
        const fetchCount = f.fetchImpl.mock.calls.length;
        const result = await f.app.request(`${path}?${query}`);
        expect(result.status).toBe(200);
        expect(await result.text()).toContain("Connector connected");
        expect(f.manager.getOAuthStatus(auth.sessionId)).toEqual({ status: "done", result: { connectorId: "synthetic" } });
        expect(f.token).toHaveBeenCalledTimes(1);
        expect(f.saveCredentials).toHaveBeenCalledTimes(1);
        expect(f.setConfig).toHaveBeenCalledTimes(1);
        expect(f.getStored().connectors[0]).toMatchObject({ oauth: { accessToken: "synthetic-access-token" } });
        // The callback uses the session's endpoint and PKCE verifier; it never discovers again.
        expect(f.fetchImpl).toHaveBeenCalledTimes(fetchCount + 1);
        const [target, init] = f.fetchImpl.mock.calls.at(-1)!;
        expect(target).toBe("https://tokens.example/token");
        expect(init?.method).toBe("POST");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code")).toBe(CODE);
        expect(body.get("code_verifier")).toBe(f.manager.oauthSessions.get(auth.sessionId).codeVerifier);
        expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
      });
    });
  });

  it("preserves a noncanonical raw issuer and decodes the query exactly once with a manual client", async () => {
    const issuer = "https://AS.example:443/tenant/%2F/";
    const f = fixture({ issuer, manual: true,
      urls: ["https://as.example/.well-known/oauth-authorization-server/tenant/%2F"],
      metadata: { ...metadataFor(issuer), authorization_response_iss_parameter_supported: true },
    });
    const auth = await f.manager.startOAuth("synthetic", REDIRECT_URI);
    const result = await f.app.request(`${path}?${callbackQuery(auth.sessionId, "success", [issuer])}`);
    expect(result.status).toBe(200);
    expect(f.register).not.toHaveBeenCalled();
    expect(f.token).toHaveBeenCalledTimes(1);
    expect(f.getStored().connectors[0]).toMatchObject({ oauthClientId: "manual-client", oauth: { accessToken: "synthetic-access-token" } });
  });

  it.each(["success", "error"])("rejects bare iss and encoded duplicate keys on a %s response", async (response) => {
    for (const extra of ["&iss", `&iss=${encodeURIComponent(ISSUER)}&%69ss=${encodeURIComponent(ISSUER)}`]) {
      const f = fixture();
      const auth = await f.manager.startOAuth("synthetic", REDIRECT_URI);
      const query = `${callbackQuery(auth.sessionId, response, [])}${extra}`;
      await expectCallbackFailure(f, path, auth.sessionId, query, extra === "&iss" ? WRONG_ISSUER : REPEATED_ISSUER);
    }
  });

  it("does not reflect untrusted error, description, or issuer values", async () => {
    for (const validIssuer of [false, true]) {
      const f = fixture();
      const auth = await f.manager.startOAuth("synthetic", REDIRECT_URI);
      const secretUrl = `${REDIRECT_URI}?code=${CODE}&state=${auth.sessionId}&access_token=synthetic-access-token`;
      const query = callbackQuery(auth.sessionId, "error", [validIssuer ? ISSUER : secretUrl]);
      query.set("error", secretUrl);
      query.set("error_description", secretUrl);
      await expectCallbackFailure(f, path, auth.sessionId, query, validIssuer ? AUTHORIZATION_ERROR : WRONG_ISSUER);
    }
  });

  it.each(["success", "error"])("preserves unknown and cancelled state handling on a %s response", async (response) => {
    const f = fixture({ metadata: { ...metadataFor(ISSUER), authorization_response_iss_parameter_supported: true } });
    const auth = await f.manager.startOAuth("synthetic", REDIRECT_URI);
    f.manager.cancelOAuth("synthetic");
    const fetchCount = f.fetchImpl.mock.calls.length;
    for (const state of [auth.sessionId, "unknown-state"]) {
      for (const issValues of [[], [ISSUER], [""], ["https://other.example"], [ISSUER, ISSUER]]) {
        const result = await f.app.request(`${path}?${callbackQuery(state, response, issValues)}`);
        expect(result.status).toBe(400);
        const page = await result.text();
        expect(page).toContain(state === auth.sessionId ? "OAuth session was cancelled" : "OAuth session not found");
        expect(page).not.toContain(state);
        expect(page).not.toContain(CODE);
        expect(f.manager.getOAuthStatus(auth.sessionId)).toEqual({ status: "cancelled" });
        expect(f.manager.getOAuthStatus("unknown-state")).toEqual({ status: "missing" });
        expectNoCallbackEffects(f, fetchCount);
      }
    }
  });
});
