import { Hono } from "hono";

export function createUsageRoute(engine) {
  const route = new Hono();

  route.get("/usage/llm", (c) => {
    const query = c.req.query();
    const filter = {};
    for (const key of [
      "since",
      "until",
      "attributionKind",
      "sessionPath",
      "agentId",
      "subsystem",
      "operation",
      "modelId",
      "provider",
      "status",
    ]) {
      if (typeof query[key] === "string" && query[key].trim()) filter[key] = query[key].trim();
    }
    const limit = Number(query.limit || 500);
    filter.limit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 2_000) : 500;
    return c.json(engine.usageLedger.list(filter));
  });

  return route;
}
