/**
 * web-fetch.js — web_fetch 自定义工具
 *
 * 让 agent 能抓取指定 URL 的内容并提取文本。
 * 流程：fetch → HTML → 提取正文文本（去标签）→ 截断返回
 *
 * 支持：HTML 页面、JSON API、纯文本
 */

import { createHash } from "node:crypto";
import { Type } from "../pi-sdk/index.ts";
import { DeepSeekToolError } from "../../shared/deepseek-tools.ts";
import { fetchDeepSeek } from "./deepseek-fetch.ts";
import type { FetchRateLimiter } from "./deepseek-fetch.ts";
import { SearchRateLimitError } from "./search-rate-limiter.ts";
import { isPrivateFetchHost, validateExternalFetchUrl, withFetchAbort } from "./web-fetch-url.ts";
import { t } from "../i18n.ts";
import { htmlToMarkdownDocument } from "./web-reader.ts";

const MAX_CONTENT_LENGTH = 12000;  // 返回最大字符数
const FETCH_TIMEOUT = 15000;       // 15 秒超时
const MAX_REDIRECTS = 5;

/**
 * 简易 HTML → 文本：去标签、合并空白
 */
function htmlToText(html) {
  // 移除 script / style / head 内容
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // 块级标签换行
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article|header)[^>]*>/gi, "\n");

  // 保留链接文本和 href
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");

  // 去掉剩余标签
  text = text.replace(/<[^>]+>/g, "");

  // HTML 实体
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

  // 合并空白
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

type ReadEvidence = {
  status: "complete" | "partial" | "failed";
  provider?: "deepseek";
  preflightUrl?: string;
  preflightHttpStatus?: number;
  providerHttpStatus?: number;
  providerContentHash?: string;
  scope: "single_response_text";
  sourceUrl: string;
  resolvedUrl?: string;
  processorVersion: "web-fetch/1";
  httpStatus?: number;
  contentType?: string;
  responseTextHash?: string;
  outputTextHash?: string;
  extractedCharacters?: number;
  returnedCharacters?: number;
  mediaReferences?: number;
  missingReasons: string[];
};

function textHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export type WebFetchRuntimeConfig = { provider?: string; resolveApiKey?: () => string };

export function createWebFetchTool({ fetchConfigResolver, rateLimiter }: {
  fetchConfigResolver?: (() => WebFetchRuntimeConfig) | null;
  rateLimiter?: FetchRateLimiter;
} = {}) {
  return {
    name: "web_fetch",
    label: "Fetch Web Page",
    description: "Fetch a URL and extract text with explicit read evidence. Check complete/partial/failed and missingReasons before claiming full content. Coverage is one response's text only; HTML extraction, dynamic content, linked pages and images are not verified as complete.",
    parameters: Type.Object({
      url: Type.String({ description: "Full URL to fetch (including https://)" }),
      maxLength: Type.Optional(
        Type.Number({ description: `Maximum characters to return, default ${MAX_CONTENT_LENGTH}`, default: MAX_CONTENT_LENGTH, minimum: 1 })
      ),
    }),
    execute: async (_toolCallId, params, signal?: AbortSignal) => {
      const url = typeof params.url === "string" ? params.url.trim() : "";
      const evidence: ReadEvidence = {
        status: "failed",
        scope: "single_response_text",
        sourceUrl: url,
        processorVersion: "web-fetch/1",
        missingReasons: [],
      };
      // Include the same evidence in model-visible text and structured details.
      // A successful HTTP request is not a claim that the source was fully read.
      const result = (body: string, reason?: string) => {
        if (reason) evidence.missingReasons.push(reason);
        return {
          ...(evidence.status === "failed" ? { isError: true as const } : {}),
          content: [{ type: "text" as const, text: `${body}\n\n[Read evidence: ${JSON.stringify(evidence)}]` }],
          details: { readEvidence: { ...evidence, missingReasons: [...evidence.missingReasons] } },
        };
      };
      if (!url) return result(t("error.fetchEmptyUrl"), "empty_url");
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return result(t("error.fetchHttpOnly"), "unsupported_protocol");
        }
      } catch {
        return result(t("error.fetchInvalidUrl", { url }), "invalid_url");
      }
      const requestedLength = params.maxLength ?? MAX_CONTENT_LENGTH;
      if (!Number.isFinite(requestedLength) || requestedLength < 1) {
        return result("maxLength must be a positive finite number.", "invalid_max_length");
      }
      const maxLen = Math.floor(requestedLength);
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)])
        : AbortSignal.timeout(FETCH_TIMEOUT);
      let external = false;
      try {
        requestSignal.throwIfAborted();
        const config = fetchConfigResolver?.() || { provider: "direct" };
        if (config.provider && !["direct", "deepseek"].includes(config.provider)) {
          return result("Invalid Web Fetch provider.", "invalid_config");
        }
        external = config.provider === "deepseek";
        if (external) {
          evidence.provider = "deepseek";
          validateExternalFetchUrl(url);
        }
        let currentUrl = url;
        let res: Response | undefined;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          requestSignal.throwIfAborted();
          const hopParsed = new URL(currentUrl);
          evidence.resolvedUrl = currentUrl;
          if (!["http:", "https:"].includes(hopParsed.protocol)) {
            return result(t("error.fetchHttpOnly"), "unsupported_redirect_protocol");
          }
          if (hopParsed.username || hopParsed.password) {
            return result("Credential-bearing URLs are not supported.", "sensitive_url");
          }
          if (external) validateExternalFetchUrl(currentUrl);
          // Keep the local redirect preflight for both backends. No URL is sent
          // to an extraction provider before the original per-hop checks pass.
          if (await withFetchAbort(isPrivateFetchHost(hopParsed.hostname), requestSignal)) {
            return result(t("error.fetchSsrf", { host: hopParsed.hostname }), "private_or_unresolved_host");
          }
          requestSignal.throwIfAborted();
          res = await withFetchAbort(fetch(currentUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; HanaAgentBot/1.0)",
              "Accept": "text/html,application/xhtml+xml,application/json,text/plain,*/*",
              "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
            redirect: "manual",
            signal: requestSignal,
          }), requestSignal);
          evidence.httpStatus = res.status;
          if ([301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers.get("location");
            await withFetchAbort(Promise.resolve(res.body?.cancel()), requestSignal);
            if (!location) return result("Redirect response has no location.", "redirect_without_location");
            currentUrl = new URL(location, currentUrl).href;
            continue;
          }
          break;
        }
        if (!res || [301, 302, 303, 307, 308].includes(res.status)) {
          return result(t("error.fetchRedirectLimit", { max: MAX_REDIRECTS }), "redirect_limit");
        }
        if (!res.ok) {
          await withFetchAbort(Promise.resolve(res.body?.cancel()), requestSignal);
          return result(t("error.fetchHttpError", { status: res.status, statusText: res.statusText }), "http_error");
        }
        if (res.status === 206 || res.headers.has("content-range")) {
          evidence.missingReasons.push("partial_response");
        }
        const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        evidence.contentType = contentType;
        const isJson = contentType === "application/json" || contentType.endsWith("+json");
        const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
        if (!isJson && !isHtml && !contentType.startsWith("text/")) {
          await withFetchAbort(Promise.resolve(res.body?.cancel()), requestSignal);
          return result("The response is not a supported text document.", "unsupported_or_missing_content_type");
        }
        if (external) {
          void res.body?.cancel().catch(() => {});
          evidence.preflightUrl = currentUrl;
          evidence.preflightHttpStatus = evidence.httpStatus;
          delete evidence.resolvedUrl;
          delete evidence.httpStatus;
          delete evidence.contentType;
          const page = await fetchDeepSeek(currentUrl, () => {
            const fresh = fetchConfigResolver?.();
            if (fresh?.provider !== "deepseek") throw new DeepSeekToolError("disabled", "DeepSeek Fetch is not enabled.");
            if (!fresh.resolveApiKey) throw new DeepSeekToolError("key_missing", "DeepSeek Fetch credentials are unavailable.");
            return fresh.resolveApiKey();
          }, requestSignal, rateLimiter);
          // The API describes extracted Markdown, not the fetched response or
          // its redirect chain. Do not reuse preflight evidence as remote proof.
          evidence.providerHttpStatus = 200;
          evidence.providerContentHash = textHash(page.content);
          evidence.missingReasons.push("provider_extraction_unverified", "remote_redirects_unverified");
          const text = (page.title ? `# ${page.title}\n\n` : "") + page.content;
          const output = text.slice(0, Math.min(maxLen, MAX_CONTENT_LENGTH));
          evidence.extractedCharacters = text.length;
          evidence.returnedCharacters = output.length;
          evidence.outputTextHash = textHash(output);
          if (output.length < text.length) evidence.missingReasons.push("output_truncated");
          evidence.status = "partial";
          const target = new URL(currentUrl);
          return result(t("error.fetchSource", { host: target.hostname, path: target.pathname, format: "DeepSeek Markdown" }) + output);
        }
        const raw = await withFetchAbort(res.text(), requestSignal);
        requestSignal.throwIfAborted();
        // Hash decoded response text, not HTTP bytes or the truncated output.
        evidence.responseTextHash = textHash(raw);
        let text = raw;
        let format = "text";
        if (isJson) {
          format = "json";
          try { text = JSON.stringify(JSON.parse(raw), null, 2); }
          catch { evidence.missingReasons.push("invalid_json"); }
        } else if (isHtml) {
          evidence.missingReasons.push("html_coverage_unverified");
          try {
            const doc = await htmlToMarkdownDocument(raw, currentUrl);
            text = doc.content;
            format = "markdown";
            evidence.mediaReferences = doc.coverage.mediaReferences;
            if (doc.coverage.mediaReferences > 0) evidence.missingReasons.push("media_not_read");
            if (doc.coverage.hasPasswordForm) evidence.missingReasons.push("login_form_detected");
            if (doc.coverage.hasScripts) evidence.missingReasons.push("script_content_not_executed");
          } catch {
            text = htmlToText(raw);
            format = "html→text";
            evidence.missingReasons.push("html_parser_failed_fallback");
          }
        }
        requestSignal.throwIfAborted();
        evidence.extractedCharacters = text.length;
        if (!text.trim()) return result("No readable response body was obtained.", "empty_body");
        const truncated = text.length > maxLen;
        const output = text.slice(0, maxLen);
        evidence.returnedCharacters = output.length;
        evidence.outputTextHash = textHash(output);
        if (truncated) evidence.missingReasons.push("output_truncated");
        evidence.status = evidence.missingReasons.length > 0 ? "partial" : "complete";
        const finalUrl = new URL(currentUrl);
        const header = t("error.fetchSource", { host: finalUrl.hostname, path: finalUrl.pathname, format });
        return result(header + output + (truncated ? t("error.fetchTruncated", { len: text.length }) : ""));
      } catch (err) {
        if (external && !signal?.aborted && !requestSignal.aborted) {
          const code = err instanceof SearchRateLimitError ? "rate_limit"
            : err instanceof DeepSeekToolError ? err.code : "transport_or_read_error";
          const message = err instanceof DeepSeekToolError || err instanceof SearchRateLimitError ? err.message : "DeepSeek Fetch request failed.";
          return result(message, code);
        }
        const reason = signal?.aborted ? "cancelled"
          : requestSignal.aborted || err.name === "TimeoutError" ? "timeout" : "transport_or_read_error";
        const msg = reason === "timeout"
          ? t("error.fetchTimeout", { sec: FETCH_TIMEOUT / 1000, url })
          : t("error.fetchError", { msg: reason === "cancelled" ? "cancelled" : err.message });
        return result(msg, reason);
      }
    },
  };
}
