import { afterEach, expect, it } from "vitest";
import { createOutboundProxyRuntime, getOutboundProxySnapshot, subscribeOutboundProxyConfig } from "../lib/net/outbound-proxy.ts";

const runtimes: ReturnType<typeof createOutboundProxyRuntime>[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.reset(); });

it("publishes monotonic effective snapshots using the applying runtime environment and unsubscribes", () => {
  const environment = { HTTPS_PROXY: "http://user:synthetic-proxy-secret@127.0.0.1:8888", NO_PROXY: "synthetic.invalid" };
  const runtime = createOutboundProxyRuntime({ env: environment }); runtimes.push(runtime);
  const initial = getOutboundProxySnapshot();
  const snapshots: ReturnType<typeof getOutboundProxySnapshot>[] = [];
  const unsubscribe = subscribeOutboundProxyConfig(snapshot => snapshots.push(snapshot));
  runtime.apply({ mode: "system" });
  expect(snapshots[0].version).toBeGreaterThan(initial.version);
  expect(snapshots[0].config).toMatchObject({ mode: "manual", httpsProxy: environment.HTTPS_PROXY, noProxy: "synthetic.invalid" });
  // A consumer cannot change the policy seen by the next subscriber/request.
  snapshots[0].config.httpsProxy = "http://tampered.invalid";
  expect(getOutboundProxySnapshot().config.httpsProxy).toBe(environment.HTTPS_PROXY);
  runtime.apply({ mode: "direct" });
  runtime.reset();
  expect(snapshots.map(s => s.version)).toEqual([initial.version + 1, initial.version + 2, initial.version + 3]);
  unsubscribe(); runtime.apply({ mode: "direct" });
  expect(snapshots).toHaveLength(3);
});
