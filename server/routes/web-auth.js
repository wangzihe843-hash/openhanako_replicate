import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import {
  WEB_SESSION_COOKIE_NAME,
  createWebSession,
  revokeWebSession,
} from "../../core/web-session-store.js";

const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function createWebAuthRoute({
  hanakoHome,
  authService,
  getConnectionKind,
  secureCookies = false,
  now = () => new Date().toISOString(),
} = {}) {
  if (!hanakoHome) throw new Error("hanakoHome required");
  if (!authService) throw new Error("authService required");
  const route = new Hono();

  route.post("/web-auth/login", async (c) => {
    const body = await safeJson(c);
    const credential = typeof body.credential === "string"
      ? body.credential.trim()
      : "";
    if (!credential) return c.json({ error: "credential_required" }, 400);

    const connectionKind = resolveConnectionKind(c, getConnectionKind);
    const principal = authService.authenticateToken(credential, {
      connectionKind,
      now: now(),
    });
    if (!principal) return c.json({ error: "forbidden" }, 403);

    const issued = createWebSession(hanakoHome, {
      principal,
      userAgent: c.req.header("user-agent"),
      now: now(),
      ttlMs: DEFAULT_SESSION_TTL_MS,
    });
    c.header("Set-Cookie", createSessionCookie(issued.secret, {
      maxAgeSeconds: Math.floor(DEFAULT_SESSION_TTL_MS / 1000),
      secure: secureCookies === true,
    }));
    return c.json({
      ok: true,
      expiresAt: issued.expiresAt,
      principal: sanitizePrincipal(principal),
    });
  });

  route.get("/web-auth/session", async (c) => {
    const connectionKind = resolveConnectionKind(c, getConnectionKind);
    const principal = authService.authenticateRequest({
      cookieHeader: c.req.header("cookie"),
      connectionKind,
      now: now(),
    });
    if (!principal) {
      return c.json({ authenticated: false, principal: null });
    }
    return c.json({
      authenticated: true,
      principal: sanitizePrincipal(principal),
    });
  });

  route.post("/web-auth/logout", async (c) => {
    revokeWebSession(hanakoHome, c.req.header("cookie"), { now: now() });
    c.header("Set-Cookie", clearSessionCookie({ secure: secureCookies === true }));
    return c.json({ ok: true });
  });

  return route;
}

function resolveConnectionKind(c, getConnectionKind) {
  if (typeof getConnectionKind === "function") {
    const value = getConnectionKind(c);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  try {
    return c.get("transportConnectionKind") || "local";
  } catch {
    return "local";
  }
}

function createSessionCookie(secret, {
  maxAgeSeconds,
  secure,
}) {
  const parts = [
    `${WEB_SESSION_COOKIE_NAME}=${encodeURIComponent(secret)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie({ secure }) {
  const parts = [
    `${WEB_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function sanitizePrincipal(principal) {
  return {
    kind: principal.kind || null,
    credentialKind: principal.credentialKind || null,
    connectionKind: principal.connectionKind || null,
    trustState: principal.trustState || null,
    serverId: principal.serverId || null,
    serverNodeId: principal.serverNodeId || null,
    userId: principal.userId || null,
    studioId: principal.studioId || null,
    deviceId: principal.deviceId || null,
    credentialId: principal.credentialId || null,
    platformAccountId: principal.platformAccountId || null,
    officialServiceKind: principal.officialServiceKind || null,
    scopes: Array.isArray(principal.scopes) ? [...principal.scopes] : [],
  };
}
