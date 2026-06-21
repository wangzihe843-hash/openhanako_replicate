import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createResourceIoRoute } from "../server/routes/resource-io.ts";

describe("resource-io route", () => {
  it("retains and releases backend resource watches", async () => {
    const release = vi.fn();
    const retainResourceWatch = vi.fn(() => release);
    const app = new Hono();
    app.route("/api", createResourceIoRoute({
      retainResourceWatch,
    }));

    const watchRes = await app.request("/api/resource-io/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp/a.md" } }),
    });
    const watchData = await watchRes.json();

    expect(watchRes.status).toBe(200);
    expect(retainResourceWatch).toHaveBeenCalledWith({ kind: "local-file", path: "/tmp/a.md" });
    expect(typeof watchData.watchId).toBe("string");

    const releaseRes = await app.request(`/api/resource-io/watch/${watchData.watchId}`, {
      method: "DELETE",
    });
    const releaseData = await releaseRes.json();

    expect(releaseRes.status).toBe(200);
    expect(releaseData).toEqual({ ok: true, released: true });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
