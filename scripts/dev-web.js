#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { constants } from "node:os";
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
const children = new Map();
const shutdownGraceMs = 5_000;

function log(message) {
  process.stdout.write(`[dev-web] ${message}\n`);
}

function isChildAlive(child) {
  return !!child?.pid && child.exitCode === null && child.signalCode === null;
}

function recordExitCode(code) {
  // Preserve the first failure, including a user's interrupt, through peer cleanup.
  if (!process.exitCode) process.exitCode = code;
}

function signalExitCode(signal) {
  return 128 + (constants.signals[signal] || 1);
}

function reportChildError(name, err) {
  console.error(`[dev-web] ${name}: ${err?.stack || err?.message || String(err)}`);
  recordExitCode(1);
}

function watchChild(child, name) {
  const state = { name, closed: false, timer: null };
  children.set(child, state);
  // Register before yielding: spawn errors are asynchronous and need not emit exit.
  child.on("error", (err) => {
    reportChildError(name, err);
    shutdown();
  });
  child.on("exit", (code, signal) => {
    // A clean server exit before Vite starts still means startup did not succeed.
    if (code === 0 && child === serverProcess && !viteProcess) code = 1;
    if (code) recordExitCode(code);
    if (shuttingDown) return;
    recordExitCode(signal ? signalExitCode(signal) : (code ?? 1));
    log(`${name} exited (${signal || code}); stopping dev-web`);
    shutdown();
  });
  child.on("close", () => {
    state.closed = true;
    clearTimeout(state.timer);
  });
}

function stopChild(child, state, signal) {
  if (state.closed || !isChildAlive(child)) return;
  try {
    if (!child.kill(signal)) {
      reportChildError(state.name, new Error(`Could not send ${signal}`));
    }
  } catch (err) {
    reportChildError(state.name, err);
  }
}

async function waitForServerInfo({ timeoutMs = 90_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return null;
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

  watchChild(serverProcess, "server");
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

  watchChild(viteProcess, "Vite");
}

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [child, state] of children) {
    if (state.closed || !isChildAlive(child)) continue;
    // Only signal the retained ChildProcess handle. Never rediscover ownership by PID.
    state.timer = setTimeout(() => {
      if (state.closed || !isChildAlive(child)) return;
      reportChildError(state.name, new Error("Did not stop within 5s; sending SIGKILL"));
      stopChild(child, state, "SIGKILL");
    }, shutdownGraceMs);
    stopChild(child, state, signal);
  }
  // Do not process.exit(): keep the parent alive until the children emit close.
}

function shutdownForSignal(signal) {
  recordExitCode(signalExitCode(signal));
  shutdown(signal);
}

process.on("SIGINT", () => shutdownForSignal("SIGINT"));
process.on("SIGTERM", () => shutdownForSignal("SIGTERM"));
if (process.platform === "win32") {
  process.on("SIGBREAK", () => shutdownForSignal("SIGBREAK"));
}

try {
  ensureWindowsSandboxHelper();
} catch (err) {
  console.warn(`[dev-web] windows-sandbox-helper 编译失败：${err?.message || err}。手动运行 npm run build:windows-sandbox-helper，或在偏好里关闭 sandbox。`);
}

try {
  if (!shuttingDown) {
    spawnServer();
    const serverInfo = await waitForServerInfo();
    if (!shuttingDown && serverInfo) {
      const clientConfig = buildDevWebClientConfig(serverInfo);
      spawnVite(clientConfig, serverInfo);
      log(`open ${buildDevWebPreviewUrl()}`);
    }
  }
} catch (err) {
  shutdown();
  console.error(`[dev-web] ${err?.stack || err?.message || String(err)}`);
  recordExitCode(1);
}
