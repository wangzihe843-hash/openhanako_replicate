import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { applyDevEnvironment } from "../scripts/dev-env.js";

const source = fs.readFileSync(new URL("../scripts/launch.js", import.meta.url), "utf-8")
  .replace(/^#![^\n]*\n/, "")
  .replace(/^import\b[\s\S]*?;\r?\n/gm, "")
  .replaceAll("import.meta.url", '"file:///launcher.js"');

describe("development launcher shared Windows helper", () => {
  it.each([
    ["electron", [".", "--fixture"]],
    ["electron-dev", [".", "--dev", "--fixture"]],
    ["electron-vite", [".", "--dev", "--fixture"]],
    ["cli", ["cli/entry.ts", "--fixture"]],
    ["server", ["server/main-full.ts", "--fixture"]],
  ])("checks the helper once before spawning %s", (mode, expectedArgs) => {
    const ensureWindowsSandboxHelper = vi.fn();
    const spawn = vi.fn((_command: string, _args: string[], _options: object) => ({ on: vi.fn() }));
    const processStub = {
      env: { ELECTRON_RUN_AS_NODE: "1", HANA_HOME: "/fixture-home" },
      argv: ["node", "launcher.js", mode, "--fixture"],
      execPath: process.execPath,
      platform: "win32",
      exit: vi.fn(),
    };
    vm.runInNewContext(source, {
      createRequire: () => () => "electron-binary",
      applyDevEnvironment,
      ensureWindowsSandboxHelper,
      spawn,
      process: processStub,
      console: { warn: vi.fn(), error: vi.fn() },
    });
    expect(ensureWindowsSandboxHelper).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(ensureWindowsSandboxHelper.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
    expect(spawn.mock.calls[0][1]).toEqual(expectedArgs);
    expect(processStub.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(processStub.env.HANA_HOME).toBe("/fixture-home");
  });

  it("keeps development available with a warning when the helper compiler is unavailable", () => {
    const spawn = vi.fn(() => ({ on: vi.fn() }));
    const warn = vi.fn();
    vm.runInNewContext(source, {
      createRequire: () => () => "electron-binary",
      applyDevEnvironment,
      ensureWindowsSandboxHelper: () => { throw new Error("fixture compiler unavailable"); },
      spawn,
      process: { env: {}, argv: ["node", "launcher.js", "server"], execPath: process.execPath, exit: vi.fn() },
      console: { warn, error: vi.fn() },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fixture compiler unavailable"));
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
