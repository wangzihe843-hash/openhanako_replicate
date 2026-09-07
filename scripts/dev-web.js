#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyDevEnvironment } from "./dev-env.js";
import { ensureWindowsSandboxHelper } from "./ensure-windows-sandbox-helper.mjs";
import { resolveHanakoHome } from "../shared/hana-runtime-paths.cjs";
import {
  buildDevWebClientConfig,
  buildDevWebPreviewUrl,
  normalizeServerInfoForDevWeb,
  resolveViteCommand,
} from "./dev-web-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
// Keep launcher I/O and both child processes on the same normalized data root.
const devEnv = applyDevEnvironment({ ...process.env });
devEnv.HANA_HOME = resolveHanakoHome(devEnv.HANA_HOME);
const hanaHome = devEnv.HANA_HOME;
const serverInfoPath = path.join(hanaHome, "server-info.json");
const serverToken = devEnv.HANA_TOKEN || randomBytes(16).toString("hex");

let serverProcess = null;
let viteProcess = null;
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[dev-web] ${message}\n`);
}

function isChildAlive(child) {
  return !!child && child.exitCode === null && child.signalCode === null;
}

async function waitForServerInfo({ timeoutMs = 90_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isChildAlive(serverProcess)) {
      throw new Error("Hana server exited before writing server-info.json");
    }
    try {
      const raw = fs.readFileSync(serverInfoPath, "utf-8");
      const info = JSON.parse(raw);
      // A previous kernel's record can remain while this child checks the home.
      // Only this launch's pid/token prove that its own server reached readiness.
      if (info?.pid === serverProcess.pid && info?.token === serverToken) {
        return normalizeServerInfoForDevWeb(info);
      }
    } catch {
      // The record may be missing or partially written while startup is pending.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for server-info.json");
}

function spawnServer() {
  fs.mkdirSync(hanaHome, { recursive: true });
  // The server owns the shared liveness check and removal of confirmed stale records.

  const serverEnv = { ...devEnv };
  serverEnv.HANA_ROOT = rootDir;
  serverEnv.HANA_SERVER_ENTRY = path.join(rootDir, "server", "main-full.ts");
  serverEnv.HANA_CREATE_STARTUP_SESSION = "0";
  serverEnv.HANA_PORT = devEnv.HANA_PORT || "0";
  serverEnv.HANA_TOKEN = serverToken;
  delete serverEnv.ELECTRON_RUN_AS_NODE;

  serverProcess = spawn(process.execPath, [path.join(rootDir, "server", "bootstrap.ts")], {
    cwd: rootDir,
    env: serverEnv,
    stdio: "inherit",
  });

  serverProcess.on("exit", (code, signal) => {
    if (!shuttingDown && isChildAlive(viteProcess)) {
      log(`server exited (${signal || code}); stopping Vite`);
      viteProcess.kill(signal || "SIGTERM");
    }
  });
}

function spawnVite(clientConfig, serverInfo) {
  const viteBin = resolveViteCommand(rootDir);
  const viteEnv = { ...devEnv };
  viteEnv.HANA_DEV_WEB = "1";
  viteEnv.HANA_DEV_WEB_CLIENT_PORT = clientConfig.serverPort;
  viteEnv.HANA_DEV_WEB_API_BASE_URL = clientConfig.apiBaseUrl;
  viteEnv.HANA_DEV_WEB_SERVER_URL = `http://127.0.0.1:${serverInfo.port}`;
  viteEnv.HANA_DEV_WEB_SERVER_TOKEN = serverInfo.token;
  delete viteEnv.ELECTRON_RUN_AS_NODE;

  viteProcess = spawn(viteBin, [
    "--config",
    path.join(rootDir, "vite.config.ts"),
    "--host",
    "127.0.0.1",
  ], {
    cwd: rootDir,
    env: viteEnv,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  viteProcess.on("exit", (code, signal) => {
    if (!shuttingDown && isChildAlive(serverProcess)) {
      log(`Vite exited (${signal || code}); stopping server`);
      serverProcess.kill(signal || "SIGTERM");
    }
  });
}

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (isChildAlive(viteProcess)) viteProcess.kill(signal);
  if (isChildAlive(serverProcess)) serverProcess.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (process.platform === "win32") {
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}

try {
  ensureWindowsSandboxHelper();
} catch (err) {
  console.warn(`[dev-web] windows-sandbox-helper 编译失败：${err?.message || err}。手动运行 npm run build:windows-sandbox-helper，或在偏好里关闭 sandbox。`);
}

try {
  spawnServer();
  const serverInfo = await waitForServerInfo();
  const clientConfig = buildDevWebClientConfig(serverInfo);
  spawnVite(clientConfig, serverInfo);
  log(`open ${buildDevWebPreviewUrl()}`);
} catch (err) {
  shutdown();
  console.error(`[dev-web] ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
}
