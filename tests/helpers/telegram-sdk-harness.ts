import { vi } from "vitest";
import { createTelegramAdapter } from "../../lib/bridge/telegram-adapter.ts";

const adapters: ReturnType<typeof createTelegramAdapter>[] = [];
let serial = 0;
export const telegramOk = (result: unknown) => Response.json({ ok: true, result });
export function telegramPending(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
export function telegramFixture(overrides: Record<string, (params: URLSearchParams, init: RequestInit) => Promise<Response> | Response> = {}) {
  const calls: { url: string; method: string; params: URLSearchParams; init: RequestInit }[] = [];
  const onStatus = vi.fn();
  const onMessage = vi.fn();
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = String(input).split("/").pop()!;
    const params = new URLSearchParams(init.body instanceof URLSearchParams ? init.body : "");
    calls.push({ url: String(input), method, params, init });
    if (overrides[method]) return overrides[method](params, init);
    if (method === "getUpdates") return telegramPending(init.signal);
    if (method === "getMe") return telegramOk({ id: 42, is_bot: true, first_name: "Synthetic", username: "synthetic_bot" });
    if (method === "getUserProfilePhotos") return telegramOk({ total_count: 0, photos: [] });
    return telegramOk({ message_id: 1 });
  });
  const options = { token: `12345:SYNTHETIC_ONLY_${++serial}`, agentId: `u17-${serial}`, onMessage, onStatus, fetch };
  const adapter = createTelegramAdapter(options);
  adapters.push(adapter);
  return { adapter, calls, fetch, onStatus, onMessage, options };
}
export async function stopTelegramFixtures() { await Promise.all(adapters.splice(0).map(a => a.stop())); }
export function registerTelegramFixture(adapter: ReturnType<typeof createTelegramAdapter>) { adapters.push(adapter); return adapter; }
