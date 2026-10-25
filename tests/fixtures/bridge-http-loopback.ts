// Synthetic test credentials only. The dispatcher refuses every non-loopback
// destination and port, including redirects, without DNS or external sockets.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { Agent, buildConnector } from "undici";

export type CapturedBridgeRequest = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  remoteAddress: string;
};

export async function bridgeHttpLoopback() {
  const cert = fs.readFileSync(new URL("./bridge-redirect-cert.fixture", import.meta.url));
  const key = fs.readFileSync(new URL("./bridge-redirect-key.fixture", import.meta.url));
  const sourceRequests: CapturedBridgeRequest[] = [];
  const sinkRequests: CapturedBridgeRequest[] = [];
  let reply = (_request: CapturedBridgeRequest, response: http.ServerResponse) => { response.end("{}"); };
  function handler(target: CapturedBridgeRequest[], source = false) {
    return async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = { method: req.method!, path: req.url!, headers: req.headers, body, remoteAddress: req.socket.remoteAddress! };
      target.push(request);
      if (source) reply(request, res);
      else { res.setHeader("Content-Type", "application/json"); res.end("{}"); }
    };
  }
  const servers = [
    https.createServer({ key, cert }, handler(sourceRequests, true)),
    https.createServer({ key, cert }, handler(sinkRequests)),
    http.createServer(handler(sinkRequests)),
  ];
  const ports: number[] = [];
  let agent: Agent;
  async function close() {
    await agent?.close();
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  }
  try {
    for (const server of servers) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      ports.push((server.address() as AddressInfo).port);
    }
    const connector = buildConnector({ ca: cert, rejectUnauthorized: true });
    agent = new Agent({ connect(options, callback) {
      if (!["127.0.0.1", "localhost"].includes(options.hostname) || !ports.includes(Number(options.port))) {
        callback(new Error("Test dispatcher forbids non-loopback destinations"), null);
        return;
      }
      connector({ ...options, hostname: "127.0.0.1", servername: options.hostname === "localhost" ? "localhost" : undefined }, callback);
    } });
    return {
      source: `https://127.0.0.1:${ports[0]}`,
      sink: `https://localhost:${ports[1]}`,
      downgrade: `http://127.0.0.1:${ports[2]}`,
      agent,
      sourceRequests,
      sinkRequests,
      respond(handler: typeof reply) { reply = handler; },
      reset() { sourceRequests.length = 0; sinkRequests.length = 0; },
      close,
    };
  } catch (error) { await close(); throw error; }
}
