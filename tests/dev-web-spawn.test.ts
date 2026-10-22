import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const stripImports = (source: string) => source
  .replace(/^#![^\n]*\n/, "")
  .replace(/^import\b[\s\S]*?;\r?\n/gm, "")
  .replaceAll("import.meta.url", "scriptUrl");
const launcher = stripImports(fs.readFileSync(new URL("../scripts/dev-web.js", import.meta.url), "utf8"));
const runtime = stripImports(fs.readFileSync(new URL("../scripts/dev-web-runtime.js", import.meta.url), "utf8"))
  .replace(/^export /gm, "");

describe("dev-web Vite spawn arguments (offline platform mocks)", () => {
  it.each([
    ["darwin", "/repo", "/usr/local/bin/node"],
    ["linux", "/workspace/Open Hanako", "/runtime/Node Install/node"],
    ["darwin", "/workspace/花子 (dev) & friends", "/runtime/节点 (24)/node"],
    ["win32", "C:\\repo", "C:\\Program Files\\nodejs\\node.exe"],
    ["win32", "C:\\Projects\\Open Hanako", "C:\\Program Files\\nodejs\\node.exe"],
    ["win32", "C:\\用户\\花子 (dev) & 100% ^ ! '", "C:\\节点 Runtime (24)\\node.exe"],
    ["win32", "\\\\server\\shared projects\\花子", "C:\\Program Files\\nodejs\\node.exe"],
  ])("keeps executable, argv and environment separate for %s: %s", async (platform, root, execPath) => {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const home = paths.join(root, "synthetic home");
    const parentEnv = {
      HANA_HOME: home, HANA_TOKEN: "synthetic-owner", HANA_PORT: "0",
      ELECTRON_RUN_AS_NODE: "1", TEST_SENTINEL: "preserve & 100% 花子",
    };
    const originalEnv = { ...parentEnv };
    const makeChild = (pid: number) => Object.assign(new EventEmitter(), {
      pid, exitCode: null, signalCode: null, kill: vi.fn(),
    });
    const children = [makeChild(41001), makeChild(41002)];
    const spawn = vi.fn((_command: string, _args: string[], _options: {
      cwd: string; env: NodeJS.ProcessEnv; stdio: string;
      shell?: boolean; windowsVerbatimArguments?: boolean;
    }) => children[spawn.mock.calls.length - 1]);
    const processStub = Object.assign(new EventEmitter(), {
      env: parentEnv, execPath, platform, exitCode: undefined as number | undefined,
      stdout: { write: vi.fn() },
    });
    const consoleStub = { error: vi.fn(), warn: vi.fn() };
    const unexpectedTimer = () => { throw new Error("Unexpected readiness or cleanup timer"); };
    // Both production JS bodies share the mocked platform. Only OS/I/O boundaries
    // are replaced; this does not execute cmd.exe or claim native Windows coverage.
    await vm.runInNewContext("(async () => {\n" + runtime + "\n" + launcher + "\n})()", {
      scriptUrl: "synthetic-script-url",
      fileURLToPath: () => paths.join(root, "scripts", "dev-web.js"),
      path: paths, randomBytes, constants, spawn, process: processStub,
      fs: {
        mkdirSync: vi.fn(),
        readFileSync: vi.fn(() => JSON.stringify({ pid: 41001, port: 4567, token: parentEnv.HANA_TOKEN })),
      },
      console: consoleStub, setTimeout: unexpectedTimer, clearTimeout: vi.fn(),
      applyDevEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env, HANA_DEV_NODE_BIN: execPath }),
      resolveHanakoHome: () => home, ensureWindowsSandboxHelper: vi.fn(),
    });

    expect(consoleStub.error).not.toHaveBeenCalled();
    expect(processStub.exitCode).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
    const [command, args, options] = spawn.mock.calls[1];
    expect(command).toBe(execPath);
    expect(args).toEqual([
      paths.join(root, "node_modules", "vite", "bin", "vite.js"),
      "--config", paths.join(root, "vite.config.ts"), "--host", "127.0.0.1",
    ]);
    expect(options.cwd).toBe(root);
    expect(options.shell).toBe(false);
    expect(options.windowsVerbatimArguments).toBeUndefined();
    expect(options.stdio).toBe("inherit");
    expect(options.env).toMatchObject({
      HANA_HOME: home, HANA_DEV_NODE_BIN: execPath, TEST_SENTINEL: parentEnv.TEST_SENTINEL,
      HANA_DEV_WEB: "1", HANA_DEV_WEB_CLIENT_PORT: "5173",
      HANA_DEV_WEB_API_BASE_URL: "http://127.0.0.1:5173",
      HANA_DEV_WEB_SERVER_URL: "http://127.0.0.1:4567",
      HANA_DEV_WEB_SERVER_TOKEN: parentEnv.HANA_TOKEN,
    });
    expect(options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(parentEnv).toEqual(originalEnv);
    expect(spawn.mock.calls[0][0]).toBe(execPath);
    expect(spawn.mock.calls[0][1]).toEqual([paths.join(root, "server", "bootstrap.ts")]);
    for (const child of children) {
      for (const event of ["error", "exit", "close"]) expect(child.listenerCount(event)).toBe(1);
      expect(child.kill).not.toHaveBeenCalled();
    }
  });
});
