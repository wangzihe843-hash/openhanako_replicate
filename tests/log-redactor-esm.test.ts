import { describe, expect, it } from "vitest";
import esm from "../shared/log-redactor.ts";
import cjs from "../shared/log-redactor.cjs";

import {
  redactLogText,
  redactLogValue,
  redactLogLabel,
  formatLogArgs,
} from "../shared/log-redactor.ts";

describe("ESM log redaction", () => {
  it("exports the same browser-safe redaction helpers without CommonJS globals", () => {
    expect(redactLogText("token=abc123")).toBe("token=[redacted]");
    expect(redactLogValue({ token: "abc123", ok: true })).toEqual({
      token: "[redacted]",
      ok: true,
    });
    expect(redactLogLabel("bridge\nbad module!")).toBe("bridge_bad_module_");
    expect(formatLogArgs(["Authorization: Bearer secret"])).toBe("Authorization: Bearer [redacted]");
  });
});

const ciPathTail = "work/openhanako_replicate/openhanako_replicate/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11";
describe.each([["TS", esm], ["CJS", cjs]] as const)("%s path redaction idempotence", (_name, api) => {
  it.each([
    "/Users/runner/" + ciPathTail,
    "file:///Users/runner/" + ciPathTail,
    "/home/runner/" + ciPathTail,
    "file:///home/runner/" + ciPathTail,
    "C:/Users/runner/" + ciPathTail,
    "file:///C:/Users/runner/" + ciPathTail,
    "C:\\Users\\runner\\" + ciPathTail.replaceAll("/", "\\"),
    "D:/a/" + ciPathTail,
    "file:///D:/a/" + ciPathTail,
    "file:///Users/[user]/" + ciPathTail,
  ])("keeps redacted path boundaries stable: %s", input => {
    const once = api.redactLogText(input);
    expect(api.redactLogText(once)).toBe(once);
    expect(api.redactLogText(api.redactLogText(once))).toBe(once);
    expect(once).not.toMatch(/(?:Users|home)[/\\]runner[/\\]/);
    expect(once).toContain(input.includes("\\") ? "@vitest\\runner\\dist\\chunk-artifact.js:302:11" : "@vitest/runner/dist/chunk-artifact.js:302:11");
    expect(once).not.toContain("[user][token]");
  });

  it.each([
    ["/Users/runner/" + ciPathTail, { homeDir: "/Users/runner" }, "~/"],
    ["file:///Users/runner/" + ciPathTail, { homeDir: "/Users/runner" }, "file://~/"],
    ["/build/private-root/" + ciPathTail, { extraPaths: ["/build/private-root"] }, "[path]/"],
  ] as const)("keeps configured path replacement delimiters: %s", (input, options, prefix) => {
    const config = { ...options, ...("extraPaths" in options ? { extraPaths: [...options.extraPaths] } : {}) };
    const once = api.redactLogText(input, config);
    expect(once).toContain(prefix);
    expect(once).toContain("@vitest/runner/dist/chunk-artifact.js:302:11");
    expect(api.redactLogText(once, config)).toBe(once);
  });

  it("does not reinterpret canonical markers or trust a marker prefix as a username", () => {
    const canonical = "file:///Users/[user]/[token]/@vitest/runner/dist/chunk-artifact.js:302:11";
    expect(api.redactLogText(canonical)).toBe(canonical);
    const raw = "/Users/[user]synthetic-person/private.txt";
    expect(api.redactLogText(raw)).not.toContain("synthetic-person");
    const legacy = "file:///Users/[user][token]@vitest/runner/dist/chunk-artifact.js:302:11";
    const once = api.redactLogText(legacy);
    expect(api.redactLogText(once)).toBe(once);
  });

  it("does not turn repeated path separators into a new token on the next pass", () => {
    for (const root of ["file:///Users/runner/", "/home/runner/", "file:///C:/Users/runner/"]) {
      for (const count of [2, 39, 40, 80]) {
        for (const body of ["", "openhanako_replicate/".repeat(3), "A".repeat(45)]) {
          const input = root + "/".repeat(count) + body + "@vitest/runner/dist/chunk-artifact.js:302:11";
          const once = api.redactLogText(input);
          expect(api.redactLogText(once), input).toBe(once);
          expect(once).toContain("@vitest/runner/dist/chunk-artifact.js:302:11");
        }
      }
    }
  });

  it("still hides unlabelled random/base64 values and complete named credentials", () => {
    const token = "aB7_".repeat(16);
    for (const value of [token, `/${token}`, `${token}/`, `//${token}//`, "/".repeat(80)]) {
      const once = api.redactLogText(`opaque ${value}`);
      expect(once).not.toContain(value);
      expect(once).toContain("[token]");
      expect(api.redactLogText(once)).toBe(once);
      expect(api.redactLogText(`access_token=${value}`)).toBe("access_token=[redacted]");
    }
  });

  it("keeps synthetic CI stacks and nested signed URLs stable through Error causes and JSON", () => {
    const media = "https://novac2c.cdn.weixin.qq.com/media?opaque=z7";
    const wrapped = "https://diagnostic.example.com/error?detail=" + encodeURIComponent(media);
    const cause = new Error(wrapped);
    cause.stack = `Error: ${wrapped}\n    at file:///Users/runner/${ciPathTail}`;
    const error = new AggregateError([cause], "upload failed", { cause });
    error.stack = `Error: ${wrapped}\n    at file:///C:/Users/runner/${ciPathTail}`;
    const source = cause.stack;
    for (const input of [error, JSON.stringify({ stack: cause.stack }), JSON.stringify({ detail: JSON.stringify({ stack: cause.stack }) })]) {
      const once = api.redactLogText(input);
      expect(once).not.toContain("z7");
      expect(once).toContain("chunk-artifact.js:302:11");
      expect(api.redactLogText(once)).toBe(once);
    }
    expect(cause.stack).toBe(source);
    expect(cause.message).toBe(wrapped);
  });
});

// Preserve natural V8 stacks as well as deterministic cross-platform paths.
// A second serialization pass must not consume a JSON escape as URL content.
describe.each([["TS", esm], ["CJS", cjs]] as const)("%s serialized diagnostic idempotence", (_name, api) => {
  const signed = "https://novac2c.cdn.weixin.qq.com/media?opaque=short-SYNTHETIC-Z9";
  const wrapped = "https://diagnostic.example.invalid/error?detail=" + encodeURIComponent(signed);
  it.each([
    signed, wrapped, encodeURIComponent(signed), encodeURIComponent(encodeURIComponent(wrapped)),
    "https://novac2c.cdn.weixin.qq.com/[redacted]",
    "https://example.invalid/media?sig=short-SYNTHETIC-Z9&version=3",
    "https://api.telegram.org/file/bot123:short-SYNTHETIC-Z9/file.png",
  ])("keeps natural Error causes stable without rewriting their stacks: %s", message => {
    const cause = new Error(message);
    const error = new AggregateError([cause], "upload failed", { cause });
    const original = cause.stack;
    const once = api.redactLogText(error);
    expect(once).not.toContain("short-SYNTHETIC-Z9");
    expect(api.redactLogText(once)).toBe(once);
    expect(api.redactLogText(api.redactLogText(once))).toBe(once);
    const cleaned = JSON.parse(once);
    expect(cleaned.cause.stack).toContain("\n");
    expect(cleaned.cause.stack).toContain("log-redactor-esm.test.ts:");
    expect(cleaned.errors[0].stack).toBe(cleaned.cause.stack);
    expect(cause.stack).toBe(original);
    expect(cause.message).toBe(message);
  });

  it("preserves JSON escape boundaries with media URLs and long stack paths together", () => {
    for (const suffix of ["\n", "\r\n", "\t", '\\continued', '"quoted"']) {
      for (const url of [signed, wrapped]) {
        for (const stackPath of ["file:///Users/runner/" + ciPathTail, "C:\\Users\\runner\\" + ciPathTail.replaceAll("/", "\\")]) {
          const detail = { stack: `Error: ${url}${suffix} at ${stackPath}`, httpStatus: 503, log_id: "local-123" };
          for (const input of [JSON.stringify(detail), JSON.stringify({ detail: JSON.stringify(detail) }), `HTTP 503 ${JSON.stringify(detail)} retry_after=3`]) {
            const once = api.redactLogText(input);
            expect(once).not.toContain("short-SYNTHETIC-Z9");
            expect(once).toContain("chunk-artifact.js:302:11");
            expect(once).toContain("local-123");
            expect(api.redactLogText(once)).toBe(once);
            expect(api.redactLogText(api.redactLogText(once))).toBe(once);
          }
        }
      }
    }
  });

  it("keeps credential assignment context around escaped strings and encoded keys", () => {
    for (const key of ["token", "upload_full_url", "X-Api-Key", "context_token", "appSecret", "aes_key"]) {
      const plain = JSON.stringify({ [key]: "short-Z9\ncontinued", safe: "ordinary\nline", status: 503 });
      const encodedKey = plain.replace(key, key.replace(/./g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")));
      for (const input of [plain, encodedKey, `HTTP 503 ${plain}`, JSON.stringify({ detail: plain })]) {
        const once = api.redactLogText(input);
        expect(once).not.toMatch(/short-Z9|continued/);
        expect(once).toContain("503");
        expect(once).toContain("ordinary");
        expect(api.redactLogText(once)).toBe(once);
      }
    }
  });

  it("does not mistake caller supplied marker text for a protected literal", () => {
    const markerText = Array.from({ length: 32 }, (_, index) => `\uE000${index}\uE001`).join(" ");
    for (const fake of [markerText, markerText.replaceAll("\uE000", "\uE000\u0000")]) {
      const input = JSON.stringify({ fake, stack: `Error: ${signed}\n at /tmp/fixture.js:12:3`, token: "short-Z9\ncontinued" });
      const once = api.redactLogText(input);
      expect(JSON.parse(once).fake).toBe(markerText);
      expect(JSON.parse(once).stack).toBe("Error: https://novac2c.cdn.weixin.qq.com/[redacted]\n at /tmp/fixture.js:12:3");
      expect(JSON.parse(once).token).toBe("[redacted]");
      expect(api.redactLogText(once)).toBe(once);
    }
  });
});

// All credentials below are short, non-working synthetic sentinels. Checking
// both runtime exports prevents a server-only fix from missing Electron main.
describe.each([["TS", esm], ["CJS", cjs]] as const)("%s diagnostic boundaries", (_name, api) => {
  it.each([
    "X-Api-Key", "x-access-token", "X-Auth-Token", "X-Goog-Api-Key",
    "x-acs-dingtalk-access-token", "X-Subscription-Token",
  ])("redacts credential header %s in each diagnostic representation", (key) => {
    const secret = "SYN_HEADER_SHORT";
    const header = { [key]: secret, "X-Request-Id": "request-local-123" };
    const object = { headers: [header], code: 403 };
    for (const raw of [
      `HTTP 403 ${key}: ${secret}; retry_after=3`,
      `${key.toUpperCase()}='SYN_HEADER_SHORT\ncontinued'`,
      JSON.stringify(header),
      JSON.stringify({ detail: JSON.stringify(header) }),
      JSON.stringify({ [key]: [secret, { nested: secret }], safe: "ordinary" }),
      JSON.stringify({ detail: JSON.stringify({ [key]: { nested: [secret] } }) }),
      `${key.replace("-", "-\u0000\u001b[31m")}: ${secret}`,
      `https://example.invalid/diagnostic?${encodeURIComponent(key).replaceAll("-", "%2D")}=SYN_HEADER_SHORT&safe=1`,
    ]) {
      const cleaned = api.redactLogText(raw);
      expect(cleaned).not.toMatch(/SYN_HEADER_SHORT|continued/);
      expect(cleaned).toContain("[redacted]");
      expect(api.redactLogText(cleaned)).toBe(cleaned);
    }
    expect(api.redactLogValue(object)).toEqual({
      headers: [{ [key]: "[redacted]", "X-Request-Id": "request-local-123" }], code: 403,
    });
    expect(api.formatLogArgs([object])).not.toContain(secret);
    expect(api.redactLogValue({ [key.replace("-", "-\u0000")]: secret }))
      .toEqual({ [key]: "[redacted]" });
    expect(header[key]).toBe(secret);
  });

  it("redacts complete JSON credential containers and retains following diagnostics", () => {
    for (const value of [["SYN_ARRAY", { nested: "SYN_OBJECT" }], { nested: ["SYN_ARRAY", "brackets ] } and quote \\\""] }]) {
      const raw = `HTTP 503 ${JSON.stringify({ "X-Api-Key": value, safe: "ordinary", code: 503 })} retry_after=3`;
      const cleaned = api.redactLogText(raw);
      expect(cleaned).not.toMatch(/SYN_ARRAY|SYN_OBJECT|brackets/);
      expect(cleaned).toContain('"safe":"ordinary","code":503');
      expect(cleaned).toContain("retry_after=3");
      expect(api.redactLogText(cleaned)).toBe(cleaned);
    }
    for (const raw of ['HTTP 503 X-Api-Key=["SYN_UNCLOSED"', 'HTTP 503 X-Api-Key={"nested":["SYN_MISMATCH"}']) {
      const cleaned = api.redactLogText(raw);
      expect(cleaned).not.toMatch(/SYN_/);
      expect(cleaned).toBe('HTTP 503 X-Api-Key="[redacted]"');
    }
    const tooDeep = 'HTTP 503 X-Api-Key=' + '['.repeat(33) + '"SYN_DEEP"' + ']'.repeat(33);
    expect(api.redactLogText(tooDeep)).toBe('HTTP 503 X-Api-Key="[redacted]"');
  });

  it.each([
    "context_token", "contextToken", "CONTEXT-TOKEN", "aes_key", "aeskey", "AESKey",
    "encrypt_query_param", "encrypted_query_param", "encryptedQueryParam",
    "upload_param", "download_param", "ticket", "typing_ticket", "verify_code",
    "botToken", "appSecret", "app_secret", "clientSecret", "client_secret",
    "accessToken", "access_token", "refresh_token", "api_key", "private_key",
  ])("redacts %s in text, JSON, objects and arrays without changing the source", (key) => {
    const secret = "fixtureValue";
    const object = { [key]: secret, safe: "ordinary text", code: 429 };
    for (const raw of [`${key}=${secret}`, `{"${key}":"${secret}"}`, `${key}='fixture\nValue'`]) {
      const cleaned = api.redactLogText(raw);
      expect(cleaned).not.toMatch(/fixture|Value/);
      expect(api.redactLogText(cleaned)).toBe(cleaned);
      expect(cleaned).toContain("[redacted]");
    }
    expect(api.redactLogValue([object])).toEqual([{ [key]: "[redacted]", safe: "ordinary text", code: 429 }]);
    expect(object[key]).toBe(secret);
  });

  it.each([
    'response={"context_token":"fixture\\"secret\\nsecond"} code=401',
    'context_\u0000token=fixtureSecret code=401',
    '\u001b[31mcontext_token\u001b[0m=fixtureSecret code=401',
    'https://cdn.fixture.invalid/x?CONTEXT%5Ftoken=fixture%0ASecret&safe=1',
    'https://cdn.fixture.invalid/x?encrypted_query_param=fixture%26secret&safe=1',
    'https://api.telegram.org/bot12345:fixtureSecret/getMe',
    'https://API.TELEGRAM.ORG/file/bot12345%3AfixtureSecret/photo.jpg',
    encodeURIComponent('https://api.telegram.org/file/bot12345:fixtureSecret/photo.jpg'),
    '{"Authorization":"Basic fixtureSecret","safe":true}',
    'Authorization: Basic fixtureSecret',
  ])("handles a reachable encoded or decorated diagnostic: %s", (raw) => {
    const cleaned = api.redactLogText(raw);
    expect(cleaned).not.toMatch(/fixtureSecret|fixture%|fixture\\|fixture\n|12345/);
    expect(api.redactLogText(cleaned)).toBe(cleaned);
    expect(cleaned).toContain("[redacted]");
  });

  it("redacts nested JSON strings, escaped URL slashes and normalized object keys on the first pass", () => {
    const raw = JSON.stringify({ detail: JSON.stringify({ context_token: "fixtureNested" }) });
    for (const input of [raw, `HTTP 401 ${raw}`, 'https:\\/\\/api.telegram.org\\/bot12345:fixtureEscaped\\/getMe']) {
      const cleaned = api.redactLogText(input);
      expect(cleaned).not.toMatch(/fixtureNested|fixtureEscaped|12345/);
      expect(api.redactLogText(cleaned)).toBe(cleaned);
    }
    const object = { ["context_\u0000token"]: "fixtureStructured", ["aes_\u001b[31mkey"]: "fixtureAes" };
    expect(api.redactLogValue(object)).toEqual({ context_token: "[redacted]", aes_key: "[redacted]" });
    expect(object["context_\u0000token"]).toBe("fixtureStructured");
  });

  it("preserves ordinary diagnostics and correlation IDs", () => {
    const headerControls = {
      "X-Request-Id": "request-local-123", "X-RateLimit-Remaining": "4",
      "X-XAI-Token-Auth": "true", "api-key-count": "2", "token-count": "3",
      "support-ticket": "SUP-321", "verify-code-count": "5", monkey: "ordinary",
    };
    const headerControlText = Object.entries(headerControls).map(([key, value]) => `${key}=${value}`).join(" ");
    expect(api.redactLogText(headerControlText)).toBe(headerControlText);
    expect(api.redactLogValue(headerControls)).toEqual(headerControls);
    for (const numericId of ["1234567890123456", "110105199001011234", "123-45-6789"]) {
      expect(api.redactLogText(`log_id=${numericId} code=429`)).toBe(`log_id=${numericId} code=429`);
      expect(api.redactLogValue({ log_id: numericId })).toEqual({ log_id: numericId });
    }
    const id = "abcdef0123456789".repeat(4);
    const raw = `stage=connect operation=send code=429 httpStatus=503 log_id=${id} retry_after=7 key=ordinary keyboard=normal`;
    expect(api.redactLogText(raw)).toBe(raw);
    expect(api.redactLogValue({ log_id: id, code: 0, httpStatus: 503, retry_after: 7, content: "normal", appId: "app-fixture" }))
      .toEqual({ log_id: id, code: 0, httpStatus: 503, retry_after: 7, content: "normal", appId: "app-fixture" });
    expect(api.redactLogText("https://example.invalid/botanical/photo.jpg?version=3")).toBe("https://example.invalid/botanical/photo.jpg?version=3");
  });

  it("copies nested errors and cycles while preserving type, location and retry diagnostics", () => {
    const cause = Object.assign(new TypeError("ticket=fixtureCause"), { code: "ECONNRESET", httpStatus: 503 });
    const error = Object.assign(new Error("context_token=fixtureOuter", { cause }), { code: 0, stage: "connect", retry_after: 3 });
    error.stack = "Error: context_token=fixtureOuter\n    at /tmp/bridge.ts:10:2";
    Object.assign(cause, { cause: error, config: { appSecret: "fixtureConfig" } });
    const cleaned = api.redactLogValue(error);
    expect(cleaned).toMatchObject({ name: "Error", code: 0, stage: "connect", retry_after: 3,
      cause: { name: "TypeError", code: "ECONNRESET", httpStatus: 503, cause: "[Circular]" } });
    expect(cleaned.stack).toContain("/tmp/bridge.ts:10:2");
    expect(api.formatLogArgs([error])).not.toMatch(/fixtureOuter|fixtureCause|fixtureConfig/);
    expect(error.message).toBe("context_token=fixtureOuter");
    expect(cause.message).toBe("ticket=fixtureCause");
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  it("does not invoke custom serialization/accessors and bounds cyclic, broad and deep objects", () => {
    let invoked = 0;
    const value = { safe: "ok", toJSON() { invoked++; throw new Error("must not run"); },
      toString() { invoked++; throw new Error("must not run"); },
      get dangerous() { invoked++; throw new Error("must not run"); }, amount: 2n };
    const array = [value];
    Object.assign(value, { self: value });
    expect(api.formatLogArgs(array)).toContain("[Circular]");
    expect(api.formatLogArgs(array)).toContain('"amount":"2"');
    expect(api.formatLogArgs(array)).toContain("[Accessor]");
    expect(invoked).toBe(0);
    const deep = { child: null };
    deep.child = deep;
    expect(api.formatLogArgs([deep])).toContain("[Circular]");
    let nested: unknown = "leaf";
    for (let i = 0; i < 20; i++) nested = { nested };
    expect(api.formatLogArgs([nested])).toContain("[MaxDepth]");
    expect(api.redactLogValue(Array.from({ length: 1000 }, () => "ok"))).toHaveLength(101);
    expect(api.formatLogArgs([new Proxy({}, { ownKeys() { throw new Error("fixtureTrap"); } })])).toBe('"[Uninspectable]"');
    const error = new Error("synthetic");
    Object.defineProperty(error, "name", { get() { invoked++; throw new Error("must not run"); } });
    expect(api.formatLogArgs([error])).toContain("[Accessor]");
    expect(invoked).toBe(0);
  });

  it("redacts aggregate error causes and Error names, without reflecting SDK request objects", () => {
    const cause = new Error("appSecret=fixtureApp");
    const error = new AggregateError([cause], "failed", { cause });
    error.name = "Custom ticket=fixtureName";
    Object.assign(error, { config: { credentials: "fixtureRequest" }, responseBody: { message: "fixtureBody" } });
    const output = api.formatLogArgs([error]);
    expect(output).toContain("Custom ticket=[redacted]");
    expect(output).toContain('"errors"');
    expect(output).not.toMatch(/fixtureApp|fixtureName|fixtureRequest|fixtureBody/);
  });
});
