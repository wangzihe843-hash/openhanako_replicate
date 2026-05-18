import { Hono } from "hono";
import { createServerRuntimeContext, toServerIdentityResponse } from "../../core/server-runtime-context.js";

export function createServerIdentityRoute({ hanakoHome, appVersion = "?", getRuntimeContext } = {}) {
  const route = new Hono();

  route.get("/server/identity", (c) => {
    try {
      const runtimeContext = typeof getRuntimeContext === "function"
        ? getRuntimeContext()
        : createServerRuntimeContext({ hanakoHome, appVersion });
      return c.json(toServerIdentityResponse(runtimeContext, { appVersion }));
    } catch (err) {
      return c.json({
        error: "invalid server identity registry",
        detail: err.message,
      }, 500);
    }
  });

  return route;
}
