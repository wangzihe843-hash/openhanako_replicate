import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { applyDevEnvironment, defaultDevHanaHome } from "../scripts/dev-env.js";
import * as devWebRuntime from "../scripts/dev-web-runtime.js";
import { resolveHanakoHome } from "../shared/hana-runtime-paths.ts";

const scriptUrl = new URL("../scripts/dev-web.js", import.meta.url);
const launcherSource = fs.readFileSync(scriptUrl, "utf-8")
  .replace(/^#![^\n]*\n/, "")
  .replace(/^import\b[\s\S]*?;\r?\n/gm, "")
  .replaceAll("import.meta.url", "scriptUrl");

describe("dev-web launcher data directory", () => {
  it.each([
    ["unset", undefined, path.join(os.homedir(), ".hanako-dev")],
    ["empty", "", path.join(os.homedir(), ".hanako-dev")],
    ["absolute", path.join(os.tmpdir(), "hana-web-isolated"), path.join(os.tmpdir(), "hana-web-isolated")],
    ["home", "~", os.homedir()],
    ["home subdirectory", "~/.hanako-isolated", path.join(os.homedir(), ".hanako-isolated")],
    ["relative", path.join("tmp", "hana-web-isolated"), path.resolve("tmp", "hana-web-isolated")],
  ])("keeps filesystem access and both child environments together for %s HANA_HOME", async (_label, input, expectedHome) => {
    const parentEnv = {
      HANA_HOME: input,
      HANA_PORT: "0",
      ELECTRON_RUN_AS_NODE: "1",
      TEST_SENTINEL: "preserve-me",
      HANA_TOKEN: "test-owner-token",
    };
    const parentSnapshot = { ...parentEnv };
    const processStub = {
      env: parentEnv,
      execPath: process.execPath,
      platform: process.platform,
      exitCode: undefined as number | undefined,
      stdout: { write: vi.fn() },
      on: vi.fn(),
    };
    const spawn = vi.fn((_command: string, _args: string[], _options: { env: NodeJS.ProcessEnv }) => ({
      pid: 41001,
      exitCode: null,
      signalCode: null,
      on: vi.fn(),
      kill: vi.fn(),
    }));
    // Run the real launcher body with all data I/O and subprocesses intercepted.
    // The read always succeeds so a wrong directory fails assertions immediately.
    const fsStub = {
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(() => {
        throw Object.assign(new Error("No stale server-info file"), { code: "ENOENT" });
      }),
      readFileSync: vi.fn(() => JSON.stringify({ pid: 41001, port: 4567, token: "test-owner-token" })),
    };
    const ensureWindowsSandboxHelper = vi.fn();
    const consoleStub = { error: vi.fn(), warn: vi.fn() };
    const setTimeoutStub = vi.fn(() => {
      throw new Error("Unexpected server-info polling delay");
    });

    await vm.runInNewContext("(async () => {\n" + launcherSource + "\n})()", {
      scriptUrl: scriptUrl.href,
      fileURLToPath,
      path,
      randomBytes,
      fs: fsStub,
      spawn,
      process: processStub,
      console: consoleStub,
      setTimeout: setTimeoutStub,
      applyDevEnvironment,
      ensureWindowsSandboxHelper,
      defaultDevHanaHome,
      resolveHanakoHome,
      ...devWebRuntime,
    }, { filename: fileURLToPath(scriptUrl) });

    expect(processStub.exitCode).toBeUndefined();
    expect(consoleStub.error).not.toHaveBeenCalled();
    expect(setTimeoutStub).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(ensureWindowsSandboxHelper).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2].env.HANA_SERVER_ENTRY).toBe(
      path.join(path.dirname(fileURLToPath(scriptUrl)), "..", "server", "main-full.ts"),
    );
    const serverInfoPath = path.join(expectedHome, "server-info.json");
    expect(fsStub.mkdirSync).toHaveBeenCalledWith(expectedHome, { recursive: true });
    expect(fsStub.unlinkSync).not.toHaveBeenCalled();
    expect(fsStub.readFileSync).toHaveBeenCalledWith(serverInfoPath, "utf-8");
    for (const [, , options] of spawn.mock.calls) {
      expect(options.env).toMatchObject({
        HANA_HOME: expectedHome,
        HANA_DEV_NODE_BIN: process.execPath,
        TEST_SENTINEL: "preserve-me",
      });
      expect(options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
      expect(options.env).not.toBe(parentEnv);
    }
    expect(parentEnv).toEqual(parentSnapshot);
  });
});

describe("dev-web launcher server ownership", () => {
  async function runLauncher({
    env = {},
    staleRecord = "active server",
  }: { env?: NodeJS.ProcessEnv; staleRecord?: "active server" | "different pid" | "missing pid" | "different token" | "none" } = {}) {
    const makeChild = (pid: number) => ({
      pid,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      on: vi.fn(),
      kill: vi.fn(),
    });
    const serverChild = makeChild(41001);
    const viteChild = makeChild(41002);
    let serverEnv: NodeJS.ProcessEnv = {};
    const spawn = vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (spawn.mock.calls.length === 1) {
        serverEnv = options.env;
        return serverChild;
      }
      return viteChild;
    });
    const activeInfo = { pid: 88001, port: 3344, token: "existing-server-token" };
    let record: typeof activeInfo | null = activeInfo;
    let polled = false;
    const fsStub = {
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(() => { record = null; }),
      readFileSync: vi.fn(() => {
        if (staleRecord === "active server") return JSON.stringify(record);
        const info = { pid: serverChild.pid, port: 4567, token: serverEnv.HANA_TOKEN || "legacy-generated-token" };
        if (polled || staleRecord === "none") return JSON.stringify(info);
        return JSON.stringify({
          ...info,
          ...(staleRecord === "different pid" ? { pid: info.pid + 100 } : {}),
          ...(staleRecord === "missing pid" ? { pid: undefined } : {}),
          ...(staleRecord === "different token" ? { token: "previous-incarnation-token" } : {}),
          port: 3344,
        });
      }),
    };
    const setTimeoutStub = vi.fn((resume: () => void) => {
      if (polled) throw new Error("Launcher should need at most one readiness poll in this fixture");
      polled = true;
      if (staleRecord === "active server") serverChild.exitCode = 1;
      resume();
    });
    const processStub = {
      env,
      execPath: process.execPath,
      platform: process.platform,
      exitCode: undefined as number | undefined,
      stdout: { write: vi.fn() },
      on: vi.fn(),
    };
    await vm.runInNewContext("(async () => {\n" + launcherSource + "\n})()", {
      scriptUrl: scriptUrl.href,
      fileURLToPath,
      path,
      randomBytes,
      fs: fsStub,
      spawn,
      process: processStub,
      console: { error: vi.fn(), warn: vi.fn() },
      setTimeout: setTimeoutStub,
      applyDevEnvironment,
      ensureWindowsSandboxHelper: vi.fn(),
      resolveHanakoHome,
      ...devWebRuntime,
    }, { filename: fileURLToPath(scriptUrl) });
    return { processStub, spawn, fsStub, serverChild, viteChild, serverEnv, setTimeoutStub, activeInfo, record };
  }

  it("leaves an active server record for the server startup gate and does not connect Vite to it", async () => {
    const harness = await runLauncher();
    expect(harness.record).toBe(harness.activeInfo);
    expect(harness.fsStub.unlinkSync).not.toHaveBeenCalled();
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.processStub.exitCode).toBe(1);
    expect(harness.serverChild.kill).not.toHaveBeenCalled();
    expect(harness.viteChild.kill).not.toHaveBeenCalled();
  });

  it.each(["different pid", "missing pid", "different token"] as const)("waits past a record with %s until its own server is ready", async (staleRecord) => {
    const harness = await runLauncher({ staleRecord });
    expect(harness.processStub.exitCode).toBeUndefined();
    expect(harness.setTimeoutStub).toHaveBeenCalledTimes(1);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.spawn.mock.calls[1][2].env).toMatchObject({
      HANA_DEV_WEB_SERVER_URL: "http://127.0.0.1:4567",
      HANA_DEV_WEB_SERVER_TOKEN: harness.serverEnv.HANA_TOKEN,
    });
  });

  it("generates a launch token and passes it only through the child environments", async () => {
    const parentEnv = { HANA_HOME: path.join(os.tmpdir(), "hana-web-token-isolated") };
    const harness = await runLauncher({ env: parentEnv, staleRecord: "none" });
    expect(harness.serverEnv.HANA_TOKEN).toMatch(/^[a-f0-9]{32}$/);
    expect(parentEnv).not.toHaveProperty("HANA_TOKEN");
    expect(harness.spawn.mock.calls[1][2].env.HANA_DEV_WEB_SERVER_TOKEN).toBe(harness.serverEnv.HANA_TOKEN);
  });

  it("preserves an explicit server token when matching readiness", async () => {
    const harness = await runLauncher({ env: { HANA_TOKEN: "explicit-dev-token" }, staleRecord: "none" });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.serverEnv.HANA_TOKEN).toBe("explicit-dev-token");
    expect(harness.spawn.mock.calls[1][2].env.HANA_DEV_WEB_SERVER_TOKEN).toBe("explicit-dev-token");
  });
});
