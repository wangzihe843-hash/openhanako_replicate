// Test-only public constructor seam. All SDK methods, transports, serializers,
// websocket frames, token cache and Worker lifecycle remain the real versions.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isMainThread } from "node:worker_threads";
import process from "node:process";
import { URL } from "node:url";
import { setImmediate } from "node:timers";
import { createHook } from "node:async_hooks";
import { appendFileSync } from "node:fs";

if (!isMainThread) {
  const domain = process.env.HANA_FEISHU_TEST_DOMAIN;
  const wsDomain = process.env.HANA_FEISHU_TEST_WS_DOMAIN || domain;
  const url = new URL(domain);
  assert.ok(["http:", "https:"].includes(url.protocol));
  assert.ok(url.hostname === "127.0.0.1" || url.hostname === "feishu-worker.invalid");
  if (url.hostname === "feishu-worker.invalid") {
    assert.equal(process.env.HANA_FEISHU_TEST_PROXY, "local-socks-only");
  }
  const wsUrl = new URL(wsDomain);
  assert.ok(["http:", "https:"].includes(wsUrl.protocol));
  assert.ok(wsUrl.hostname === "127.0.0.1" || wsDomain === domain);
  const require = createRequire(import.meta.url);
  const tracePath = process.env.HANA_FEISHU_TEST_CONNECT_TRACE;
  if (tracePath) {
    createHook({ init(id, type) {
      if (type === "TCPCONNECTWRAP") appendFileSync(tracePath, JSON.stringify({ id, type, atNs: process.hrtime.bigint().toString() }) + "\n");
    } }).enable();
  }
  const sdk = require("@larksuiteoapi/node-sdk");
  const RealClient = sdk.Client;
  const RealWSClient = sdk.WSClient;
  sdk.Client = class extends RealClient {
    constructor(options) { super({ ...options, domain, cache: new sdk.DefaultCache() }); }
  };
  sdk.WSClient = class extends RealWSClient {
    constructor(options) { super({ ...options, domain: wsDomain }); }
  };
  if (process.env.HANA_FEISHU_TEST_RAW_OUTPUT === "1") {
    process.stdout.write("raw-secret-");
    setImmediate(() => process.stdout.write("sentinel\n"));
    process.stderr.write("raw-token-");
    setImmediate(() => process.stderr.write("sentinel\n"));
  }
}
