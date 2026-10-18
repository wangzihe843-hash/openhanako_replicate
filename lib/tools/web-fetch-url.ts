import { lookup } from "dns/promises";
import { BlockList, isIP } from "node:net";
import { DeepSeekToolError } from "../../shared/deepseek-tools.ts";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ["2001::", 32], ["2002::", 16], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
] as const) blocked.addSubnet(address, prefix, "ipv6");

export async function isPrivateFetchHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host.includes(".") && !isIP(host)) return true;
  if (/(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)) return true;
  const isBlocked = (address: string) => {
    const family = isIP(address);
    return !family || blocked.check(address, family === 6 ? "ipv6" : "ipv4");
  };
  if (isIP(host)) return isBlocked(host);
  try {
    const results = await lookup(host, { all: true });
    return results.length === 0 || results.some(row => isBlocked(row.address));
  } catch { return true; }
}

/** Conservative disclosure boundary. Do not remove query/fragment and change the resource. */
export function validateExternalFetchUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new DeepSeekToolError("invalid_url", "DeepSeek Fetch requires a valid public HTTP(S) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || Array.from(value).length > 8192) {
    throw new DeepSeekToolError("invalid_url", "DeepSeek Fetch requires a public HTTP(S) URL of at most 8192 characters.");
  }
  if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) {
    throw new DeepSeekToolError("sensitive_url", "URLs with credentials, query strings or fragments cannot be sent to DeepSeek Fetch. Use direct fetching for public query URLs.");
  }
}

/** DNS, mocks and response readers must not hold a cancelled tool open. */
export async function withFetchAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    // The caller already created this promise. A synchronous transport abort
    // must not leave its later rejection unobserved when cancellation wins.
    void operation.catch(() => {});
    signal.throwIfAborted();
  }
  if (!signal) return operation;
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason || new DOMException("Fetch cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", onAbort!); }
}
