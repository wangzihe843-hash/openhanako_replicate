const DEFAULT_LOOPBACK_WEB_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isCorsOriginAllowed({
  origin,
  configuredOrigin = "",
} = {}) {
  const value = String(origin || "");
  if (!value) return false;
  if (configuredOrigin) return value === configuredOrigin;
  if (value === "null") return true;
  return DEFAULT_LOOPBACK_WEB_ORIGIN.test(value);
}
