import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
import viteServerConfig from "../vite.config.server.js";
import { applyDevEnvironment } from "../scripts/dev-env.js";
import { ensureHanaPiSdkDirs } from "../shared/hana-runtime-paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const requireCjs = createRequire(import.meta.url);
const { configureClientSingleInstance } = requireCjs(
  "../desktop/src/shared/single-instance-lock.cjs",
);

function listDirsRecursive(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        out.push(path.relative(root, path.join(dir, entry.name)));
        walk(path.join(dir, entry.name));
      }
    }
  }
  walk(root);
  return out.sort();
}

const tmpDirsToCleanup = [];
afterEach(() => {
  while (tmpDirsToCleanup.length) {
    const dir = tmpDirsToCleanup.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; Windows can race file handles
    }
  }
});

describe("local startup contract", () => {
  it("start scripts build theme bundle before launching Electron", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts.start).toContain("build:theme");
    expect(pkg.scripts["start:dev"]).toContain("build:theme");
  });

  it("dev Electron launcher passes a dedicated Node runtime to main process", () => {
    const launchJs = fs.readFileSync(path.join(ROOT, "scripts", "launch.js"), "utf-8");
    const devEnvJs = fs.readFileSync(path.join(ROOT, "scripts", "dev-env.js"), "utf-8");
    const mainCjs = fs.readFileSync(path.join(ROOT, "desktop", "main.cjs"), "utf-8");

    expect(launchJs).toContain('from "./dev-env.js"');
    expect(launchJs).toContain("applyDevEnvironment(process.env)");
    expect(devEnvJs).toContain("HANA_DEV_NODE_BIN");
    expect(mainCjs).toContain("HANA_DEV_NODE_BIN");

    const env = applyDevEnvironment({}, { nodeBin: "/tmp/hana-node" });
    expect(env.HANA_DEV_NODE_BIN).toBe("/tmp/hana-node");
  });

  it("applyDevEnvironment respects an externally provided HANA_HOME and only fills the dev default when unset", () => {
    // Regression guard: an earlier upstream refactor silently turned this into an
    // unconditional overwrite, which clobbered developers' persistent HANA_HOME on every
    // dev launch and forced them through Onboarding against the wrong data dir.
    const explicit = applyDevEnvironment({ HANA_HOME: "D:\\custom\\hana" });
    expect(explicit.HANA_HOME).toBe("D:\\custom\\hana");

    const blank = applyDevEnvironment({});
    expect(blank.HANA_HOME).toBeTruthy();
    expect(blank.HANA_HOME).not.toBe("D:\\custom\\hana");
  });

  it("server configures Pi SDK from HANA_HOME and CLI stays server-first", () => {
    const cliSource = fs.readFileSync(path.join(ROOT, "index.js"), "utf-8");
    const cliEntrySource = fs.readFileSync(path.join(ROOT, "cli", "entry.ts"), "utf-8");
    const launchSource = fs.readFileSync(path.join(ROOT, "scripts", "launch.js"), "utf-8");
    const serverSource = fs.readFileSync(path.join(ROOT, "server", "index.ts"), "utf-8");

    expect(cliSource).toContain("./cli/entry.ts");
    expect(cliSource).not.toContain("HanaEngine");
    expect(cliEntrySource).not.toContain("HanaEngine");
    expect(launchSource).toContain('"cli/entry.ts"');
    expect(serverSource).toContain("ensureHanaPiSdkDirs(hanakoHome)");
    expect(serverSource).toContain("configureProcessPiSdkEnv(hanakoHome)");
  });

  it("desktop main propagates Hana-owned Pi SDK env to the spawned server", () => {
    const mainCjs = fs.readFileSync(path.join(ROOT, "desktop", "main.cjs"), "utf-8");

    expect(mainCjs).toContain("ensureHanaPiSdkDirs(hanakoHome)");
    expect(mainCjs).toContain("configureProcessPiSdkEnv(hanakoHome)");
    expect(mainCjs).toContain("withHanaPiSdkEnv(process.env, hanakoHome)");
  });

  it("desktop main installs the client single-instance lock before app readiness", () => {
    const mainCjs = fs.readFileSync(path.join(ROOT, "desktop", "main.cjs"), "utf-8");

    expect(mainCjs).toContain("configureClientSingleInstance(app");
    expect(mainCjs).toContain("onSecondInstance: () => showPrimaryWindow()");
    expect(mainCjs.indexOf("configureClientSingleInstance(app")).toBeLessThan(
      mainCjs.indexOf("app.whenReady()"),
    );
  });

  it("keeps jsdom external in the server bundle for packaged runtime", () => {
    const external = viteServerConfig.build?.rollupOptions?.external || [];

    expect(external).toContain("jsdom");
  });

  it("keeps the native jieba tokenizer external in the server bundle", () => {
    const external = viteServerConfig.build?.rollupOptions?.external || [];

    expect(external).toContain("@node-rs/jieba");
  });

  it("keeps workspace output helper statically bundleable in packaged server", () => {
    const source = fs.readFileSync(path.join(ROOT, "shared", "workspace-output.ts"), "utf-8");

    expect(source).toContain('from "./workspace-output.cjs"');
    expect(source).not.toContain("createRequire");
    expect(source).not.toContain('require("./workspace-output.cjs")');
  });

  it("server-only packaging emits a bundled CLI and wrapper", () => {
    const buildServer = fs.readFileSync(path.join(ROOT, "scripts", "build-server.mjs"), "utf-8");

    expect(buildServer).toContain("bundle/cli.js");
    expect(buildServer).toContain('path.join(ROOT, "cli", "entry.ts")');
    expect(buildServer).toContain('path.join(outDir, "hana")');
    expect(buildServer).toContain('path.join(outDir, "hana.cmd")');
  });

  it("server dependency install explicitly enables native package scripts", () => {
    const buildServer = fs.readFileSync(path.join(ROOT, "scripts", "build-server.mjs"), "utf-8");

    expect(buildServer).toContain("--ignore-scripts=false");
    expect(buildServer).toContain("runBetterSqliteRuntimeSmokeIfNeeded()");
  });

  it("applyDevEnvironment writes HANA_DEV_NODE_BIN from opts.nodeBin and overrides any inherited value", () => {
    // dev-env.js intentionally treats opts.nodeBin (defaulting to process.execPath) as
    // authoritative so the spawned main process always runs against the launcher's Node,
    // not whatever the parent shell happened to inherit. Document that contract here
    // because an `||` fallback would silently re-introduce a stale child runtime.
    const withOpts = applyDevEnvironment(
      { HANA_DEV_NODE_BIN: "/stale/inherited/node" },
      { nodeBin: "/tmp/hana-node" },
    );
    expect(withOpts.HANA_DEV_NODE_BIN).toBe("/tmp/hana-node");

    const defaulted = applyDevEnvironment({});
    expect(defaulted.HANA_DEV_NODE_BIN).toBe(process.execPath);
  });

  it("configureClientSingleInstance triggers onSecondInstance when Electron emits second-instance", () => {
    const calls = [];
    const handlers = {};
    const fakeApp = {
      setPath: (key, value) => {
        calls.push(["setPath", key, value]);
      },
      getPath: (key) => (key === "appData" ? "/tmp/appdata" : ""),
      requestSingleInstanceLock: () => true,
      on: (event, fn) => {
        handlers[event] = fn;
      },
      exit: () => {
        calls.push(["exit"]);
      },
      quit: () => {
        calls.push(["quit"]);
      },
    };
    let secondInstanceCalls = 0;
    const got = configureClientSingleInstance(fakeApp, {
      hanakoHome: "/tmp/hana-home",
      defaultHome: "/home/user/.hanako",
      onSecondInstance: () => {
        secondInstanceCalls += 1;
      },
    });
    expect(got).toBe(true);
    expect(typeof handlers["second-instance"]).toBe("function");
    expect(calls.some((c) => c[0] === "exit" || c[0] === "quit")).toBe(false);

    handlers["second-instance"]();
    handlers["second-instance"]();
    expect(secondInstanceCalls).toBe(2);
  });

  it("configureClientSingleInstance exits the duplicate client when the lock cannot be acquired", () => {
    const calls = [];
    const fakeApp = {
      setPath: () => {},
      getPath: () => "/tmp/appdata",
      requestSingleInstanceLock: () => false,
      on: () => {
        throw new Error("should not subscribe when no lock");
      },
      exit: () => {
        calls.push(["exit"]);
      },
      quit: () => {
        calls.push(["quit"]);
      },
    };
    let secondInstanceCalls = 0;
    const got = configureClientSingleInstance(fakeApp, {
      hanakoHome: "/tmp/hana-home",
      defaultHome: "/home/user/.hanako",
      onSecondInstance: () => {
        secondInstanceCalls += 1;
      },
    });
    expect(got).toBe(false);
    expect(calls.some((c) => c[0] === "exit")).toBe(true);
    expect(secondInstanceCalls).toBe(0);
  });

  it("ensureHanaPiSdkDirs creates the .pi/agent and .pi/project subdirs under HANA_HOME and is idempotent", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pi-sdk-dirs-"));
    tmpDirsToCleanup.push(tmpHome);

    ensureHanaPiSdkDirs(tmpHome);

    const agentDir = path.join(tmpHome, ".pi", "agent");
    const projectDir = path.join(tmpHome, ".pi", "project");
    expect(fs.statSync(agentDir).isDirectory()).toBe(true);
    expect(fs.statSync(projectDir).isDirectory()).toBe(true);

    const before = listDirsRecursive(tmpHome);
    expect(before).toEqual([".pi", path.join(".pi", "agent"), path.join(".pi", "project")].sort());

    // Second call must be a no-op: must not throw and must not change the tree.
    expect(() => ensureHanaPiSdkDirs(tmpHome)).not.toThrow();
    const after = listDirsRecursive(tmpHome);
    expect(after).toEqual(before);
  });
});
