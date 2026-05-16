import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function buildTestApp() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xy-wikiquote-"));
  const agentsDir = path.join(tempRoot, "agents");
  fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
  const engine = {
    agentsDir,
    userName: "liyu",
    resolveUtilityConfig: () => null,
    resolveModelWithCredentials: () => null,
    getAgent: (id) => (id === "agent-a" ? { id, name: "A" } : null),
    listAgents: () => [{ id: "agent-a", name: "A" }],
  };
  const { createXingyeRoute } = await import("../server/routes/xingye.js");
  const app = new Hono();
  app.route("/api", createXingyeRoute(engine));
  return { app, tempRoot };
}

describe("xingye wikiquote search proxy", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("hits en.wikiquote.org/w/api.php and extracts quoted lines from wikitext", async () => {
    const wikitext = [
      "== Quotes ==",
      "* \"When a man is denied the right to live the life he believes in, he has no choice but to become an outlaw.\"",
      "** Nelson Mandela, autobiography",
      "* \"Education is the most powerful weapon which you can use to change the world.\" {{cite|book}}",
      "* Not a quoted line; should be skipped",
      "* \"Too short\"",
    ].join("\n");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ parse: { title: "Nelson Mandela", wikitext } }),
    });
    globalThis.fetch = fetchMock;

    const { app } = await buildTestApp();
    const res = await app.request("/api/xingye/quotes/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Long Walk to Freedom", authors: ["Nelson Mandela"], lang: "en" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe("wikiquote");
    expect(body.lang).toBe("en");
    expect(Array.isArray(body.quotes)).toBe(true);
    const texts = body.quotes.map((q) => q.text);
    expect(texts).toContain("When a man is denied the right to live the life he believes in, he has no choice but to become an outlaw.");
    expect(texts).toContain("Education is the most powerful weapon which you can use to change the world.");
    expect(texts.every((t) => t.length >= 12)).toBe(true);
    // 每条都有 wikiquote citation
    expect(body.quotes.every((q) => q.sourceCitation?.provider === "wikiquote")).toBe(true);
    expect(body.quotes[0].sourceCitation.pageUrl).toContain("en.wikiquote.org");
  });

  it("rejects empty queries with HTTP 400", async () => {
    globalThis.fetch = vi.fn();
    const { app } = await buildTestApp();
    const res = await app.request("/api/xingye/quotes/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/至少提供/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns empty quotes (200) when no pages match", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const { app } = await buildTestApp();
    const res = await app.request("/api/xingye/quotes/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Nonexistent Book Title 9q8w7e" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.quotes).toEqual([]);
  });

  it("only calls wikiquote.org, ignoring any url/host fields a client sneaks in", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ parse: { title: "X", wikitext: "* \"valid quote line goes here.\"" } }),
    });
    globalThis.fetch = fetchMock;
    const { app } = await buildTestApp();
    await app.request("/api/xingye/quotes/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "X",
        url: "https://evil.example.com/steal",
        host: "evil.example.com",
      }),
    });
    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url.startsWith("https://en.wikiquote.org/") || url.startsWith("https://zh.wikiquote.org/")).toBe(true);
      expect(url).not.toContain("evil.example.com");
    }
  });

  it("respects lang=zh and falls back to en for any other lang", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ parse: { title: "X", wikitext: "* \"valid quote line goes here.\"" } }),
    });
    globalThis.fetch = fetchMock;
    const { app } = await buildTestApp();

    await app.request("/api/xingye/quotes/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "活着", lang: "zh" }),
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://zh.wikiquote.org/");

    fetchMock.mockClear();
    await app.request("/api/xingye/quotes/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "X", lang: "fr" }),
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://en.wikiquote.org/");
  });
});

describe("extractWikiquoteLines", () => {
  it("strips templates, refs, links, and rejects too-short/too-long lines", async () => {
    const { extractWikiquoteLines } = await import("../server/routes/xingye.js");
    const wikitext = [
      "* \"A meaningful sentence with [[link|some]] [https://x.example body] markup.\" {{cite}}",
      "* \"x\"",
      "* '''bold quote text long enough to qualify as a sentence with period.'''",
      "* Plain text without quote marks but ends with period.",
      "* Short.",
    ].join("\n");
    const out = extractWikiquoteLines(wikitext);
    expect(out).toContain("A meaningful sentence with some body markup.");
    expect(out.find((l) => l === "x")).toBeUndefined();
    expect(out.some((l) => l.includes("bold quote text long enough"))).toBe(true);
  });
});
