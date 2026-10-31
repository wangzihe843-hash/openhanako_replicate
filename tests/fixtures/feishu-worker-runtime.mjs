import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import { once } from "node:events";
import { createHook } from "node:async_hooks";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import console from "node:console";
import { WebSocketServer } from "ws";
import { createFeishuWorkerAdapter } from "../../lib/bridge/feishu-worker-adapter.ts";
import { createOutboundProxyRuntime } from "../../lib/net/outbound-proxy.ts";
import { initDebugLog, debugLog } from "../../lib/debug-log.ts";

const scenario = process.argv[2];
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("@larksuiteoapi/node-sdk"));
const protobuf = sdkRequire("protobufjs/minimal");
const observation = { scenario, sdkVersion: require("@larksuiteoapi/node-sdk/package.json").version };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, ms = 5000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Fixture deadline: ${description}`);
    await pause(5);
  }
}
function encodeEvent(id = "event-1", openId = "synthetic-user") {
  const body = JSON.stringify({ schema: "2.0", header: { event_type: "im.message.receive_v1", event_id: id },
    event: { message: { message_id: "synthetic-message", message_type: "text", chat_id: "synthetic-chat", chat_type: "p2p", content: '{"text":"synthetic inbound"}' },
      sender: { sender_type: "user", sender_id: { open_id: openId } } } });
  const writer = protobuf.Writer.create().uint32(8).uint64(1).uint32(16).uint64(1).uint32(24).int32(1).uint32(32).int32(1);
  for (const [key, value] of Object.entries({ type: "event", message_id: id, sum: "1", seq: "0", trace_id: "synthetic-trace" })) {
    writer.uint32(42).fork().uint32(10).string(key).uint32(18).string(value).ldelim();
  }
  return writer.uint32(66).bytes(Buffer.from(body)).finish();
}

async function httpFixture(mode = "healthy") {
  const sockets = new Set();
  const requests = [];
  const wsClients = new Set();
  let upgrades = 0;
  let aborts = 0;
  let tokens = 0;
  let messageId = 0;
  let failContentOnce = false;
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const record = { path: request.url, method: request.method, body: Buffer.concat(chunks).toString(), response };
      requests.push(record);
      response.on("close", () => { if (!response.writableFinished) aborts++; });
      response.setHeader("content-type", "application/json");
      if (record.path === "/callback/ws/endpoint") {
        if (mode !== "endpoint") releaseEndpoint(response);
      } else if (record.path.includes("tenant_access_token/internal")) {
        tokens++;
        if (mode !== "token") response.end(JSON.stringify({ code: 0, tenant_access_token: "synthetic-token-sentinel", expire: mode === "contracts" && tokens === 1 ? 1 : 7200 }));
      } else if (record.path === "/synthetic-media" || record.path.includes("/resources/") || (record.path.includes("/im/v1/images/") && record.method === "GET")) {
        response.setHeader("content-type", "application/octet-stream");
        response.write(Buffer.from([0, 1, 2, 255]));
        if (mode !== "resource") response.end();
      } else if (record.path.includes("/contact/v3/users/")) {
        if (mode !== "contact") response.end(JSON.stringify({ code: 0, data: { user: { name: "Synthetic User" } } }));
      } else if (record.path.includes("/cardkit/v1/cards")) {
        if (mode === "card") return;
        if (record.path.includes("/elements/") && failContentOnce) {
          failContentOnce = false;
          response.end(JSON.stringify({ code: 230001, msg: "synthetic confirmed rejection", error: { log_id: "safe-request-id" } }));
        } else response.end(JSON.stringify({ code: 0, data: { card_id: "synthetic-card" } }));
      } else if (record.path.startsWith("/open-apis/im/v1/messages")) {
        if (mode === "message") return;
        if (mode === "drop-message") { response.socket.destroy(); return; }
        if (mode === "diagnostics") {
          response.end(JSON.stringify({ code: 230001, msg: "secret-sentinel Authorization: Bearer synthetic-token-sentinel", error: { log_id: "safe-request-id" } }));
        } else response.end(JSON.stringify({ code: 0, data: { message_id: `synthetic-message-${++messageId}` } }));
      } else if (/\/im\/v1\/(images|files)(?:\?|$)/.test(record.path)) {
        if (mode !== "upload") response.end(JSON.stringify({ code: 0, data: { image_key: "synthetic-image", file_key: "synthetic-file" } }));
      } else { response.statusCode = 404; response.end("{}"); }
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", ws => { wsClients.add(ws); ws.on("close", () => wsClients.delete(ws)); ws.on("error", () => {}); });
  server.on("upgrade", (request, socket, head) => {
    upgrades++;
    if (mode === "handshake") { socket.resume(); socket.on("end", () => socket.end()); }
    else wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  function releaseEndpoint(response) {
    const wsDomain = process.env.HANA_FEISHU_TEST_WS_DOMAIN || process.env.HANA_FEISHU_TEST_DOMAIN;
    const target = wsDomain?.includes(".invalid") ? "ws://feishu-worker.invalid" : base.replace("http:", "ws:");
    response.end(JSON.stringify({ code: 0, data: { URL: `${target}/socket?device_id=synthetic&service_id=1`,
      ClientConfig: { PingInterval: 60, ReconnectCount: 3, ReconnectInterval: 0.02, ReconnectNonce: 0 } } }));
  }
  return { base, port, sockets, requests, wsClients, releaseEndpoint,
    upgrades: () => upgrades, aborts: () => aborts, tokens: () => tokens,
    endpoints: () => requests.filter(r => r.path === "/callback/ws/endpoint"),
    messages: () => requests.filter(r => r.path.startsWith("/open-apis/im/v1/messages") && !r.path.includes("/resources/")),
    failNextContent() { failContentOnce = true; },
    async close() {
      for (const ws of wsClients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}

// A real SOCKS5 peer with a bounded parser. It never resolves or connects the
// requested host: healthy mode forwards only to this test's loopback server.
async function socksFixture(stage, upstreamPort) {
  const peers = new Set(); const upstreams = new Set(); const received = [];
  const traces = []; const peerIds = new Map(); const releases = new Map();
  let resolveFirstGreeting;
  const firstGreeting = new Promise(resolve => { resolveFirstGreeting = resolve; });
  let nextPeerId = 0;
  let greetings = 0; let authentications = 0; let connects = 0; let tlsHellos = 0; let applicationBytes = 0;
  const server = createNetServer(socket => {
    const id = ++nextPeerId; peerIds.set(socket, id);
    const mark = type => traces.push({ id, type, atNs: process.hrtime.bigint().toString() });
    mark("connection"); peers.add(socket);
    socket.on("close", () => { mark("close"); peers.delete(socket); releases.delete(socket); }); socket.on("error", () => {});
    let phase = "greeting"; let buffered = Buffer.alloc(0);
    releases.set(socket, () => {
      if (socket.destroyed || phase !== "paused") return;
      if (stage === "greeting") { phase = "connect"; socket.write(Buffer.from([5, 0])); }
      else if (stage === "auth") { phase = "connect"; socket.write(Buffer.from([1, 0])); }
      else if (stage === "connect") { phase = "application"; socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); }
    });
    const onData = chunk => {
      received.push(chunk.toString("hex")); buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 65536) { socket.destroy(new Error("Fixture input too large")); return; }
      if (phase === "greeting" && buffered.length >= 2 && buffered.length >= 2 + buffered[1]) {
        assert.equal(buffered[0], 5); greetings++; mark("greeting"); resolveFirstGreeting(); buffered = buffered.subarray(2 + buffered[1]);
        phase = stage === "auth" ? "auth" : "connect";
        if (stage === "greeting") { phase = "paused"; return; }
        socket.write(Buffer.from([5, stage === "auth" ? 2 : 0]));
      }
      if (phase === "auth" && buffered.length >= 2) {
        const passwordOffset = 2 + buffered[1];
        if (buffered.length < passwordOffset + 1 || buffered.length < passwordOffset + 1 + buffered[passwordOffset]) return;
        assert.equal(buffered[0], 1); authentications++; mark("auth"); buffered = buffered.subarray(passwordOffset + 1 + buffered[passwordOffset]); phase = "paused"; return;
      }
      if (phase === "connect" && buffered.length >= 5) {
        assert.equal(buffered[0], 5); assert.equal(buffered[1], 1); assert.equal(buffered[3], 3);
        const length = 7 + buffered[4]; if (buffered.length < length) return;
        assert.equal(buffered.subarray(5, 5 + buffered[4]).toString(), "feishu-worker.invalid");
        connects++; mark("connect"); buffered = buffered.subarray(length);
        if (["greeting", "auth", "connect"].includes(stage)) { phase = "paused"; return; }
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        if (stage === "tls") { phase = "tls"; return; }
        assert.equal(stage, "healthy"); assert.ok(upstreamPort > 0);
        const upstream = connect(upstreamPort, "127.0.0.1"); upstreams.add(upstream);
        upstream.on("close", () => upstreams.delete(upstream)); upstream.on("error", () => socket.destroy());
        socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
        socket.removeListener("data", onData);
        if (buffered.length) upstream.write(buffered);
        socket.pipe(upstream); upstream.pipe(socket); phase = "forwarding";
      }
      if (phase === "tls" && buffered.length > 2) { assert.equal(buffered[0], 22); tlsHellos++; mark("tls"); phase = "paused"; }
      if (phase === "application" && buffered.length) { applicationBytes += buffered.length; mark("application"); buffered = Buffer.alloc(0); }
    };
    socket.on("data", onData);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { peers, upstreams, received, firstGreeting,
    url: `socks://${stage === "auth" ? "proxy-user-sentinel:proxy-pass-sentinel@" : ""}127.0.0.1:${server.address().port}`,
    reached: () => stage === "greeting" ? greetings > 0 : stage === "auth" ? authentications > 0 : stage === "tls" ? tlsHellos > 0 : connects > 0,
    traces,
    snapshot: () => ({ atNs: process.hrtime.bigint().toString(), peerIds: [...peers].map(socket => peerIds.get(socket)) }),
    counts: () => ({ greetings, authentications, connects, tlsHellos, applicationBytes }),
    late() { for (const release of releases.values()) release(); },
    async close() { for (const socket of peers) socket.destroy(); for (const socket of upstreams) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

const liveWorkers = new Set(); const livePorts = new Set(); let startedWorkers = 0;
const hook = createHook({
  init(id, type) { if (type === "WORKER") { liveWorkers.add(id); startedWorkers++; } if (type === "MESSAGEPORT") livePorts.add(id); },
  destroy(id) { liveWorkers.delete(id); livePorts.delete(id); },
});
const adapters = []; const cleanups = []; const statuses = []; const messages = [];
const runtime = createOutboundProxyRuntime();
function adapter(options = {}) {
  const value = createFeishuWorkerAdapter({ appId: "cli_0000000000000015", appSecret: "secret-sentinel", agentId: "synthetic-agent",
    onMessage: message => { messages.push(message); return new Promise(() => {}); },
    onStatus: (...args) => statuses.push(args), ...options });
  adapters.push(value); return value;
}
async function stoppedAt250(value, sockets) {
  const began = Date.now(); let settled = false;
  const exit = value.stop().then(() => { settled = true; });
  await pause(Math.max(0, 250 - (Date.now() - began)));
  const snapshot = { socketCount: sockets.size, activeWorkers: liveWorkers.size, activeMessagePorts: livePorts.size, settled, observedAfterMs: Date.now() - began };
  assert.equal(snapshot.socketCount, 0, "owned peer must close before fixture cleanup");
  assert.equal(snapshot.activeWorkers, 0, "Worker isolate (including unref timers) must exit");
  assert.equal(snapshot.activeMessagePorts, 0, "Worker MessagePorts must close");
  assert.equal(settled, true, "stop must await observed Worker exit");
  await exit;
  return snapshot;
}

try {
  assert.equal(observation.sdkVersion, "1.76.0");
  if (scenario === "socks-concurrent-greeting-probe") {
    const proxy = await socksFixture("greeting"); cleanups.push(() => proxy.close());
    const traceDir = await mkdtemp(join(tmpdir(), "feishu-worker-connect-trace-")); cleanups.push(() => rm(traceDir, { recursive: true, force: true }));
    const tracePath = join(traceDir, "connects.jsonl");
    process.env.HANA_FEISHU_TEST_CONNECT_TRACE = tracePath;
    process.env.HANA_FEISHU_TEST_DOMAIN = "http://feishu-worker.invalid";
    process.env.HANA_FEISHU_TEST_WS_DOMAIN = "";
    process.env.HANA_FEISHU_TEST_PROXY = "local-socks-only";
    runtime.apply({ mode: "manual", httpProxy: proxy.url, httpsProxy: proxy.url, wsProxy: proxy.url, wssProxy: proxy.url, noProxy: "" });
    hook.enable(); const value = adapter();
    const pending = value.sendReply("synthetic-chat", "concurrent with WS discovery").catch(error => error);
    await proxy.firstGreeting;
    const countsBefore = proxy.counts(); const stopSnapshot = proxy.snapshot();
    const stopping = value.stop(); const stopReturnedAtNs = process.hrtime.bigint().toString(); proxy.late();
    observation.stop = await stoppedAt250(value, proxy.peers); await stopping; await pending;
    const tcpStarts = (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    observation.concurrentProbe = { countsBefore, countsAfter: proxy.counts(), stopSnapshot, stopReturnedAtNs, peerTrace: proxy.traces, tcpStarts,
      connectsStartedAfterStopReturned: tcpStarts.filter(record => BigInt(record.atNs) > BigInt(stopReturnedAtNs)).length };
    assert.equal(proxy.counts().connects, 0, "valid late greeting must not trigger SOCKS CONNECT");
    assert.equal(observation.concurrentProbe.connectsStartedAfterStopReturned, 0, "no native TCP connect may begin after stop returned");
  } else if (scenario === "socks-greeting-deadline") {
    const proxy = await socksFixture("greeting"); cleanups.push(() => proxy.close());
    const wsServer = await httpFixture(); cleanups.push(() => wsServer.close());
    process.env.HANA_FEISHU_TEST_DOMAIN = "http://feishu-worker.invalid";
    process.env.HANA_FEISHU_TEST_WS_DOMAIN = wsServer.base;
    process.env.HANA_FEISHU_TEST_PROXY = "local-socks-only";
    runtime.apply({ mode: "manual", httpProxy: proxy.url, httpsProxy: proxy.url, wsProxy: proxy.url, wssProxy: proxy.url, noProxy: "" });
    hook.enable();
    const began = Date.now(); const stalled = adapter();
    const pending = stalled.sendReply("synthetic-chat", "deadline must not replay").catch(error => error);
    await until(proxy.reached, "pending SOCKS before real production deadline");
    const stalledWorkers = new Set(liveWorkers); const stalledPorts = new Set(livePorts);
    const countsBefore = proxy.counts();
    const healthyServer = await httpFixture(); cleanups.push(() => healthyServer.close());
    process.env.HANA_FEISHU_TEST_DOMAIN = healthyServer.base;
    process.env.HANA_FEISHU_TEST_WS_DOMAIN = healthyServer.base;
    const healthy = adapter({ agentId: "independent-binding" });
    await healthy.sendReply("synthetic-chat", "independent before deadline");
    const error = await pending;
    const elapsedMs = Date.now() - began;
    assert.ok(elapsedMs >= 29_000, "exercise the unshortened 30-second production deadline");
    assert.equal(error.deliveryUnknown, true);
    // Do not call stop before this observation: the deadline itself must
    // reclaim the stalled isolate and peers, while the other binding survives.
    await pause(250);
    observation.automaticStop = { socketCount: proxy.peers.size + wsServer.sockets.size,
      ownedWorkers: [...stalledWorkers].filter(id => liveWorkers.has(id)).length,
      ownedMessagePorts: [...stalledPorts].filter(id => livePorts.has(id)).length,
      remainingWorkers: liveWorkers.size, elapsedMs };
    assert.deepEqual({ ...observation.automaticStop, elapsedMs: 0 }, { socketCount: 0, ownedWorkers: 0, ownedMessagePorts: 0, remainingWorkers: 1, elapsedMs: 0 });
    await healthy.sendReply("synthetic-chat", "independent after deadline");
    assert.equal(healthyServer.messages().length, 2);
    proxy.late(); await pause(50);
    assert.deepEqual(proxy.counts(), countsBefore, "no automatic retry or late SOCKS continuation");
    await stalled.stop();
    observation.stop = await stoppedAt250(healthy, healthyServer.sockets);
    observation.healthyBindingSurvives = true; observation.error = { code: error.code, deliveryUnknown: error.deliveryUnknown };
  } else if (scenario.startsWith("socks-")) {
    const stage = scenario.slice(6);
    const proxy = await socksFixture(stage); cleanups.push(() => proxy.close());
    const wsServer = await httpFixture(); cleanups.push(() => wsServer.close());
    process.env.HANA_FEISHU_TEST_DOMAIN = `${stage === "tls" ? "https" : "http"}://feishu-worker.invalid`;
    process.env.HANA_FEISHU_TEST_WS_DOMAIN = wsServer.base;
    process.env.HANA_FEISHU_TEST_PROXY = "local-socks-only";
    runtime.apply({ mode: "manual", httpProxy: proxy.url, httpsProxy: proxy.url, wsProxy: proxy.url, wssProxy: proxy.url, noProxy: "" });
    hook.enable();
    const value = adapter();
    await until(() => wsServer.upgrades() === 1, "healthy WS before one paused SOCKS token request");
    const send = value.sendReply("synthetic-chat", "pending").catch(error => error);
    await until(proxy.reached, `SOCKS ${stage}`);
    const countsBefore = proxy.counts();
    const stopSnapshot = proxy.snapshot();
    const stopping = value.stop(); proxy.late();
    observation.stop = await stoppedAt250(value, proxy.peers); await stopping;
    assert.equal(wsServer.sockets.size, 0, "the same binding's healthy WS must also close");
    observation.error = { code: (await send).code, deliveryUnknown: (await send).deliveryUnknown };
    observation.countsBefore = countsBefore; observation.countsAfter = proxy.counts();
    observation.stopSnapshot = stopSnapshot; observation.peerTrace = proxy.traces;
    assert.deepEqual(proxy.counts(), countsBefore, "late proxy response must not advance negotiation after stop");
    assert.equal((await send).deliveryUnknown, true);
  } else {
    const mode = ["proxy-config", "proxy-system", "no-proxy", "events", "reconnect"].includes(scenario) ? "healthy" : scenario;
    const h = await httpFixture(mode); cleanups.push(() => h.close());
    let firstProxy; let secondProxy;
    if (["proxy-config", "proxy-system", "no-proxy"].includes(scenario)) {
      firstProxy = await socksFixture("healthy", h.port); cleanups.push(() => firstProxy.close());
      if (scenario === "proxy-config") { secondProxy = await socksFixture("healthy", h.port); cleanups.push(() => secondProxy.close()); }
      process.env.HANA_FEISHU_TEST_DOMAIN = scenario === "no-proxy" ? h.base : "http://feishu-worker.invalid";
      process.env.HANA_FEISHU_TEST_PROXY = "local-socks-only";
      if (scenario === "proxy-system") {
        const envRuntime = createOutboundProxyRuntime({ env: { HTTP_PROXY: firstProxy.url, HTTPS_PROXY: firstProxy.url, NO_PROXY: "" } });
        envRuntime.apply({ mode: "system" });
      } else runtime.apply({ mode: "manual", httpProxy: firstProxy.url, httpsProxy: firstProxy.url, wsProxy: firstProxy.url, wssProxy: firstProxy.url, noProxy: "" });
    } else { process.env.HANA_FEISHU_TEST_DOMAIN = h.base; runtime.apply({ mode: "direct" }); }
    let logDir;
    if (scenario === "diagnostics") { process.env.HANA_FEISHU_TEST_RAW_OUTPUT = "1"; logDir = await mkdtemp(join(tmpdir(), "feishu-worker-logs-")); initDebugLog(logDir); cleanups.push(() => rm(logDir, { recursive: true, force: true })); }
    hook.enable(); const value = adapter();
    if (scenario === "endpoint") {
      await until(() => h.endpoints().length === 1, "pending endpoint");
      const stopped = value.stop(); h.releaseEndpoint(h.endpoints()[0].response);
      observation.stop = await stoppedAt250(value, h.sockets); await stopped;
      assert.equal(h.upgrades(), 0);
    } else if (scenario === "handshake") {
      await until(() => h.upgrades() === 1, "pending WS handshake");
      observation.stop = await stoppedAt250(value, h.sockets);
    } else if (["message", "token", "upload", "card", "resource"].includes(scenario)) {
      await until(() => h.upgrades() === 1, "healthy WS handshake");
      const send = (scenario === "upload" ? value.sendMediaBuffer("synthetic-chat", Buffer.from("IMAGE"), { mime: "image/png" })
        : scenario === "card" ? value.startRichStreamReply("synthetic-chat", "card")
        : scenario === "resource" ? value.downloadFile("synthetic-message", "synthetic-file")
        : value.sendReply("synthetic-chat", "hello")).catch(error => error);
      const target = { message: "/im/v1/messages", token: "tenant_access_token", upload: "/im/v1/images", card: "/cardkit/", resource: "/resources/" }[scenario];
      await until(() => h.requests.some(r => r.path.includes(target)), `pending ${scenario}`);
      observation.stop = await stoppedAt250(value, h.sockets);
      const error = await send; assert.ok(error instanceof Error); observation.error = { code: error.code, deliveryUnknown: error.deliveryUnknown };
      assert.ok(h.aborts() > 0, "real HTTP response/body is aborted");
      if (["token", "upload", "card"].includes(scenario)) assert.equal(h.messages().length, 0, "cancelled predecessor must not submit an IM write");
      if (scenario === "resource") assert.notEqual(error.deliveryUnknown, true);
    } else if (scenario === "reconnect") {
      await until(() => statuses.some(s => s[0] === "connected"), "connected status");
      for (const ws of h.wsClients) ws.terminate();
      await until(() => h.upgrades() === 2, "single SDK reconnect");
      await pause(100); assert.equal(h.upgrades(), 2); assert.equal(h.endpoints().length, 2);
      observation.stop = await stoppedAt250(value, h.sockets); assert.equal(h.upgrades(), 2);
    } else if (scenario === "events" || scenario === "contact") {
      await until(() => h.wsClients.size === 1, "event socket");
      [...h.wsClients][0].send(encodeEvent());
      await until(() => h.requests.some(r => r.path.includes("/contact/")), "inbound user lookup");
      if (scenario === "contact") {
        const stopping = value.stop();
        h.requests.find(r => r.path.includes("/contact/")).response.end(JSON.stringify({ code: 0, data: { user: { name: "late" } } }));
        observation.stop = await stoppedAt250(value, h.sockets); await stopping; assert.equal(messages.length, 0);
      } else {
        await until(() => messages.length === 1, "inbound normalized event");
        assert.equal(messages[0].sessionKey, "fs_dm_synthetic-user@synthetic-agent");
        assert.equal(messages[0].senderName, "Synthetic User");
        await value.sendReply("synthetic-chat", "reply while application callback remains pending");
        observation.stop = await stoppedAt250(value, h.sockets);
      }
    } else if (scenario === "contracts") {
      await value.sendReply("synthetic-chat", "hello"); await value.sendBlockReply("synthetic-chat", "block");
      assert.equal(h.tokens(), 2, "SDK refreshes a deliberately expired token then caches the new one");
      const plain = await value.startStreamReply("synthetic-chat", "plain"); const oldId = plain.messageId;
      const table = "| Name | Status |\n| --- | --- |\n| Synthetic | ready |";
      await value.updateStreamReply("synthetic-chat", plain, table);
      assert.equal(plain.renderKind, "interactive"); assert.equal(plain.previousMessageId, oldId); assert.notEqual(plain.messageId, oldId);
      await value.finishStreamReply("synthetic-chat", plain, table + "\nfinished");
      assert.equal(h.messages().at(-1).method, "PATCH"); assert.deepEqual(Object.keys(JSON.parse(h.messages().at(-1).body)), ["content"]);
      const rich = await value.startRichStreamReply("synthetic-chat", "rich"); assert.equal(rich.sequence, 2);
      h.failNextContent(); const rejected = await value.updateRichStreamReply("synthetic-chat", rich, "rejected").catch(error => error);
      assert.equal(rejected.code, 230001); assert.notEqual(rejected.deliveryUnknown, true); assert.equal(rich.sequence, 3);
      await Promise.all([value.updateRichStreamReply("synthetic-chat", rich, "first"), value.updateRichStreamReply("synthetic-chat", rich, "second")]);
      assert.equal(rich.sequence, 5);
      await value.finishRichStreamReply("synthetic-chat", rich, "finished"); assert.equal(rich.sequence, 7);
      assert.deepEqual(h.requests.filter(r => r.path.includes("/cardkit/") && r.method !== "POST").map(r => JSON.parse(r.body).sequence), [2, 3, 4, 5, 6, 7]);
      const source = Buffer.from("VIEW-PREFIXIMAGEVIEW-SUFFIX");
      await value.sendMediaBuffer("synthetic-chat", source.subarray(11, 16), { mime: "image/png", filename: "image.png" });
      const upload = h.requests.find(r => /\/im\/v1\/images(?:\?|$)/.test(r.path)); assert.ok(upload.body.includes("IMAGE")); assert.ok(!upload.body.includes("VIEW-PREFIX")); assert.equal(source.toString(), "VIEW-PREFIXIMAGEVIEW-SUFFIX");
      await value.sendMedia("synthetic-chat", `${h.base}/synthetic-media`, { mime: "application/pdf", filename: "sample.pdf" });
      assert.deepEqual(await value.downloadImage("synthetic-image"), Buffer.from([0, 1, 2, 255]));
      assert.deepEqual(await value.downloadFile("synthetic-message", "synthetic-file"), Buffer.from([0, 1, 2, 255]));
      const beforeOversize = h.messages().length;
      const tooLarge = await value.sendReply("synthetic-chat", '\\"'.repeat(16000)).catch(error => error);
      assert.equal(tooLarge.code, "FEISHU_MESSAGE_TOO_LARGE"); assert.equal(tooLarge.maxBytes, 30000); assert.ok(tooLarge.actualBytes > 30000); assert.equal(tooLarge.operation, "create"); assert.equal(h.messages().length, beforeOversize);
      observation.ordinaryState = plain; observation.cardkitState = rich; observation.tooLarge = { code: tooLarge.code, actualBytes: tooLarge.actualBytes, maxBytes: tooLarge.maxBytes };
      observation.stop = await stoppedAt250(value, h.sockets);
    } else if (scenario === "drop-message") {
      const error = await value.sendReply("synthetic-chat", "accepted then response lost").catch(error => error);
      assert.equal(error.deliveryUnknown, true); assert.equal(h.messages().length, 1);
      await pause(100); assert.equal(h.messages().length, 1, "no replay of unconfirmed write");
      observation.error = { code: error.code, deliveryUnknown: error.deliveryUnknown };
      observation.stop = await stoppedAt250(value, h.sockets);
    } else if (["proxy-config", "proxy-system", "no-proxy"].includes(scenario)) {
      await until(() => h.upgrades() === 1, "proxy WS handshake"); await value.sendReply("synthetic-chat", "first proxy");
      if (scenario === "no-proxy") assert.equal(firstProxy.counts().connects, 0, "forced loopback bypass must remain direct");
      else assert.ok(firstProxy.counts().connects >= 3, "HTTP/WS both use the configured proxy");
      if (scenario === "proxy-config") {
        const firstCount = firstProxy.counts().connects;
        runtime.apply({ mode: "manual", httpProxy: secondProxy.url, httpsProxy: secondProxy.url, wsProxy: secondProxy.url, wssProxy: secondProxy.url, noProxy: "" });
        await value.sendReply("synthetic-chat", "second proxy");
        for (const ws of h.wsClients) ws.terminate();
        await until(() => h.upgrades() === 2, "reconnect on updated proxy");
        assert.equal(firstProxy.counts().connects, firstCount); assert.ok(secondProxy.counts().connects >= 3);
        observation.nextProxy = secondProxy.counts();
      }
      observation.proxy = firstProxy.counts(); observation.stop = await stoppedAt250(value, firstProxy.peers);
      assert.equal(h.sockets.size, 0); if (secondProxy) assert.equal(secondProxy.peers.size, 0);
    } else if (scenario === "diagnostics") {
      const error = await value.sendReply("synthetic-chat", "diagnostic rejection").catch(error => error);
      assert.equal(error.log_id, "safe-request-id"); assert.equal(error.code, 230001);
      const rendered = JSON.stringify([error.message, error.name, error]);
      assert.ok(!rendered.includes("secret-sentinel") && !rendered.includes("synthetic-token-sentinel"));
      assert.ok(!Object.hasOwn(error, "config") && !Object.hasOwn(error, "cause"));
      observation.stop = await stoppedAt250(value, h.sockets); debugLog()?.close();
      const logs = (await Promise.all((await readdir(logDir)).map(name => readFile(join(logDir, name), "utf8")))).join("\n");
      assert.ok(!logs.includes("raw-secret-sentinel") && !logs.includes("raw-token-sentinel") && !logs.includes("secret-sentinel") && !logs.includes("synthetic-token-sentinel"));
      observation.logRedacted = true; observation.error = { code: error.code, log_id: error.log_id };
    } else throw new Error(`Unknown scenario: ${scenario}`);
    observation.upgrades = h.upgrades(); observation.requests = h.requests.map(({ path, method }) => ({ path, method })); observation.inboundCount = messages.length;
  }
  observation.startedWorkers = startedWorkers; assert.ok(startedWorkers >= 1, "test must exercise a real Worker");
  observation.pass = true;
} finally {
  await Promise.allSettled(adapters.map(value => value.stop()));
  hook.disable();
  for (const cleanup of cleanups.reverse()) await cleanup();
  runtime.reset();
}
console.log(`FEISHU_WORKER_OBSERVATION ${JSON.stringify(observation)}`);
