import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const preload = fileURLToPath(new URL("./fixtures/feishu-worker-preload.mjs", import.meta.url));
const runner = fileURLToPath(new URL("./fixtures/feishu-worker-runtime.mjs", import.meta.url));
const streamRunner = fileURLToPath(new URL("./fixtures/feishu-worker-stream-lifecycle.mjs", import.meta.url));
const scenarios = [
  "endpoint", "handshake", "message", "token", "upload", "card", "resource",
  "socks-greeting", "socks-auth", "socks-connect", "socks-tls",
  "socks-greeting-deadline",
  "socks-concurrent-greeting-probe",
  "reconnect", "events", "contact", "contracts", "drop-message",
  "proxy-config", "proxy-system", "no-proxy", "diagnostics",
  "stream-edit-final-only", "stream-cardkit-final-only",
  "stream-edit-receipt-empty-final", "stream-cardkit-receipt-empty-final",
  "stream-edit-rejected-finish", "stream-cardkit-rejected-finish", "stream-edit-missing-message-id",
  "stream-active-capacity",
];

describe("actual Feishu SDK in the production Worker", () => {
  it.each(scenarios)("preserves %s behavior and physically exits before the cleanup deadline", async scenario => {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, ["--import", preload, scenario.startsWith("stream-") ? streamRunner : runner, scenario], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: scenario.endsWith("-deadline") ? 40_000 : 15_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", WS_PROXY: "", WSS_PROXY: "",
          http_proxy: "", https_proxy: "", all_proxy: "", ws_proxy: "", wss_proxy: "", NO_PROXY: "", no_proxy: "",
          HANA_FEISHU_TEST_DOMAIN: "", HANA_FEISHU_TEST_WS_DOMAIN: "", HANA_FEISHU_TEST_PROXY: "", HANA_FEISHU_TEST_RAW_OUTPUT: "", HANA_FEISHU_TEST_CONNECT_TRACE: "" },
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Worker fixture ${scenario} failed: ${error.message}\n${stdout}\n${stderr}`));
        else resolve({ stdout, stderr });
      });
    });
    const marker = result.stdout.split("\n").find(line => line.startsWith("FEISHU_WORKER_OBSERVATION "));
    expect(marker).toBeTruthy();
    const observation = JSON.parse(marker!.slice("FEISHU_WORKER_OBSERVATION ".length));
    expect(observation).toMatchObject({ pass: true, scenario, sdkVersion: "1.76.0", startedWorkers: scenario.endsWith("-deadline") ? 2 : 1,
      stop: { socketCount: 0, activeWorkers: 0, activeMessagePorts: 0, settled: true } });
    expect(result.stdout + result.stderr).not.toMatch(/secret-sentinel|raw-token-sentinel|synthetic-token-sentinel|proxy-pass-sentinel/);
  }, 45_000);
});
