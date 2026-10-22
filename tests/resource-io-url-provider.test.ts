import dns from "dns";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrlProvider } from "../lib/resource-io/providers/url-provider.ts";
import { ResourceIO } from "../lib/resource-io/resource-io.ts";
import { wrapResourceIoFileTools } from "../lib/resource-io/agent-tools.ts";
import { createSandboxResourceIO } from "../lib/resource-io/sandbox-resource-io.ts";
import { createMaterializeTool } from "../lib/resource-io/materialize-tool.ts";

const CAPABILITY_KEYS = [
  "stat",
  "read",
  "write",
  "writeExpectedVersion",
  "edit",
  "list",
  "search",
  "watch",
  "materialize",
  "copy",
  "rename",
  "move",
  "trash",
  "delete",
  "mkdir",
].sort();

// ResourceIO's existing IPv4 policy, including both ends and adjacent addresses.
// Other special-use ranges intentionally remain outside this provider's deny set.
const IPV4_CASES = [
  ["0.0.0.0", true], ["0.255.255.255", true], ["1.0.0.0", false],
  ["9.255.255.255", false], ["10.0.0.0", true], ["10.255.255.255", true], ["11.0.0.0", false],
  ["126.255.255.255", false], ["127.0.0.0", true], ["127.255.255.255", true], ["128.0.0.0", false],
  ["169.253.255.255", false], ["169.254.0.0", true], ["169.254.255.255", true], ["169.255.0.0", false],
  ["172.15.255.255", false], ["172.16.0.0", true], ["172.31.255.255", true], ["172.32.0.0", false],
  ["192.167.255.255", false], ["192.168.0.0", true], ["192.168.255.255", true], ["192.169.0.0", false],
  ["8.8.8.8", false], ["93.184.216.34", false], ["100.64.0.1", false],
  ["192.0.0.1", false], ["198.18.0.1", false], ["224.0.0.1", false], ["240.0.0.1", false],
] as const;

function mappedForms(address: string): string[] {
  const octets = address.split(".").map(Number);
  const high = ((octets[0] << 8) | octets[1]).toString(16);
  const low = ((octets[2] << 8) | octets[3]).toString(16);
  return [
    `::ffff:${address}`,
    `::ffff:${high}:${low}`,
    `0:0:0:0:0:ffff:${address}`,
    `0000:0000:0000:0000:0000:FFFF:${high.padStart(4, "0")}:${low.padStart(4, "0")}`.toUpperCase(),
    `0::ffff:${high}:${low}`,
  ];
}

const IPV6_CASES = [
  ["::", true], ["0:0:0:0:0:0:0:0", true],
  ["::1", true], ["0:0:0:0:0:0:0:1", true], ["0000::0001", true],
  ["fc00::", true], ["FC00:0000:0000:0000:0000:0000:0000:0001", true],
  ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true],
  ["fe80::", true], ["FE80:0000:0000:0000:0000:0000:0000:0001", true],
  ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true],
  ["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["fe00::", false],
  ["fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["fec0::", false],
  ["2606:4700:4700::1111", false], ["::2", false], ["::127.0.0.1", false],
  ["::ffff:0:7f00:1", false], ["64:ff9b::7f00:1", false], ["64:ff9b:1::1", false],
  ["2001::1", false], ["2002:7f00:1::", false], ["ff02::1", false],
] as const;

function fixture(addresses = ["93.184.216.34"]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("safe", { headers: { etag: '"v1"' } }));
  const resolveHostname = vi.fn(async (_hostname: string) => addresses);
  return { fetch, resolveHostname, provider: new UrlProvider({ fetch, resolveHostname }) };
}

const PRIVATE_URL_ERROR = { code: "blocked_private_url", status: 403 };

describe("UrlProvider", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reads and materializes safe http resources with version metadata", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-url-"));
    const fetch = vi.fn(async () => new Response("hello url", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        etag: "\"abc\"",
        "last-modified": "Sun, 21 Jun 2026 00:00:00 GMT",
      },
    }));
    const provider = new UrlProvider({
      fetch,
      materializeRoot: tempRoot,
      resolveHostname: async () => ["93.184.216.34"],
    });

    const read = await provider.read({ kind: "url", url: "https://example.com/a.txt" });
    expect(read.content.toString("utf-8")).toBe("hello url");
    expect(read).toMatchObject({
      resourceKey: "url:https://example.com/a.txt",
      resource: {
        kind: "url",
        url: "https://example.com/a.txt",
        provider: "url",
      },
      version: {
        size: 9,
        etag: "\"abc\"",
      },
    });

    const materialized = await provider.materialize({ kind: "url", url: "https://example.com/a.txt" });
    expect(fs.readFileSync(materialized.filePath, "utf-8")).toBe("hello url");
  });

  it("rejects unsafe schemes, localhost, private ranges, and writes", async () => {
    const provider = new UrlProvider({
      fetch: vi.fn(),
      resolveHostname: async (hostname) => hostname === "private.test" ? ["10.0.0.2"] : ["93.184.216.34"],
    });

    await expect(provider.read({ kind: "url", url: "file:///etc/passwd" }))
      .rejects.toMatchObject({ code: "invalid_url_scheme" });
    await expect(provider.read({ kind: "url", url: "http://localhost/a" }))
      .rejects.toMatchObject({ code: "blocked_private_url" });
    await expect(provider.read({ kind: "url", url: "https://private.test/a" }))
      .rejects.toMatchObject({ code: "blocked_private_url" });
    await expect(provider.write({ kind: "url", url: "https://example.com/a" }, "x"))
      .rejects.toMatchObject({ code: "capability_denied" });
  });

  it("declares complete read-only capabilities and denies direct mutations", async () => {
    const provider = new UrlProvider({
      fetch: vi.fn(),
      resolveHostname: async () => ["93.184.216.34"],
    });
    const ref = { kind: "url" as const, url: "https://example.com/a.txt" };

    expect(Object.keys(provider.capabilities()).sort()).toEqual(CAPABILITY_KEYS);
    await expect(provider.write(ref, "x")).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.writeExpectedVersion(ref, "x", { mtimeMs: 1, size: 1 })).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.edit(ref, [{ oldText: "a", newText: "b" }])).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.rename(ref, ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.move(ref, ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.trash(ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.delete(ref)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(provider.mkdir(ref)).rejects.toMatchObject({ code: "capability_denied" });
  });

  it.each(IPV4_CASES)("classifies IPv4 %s and its mapped forms consistently (blocked=%s)", async (address, blocked) => {
    for (const value of [address, ...mappedForms(address)]) {
      const { provider, fetch } = fixture([value]);
      const operation = provider.read({ kind: "url", url: "https://fixture.example/a" });
      if (blocked) {
        await expect(operation, value).rejects.toMatchObject(PRIVATE_URL_ERROR);
        expect(fetch, value).not.toHaveBeenCalled();
      } else {
        expect((await operation).content.toString(), value).toBe("safe");
        expect(fetch, value).toHaveBeenCalledTimes(1);
      }
    }
  });

  it.each(IPV6_CASES)("classifies IPv6 DNS answer %s by address value (blocked=%s)", async (address, blocked) => {
    const { provider, fetch } = fixture([address]);
    const operation = provider.read({ kind: "url", url: "https://fixture.example/a" });
    if (blocked) {
      await expect(operation).rejects.toMatchObject(PRIVATE_URL_ERROR);
      expect(fetch).not.toHaveBeenCalled();
    } else {
      expect((await operation).content.toString()).toBe("safe");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["fc", "fc0", "fd", "fd0", "fe8", "fe9", "fea", "feb"])("does not mistake the short first group %s for ULA or link-local", async (group) => {
    // fc::1 is 00fc::1, outside fc00::/7; fe8::1 is outside fe80::/10.
    for (const address of [`${group}::1`, `${group.padStart(4, "0")}::1`, `${group.padStart(4, "0")}:0:0:0:0:0:0:1`]) {
      const resolved = fixture([address]);
      await expect(resolved.provider.assertSafeUrl("https://fixture.example/")).resolves.toBeInstanceOf(URL);
      const literal = fixture();
      await expect(literal.provider.assertSafeUrl(`https://[${address}]/`)).resolves.toBeInstanceOf(URL);
      expect(literal.resolveHostname).not.toHaveBeenCalled();
    }
  });

  it.each([
    ...IPV6_CASES,
    ...IPV4_CASES.flatMap(([address, blocked]) => mappedForms(address).map(value => [value, blocked] as const)),
  ])("checks bracketed literal %s without DNS (blocked=%s)", async (address, blocked) => {
    const { provider, fetch, resolveHostname } = fixture();
    const url = `https://[${address}]:9443/a.txt?x=1#fragment`;
    const operation = provider.read({ kind: "url", url });
    if (blocked) {
      await expect(operation).rejects.toMatchObject(PRIVATE_URL_ERROR);
      expect(fetch).not.toHaveBeenCalled();
    } else {
      const result = await operation;
      expect(result).toMatchObject({
        resourceKey: `url:${url}`,
        resource: { url, provider: "url", displayName: new URL(url).href },
        version: { size: 4, etag: '"v1"' },
      });
      expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL(url).href, {
        redirect: "manual", signal: expect.any(AbortSignal),
      });
    }
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it.each(["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "%31%32%37.0.0.1"])("checks IPv4 URL parser aliases: %s", async (host) => {
    const { provider, fetch, resolveHostname } = fixture();
    await expect(provider.fetchSafe(`http://${host}/`)).rejects.toMatchObject(PRIVATE_URL_ERROR);
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it.each([
    "not a URL", "http://[::ffff:127.1]/", "http://[::ffff:127.000.0.1]/",
    "http://::1/", "http://[::gg]/", "http://[::1%25lo0]/", "http://[::1]]/", "http://256.1.1.1/",
  ])("preserves invalid_url/400 for %s", async (url) => {
    const { provider, fetch, resolveHostname } = fixture();
    await expect(provider.fetchSafe(url)).rejects.toMatchObject({ code: "invalid_url", status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it.each(["file:///tmp/synthetic", "ftp://example.com/", "data:text/plain,synthetic"])("preserves scheme error for %s", async (url) => {
    const { provider, fetch, resolveHostname } = fixture();
    await expect(provider.assertSafeUrl(url)).rejects.toMatchObject({ code: "invalid_url_scheme", status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it.each(["localhost", "sub.localhost", "LOCALHOST"])("rejects localhost name %s before resolution", async (host) => {
    const { provider, fetch, resolveHostname } = fixture();
    await expect(provider.fetchSafe(`https://${host}/`)).rejects.toMatchObject(PRIVATE_URL_ERROR);
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it.each([
    [], [""], ["not-an-ip"], ["127.1"], [" 93.184.216.34"], ["256.0.0.1"],
    ["[::1]"], ["::ffff:127.00.0.1"], ["1:2:3:4:5:6:7:8:9"],
    ["93.184.216.34", "::ffff:7f00:1"], ["::ffff:7f00:1", "93.184.216.34"],
    ["2606:4700:4700::1111", "0:0:0:0:0:0:0:1"], ["93.184.216.34", "invalid"],
    ["::1%lo0"], ["fe80::1%eth0"], ["::ffff:127.0.0.1%lo0"],
  ])("rejects empty, invalid, or partly forbidden DNS answers %#", async (...addresses: string[]) => {
    const { provider, fetch } = fixture(addresses);
    await expect(provider.fetchSafe("https://fixture.example/")).rejects.toMatchObject(PRIVATE_URL_ERROR);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts all-public DNS answers and preserves the resolver's rejection identity", async () => {
    const { provider, fetch, resolveHostname } = fixture(["93.184.216.34", "::ffff:8.8.8.8", "2606:4700:4700::1111"]);
    await provider.read({ kind: "url", url: "https://EXAMPLE.com/a" });
    expect(resolveHostname).toHaveBeenCalledExactlyOnceWith("example.com");
    expect(fetch).toHaveBeenCalledTimes(1);
    const failure = new Error("synthetic resolver rejection");
    resolveHostname.mockRejectedValueOnce(failure);
    await expect(provider.fetchSafe("https://example.com/a")).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])("rechecks a %i redirect to a mapped literal or DNS answer", async (status) => {
    for (const location of ["http://[0:0:0:0:0:ffff:127.0.0.1]/private", "https://mapped.example/private"]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status, headers: { location } }));
      const provider = new UrlProvider({
        fetch,
        resolveHostname: async host => host === "mapped.example" ? ["::ffff:7f00:1"] : ["93.184.216.34"],
      });
      await expect(provider.fetchSafe("https://example.com/start")).rejects.toMatchObject(PRIVATE_URL_ERROR);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("checks later hops while preserving relative Location, original identity and public mapped URLs", async () => {
    const { provider, fetch } = fixture();
    fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "../next?x=1#f" } }));
    fetch.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://[::ffff:8.8.8.8]/final" } }));
    const url = "https://example.com/dir/start";
    const result = await provider.read({ kind: "url", url });
    expect(fetch.mock.calls.map(([target]) => target)).toEqual([
      url, "https://example.com/next?x=1#f", "https://[::ffff:808:808]/final",
    ]);
    expect(result.resourceKey).toBe(`url:${url}`);
    expect(result.resource).toMatchObject({ url, displayName: "https://[::ffff:808:808]/final" });

    fetch.mockClear();
    fetch.mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/next" } }));
    fetch.mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: "http://[::ffff:a00:1]/" } }));
    await expect(provider.fetchSafe(url)).rejects.toMatchObject(PRIVATE_URL_ERROR);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains redirect limit and missing Location errors", async () => {
    const { provider, fetch } = fixture();
    provider.maxRedirects = 1;
    fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/again" } }));
    await expect(provider.fetchSafe("https://example.com/")).rejects.toMatchObject({ code: "url_redirect_limit", status: 400 });
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(provider.fetchSafe("https://example.com/")).rejects.toMatchObject({ code: "invalid_url_redirect", status: 400 });
  });

  it("retains timeout abort and clears its timer", async () => {
    vi.useFakeTimers();
    const { provider, fetch } = fixture();
    provider.timeoutMs = 20;
    fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const operation = expect(provider.fetchSafe("https://[::ffff:8.8.8.8]/")).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20);
    await operation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stat", "read", "materialize"] as const)("enforces the same boundary through ResourceIO.%s", async (method) => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-url-boundary-"));
    const { provider, fetch } = fixture(["::ffff:7f00:1"]);
    provider.materializeRoot = path.join(tempRoot, "staged");
    const io = new ResourceIO({ providers: { url: provider } });
    for (const input of [
      { kind: "url", url: "https://fixture.example/a.txt" },
      { href: "https://fixture.example/a.txt" },
      { target: { type: "url", href: "https://fixture.example/a.txt" } },
    ]) await expect(io[method](input)).rejects.toMatchObject(PRIVATE_URL_ERROR);
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(provider.materializeRoot)).toBe(false);

    const url = "https://[::ffff:8.8.8.8]:9443/a.txt?x=1#f";
    const result = await io[method]({ kind: "url", url });
    expect(result).toMatchObject({ resourceKey: `url:${url}`, resource: { url }, version: { size: 4, etag: '"v1"' } });
    if (method === "materialize") {
      const entries = fs.readdirSync(provider.materializeRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^[a-f0-9]{64}\.txt$/);
      expect(fs.readFileSync(path.join(provider.materializeRoot, entries[0]), "utf8")).toBe("safe");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("enforces classification through production sandbox wiring and tool aliases", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-url-wiring-"));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("safe"));
    vi.stubGlobal("fetch", fetch);
    const lookup = vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "::ffff:7f00:1", family: 6 }] as never);
    const staged = path.join(tempRoot, "staged");
    const io = createSandboxResourceIO({ cwd: tempRoot, agentDir: tempRoot, hanakoHome: tempRoot, urlMaterializeRoot: staged });
    const legacyRead = vi.fn();
    const [read] = wrapResourceIoFileTools([{ name: "read", parameters: {}, execute: legacyRead }], { cwd: tempRoot, resourceIO: io });
    const blocked = "https://fixture.example/a.txt";
    for (const params of [
      { url: blocked }, { href: blocked }, { resource: blocked },
      { resource: { kind: "remote-url", uri: blocked } }, { ref: { kind: "http", href: blocked } },
    ]) await expect(read.execute("read-url", params)).rejects.toMatchObject(PRIVATE_URL_ERROR);
    expect(lookup).toHaveBeenCalledWith("fixture.example", { all: true, verbatim: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(legacyRead).not.toHaveBeenCalled();
    const materialize = createMaterializeTool({ cwd: tempRoot, resourceIO: io });
    expect(await materialize.execute("materialize-url", { resource: { kind: "url", url: blocked } }))
      .toMatchObject({ isError: true, details: { errorCode: "materialize_failed" } });
    expect(fs.existsSync(staged)).toBe(false);

    lookup.mockClear();
    const allowed = "https://[::ffff:8.8.8.8]/a.txt";
    expect((await read.execute("read-url", { url: allowed })).content[0].text).toContain("safe");
    expect(await materialize.execute("materialize-url", { resource: { kind: "url", url: allowed } }))
      .toMatchObject({ details: { resourceKey: `url:${allowed}` } });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(staged)).toHaveLength(1);
  });
});
