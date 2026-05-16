const AUTHENTICATED_ONLY = Object.freeze({ kind: "authenticated" });
const LOCAL_ONLY = Object.freeze({ kind: "local_only" });
const PUBLIC = Object.freeze({ kind: "public" });

export function authorizeHttpRoute({ method, path, principal }) {
  const policy = classifyHttpRoute({ method, path });
  if (policy.kind === "public") {
    return allowed(policy);
  }
  if (isLocalOwnerPrincipal(principal)) {
    return allowed(policy);
  }
  if (policy.kind === "local_only") {
    return denied("local_only_route", 403, policy);
  }
  if (policy.kind === "authenticated") {
    return principal ? allowed(policy) : denied("forbidden", 403, policy);
  }
  if (!principal) {
    return denied("forbidden", 403, policy);
  }
  const scopes = Array.isArray(principal.scopes) ? principal.scopes : [];
  const required = policy.scope;
  if (scopeAllows(scopes, required)) {
    return allowed(policy);
  }
  return denied("insufficient_scope", 403, policy);
}

export function classifyHttpRoute({ method = "GET", path = "" } = {}) {
  const verb = String(method || "GET").toUpperCase();
  const routePath = normalizePath(path);

  if (isMobileStaticRoute(verb, routePath)) return PUBLIC;
  if (isWebAuthBootstrapRoute(verb, routePath)) return PUBLIC;

  if (routePath === "/api/health") return AUTHENTICATED_ONLY;
  if (routePath === "/api/server/identity") return AUTHENTICATED_ONLY;

  if (routePath === "/ws") return scoped("chat");
  if (routePath === "/api/mobile/workbench/files" || routePath === "/api/mobile/workbench/search") {
    return verb === "GET" ? scoped("files.read") : LOCAL_ONLY;
  }
  if (routePath === "/api/mobile/workbench/content") {
    return (verb === "GET" || verb === "HEAD") ? scoped("files.read") : LOCAL_ONLY;
  }
  if (
    routePath === "/api/mobile/workbench/actions"
    || routePath === "/api/mobile/workbench/upload"
  ) {
    return verb === "POST" ? scoped("files.write") : LOCAL_ONLY;
  }
  if (isSettingsReadRoute(verb, routePath)) return scoped("settings.read");
  if (isSettingsWriteRoute(verb, routePath)) return scoped("settings.write");
  if (isProviderManagementRoute(verb, routePath)) return scoped("providers.manage");
  if (isBridgeManagementRoute(verb, routePath)) return scoped("bridge.manage");
  if (routePath.startsWith("/api/resources/")) {
    if (verb === "GET" || verb === "HEAD") return scoped("resources.read");
    return scoped("resources.write");
  }
  if (routePath === "/api/sessions" || routePath.startsWith("/api/sessions/")) {
    return scoped("chat");
  }
  if (routePath === "/api/chat" || routePath.startsWith("/api/chat/")) {
    return scoped("chat");
  }
  if (
    routePath === "/api/channels"
    || routePath.startsWith("/api/channels/")
    || routePath.startsWith("/api/conversations/")
    || routePath === "/api/dm"
    || routePath.startsWith("/api/dm/")
  ) {
    return scoped("chat");
  }

  return LOCAL_ONLY;
}

export function isPublicHttpRoute({ method = "GET", path = "" } = {}) {
  return classifyHttpRoute({ method, path }).kind === "public";
}

export function isLocalOwnerPrincipal(principal) {
  if (!principal || typeof principal !== "object") return false;
  return principal.kind === "local_user"
    && principal.connectionKind === "local"
    && principal.credentialKind === "loopback_token";
}

function scoped(scope) {
  return Object.freeze({ kind: "scope", scope });
}

function allowed(policy) {
  return { allowed: true, policy };
}

function denied(error, status, policy) {
  return { allowed: false, error, status, policy };
}

function normalizePath(path) {
  const raw = String(path || "");
  try {
    return new URL(raw, "http://hana.local").pathname;
  } catch {
    return raw.split("?")[0] || "/";
  }
}

export function scopeAllows(scopes, required) {
  if (!required) return true;
  if (scopes.includes(required)) return true;
  const [namespace] = required.split(".");
  return scopes.includes(namespace) || scopes.includes(`${namespace}.*`);
}

function isMobileStaticRoute(verb, routePath) {
  if (verb !== "GET" && verb !== "HEAD") return false;
  return routePath === "/mobile"
    || routePath === "/mobile/"
    || routePath === "/mobile/index.html"
    || routePath === "/mobile/manifest.webmanifest"
    || routePath === "/mobile/sw.js"
    || routePath.startsWith("/mobile/assets/")
    || routePath.startsWith("/mobile/icons/");
}

function isWebAuthBootstrapRoute(verb, routePath) {
  if (routePath === "/api/web-auth/login") return verb === "POST";
  if (routePath === "/api/web-auth/session") return verb === "GET";
  if (routePath === "/api/web-auth/logout") return verb === "POST";
  return false;
}

function isSettingsReadRoute(verb, routePath) {
  if (verb !== "GET") return false;
  return routePath === "/api/config"
    || routePath === "/api/providers/summary"
    || routePath === "/api/preferences/models"
    || routePath === "/api/bridge/status"
    || /^\/api\/agents\/[^/]+\/config$/.test(routePath);
}

function isSettingsWriteRoute(verb, routePath) {
  return (verb === "PUT" && (
    routePath === "/api/config"
    || routePath === "/api/preferences/models"
    || /^\/api\/agents\/[^/]+\/config$/.test(routePath)
  ));
}

function isProviderManagementRoute(verb, routePath) {
  if (verb === "POST" && (
    routePath === "/api/providers/test"
    || routePath === "/api/providers/fetch-models"
  )) return true;
  if (
    (verb === "GET" && /^\/api\/providers\/[^/]+\/discovered-models$/.test(routePath))
    || ((verb === "PUT" || verb === "DELETE") && /^\/api\/providers\/[^/]+\/models\/[^/]+$/.test(routePath))
  ) {
    return true;
  }
  return false;
}

function isBridgeManagementRoute(verb, routePath) {
  if (verb !== "POST") return false;
  return routePath === "/api/bridge/config"
    || routePath === "/api/bridge/settings"
    || routePath === "/api/bridge/owner"
    || routePath === "/api/bridge/stop"
    || routePath === "/api/bridge/test";
}
