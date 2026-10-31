import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createHook } from "node:async_hooks";
import { setTimeout } from "node:timers";
import process from "node:process";
import console from "node:console";
import { WebSocketServer } from "ws";
import { createFeishuWorkerAdapter } from "../../lib/bridge/feishu-worker-adapter.ts";
import { BridgeManager } from "../../lib/bridge/bridge-manager.ts";
import { createOutboundProxyRuntime } from "../../lib/net/outbound-proxy.ts";
import { markFeishuWorkerPhase } from "./feishu-worker-phases.mjs";

const scenario = process.argv[2];
markFeishuWorkerPhase("fixture:loaded");
const cases = {
  "stream-edit-final-only": { mode: "edit_message", behavior: "final_only", fallbacks: 0 },
  "stream-cardkit-final-only": { mode: "cardkit_stream", behavior: "final_only", fallbacks: 0 },
  "stream-edit-receipt-empty-final": { mode: "edit_message", behavior: "receipt_empty", fallbacks: 0 },
  "stream-cardkit-receipt-empty-final": { mode: "cardkit_stream", behavior: "receipt_empty", fallbacks: 0 },
  "stream-edit-rejected-finish": { mode: "edit_message", behavior: "rejected_finish", fallbacks: 130 },
  "stream-cardkit-rejected-finish": { mode: "cardkit_stream", behavior: "rejected_finish", fallbacks: 130 },
  "stream-edit-missing-message-id": { mode: "edit_message", behavior: "missing_id", fallbacks: 130 },
  "stream-active-capacity": { mode: "edit_message", behavior: "capacity", fallbacks: 0 },
};
assert.ok(Object.hasOwn(cases, scenario), "known local scenario required");
const { mode, behavior, fallbacks } = cases[scenario];
const require = createRequire(import.meta.url);
const sdkVersion = require("@larksuiteoapi/node-sdk/package.json").version;
assert.equal(sdkVersion, "1.76.0");
const sockets = new Set(); const requests = []; const wsClients = new Set();
let nextMessage = 0; let nextCard = 0;
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const path = request.url; const method = request.method;
    requests.push({ method, path }); response.setHeader("content-type", "application/json");
    if (path === "/callback/ws/endpoint") response.end(JSON.stringify({ code: 0, data: { URL: `${base.replace("http:", "ws:")}/socket?device_id=synthetic&service_id=1`, ClientConfig: { PingInterval: 60, ReconnectCount: 3, ReconnectInterval: 0.02, ReconnectNonce: 0 } } }));
    else if (path.includes("tenant_access_token/internal")) response.end(JSON.stringify({ code: 0, tenant_access_token: "synthetic-token", expire: 7200 }));
    else if (behavior === "rejected_finish" && ((mode === "edit_message" && path.includes("/im/v1/messages/") && ["PUT", "PATCH"].includes(method)) || (mode === "cardkit_stream" && path.includes("/elements/")))) response.end(JSON.stringify({ code: 230001, msg: "synthetic confirmed finish rejection" }));
    else if (path.includes("/im/v1/messages")) response.end(JSON.stringify({ code: 0, data: behavior === "missing_id" ? {} : { message_id: `message-${++nextMessage}` } }));
    else if (path.includes("/cardkit/")) response.end(JSON.stringify({ code: 0, data: { card_id: `card-${++nextCard}` } }));
    else { response.statusCode = 404; response.end("{}"); }
  });
});
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); });
const wss = new WebSocketServer({ server });
wss.on("connection", ws => { wsClients.add(ws); ws.on("close", () => wsClients.delete(ws)); ws.on("error", () => {}); });
markFeishuWorkerPhase("server:listen");
server.listen(0, "127.0.0.1"); await once(server, "listening");
markFeishuWorkerPhase("server:listening", { port: server.address().port });
const base = `http://127.0.0.1:${server.address().port}`;
process.env.HANA_FEISHU_TEST_DOMAIN = base; process.env.HANA_FEISHU_TEST_WS_DOMAIN = base;
const runtime = createOutboundProxyRuntime(); runtime.apply({ mode: "direct" });
const liveWorkers = new Set(); const livePorts = new Set(); let startedWorkers = 0;
const hook = createHook({
  init(id, type) { if (type === "WORKER") { liveWorkers.add(id); startedWorkers++; markFeishuWorkerPhase("worker:init", { id }); } if (type === "MESSAGEPORT") livePorts.add(id); },
  destroy(id) { if (liveWorkers.has(id)) markFeishuWorkerPhase("worker:destroy", { id }); liveWorkers.delete(id); livePorts.delete(id); },
});
hook.enable();
const actual = createFeishuWorkerAdapter({ appId: "cli_0000000000000015", appSecret: "synthetic-secret", agentId: "stream-probe", onMessage() {} });
markFeishuWorkerPhase("adapter:created");
const methodCalls = {}; let round = 0; const failures = []; const fallbackRounds = []; const thrown = [];
// Observe public calls without replacing their implementation or transport.
const adapter = new Proxy(actual, { get(target, property) {
  const member = target[property];
  if (typeof member !== "function") return member;
  return (...args) => { methodCalls[property] = (methodCalls[property] || 0) + 1; return member.apply(target, args); };
} });
// The real Manager stream closures need only pure snapshot helpers and the
// delivery-failure/fallback hooks. No engine, credentials or external LLM runs.
const manager = Object.create(BridgeManager.prototype);
manager._recordStreamDeliveryFailure = ({ stage, err }) => failures.push({ round, stage, code: err?.code, deliveryUnknown: err?.deliveryUnknown === true });
manager._sendStreamFallbackReply = async args => {
  fallbackRounds.push(round);
  return BridgeManager.prototype._sendStreamFallbackReply.call(manager, args);
};
let observation;
try {
  if (behavior === "capacity") {
    const states = [];
    for (let active = 0; active < 128; active++) states.push(await adapter.startStreamReply("synthetic-chat", `active ${active}`));
    const blocked = await adapter.startStreamReply("synthetic-chat", "129th active").catch(error => error);
    assert.equal(blocked.code, "FEISHU_STREAM_LIMIT", "simultaneously active streams must remain bounded at 128");
    assert.notEqual(blocked.deliveryUnknown, true);
    assert.equal(requests.filter(r => r.path.includes("/im/v1/messages?") && r.method === "POST").length, 128, "capacity rejection must precede remote write");
    adapter.releaseStreamReply(states[0]);
    const replacement = await adapter.startStreamReply("synthetic-chat", "released slot is reusable");
    assert.ok(replacement.messageId);
    for (const state of states) adapter.releaseStreamReply(state);
    adapter.releaseStreamReply(replacement);
  } else {
    for (round = 1; round <= 130; round++) {
      const input = { adapter, chatId: "synthetic-chat", capability: { minIntervalMs: 0, maxChars: 0 }, context: null, platform: "feishu" };
      const delivery = mode === "edit_message" ? manager._createEditMessageStreamDelivery(input) : manager._createCardKitStreamDelivery(input);
      try {
        if (behavior !== "final_only") {
          markFeishuWorkerPhase("receipt:start", { round });
          await delivery.startReceipt("working");
          markFeishuWorkerPhase("receipt:done", { round });
        }
        markFeishuWorkerPhase("finish:start", { round });
        await delivery.finish(behavior === "receipt_empty" ? "" : `finished round ${round}`);
        markFeishuWorkerPhase("finish:done", { round });
      } catch (error) { thrown.push({ round, code: error.code }); }
    }
  }
  markFeishuWorkerPhase("health:start");
  await actual.sendReply("synthetic-chat", "binding remains healthy after rounds");
  markFeishuWorkerPhase("health:done");
  const limits = failures.filter(failure => failure.code === "FEISHU_STREAM_LIMIT");
  assert.deepEqual(limits, [], "completed Manager rounds must not exhaust live stream handles");
  assert.deepEqual(thrown, [], "Manager completion semantics remain intact");
  assert.equal(fallbackRounds.length, fallbacks, "retain fallback only for known rejection/missing id");
  assert.equal(failures.length, behavior === "rejected_finish" ? 130 : 0, "no silently swallowed stream failures");
  assert.equal(requests.filter(r => r.path.includes("/im/v1/messages?") && r.method === "POST").length, (behavior === "capacity" ? 130 : 131) + fallbacks, "handle disposal must not add a remote write");
  if (mode === "cardkit_stream") assert.equal(requests.filter(r => r.path === "/open-apis/cardkit/v1/cards" && r.method === "POST").length, 130);
  const began = Date.now(); let settled = false;
  markFeishuWorkerPhase("stop:start");
  const exit = actual.stop().then(() => { settled = true; markFeishuWorkerPhase("stop:settled"); });
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 250 - (Date.now() - began))));
  const stop = { socketCount: sockets.size, activeWorkers: liveWorkers.size, activeMessagePorts: livePorts.size, settled };
  assert.deepEqual(stop, { socketCount: 0, activeWorkers: 0, activeMessagePorts: 0, settled: true });
  await exit;
  observation = { scenario, sdkVersion, rounds: 130, methodCalls, streamLimitCount: 0, fallbackCount: fallbackRounds.length, startedWorkers, stop, pass: true };
} finally {
  markFeishuWorkerPhase("cleanup:stop");
  await actual.stop(); hook.disable();
  markFeishuWorkerPhase("cleanup:sockets", { sockets: sockets.size, wsClients: wsClients.size });
  for (const ws of wsClients) ws.terminate(); for (const socket of sockets) socket.destroy();
  markFeishuWorkerPhase("cleanup:websocket-close");
  await new Promise(resolve => wss.close(resolve));
  markFeishuWorkerPhase("cleanup:http-close");
  await new Promise(resolve => server.close(resolve)); runtime.reset();
  markFeishuWorkerPhase("cleanup:done");
}
markFeishuWorkerPhase("observation:write");
console.log(`FEISHU_WORKER_OBSERVATION ${JSON.stringify(observation)}`);
