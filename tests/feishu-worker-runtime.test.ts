import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runFeishuWorkerFixture } from "./helpers/feishu-worker-process.ts";

function preloadImportUrl(preloadPath: string, windows = process.platform === "win32"): string {
  return pathToFileURL(preloadPath, { windows }).href;
}

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
    await runFeishuWorkerFixture({
      scenario, args: ["--import", preloadImportUrl(preload), scenario.startsWith("stream-") ? streamRunner : runner, scenario],
      cwd: fileURLToPath(new URL("../", import.meta.url)), timeoutMs: scenario.endsWith("-deadline") ? 40_000 : 15_000,
      env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", WS_PROXY: "", WSS_PROXY: "",
        http_proxy: "", https_proxy: "", all_proxy: "", ws_proxy: "", wss_proxy: "", NO_PROXY: "", no_proxy: "",
        HANA_FEISHU_TEST_DOMAIN: "", HANA_FEISHU_TEST_WS_DOMAIN: "", HANA_FEISHU_TEST_PROXY: "", HANA_FEISHU_TEST_RAW_OUTPUT: "", HANA_FEISHU_TEST_CONNECT_TRACE: "" },
    }, result => {
      const marker = result.stdout.split("\n").find(line => line.startsWith("FEISHU_WORKER_OBSERVATION "));
      expect(marker).toBeTruthy();
      const observation = JSON.parse(marker!.slice("FEISHU_WORKER_OBSERVATION ".length));
      expect(observation).toMatchObject({ pass: true, scenario, sdkVersion: "1.76.0", startedWorkers: scenario.endsWith("-deadline") ? 2 : 1,
        stop: { socketCount: 0, activeWorkers: 0, activeMessagePorts: 0, settled: true } });
      expect(result.stdout + result.stderr).not.toMatch(/secret-sentinel|raw-token-sentinel|synthetic-token-sentinel|proxy-pass-sentinel/);
    });
  }, 45_000);
});

describe("Feishu Worker preload import URL", () => {
  it.each([
    [String.raw`D:\a\openhanako\preload.mjs`, true, "file:///D:/a/openhanako/preload.mjs"],
    [String.raw`D:\a\open hanako\preload.mjs`, true, "file:///D:/a/open%20hanako/preload.mjs"],
    [String.raw`D:\a\open#hanako\preload.mjs`, true, "file:///D:/a/open%23hanako/preload.mjs"],
    [String.raw`D:\a\open%hanako\preload.mjs`, true, "file:///D:/a/open%25hanako/preload.mjs"],
    [String.raw`D:\a\open hanako#100%\preload.mjs`, true, "file:///D:/a/open%20hanako%23100%25/preload.mjs"],
    ["/tmp/openhanako/preload.mjs", false, "file:///tmp/openhanako/preload.mjs"],
    ["/tmp/open hanako#100%/preload.mjs", false, "file:///tmp/open%20hanako%23100%25/preload.mjs"],
  ] as const)("encodes %s as a file URL", (path, windows, expected) => {
    expect(preloadImportUrl(path, windows)).toBe(expected);
  });

  it.each(["plain", "with space", "with#hash", "with%percent", "with space#100%"])(
    "loads a preload from %s in real Node and its Worker", async name => {
      const directory = await mkdtemp(join(tmpdir(), "feishu-preload-url-"));
      try {
        const fixture = join(directory, name);
        await mkdir(fixture);
        const preloadPath = join(fixture, "preload.mjs");
        await writeFile(preloadPath, `
          import { isMainThread } from "node:worker_threads";
          globalThis.__feishuPreload = isMainThread ? "main" : "worker";
        `);
        await writeFile(join(fixture, "worker.mjs"), `
          import { parentPort } from "node:worker_threads";
          parentPort.postMessage(globalThis.__feishuPreload);
        `);
        const runnerPath = join(fixture, "runner.mjs");
        await writeFile(runnerPath, `
          import assert from "node:assert/strict";
          import { once } from "node:events";
          import { Worker } from "node:worker_threads";
          assert.equal(globalThis.__feishuPreload, "main");
          const worker = new Worker(new URL("./worker.mjs", import.meta.url));
          const [message, exit] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
          assert.equal(message[0], "worker");
          assert.equal(exit[0], 0);
          console.log("PRELOAD_URL_OK");
        `);
        const result = await promisify(execFile)(process.execPath, ["--import", preloadImportUrl(preloadPath), runnerPath], {
          timeout: 5_000, env: { ...process.env, NODE_OPTIONS: "" },
        });
        expect(result.stdout.trim()).toBe("PRELOAD_URL_OK");
        expect(result.stderr).toBe("");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
