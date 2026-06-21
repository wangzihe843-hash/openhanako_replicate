import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";

export function createResourceIoRoute(engine) {
  const route = new Hono();
  const releases = new Map();

  route.post("/resource-io/watch", async (c) => {
    try {
      const body = await safeJson(c);
      const resource = body?.resource || body?.ref || body?.target || body;
      const release = engine.retainResourceWatch?.(resource);
      if (typeof release !== "function") {
        return c.json({ error: "resource watch unavailable" }, 500);
      }
      const watchId = crypto.randomUUID();
      releases.set(watchId, release);
      return c.json({ ok: true, watchId });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }
  });

  route.delete("/resource-io/watch/:watchId", (c) => {
    const watchId = c.req.param("watchId");
    const release = releases.get(watchId);
    if (!release) return c.json({ ok: true, released: false });
    releases.delete(watchId);
    release();
    return c.json({ ok: true, released: true });
  });

  return route;
}
