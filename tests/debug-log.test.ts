import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("module diagnostic output", () => {
  it("redacts prefixed credential headers in console and actual module/direct log files", async () => {
    vi.resetModules();
    const { createModuleLogger, initDebugLog, debugLog } = await import("../lib/debug-log.ts");
    const spies = ["log", "warn", "error"].map((name: "log" | "warn" | "error") => vi.spyOn(console, name).mockImplementation(() => {}));
    const raw = "HTTP 403 X-Api-Key: SYN_HEADER_1234567890123456; X-Access-Token=SYN_HEADER_ACCESS " +
      JSON.stringify({ "X-Api-Key": ["SYN_HEADER_ARRAY"] });
    const object = { headers: { "X-Api-Key": "SYN_HEADER_OBJECT", "X-Request-Id": "request-local-123" }, code: 403 };
    const cause = new Error("x-acs-dingtalk-access-token=SYN_HEADER_CAUSE");
    const error = new TypeError(raw, { cause });
    const logger = createModuleLogger("bridge");
    expect(debugLog()).toBeNull();
    logger.error(raw);
    expect(spies[2].mock.calls.flat().join("\n")).not.toMatch(/SYN_HEADER_/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-log-redaction-"));
    tempDirs.push(dir);
    const file = initDebugLog(dir);
    for (const level of ["log", "info", "warn", "error"] as const) {
      logger[level](raw);
      logger[level](object);
      logger[level](error);
    }
    for (const level of ["log", "warn", "error"] as const) {
      file[level]("direct", raw);
      file[level]("direct", object);
      file[level]("direct", error);
    }
    file.close();
    const outputs = [spies.flatMap((spy) => spy.mock.calls.flat()).join("\n"), fs.readFileSync(file.filePath, "utf8")];
    for (const output of outputs) {
      expect(output).not.toMatch(/SYN_HEADER_/);
      expect(output).toContain("HTTP 403");
      expect(output).toContain("TypeError");
      expect(output).toContain("request-local-123");
    }
    expect(object.headers["X-Api-Key"]).toBe("SYN_HEADER_OBJECT");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe(raw);
  });

  it("redacts console before initialization and the actual persisted log after initialization", async () => {
    vi.resetModules();
    const { createModuleLogger, initDebugLog, debugLog } = await import("../lib/debug-log.ts");
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = 'HTTP 401 context_token=fixtureWxContext aes_key=fixtureWxAes ' +
      'https://api.telegram.org/file/bot12345:fixtureTelegramToken/photo.jpg ' +
      '{"appSecret":"fixtureAppSecret","ticket":"fixtureStreamTicket"} ' +
      JSON.stringify({ detail: '{"context_token":"fixtureNested"}' }) +
      ' https:\\/\\/api.telegram.org\\/bot12345:fixtureEscaped\\/getMe';
    const secrets = ["fixtureWxContext", "fixtureWxAes", "12345:fixtureTelegramToken", "fixtureAppSecret", "fixtureStreamTicket", "fixtureNested", "fixtureEscaped"];
    const logger = createModuleLogger("bridge");
    expect(debugLog()).toBeNull();
    logger.error(raw);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-log-redaction-"));
    tempDirs.push(dir);
    const file = initDebugLog(dir);
    logger.error(raw);
    file.close();
    const consoleText = output.mock.calls.flat().join("\n");
    const fileText = fs.readFileSync(file.filePath, "utf8");
    for (const secret of secrets) {
      expect(consoleText).not.toContain(secret);
      expect(fileText).not.toContain(secret);
    }
    expect(consoleText).toContain("HTTP 401");
    expect(fileText).toContain("[ERROR] [bridge] HTTP 401");
    expect(raw).toContain("fixtureWxContext");
  });

  it("uses safe copies for all levels, structured errors and direct file writes", async () => {
    vi.resetModules();
    const { createModuleLogger, initDebugLog } = await import("../lib/debug-log.ts");
    const spies = ["log", "warn", "error"].map((name: "log" | "warn" | "error") => vi.spyOn(console, name).mockImplementation(() => {}));
    const cause = new TypeError("clientSecret=fixtureCause");
    const error = Object.assign(new Error("HTTP 429 appSecret=fixtureError", { cause }), { code: "RATE_LIMIT", retry_after: 3 });
    const input = { error, data: [{ aesKey: "fixtureArray", safe: "ordinary", ["context_\u0000token"]: "fixtureControl" }] };
    Object.assign(input, { self: input });
    const logger = createModuleLogger("bridge\ncontext_token=fixtureModule");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-log-redaction-"));
    tempDirs.push(dir);
    const file = initDebugLog(dir);
    for (const level of ["log", "info", "warn", "error"] as const) logger[level](input);
    file.error("bridge", input);
    file.close();
    const outputs = [...spies.flatMap((spy) => spy.mock.calls.flat()), fs.readFileSync(file.filePath, "utf8")];
    for (const output of outputs) {
      expect(output).not.toMatch(/fixtureCause|fixtureError|fixtureArray|fixtureModule|fixtureControl/);
      expect(output).toContain("RATE_LIMIT");
      expect(output).toContain("TypeError");
      expect(output).toContain("ordinary");
      expect(output).toContain("[Circular]");
    }
    expect(error.message).toBe("HTTP 429 appSecret=fixtureError");
    expect(error.cause).toBe(cause);
    expect(input.data[0].aesKey).toBe("fixtureArray");
  });
});
