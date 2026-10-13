import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { complete, delay, gate, harness, json, modes, truncated, until, watch } from "./fixtures/mcp-http-fixture.ts";

const fresh = () => json({ access_token: "fixture-new", refresh_token: "fixture-new-refresh", expires_in: 3600 });
const invalid = () => json({ error: "invalid_grant", error_description: "terminal auth failure" }, 400);
function alive(h) {
  expect(h.manager.clients.get("remote")?.running).toBe(true);
  expect(h.manager.clientErrors.size).toBe(0);
  expect(h.manager.connectorStatus.size).toBe(0);
  expect(h.manager.reconnectState.size).toBe(0);
}

// 3 transports × 2 refresh entry points × (6 cancellation settlements +
// 5 credential/client generations × 2 late settlements) = 96 protections.
describe.each(modes)("%s refresh ownership", (mode) => {
  describe.each(["pre-refresh", "401-refresh"])("%s", (phase) => {
    it.each(["all-failure", "all-success", "survivor-failure", "survivor-success", "shared-abort", "transient"])(
      "settles %s once after cancelling waiters", async (scenario) => {
        const h = await harness(mode, { oauth: true, autoReconnect: true });
        const token = gate<Response>();
        h.replyToken(() => token.promise);
        const controllers = Array.from({ length: 4 }, () => new AbortController());
        let outcomes = [];
        try {
          if (phase === "pre-refresh") h.expire();
          else h.reply((body, init) => init.headers.Authorization === "Bearer fixture-old"
            ? truncated("unauthorized diagnostic", { status: 401 }) : h.respond(body, complete(mode)));
          outcomes = controllers.map((controller) => watch(h.run(controller.signal)));
          await until(() => h.tokenRequests.length === 1 && (phase === "pre-refresh" || h.calls.length === 4));
          const surviving = scenario.startsWith("survivor");
          const cancelled = surviving ? 3 : 4;
          for (let i = 0; i < cancelled; i++) controllers[i].abort();
          for (let i = 0; i < cancelled; i++) expect((await outcomes[i]).error).toBe(controllers[i].signal.reason);
          alive(h);
          expect(h.closes).toHaveLength(0);
          expect(h.manager.refreshInFlight.size).toBe(1);
          expect(h.tokenRequests[0].signal?.aborted).not.toBe(true);

          let response = scenario.endsWith("failure") ? invalid() : fresh();
          if (scenario === "shared-abort") response = truncated('{"access_token":', { error: new DOMException("auth source cancelled", "AbortError") });
          if (scenario === "transient") response = json({ error: "temporarily_unavailable" }, 503);
          token.resolve(response);
          await Promise.all(outcomes);
          await until(() => h.manager.refreshInFlight.size === 0);
          await delay();
          if (scenario.endsWith("failure")) {
            expect(h.manager.connectorStatusFor("remote")).toBe("needs-auth");
            expect(h.manager.clientErrors.get("remote")).toContain("terminal auth failure");
            expect(h.closes).toHaveLength(1);
            expect(h.manager.reconnectState.size).toBe(0);
          } else if (scenario === "transient") {
            expect(h.manager.connectorStatusFor("remote")).toBe("reconnecting");
            expect(h.closes).toHaveLength(1);
          } else { alive(h); expect(h.closes).toHaveLength(0); }
          if (surviving) {
            const result = await outcomes[3];
            expect(result.error).toBeUndefined();
            if (scenario.endsWith("success")) expect(result.value.content).toEqual(complete(mode).content);
            else { expect(result.value.isError).toBe(true); expect(result.value.content[0].text).toContain("terminal auth failure"); }
          }
          expect(h.calls).toHaveLength((phase === "pre-refresh" ? 0 : 4) + (scenario === "survivor-success" ? 1 : 0));
          expect(h.tokenRequests).toHaveLength(1);
          for (const controller of controllers) expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
          expect(h.client._pending?.size ?? 0).toBe(0);
          expect(h.client._queued?.size ?? 0).toBe(0);
        } finally { token.resolve(fresh()); await Promise.all(outcomes); await h.dispose(); }
      },
    );

    describe.each(["oauth", "client-id", "client-secret", "url", "same-credential-reconnect"])("replaced %s", (replacement) => {
      it.each(["success", "failure"])("ignores the old refresh's late %s without clearing the new refresh", async (settlement) => {
        const h = await harness(mode, { oauth: true, autoReconnect: true });
        const token = gate<Response>();
        const nextToken = gate<Response>();
        h.replyToken(() => token.promise);
        let old, next;
        try {
          if (phase === "pre-refresh") h.expire();
          else h.reply(() => truncated("unauthorized diagnostic", { status: 401 }));
          old = watch(h.run());
          await until(() => h.tokenRequests.length === 1);
          if (replacement === "same-credential-reconnect") {
            await h.manager.stopConnector("remote");
            h.reply((body) => h.respond(body, complete(mode)));
            h.mutate((connector) => { connector.oauth.expiresAt = Date.now() + 3_600_000; });
            await h.manager.startConnector("remote");
            h.expire();
          } else h.mutate((connector) => {
            if (replacement === "oauth") { connector.oauth.refreshToken = "replaced"; connector.oauth.accessToken = "replaced"; }
            if (replacement === "client-id") connector.oauthClientId = "replaced-client";
            if (replacement === "client-secret") connector.oauthClientSecret = "replaced-secret";
            if (replacement === "url") connector.url = "https://fixture.invalid/replaced";
            connector.oauth.expiresAt = Date.now() - 1;
          });
          const current = h.manager.clients.get("remote");
          h.replyToken(() => nextToken.promise);
          h.reply((body) => h.respond(body, complete(mode)));
          next = watch(h.run());
          await until(() => h.tokenRequests.length === 2);
          const saved = JSON.stringify(h.manager.getConfig().connectors[0]);
          token.resolve(settlement === "success" ? fresh() : invalid());
          const obsolete = await old;
          if (replacement === "same-credential-reconnect" && mode === "sse") expect(obsolete.error || obsolete.value?.isError).toBeTruthy();
          else expect(obsolete.error?.name).toBe("AbortError");
          await delay();
          expect(h.manager.refreshInFlight.size).toBe(1);
          expect(JSON.stringify(h.manager.getConfig().connectors[0])).toBe(saved);
          expect(h.manager.clients.get("remote")).toBe(current);
          alive(h);
          nextToken.resolve(json({ access_token: "fixture-latest", expires_in: 3600 }));
          const result = await next;
          expect(result.error).toBeUndefined();
          expect(result.value.content).toEqual(complete(mode).content);
          expect(h.manager.getConfig().connectors[0].oauth.accessToken).toBe("fixture-latest");
          expect(h.tokenRequests).toHaveLength(2);
          alive(h);
        } finally {
          token.resolve(fresh()); nextToken.resolve(fresh());
          await Promise.all([old, next]);
          await h.dispose();
        }
      });
    });
  });
});
