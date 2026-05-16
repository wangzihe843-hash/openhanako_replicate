export function createRequestContext(c, engine) {
  const runtimeContext = readRuntimeContext(engine);
  const request = {
    method: c.req.method,
    url: c.req.url,
    path: safePathname(c.req.url),
  };

  return Object.freeze({
    request,
    runtimeContext,
    serverId: runtimeContext?.serverId ?? null,
    userId: runtimeContext?.userId ?? null,
    studioId: runtimeContext?.studioId ?? null,
    connectionKind: runtimeContext?.connectionKind ?? null,
    credentialKind: runtimeContext?.credentialKind ?? null,
    platformAccountId: runtimeContext?.platformAccountId ?? null,
    officialServiceKind: runtimeContext?.officialServiceKind ?? null,
    authPrincipal: createAuthPrincipal(runtimeContext),
  });
}

export function jsonError(c, {
  code,
  detail,
  status = 500,
}) {
  return c.json({
    error: code,
    ...(detail ? { detail } : {}),
  }, status);
}

function readRuntimeContext(engine) {
  if (typeof engine?.getRuntimeContext !== "function") return null;
  return engine.getRuntimeContext();
}

function createAuthPrincipal(runtimeContext) {
  if (!runtimeContext) {
    return Object.freeze({ kind: "unknown" });
  }
  const platformAccountId = runtimeContext.platformAccountId ?? null;
  return Object.freeze({
    kind: platformAccountId ? "platform_account" : "local_user",
    userId: runtimeContext.userId ?? null,
    platformAccountId,
    connectionKind: runtimeContext.connectionKind ?? null,
    credentialKind: runtimeContext.credentialKind ?? null,
  });
}

function safePathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
