/**
 * Browser-safe ESM diagnostic log redaction.
 *
 * Keep this in sync with log-redactor.cjs, which is retained for Electron main
 * and other CommonJS entry points.
 */

const REDACTED = "[redacted]";

// Preserve the original credential suffixes after hyphens in text headers.
const CREDENTIAL_KEY_PATTERN = "api[_-]?key|secret[_-]?key|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|client[_-]?secret|bot[_-]?token|server[_-]?token";
// New channel keys remain whole names: support-ticket and email-verify-code
// are ordinary diagnostics, not credential headers.
const CHANNEL_KEY_PATTERN = "app[_-]?secret|app[_-]?key|context[_-]?token|aes[_-]?key|encrypt(?:ed)?[_-]?query[_-]?param|upload[_-]?param|download[_-]?param|(?:typing[_-]?)?ticket|verify[_-]?code|private[_-]?key|credential(?:s)?|filekey";
const SECRET_KEY_PATTERN = `${CREDENTIAL_KEY_PATTERN}|${CHANNEL_KEY_PATTERN}`;
const CREDENTIAL_HEADER_KEY_RE = new RegExp("^[!#$%&'*+.^_`|~0-9A-Za-z-]+-(?:" + CREDENTIAL_KEY_PATTERN + ")$", "i");
const SECRET_ASSIGN_RE = new RegExp(`((?:(?<!\\w)["']?(?:${CREDENTIAL_KEY_PATTERN})|(?<![\\w-])["']?(?:${CHANNEL_KEY_PATTERN}))["']?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\[redacted\\]|[^\\s,;"'\\]}&#]+)`, "gi");
const SENSITIVE_OBJECT_KEY_RE = new RegExp(`^(?:${SECRET_KEY_PATTERN}|authorization|cookie|set-cookie|session[_-]?key|session[_-]?id|user[_-]?id|chat[_-]?id|sender[_-]?name|avatar[_-]?url|owner)$`, "i");
const URL_SECRET_KEY_RE = new RegExp(`^(?:${SECRET_KEY_PATTERN}|auth|authorization|key|code)$`, "i");
const URL_QUERY_RE = /([?&])([^=&#\s"'<>]+)=([^&#\s"'<>]*)/g;
const TELEGRAM_PATH_RE = /(\bhttps?:\/\/api\.telegram\.org(?::\d+)?\/(?:file\/)?bot)(?!\[redacted\])[^/\s?&#"'<>]+/gi;
const API_KEY_VALUE_RE = /\b(sk-[a-zA-Z0-9_-]{20,}|AKIA[A-Z0-9]{16}|gsk_[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]{20,}|xox[abpors]-[a-zA-Z0-9-]+)\b/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CREDIT_CARD_RE = /\b(?:\d{4}[- ]?){3}\d{4}\b/g;
const CN_ID_CARD_RE = /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const LONG_RANDOM_RE = /(^|[^\w/.-])([A-Za-z0-9+/_-]{40,}=*)(?=$|[^\w/.-])/g;

function isCorrelationId(text: string, offset: number): boolean {
  return /(?:log[_-]?id|trace[_-]?id|request[_-]?id)["']?\s*[:=]\s*["']?$/i
    .test(text.slice(Math.max(0, offset - 40), offset));
}

export function redactLogText(value: unknown, options: { homeDir?: string; extraPaths?: string[] } = {}): string {
  if (value == null) return "";
  if (typeof value === "object") return formatLogArgs([value], options);
  if (typeof value === "function") return "[Function]";
  return redactText(String(value), options, 0);
}

function redactText(text: string, options: RedactOptions, encodingDepth: number): string {
  // Server error bodies may contain JSON inside a JSON string. Decode only
  // valid string literals, then re-encode the sanitized copy. Bound nesting.
  text = text.replace(/"(?:\\.|[^"\\])*"/g, (literal) => {
    if (!literal.includes("\\")) return literal;
    if (encodingDepth >= 4) return '"[MaxEncodingDepth]"';
    try {
      return JSON.stringify(redactText(JSON.parse(literal), options, encodingDepth + 1));
    } catch { return literal; }
  });
  text = text.replace(/\\\//g, "/");

  // Strip terminal decorations and non-whitespace controls before recognizing keys.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  text = redactKnownPaths(text, options);

  text = text.replace(/data:([^;,]+);base64,[A-Za-z0-9+/=]+/gi, "data:$1;base64,[redacted]");
  // Errors sometimes contain an encodeURIComponent(URL) copy. Decode only that
  // representation, once, in this output copy; never decode request inputs.
  text = text.replace(/https?%3a%2f%2f[^\s"'<>]+/gi, (url) => {
    try { return decodeURIComponent(url); } catch { return url; }
  });
  text = text.replace(/(https?:\/\/)([^:@\s/?#]+):([^@\s/?#]+)@/gi, "$1[credentials]@");
  text = text.replace(TELEGRAM_PATH_RE, "$1[redacted]");
  text = text.replace(URL_QUERY_RE, (match, separator, key) => {
    let decoded = key;
    try { decoded = decodeURIComponent(key); } catch { /* keep malformed keys */ }
    return (URL_SECRET_KEY_RE.test(decoded) || CREDENTIAL_HEADER_KEY_RE.test(decoded)) ? `${separator}${key}=[redacted]` : match;
  });
  text = text.replace(/\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, "$1[redacted]");
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[redacted]");
  text = text.replace(/\b(Cookie|Set-Cookie)\s*[:=]\s*[^\r\n]+/gi, "$1=[redacted]");
  text = text.replace(/(["'](?:authorization|cookie|set-cookie)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, "$1\"[redacted]\"");
  text = redactAssignments(text);
  text = text.replace(API_KEY_VALUE_RE, REDACTED);
  text = text.replace(CREDIT_CARD_RE, (match, offset) => isCorrelationId(text, offset) ? match : "[credit_card]");
  text = text.replace(CN_ID_CARD_RE, (match, offset) => isCorrelationId(text, offset) ? match : "[id_card]");
  text = text.replace(SSN_RE, (match, offset) => isCorrelationId(text, offset) ? match : "[ssn]");
  text = text.replace(EMAIL_RE, "[email]");
  text = text.replace(LONG_RANDOM_RE, (match, prefix, _token, offset) => {
    // Known correlation IDs locate a request; do not mistake them for tokens.
    return isCorrelationId(text, offset + prefix.length) ? match : `${prefix}[token]`;
  });

  return text;
}

// Consume only an explicitly sensitive bracketed value. Do not JSON.parse or
// serialize arbitrary input. A malformed/over-deep value hides the remaining
// output because there is no trustworthy end for its credential contents.
function credentialContainerEnd(text: string, start: number): number {
  const closing: string[] = [];
  let quote = "";
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "{") {
      if (closing.length >= 32) return text.length;
      closing.push(char === "[" ? "]" : "}");
    } else if (char === "]" || char === "}") {
      if (closing.pop() !== char) return text.length;
      if (!closing.length) return index + 1;
    }
  }
  return text.length;
}

function redactAssignments(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  SECRET_ASSIGN_RE.lastIndex = 0;
  for (let match = SECRET_ASSIGN_RE.exec(text); match; match = SECRET_ASSIGN_RE.exec(text)) {
    const [, prefix, secret] = match;
    let end = SECRET_ASSIGN_RE.lastIndex;
    let quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : "";
    if ((secret[0] === "[" || secret[0] === "{") && secret !== REDACTED) {
      end = credentialContainerEnd(text, match.index + prefix.length);
      quote = '"';
    }
    parts.push(text.slice(cursor, match.index), `${prefix}${quote}${REDACTED}${quote}`);
    cursor = end;
    SECRET_ASSIGN_RE.lastIndex = end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function redactKnownPaths(text: string, options: { homeDir?: string; extraPaths?: string[] }): string {
  let out = text;
  const paths = [];
  if (options.homeDir) paths.push([options.homeDir, "~"]);
  if (Array.isArray(options.extraPaths)) {
    for (const p of options.extraPaths) paths.push([p, "[path]"]);
  }

  for (const [rawPath, replacement] of paths) {
    if (!rawPath || typeof rawPath !== "string") continue;
    const variants = pathVariants(rawPath);
    for (const variant of variants) {
      out = out.split(variant).join(replacement);
      if (variant.startsWith("/")) {
        out = out.split(`file://${variant}`).join(`file://${replacement}`);
      }
    }
  }

  out = out.replace(/file:\/\/\/Users\/[^/\s]+/g, "file:///Users/[user]");
  out = out.replace(/\/Users\/[^/\s]+/g, "/Users/[user]");
  out = out.replace(/file:\/\/\/home\/[^/\s]+/g, "file:///home/[user]");
  out = out.replace(/\/home\/[^/\s]+/g, "/home/[user]");
  out = out.replace(/\b([A-Za-z]:\\Users\\)[^\\/\s]+/g, "$1[user]");
  out = out.replace(/\b([A-Za-z]:\/Users\/)[^\\/\s]+/g, "$1[user]");

  return out;
}

function pathVariants(rawPath: string): Set<string> {
  const variants = new Set([rawPath]);
  if (rawPath.includes("\\")) variants.add(rawPath.replace(/\\/g, "/"));
  if (rawPath.includes("/")) variants.add(rawPath.replace(/\//g, "\\"));
  return variants;
}

type RedactOptions = { homeDir?: string; extraPaths?: string[] };
type RedactState = { depth?: number; seen?: WeakSet<object>; budget?: { remaining: number } };
const NATIVE_STACK_GETTER = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const ERROR_FIELDS = ["name", "message", "stack", "code", "status", "statusCode", "httpStatus", "stage", "operation", "log_id", "logId", "retry_after", "retryAfter", "cause", "errors"];

// Never call arbitrary accessors, toJSON, custom inspect or toString methods.
// V8's own lazy stack getter is the one exception, to retain source locations.
function diagnosticProperty(value: object, key: string, inherited = false): unknown {
  let current = value;
  for (let depth = 0; current && depth < 8; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if ("value" in descriptor) return descriptor.value;
      if (key === "stack" && NATIVE_STACK_GETTER && descriptor.get === NATIVE_STACK_GETTER) {
        const name = diagnosticProperty(value, "name", true);
        const message = diagnosticProperty(value, "message", true);
        if ((name !== undefined && typeof name !== "string") || name === "[Accessor]"
          || (message !== undefined && typeof message !== "string") || message === "[Accessor]") return "[Accessor]";
        return descriptor.get.call(value);
      }
      return "[Accessor]";
    }
    if (!inherited) break;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

// Keep the existing loose return contract for diagnostic consumers of arbitrary shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function redactLogValue(value: unknown, options: RedactOptions = {}, state: RedactState = {}): any {
  const depth = state.depth || 0;
  const seen = state.seen || new WeakSet<object>();
  const budget = state.budget || { remaining: 1000 };
  if (budget.remaining-- <= 0) return "[MaxEntries]";
  if (value == null) return value;
  if (typeof value === "string") return redactLogText(value, options);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "symbol") return redactLogText(String(value), options);
  if (typeof value === "function") return "[Function]";
  if (typeof value !== "object") return "[Unsupported]";
  if (seen.has(value)) return "[Circular]";
  if (depth >= 8) return "[MaxDepth]";
  seen.add(value);
  const next = { depth: depth + 1, seen, budget };

  try {
    if (Array.isArray(value)) {
      const out = [];
      const length = Math.min(value.length, 100);
      for (let index = 0; index < length && budget.remaining > 0; index++) {
        out.push(redactLogValue(diagnosticProperty(value, String(index)), options, next));
      }
      if (out.length < value.length) out.push("[MaxEntries]");
      return out;
    }
    const isError = value instanceof Error;
    const keys = isError ? ERROR_FIELDS : Object.keys(value);
    const out: Record<string, unknown> = Object.create(null);
    for (const key of keys.slice(0, 100)) {
      if (budget.remaining <= 0) break;
      const cleanKey = redactLogLabel(key);
      if (SENSITIVE_OBJECT_KEY_RE.test(key) || SENSITIVE_OBJECT_KEY_RE.test(cleanKey)
        || CREDENTIAL_HEADER_KEY_RE.test(key) || CREDENTIAL_HEADER_KEY_RE.test(cleanKey)) {
        out[cleanKey] = REDACTED;
      } else {
        const item = diagnosticProperty(value, key, isError);
        out[cleanKey] = /^(?:log[_-]?id|trace[_-]?id|request[_-]?id)$/i.test(key) && typeof item === "string"
          ? redactLogText(`${key}=${item}`, options).slice(key.length + 1)
          : redactLogValue(item, options, next);
      }
    }
    if (keys.length > 100 || budget.remaining <= 0) out["[MaxEntries]"] = true;
    return out;
  } catch {
    return "[Uninspectable]";
  } finally {
    seen.delete(value);
  }
}

export function redactLogLabel(value: unknown): string {
  return redactLogText(value == null ? "unknown" : value)
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .slice(0, 80) || "unknown";
}

export function formatLogArgs(args: ArrayLike<unknown>, options: RedactOptions = {}): string {
  return Array.from(args || []).slice(0, 100).map((arg) => {
    if (typeof arg === "string") return redactLogText(arg, options);
    const cleaned = redactLogValue(arg, options);
    try {
      return JSON.stringify(cleaned, (_key, item) => typeof item === "bigint" ? String(item) : item)
        ?? String(cleaned);
    } catch {
      return "[Unserializable]";
    }
  }).join(" ");
}

const api = {
  redactLogText,
  redactLogValue,
  redactLogLabel,
  formatLogArgs,
};

export default api;
