import { Agent, fetch as undiciFetch } from "undici";
import { fetchDispatcherForUrl } from "./outbound-proxy.ts";

// Explicit direct dispatcher: a null per-URL result must not fall through to
// an inherited/global proxy. Resolve policy again on every request.
const directDispatcher = new Agent();

export const telegramFetch: typeof fetch = async (input, init = {}) => {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const { dispatcher } = fetchDispatcherForUrl(url);
  const response = await undiciFetch(url, {
    ...init,
    dispatcher: dispatcher || directDispatcher,
    // API bodies and file URLs contain credentials. Telegram's fixed endpoints
    // do not require redirects; never forward them to a redirected destination.
    redirect: "manual",
  } as Parameters<typeof undiciFetch>[1]);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("Telegram redirect refused");
  }
  return response as unknown as Response;
};

export function telegramApiOptions(fetchImpl: typeof fetch = telegramFetch) {
  // Polling retries belong to longPoll. An unknown send result must never be
  // replayed by the SDK's default transport retry policy.
  return { fetch: fetchImpl, maxRetries: 0, timeoutMs: 30_000 };
}
