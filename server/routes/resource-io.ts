import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { createApiResourceOperationContext, requestIdFromHono } from "../http/resource-operation-context.ts";

export function createResourceIoRoute(engine) {
  const route = new Hono();
  const releases = new Map();

  route.post("/resource-io/subscribe", async (c) => {
    try {
      const body = await safeJson(c);
      const subscribe = engine.subscribeResourceWatch?.(body);
      if (!subscribe?.subscriptionId) {
        return c.json({ error: "resource watch unavailable" }, 500);
      }
      return c.json({ ok: true, ...subscribe });
    } catch (err) {
      return errorJson(c, err);
    }
  });

  route.delete("/resource-io/subscriptions/:subscriptionId", (c) => {
    const subscriptionId = c.req.param("subscriptionId");
    const released = Boolean(engine.unsubscribeResourceWatch?.(subscriptionId));
    return c.json({ ok: true, released });
  });

  route.get("/resource-io/watch-diagnostics", (c) => {
    return c.json({ ok: true, diagnostics: engine.resourceWatchDiagnostics?.() || { subscriptions: 0, watches: [] } });
  });

  route.get("/resource-io/events", (c) => {
    try {
      const since = numericCursor(c.req.query("since"));
      const result = resourceEventsSince(engine, since);
      if (result?.stale) {
        return c.json({
          ...result,
          resync: "resource-stat-required",
        });
      }
      return c.json(result);
    } catch (err) {
      return errorJson(c, err, 500);
    }
  });

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
      return errorJson(c, err);
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

  route.post("/resource-io/stat", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target || body;
    return resourceIO.stat(resource);
  }));

  route.post("/resource-io/read", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target || body;
    const result = await resourceIO.read(resource);
    return {
      ...result,
      content: Buffer.isBuffer(result.content)
        ? result.content.toString("utf-8")
        : Buffer.from(result.content || "").toString("utf-8"),
      encoding: "utf-8",
    };
  }));

  route.post("/resource-io/list", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target || body;
    return resourceIO.list(resource);
  }));

  route.post("/resource-io/search", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target || body;
    return resourceIO.search(resource, { query: body?.query });
  }));

  route.post("/resource-io/write", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target;
    return resourceIO.write(resource, String(body?.content ?? ""), operationContextFromBody(body, c));
  }));

  route.post("/resource-io/write-expected-version", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target;
    return resourceIO.writeExpectedVersion(
      resource,
      String(body?.content ?? ""),
      body?.expectedVersion,
      operationContextFromBody(body, c),
    );
  }));

  route.post("/resource-io/rename", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    return resourceIO.rename(body?.from || body?.oldResource, body?.to || body?.newResource, operationContextFromBody(body, c));
  }));

  route.post("/resource-io/move", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    return resourceIO.move(body?.from || body?.oldResource, body?.to || body?.newResource, operationContextFromBody(body, c));
  }));

  route.post("/resource-io/trash", async (c) => resourceJson(c, engine, async (resourceIO, body) => {
    const resource = body?.resource || body?.ref || body?.target;
    return resourceIO.trash(resource, body?.trash || {}, operationContextFromBody(body, c));
  }));

  return route;
}

function operationContextFromBody(body, c) {
  const principal = body?.principal && typeof body.principal === "object" ? body.principal : {};
  return createApiResourceOperationContext({
    reason: body?.reason || "resource_io_route",
    sessionId: body?.sessionId ?? principal.sessionId,
    sessionPath: body?.sessionPath ?? principal.sessionPath,
    requestId: body?.requestId ?? principal.requestId ?? requestIdFromHono(c),
    principal: {
      ...principal,
      userId: body?.userId ?? principal.userId,
      studioId: body?.studioId ?? principal.studioId,
      connectionKind: body?.connectionKind ?? principal.connectionKind,
      credentialKind: body?.credentialKind ?? principal.credentialKind,
    },
  });
}

async function resourceJson(c, engine, handler) {
  try {
    const body = await safeJson(c);
    const resourceIO = engine.resourceIO || engine.getResourceIO?.();
    if (!resourceIO) return c.json({ error: "resource io unavailable" }, 500);
    const result = await handler(resourceIO, body);
    if (isConflictResult(result)) {
      return c.json({
        ...result,
        safeMessage: result.safeMessage || "Resource write conflict",
      }, 409);
    }
    return c.json(result);
  } catch (err) {
    return errorJson(c, err);
  }
}

function isConflictResult(result) {
  return Boolean(result?.ok === false && result?.conflict === true);
}

function numericCursor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function resourceEventsSince(engine, sequence) {
  if (typeof engine?.resourceEventsSince === "function") {
    return engine.resourceEventsSince(sequence);
  }
  const bus = engine?.resourceEventBus || engine?.getResourceIO?.()?.eventBus || engine?.resourceIO?.eventBus;
  if (bus && typeof bus.since === "function") {
    return bus.since(sequence);
  }
  const err: any = new Error("resource event catch-up unavailable");
  err.code = "resource_event_catch_up_unavailable";
  throw err;
}

function errorJson(c, err, fallbackStatus = 400) {
  const safeMessage = typeof err?.safeMessage === "string" && err.safeMessage
    ? err.safeMessage
    : null;
  return c.json({
    error: safeMessage || err?.message || String(err),
    ...(err?.code ? { code: err.code } : {}),
    ...(safeMessage ? { safeMessage } : {}),
  }, err?.status || fallbackStatus);
}
