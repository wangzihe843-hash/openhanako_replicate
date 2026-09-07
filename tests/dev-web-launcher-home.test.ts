import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
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
      readFileSync: vi.fn(() => JSON.stringify({ port: 4567, token: "test-owner-token" })),
    };
    const consoleStub = { error: vi.fn() };
    const setTimeoutStub = vi.fn(() => {
      throw new Error("Unexpected server-info polling delay");
    });

    await vm.runInNewContext("(async () => {\n" + launcherSource + "\n})()", {
      scriptUrl: scriptUrl.href,
      fileURLToPath,
      path,
      fs: fsStub,
      spawn,
      process: processStub,
      console: consoleStub,
      setTimeout: setTimeoutStub,
      applyDevEnvironment,
      defaultDevHanaHome,
      resolveHanakoHome,
      ...devWebRuntime,
    }, { filename: fileURLToPath(scriptUrl) });

    expect(processStub.exitCode).toBeUndefined();
    expect(consoleStub.error).not.toHaveBeenCalled();
    expect(setTimeoutStub).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    const serverInfoPath = path.join(expectedHome, "server-info.json");
    expect(fsStub.mkdirSync).toHaveBeenCalledWith(expectedHome, { recursive: true });
    expect(fsStub.unlinkSync).toHaveBeenCalledWith(serverInfoPath);
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
