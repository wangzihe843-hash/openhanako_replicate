import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import esm from "../shared/log-redactor.ts";
import cjs from "../shared/log-redactor.cjs";
import { readWechatApiResponse } from "../lib/bridge/wechat-api.ts";
import { MediaDeliveryService } from "../lib/bridge/media-delivery-service.ts";
import { createModuleLogger, initDebugLog } from "../lib/debug-log.ts";

// Invalid synthetic values and .invalid hosts only; no network requests.
const short = "short-SYNTHETIC-Z9";
const hex = "b79a1f0c".repeat(8);
const percent = (value: string) => Array.from(value, char => `%${char.charCodeAt(0).toString(16)}`).join("");
const signatureValues = [short, hex, percent(hex), encodeURIComponent(percent(hex))];
const mediaUrl = (value: string, key = "X-Amz-Signature") => `https://storage.example.invalid/media?${key}=${value}&version=3&X-Amz-Expires=60`;
const wrap = (value: string) => `https://diagnostic.example.invalid/failure?detail=${encodeURIComponent(value)}`;
const diagnostic = "stage=upload httpStatus=503 log_id=aws-local-123";
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.each([["TS", esm], ["CJS", cjs]] as const)("%s namespaced signed URL redaction", (_name, api) => {
  it.each(["X-Amz-Signature", "x-amz-signature", "X-AMZ-SIGNATURE", "x-AmZ-SiGnAtUrE", "%58-Amz-Signature", "%2558-Amz-Signature", percent("X-Amz-Signature")])("recognizes %s without relying on signature length or encoding", key => {
    for (const value of signatureValues) {
      const cleaned = api.redactLogText(`${mediaUrl(value, key)} ${diagnostic}`);
      expect(cleaned).toBe(`https://storage.example.invalid/media?${key}=[redacted]&version=3&X-Amz-Expires=60 ${diagnostic}`);
      expect(api.redactLogText(cleaned)).toBe(cleaned);
    }
  });

  it("protects nested URLs, JSON, and natural Error causes without losing stack boundaries", () => {
    for (const value of signatureValues) {
      let url = mediaUrl(value);
      for (let depth = 0; depth < 5; depth++) {
        const cause = new Error(`${url} ${diagnostic}`);
        const source = cause.stack;
        for (const input of [url, JSON.stringify({ detail: url }), JSON.stringify({ detail: JSON.stringify({ url }) }), new AggregateError([cause], "upload failed", { cause })]) {
          const cleaned = api.redactLogText(input);
          expect(cleaned).not.toContain(value);
          expect(cleaned).not.toContain(short);
          expect(cleaned).toContain("[redacted]");
          expect(api.redactLogText(cleaned)).toBe(cleaned);
          expect(api.redactLogText(api.redactLogText(cleaned))).toBe(cleaned);
          if (typeof input !== "string") {
            expect(JSON.parse(cleaned).cause.stack).toContain("\n");
            expect(cleaned).toContain("log-redactor-signed-url.test.ts:");
          }
        }
        expect(cause.stack).toBe(source);
        url = wrap(url);
      }
    }
  });

  it("does not expose a canonical 64-hex signature when a sentence ends after the URL", () => {
    const url = `https://storage.example.invalid/media?version=3&X-Amz-Signature=${hex}`;
    for (const value of [url, wrap(url)]) {
      const input = `download failed ${value}. ${diagnostic}`;
      const cleaned = api.redactLogText(input);
      expect(cleaned).not.toContain(hex);
      expect(cleaned).toContain("[redacted]");
      expect(cleaned).toContain(diagnostic);
      expect(api.redactLogText(cleaned)).toBe(cleaned);
    }
  });

  it("uses the same sensitive-key contract for structured and text diagnostics", () => {
    for (const key of ["X-Amz-Signature", "x-amz-signature"]) {
      const input = { [key]: short, status: 503, "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-SignedHeaders": "host" };
      expect(api.redactLogValue(input)).toEqual({ ...input, [key]: "[redacted]" });
      for (const raw of [JSON.stringify(input), JSON.stringify({ detail: JSON.stringify(input) }), `${key}=${short} ${diagnostic}`, `${key}: "${short}\\ncontinued" ${diagnostic}`]) {
        const cleaned = api.redactLogText(raw);
        expect(cleaned).not.toMatch(/short-SYNTHETIC-Z9|continued/);
        expect(api.redactLogText(cleaned)).toBe(cleaned);
      }
      expect(input[key]).toBe(short);
    }
  });

  it("preserves ordinary metadata and similarly named diagnostic fields", () => {
    for (const ordinary of [
      "https://storage.example.invalid/media?version=3&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=60&X-Amz-SignedHeaders=host",
      "https://example.invalid/docs/X-Amz-Signature?version=3",
      "https://example.invalid/report?X-Amz-Signature-Count=3",
      "support-X-Amz-Signature=reference X-Amz-Signature-Count=3",
    ]) expect(api.redactLogText(ordinary)).toBe(ordinary);
  });
});

describe("signed URL production diagnostic boundaries", () => {
  it.each(["HTTP raw", "HTTP nested", "business raw", "business nested"])("removes synthetic signature values from %s errors, logs and notices", async mode => {
    for (const signature of [short, percent(hex), hex]) {
      const period = signature === hex;
      const media = period ? `https://storage.example.invalid/media?version=3&X-Amz-Signature=${hex}` : mediaUrl(signature);
      const url = mode.endsWith("nested") ? wrap(media) : media;
      const body = { ret: 1, errmsg: `media preparation failed ${url}${period ? "." : ""} log_id=aws-local-123` };
      const original = JSON.stringify(body);
      let error: Error | undefined;
      try { await readWechatApiResponse("ilink/bot/getuploadurl", new Response(original, { status: mode.startsWith("HTTP") ? 503 : 200 })); }
      catch (caught) { error = caught as Error; }
      expect(error).toBeInstanceOf(Error);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signed-url-redaction-"));
      temporary.push(dir);
      const log = initDebugLog(dir);
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      createModuleLogger("bridge").warn(`media send failed: ${error!.message} (remote_url:${media})`);
      const sendReply = vi.fn<(chatId: string, text: string) => Promise<void>>(async () => {});
      await new MediaDeliveryService().sendFailureNotice({ sendReply }, "synthetic-user", error);
      for (const output of [error!.message, error!.stack!, fs.readFileSync(log.filePath, "utf8"), JSON.stringify(consoleWarn.mock.calls), JSON.stringify(sendReply.mock.calls)]) {
        expect(output).not.toContain(signature);
        expect(output).not.toContain(encodeURIComponent(signature));
        expect(output).toContain("aws-local-123");
      }
      expect(error!.message).toContain(mode.startsWith("HTTP") ? "HTTP 503" : "ret=1");
      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(body)).toBe(original);
      consoleWarn.mockRestore();
    }
  });
});
