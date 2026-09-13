const DEFAULT_LOOPBACK_WEB_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ELECTRON_FILE_ORIGINS = new Set(["file://", "file:///"]);

export function isCorsOriginAllowed({
  origin,
  configuredOrigin = "",
}: { origin?: string; configuredOrigin?: string } = {}) {
  const value = String(origin || "");
  if (!value) return false;
  if (configuredOrigin) return value === configuredOrigin;
  if (value === "null") return true;
  if (ELECTRON_FILE_ORIGINS.has(value)) return true;
  return DEFAULT_LOOPBACK_WEB_ORIGIN.test(value);
}

/** Shared by the server entrypoint and HTTP contract tests. */
export function createCorsMiddleware({ configuredOrigin = "" } = {}) {
  return async (c, next) => {
    const origin = c.req.header("origin") || "";
    if (origin && isCorsOriginAllowed({ origin, configuredOrigin })) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
    }
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  };
}
