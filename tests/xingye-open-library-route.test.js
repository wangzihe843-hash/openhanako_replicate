import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function buildTestApp() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xy-ol-proxy-"));
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

describe("xingye open-library search proxy", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("builds the /subjects/<slug>.json URL when only subject is provided and passes JSON through", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ works: [{ key: "/works/OL1W", title: "Sample" }] }),
    });
    globalThis.fetch = fetchMock;

    const { app } = await buildTestApp();
    const res = await app.request("/api/xingye/open-library/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "War Memoir", limit: 5 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.url).toBe("https://openlibrary.org/subjects/war_memoir.json?limit=5");
    expect(body.data).toEqual({ works: [{ key: "/works/OL1W", title: "Sample" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://openlibrary.org/subjects/war_memoir.json?limit=5",
    );
  });

  it("builds /search.json with q/title/author/subject and clamps limit to [1, 20]", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ docs: [] }),
    });
    globalThis.fetch = fetchMock;

    const { app } = await buildTestApp();
    const res = await app.request("/api/xingye/open-library/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "anarchism", subject: "philosophy", limit: 999 }),
    });
    expect(res.status).toBe(200);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/search.json");
    expect(url.searchParams.get("q")).toBe("anarchism");
    expect(url.searchParams.get("subject")).toBe("philosophy");
    expect(url.searchParams.get("limit")).toBe("20");
  });

  it("rejects empty queries with HTTP 400", async () => {
    globalThis.fetch = vi.fn();
    const { app } = await buildTestApp();
    const res = await app.request("/api/xingye/open-library/search", {
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

  it("returns 502 with HTTP status when Open Library is non-OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const { app } = await buildTestApp();
    const res = await app.request("/api/xingye/open-library/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "history" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Open Library 查询失败：HTTP 503");
  });

  it("returns 502 with Chinese reason when fetch itself fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const { app } = await buildTestApp();
    const res = await app.request("/api/xingye/open-library/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "history" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Open Library 请求失败：ENOTFOUND");
  });

  it("never lets the client choose a non-openlibrary URL — input fields can only seed query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ docs: [] }) });
    globalThis.fetch = fetchMock;

    const { app } = await buildTestApp();
    await app.request("/api/xingye/open-library/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: "anything",
        url: "https://evil.example.com/steal",
        host: "evil.example.com",
        path: "/etc/passwd",
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const called = String(fetchMock.mock.calls[0][0]);
    expect(called.startsWith("https://openlibrary.org/")).toBe(true);
    expect(called).not.toContain("evil.example.com");
    expect(called).not.toContain("/etc/passwd");
  });
});
