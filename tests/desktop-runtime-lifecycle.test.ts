import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import os from "node:os";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "vitest";

// Run the actual Electron entry's functions with only host I/O replaced.
// This follows the existing server-startup-diagnostics-contract tests.
const source = fs.readFileSync(path.join(process.cwd(), "desktop/main.cjs"), "utf8");
function extractFunctionSource(name) {
  const marker = source.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated function ${name}`);
  return source.slice(start, end + 2);
}

function loadFunctions(context, names) {
  vm.runInContext(names.map(extractFunctionSource).join("\n"), context);
}

function makeBrowserHarness(command: () => Promise<unknown> = async () => ({ ok: true })) {
  const sockets: FakeWebSocket[] = [];
  const timers = new Map<object, () => void>();
  class FakeWebSocket extends EventEmitter {
    url;
    readyState = 1;
    sent = [];
    closeCalls = 0;
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {
      this.closeCalls++;
      this.readyState = 3;
      this.emit("close");
    }
  }
  const context = vm.createContext({
    serverPort: 14500,
    serverToken: "initial-token",
    isQuitting: false,
    _browserCmdWs: null,
    _browserCmdReconnectTimer: null,
    _browserCmdGeneration: 0,
    hanakoHome: "/test-home",
    redactMainLogText: (value) => value,
    console: { log() {} },
    require: (name) => {
      if (name === "ws") return FakeWebSocket;
      if (name === "fs") return { appendFileSync() {} };
      if (name === "path") return path;
      throw new Error(`unexpected require ${name}`);
    },
    setTimeout: (callback, delay) => {
      assert.equal(delay, 2000);
      const timer = { unref() {} };
      timers.set(timer, callback);
      return timer;
    },
    clearTimeout: (timer) => { timers.delete(timer); },
    handleBrowserCommand: command,
  });
  loadFunctions(context, ["stopBrowserCommands", "setupBrowserCommands"]);
  function runNextTimer() {
    assert.equal(timers.size, 1, "exactly one reconnect loop is active");
    const [timer, callback] = timers.entries().next().value;
    timers.delete(timer);
    callback();
  }
  return { context, sockets, timers, runNextTimer };
}

describe("desktop browser control lifecycle", () => {
  it("reconnects with the current server port and token", () => {
    const h = makeBrowserHarness();
    h.context.setupBrowserCommands();
    h.sockets[0].close();
    h.context.serverPort = 14501;
    h.context.serverToken = "replacement/token+value";
    h.runNextTimer();
    assert.equal(h.sockets[1].url, "ws://127.0.0.1:14501/internal/browser?token=replacement%2Ftoken%2Bvalue");
    assert.equal(h.context._browserCmdWs, h.sockets[1]);
  });

  it("replaces the old connection and cancels its reconnect loop", () => {
    const h = makeBrowserHarness();
    h.context.setupBrowserCommands();
    h.sockets[0].close();
    const obsoleteCallback = [...h.timers.values()][0];
    h.context.serverPort = 14501;
    h.context.serverToken = "replacement";
    h.context.setupBrowserCommands();
    assert.equal(h.timers.size, 0);
    h.sockets[1].close();
    const currentTimer = h.context._browserCmdReconnectTimer;
    obsoleteCallback(); // A callback already queued when it was cancelled.
    h.sockets[0].emit("close");
    assert.equal(h.context._browserCmdReconnectTimer, currentTimer);
    assert.equal(h.timers.size, 1);
    h.runNextTimer();
    assert.equal(h.sockets.length, 3);
    assert.equal(h.context._browserCmdWs, h.sockets[2]);
  });

  it("does not create competing loops when setup or close is repeated", () => {
    const h = makeBrowserHarness();
    h.context.setupBrowserCommands();
    h.context.setupBrowserCommands();
    assert.equal(h.sockets[0].closeCalls, 1);
    assert.equal(h.timers.size, 0);
    h.sockets[0].emit("close");
    h.sockets[1].close();
    h.sockets[1].emit("close");
    h.runNextTimer();
    assert.equal(h.sockets.length, 3);
    assert.equal(h.context._browserCmdWs, h.sockets[2]);
  });

  for (const rejectCommand of [false, true]) {
    it(`drops an old asynchronous command ${rejectCommand ? "error" : "result"} after reconnection`, async () => {
      let settle;
      const pending = new Promise((resolve, reject) => { settle = rejectCommand ? reject : resolve; });
      const h = makeBrowserHarness(() => pending);
      h.context.setupBrowserCommands();
      const oldSocket = h.sockets[0];
      const complete = oldSocket.listeners("message")[0](JSON.stringify({ type: "browser-cmd", id: "old-id", cmd: "wait" }));
      oldSocket.close();
      h.runNextTimer();
      settle(rejectCommand ? new Error("old failure") : { old: true });
      await complete;
      assert.deepEqual(oldSocket.sent, []);
      assert.deepEqual(h.sockets[1].sent, []);
    });
  }

  it("ignores messages and delayed replies from a replaced generation even before close finishes", async () => {
    let finish;
    let commandCalls = 0;
    const h = makeBrowserHarness(() => {
      commandCalls++;
      return new Promise((resolve) => { finish = resolve; });
    });
    h.context.setupBrowserCommands();
    const oldSocket = h.sockets[0];
    const command = JSON.stringify({ type: "browser-cmd", id: "old-id", cmd: "wait" });
    const complete = oldSocket.listeners("message")[0](command);
    oldSocket.close = () => { oldSocket.closeCalls++; };
    h.context.setupBrowserCommands();
    await oldSocket.listeners("message")[0](command);
    finish({ old: true });
    await complete;
    assert.equal(commandCalls, 1);
    assert.deepEqual(oldSocket.sent, []);
    assert.deepEqual(h.sockets[1].sent, []);
  });

  for (const rejectCommand of [false, true]) {
    it(`still returns a current command ${rejectCommand ? "error" : "result"} to its own socket`, async () => {
      const h = makeBrowserHarness(async () => {
        if (rejectCommand) throw new Error("command failure");
        return { ok: true };
      });
      h.context.setupBrowserCommands();
      await h.sockets[0].listeners("message")[0](JSON.stringify({ type: "browser-cmd", id: "current-id", cmd: "run" }));
      assert.deepEqual(h.sockets[0].sent, [rejectCommand
        ? { type: "browser-result", id: "current-id", error: "command failure" }
        : { type: "browser-result", id: "current-id", result: { ok: true } }]);
    });
  }

  it("cancels a pending reconnect and cannot reopen after quit", () => {
    const h = makeBrowserHarness();
    h.context.setupBrowserCommands();
    h.sockets[0].close();
    const alreadyQueued = [...h.timers.values()][0];
    h.context.isQuitting = true;
    h.context.stopBrowserCommands();
    assert.equal(h.timers.size, 0);
    alreadyQueued();
    h.context.setupBrowserCommands();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.context._browserCmdWs, null);
  });

  it("reconnects immediately after monitorServer publishes a replacement server", async () => {
    const h = makeBrowserHarness();
    const oldProcess = new EventEmitter();
    const replacementProcess = new EventEmitter();
    Object.assign(h.context, {
      serverProcess: oldProcess,
      _intentionalServerStops: new WeakSet(),
      _serverRestartAttempts: 0,
      _isUpdating: false,
      isExitingServer: false,
      _isApplyingTrainUpdate: false,
      mainWindow: null,
      settingsWindow: null,
      console: { log() {}, error() {} },
      startServer: async () => {
        assert.equal(h.context._browserCmdWs, null);
        h.context.serverPort = 14501;
        h.context.serverToken = "replacement";
        h.context.serverProcess = replacementProcess;
      },
    });
    loadFunctions(h.context, ["monitorServer"]);
    h.context.setupBrowserCommands();
    h.context.monitorServer();
    await oldProcess.listeners("exit")[0](1, null);
    assert.equal(h.sockets[0].closeCalls, 1);
    assert.equal(h.sockets[1].url, "ws://127.0.0.1:14501/internal/browser?token=replacement");
    assert.equal(replacementProcess.listenerCount("exit"), 1);
    assert.equal(h.timers.size, 0);
  });

  it("wires cleanup before quit early returns and refreshes after apply-now restart", () => {
    const beforeQuit = source.slice(source.indexOf('app.on("before-quit", async (event) => {'));
    assert.ok(beforeQuit.indexOf("stopBrowserCommands();") < beforeQuit.indexOf("if (_isUpdating) return;"));
    const applyNow = extractFunctionSource("applyTrainUpdateNow");
    assert.ok(applyNow.indexOf("stopBrowserCommands();") > applyNow.indexOf("assertServerShutdownConfirmed(shutdownResult)"));
    assert.ok(applyNow.indexOf("setupBrowserCommands();") > applyNow.indexOf("await startServer()"));
  });

  for (const shutdownOutcome of ["external-running", "unconfirmed-owned", "throws", "confirmed"]) {
    it(`keeps a single usable browser channel after apply-now shutdown is ${shutdownOutcome}`, async () => {
      const h = makeBrowserHarness();
      let restartCalls = 0;
      Object.assign(h.context, {
        app: { isPackaged: true, getVersion: () => "1.0.0" },
        process: { platform: "darwin", arch: "arm64" },
        readUpdateChannelPreference: () => "beta",
        loadPinnedKeyset: () => [],
        trainUpdateApply,
        artifactOta: {
          downloadAndApplyArtifacts: async () => ({ ok: true }),
          readStagedTrainStatus: async () => ({ staged: true }),
        },
        shutdownServer: async () => {
          if (shutdownOutcome === "throws") throw new Error("shutdown failed");
          return { confirmed: shutdownOutcome === "confirmed", reason: shutdownOutcome };
        },
        startServer: async () => {
          restartCalls++;
          h.context.serverPort = 14501;
          h.context.serverToken = "updated-server";
        },
        monitorServer() {},
        reloadAllWindowsForTrainUpdate() {},
        console: { log() {}, error() {} },
        dialog: { showErrorBox() {} },
        mt: (key) => key,
      });
      loadFunctions(h.context, ["applyTrainUpdateNow"]);
      h.context.setupBrowserCommands();
      const original = h.sockets[0];
      const result = await h.context.applyTrainUpdateNow(null);
      assert.equal(h.timers.size, 0);
      assert.equal(h.context._isApplyingTrainUpdate, false);
      if (shutdownOutcome === "confirmed") {
        assert.equal(result.ok, true);
        assert.equal(restartCalls, 1);
        assert.equal(original.closeCalls, 1);
        assert.equal(h.context._browserCmdWs, h.sockets[1]);
        assert.equal(h.sockets[1].url, "ws://127.0.0.1:14501/internal/browser?token=updated-server");
      } else {
        assert.equal(result.ok, false);
        assert.equal(restartCalls, 0);
        assert.equal(original.closeCalls, 0);
        assert.equal(h.context._browserCmdWs, original);
      }
    });
  }
});

function makeStartupHarness(options: {
  platform?: "darwin" | "win32";
  ownerKind?: string;
  rendererError?: Error;
  reusable?: boolean;
  alive?: boolean;
  knownDead?: boolean;
  isPackaged?: boolean;
  hasSeed?: boolean;
} = {}) {
  // This VM has no real filesystem I/O: keep its paths tied to its platform.
  const platform = options.platform ?? "darwin";
  const fixturePath = platform === "win32" ? path.win32 : path.posix;
  const fixtureRoot = platform === "win32" ? "C:\\" : "/";
  const resourcesPath = platform === "win32"
    ? "C:\\Program Files\\HanaAgent\\resources"
    : "/Applications/HanaAgent.app/Contents/Resources";
  const rendererDir = fixturePath.join(fixtureRoot, "verified-renderer");
  const rendererIndex = fixturePath.join(rendererDir, "index.html");
  const calls = [];
  const info = { pid: 1234, port: 14500, token: "trusted-token", version: "1.0.0", ownerKind: options.ownerKind ?? "desktop" };
  const context = vm.createContext({
    path: fixturePath,
    app: { isPackaged: options.isPackaged ?? true, getVersion: () => "1.0.0" },
    process: {
      platform, arch: platform === "win32" ? "x64" : "arm64", resourcesPath, env: {},
      kill: () => { if (options.alive === false) throw new Error("not running"); },
    },
    fs: {
      readFileSync: () => JSON.stringify(info),
      existsSync: (file) => file === rendererIndex,
      unlinkSync: () => calls.push("unlink-info"),
    },
    console: { log() {}, warn() {}, error() {} },
    hanakoHome: fixturePath.join(fixtureRoot, "test-home"),
    __dirname: fixturePath.join(resourcesPath, "app.asar", "desktop"),
    _isDev: false,
    _distRenderer: fixturePath.join(fixtureRoot, "app.asar", "desktop", "dist-renderer"),
    _rendererBootChannel: null,
    _rendererBootTrain: null,
    _reusedServerArtifactVersion: null,
    _artifactBootChannel: null,
    _currentContentVersion: null,
    serverPort: null,
    serverToken: null,
    reusedServerPid: null,
    reusedServerOwned: false,
    splashWindow: null,
    readUpdateChannelPreference: () => "beta",
    loadPinnedKeyset: () => [],
    redactMainLogText: (value) => value,
    artifactBoot: {
      hasSeed: () => options.hasSeed ?? true,
      rendererPointerChannel: (channel) => `${channel}.renderer`,
      prepareArtifactRendererBoot: async (opts) => {
        calls.push("renderer-only");
        assert.equal(opts.reuseServerVersion, "1.0.0");
        assert.equal(opts.channel, "beta");
        if (options.rendererError) throw options.rendererError;
        return { versionDir: rendererDir, version: "1.0.0", train: 7, slot: "current" };
      },
    },
    verifyReusableServerInfo: async () => {
      calls.push("verify");
      return { reusable: options.reusable ?? true, terminate: false, identity: { studioId: "expected-home", version: "1.0.0" }, reason: "untrusted" };
    },
    requestServerShutdown: async () => { calls.push("shutdown"); },
    waitForProcessExit: async () => { calls.push("wait-exit"); return options.knownDead ?? true; },
    signalPidOnPosix: () => { calls.push("signal"); },
    readDesiredServerNetworkConfig: () => ({ config: { listenPort: info.port } }),
    resolveStaleServerInfoDisposition: ({ knownDead }) => ({ removeInfoFile: knownDead, failFast: !knownDead }),
    STALE_SERVER_EXIT_GRACE_MS: 1,
    SERVER_SHUTDOWN_GRACE_MS: 1,
    SERVER_FORCE_KILL_WAIT_MS: 1,
    resolvePackagedArtifactBoot: async () => { calls.push("full-boot"); return { serverRoot: fixturePath.join(fixtureRoot, "fresh-server") }; },
    ensureServerFilesReady: async () => ({ ok: true }),
    _spawnServerOnce: async () => { calls.push("spawn"); },
  });
  loadFunctions(context, ["isDesktopOwnedServerInfo", "resolvePackagedRendererForServerReuse", "startServer", "loadPageFromDir", "loadWindowURL"]);
  return { context, info, calls };
}

describe("packaged renderer initialization when reusing a server", () => {
  for (const ownerKind of ["desktop", "standalone"]) {
    it.each(["darwin", "win32"] as const)(`loads a verified renderer and initializes content/crash state with a ${ownerKind} server (%s paths)`, async (platform) => {
      const h = makeStartupHarness({ ownerKind, platform });
      await h.context.startServer();
      let loadedFile;
      h.context.loadWindowURL({ loadFile: (file) => { loadedFile = file; } }, "index");
      assert.equal(loadedFile, platform === "win32" ? "C:\\verified-renderer\\index.html" : "/verified-renderer/index.html");
      assert.equal(h.context._rendererBootChannel, "beta.renderer");
      assert.equal(h.context._artifactBootChannel, "beta");
      assert.equal(h.context._rendererBootTrain, 7);
      assert.equal(h.context._currentContentVersion, "1.0.0");
      assert.equal(h.context._reusedServerArtifactVersion, "1.0.0");
      assert.equal(h.context.serverPort, 14500);
      assert.equal(h.context.serverToken, "trusted-token");
      assert.equal(h.context.reusedServerOwned, ownerKind === "desktop");
      assert.deepEqual(h.calls, ["verify", "renderer-only"]);
    });
  }

  it("requires confirmed owned-server exit before full boot following a reuse rejection", async () => {
    const rendererError = Object.assign(new Error("mismatch"), { code: "ARTIFACT_REUSE_REQUIRES_RESTART" });
    const h = makeStartupHarness({ rendererError });
    await h.context.startServer();
    assert.deepEqual(h.calls, ["verify", "renderer-only", "shutdown", "wait-exit", "unlink-info", "full-boot", "spawn"]);
  });

  it("does not mutate artifacts or spawn after owned-server exit is unconfirmed", async () => {
    const rendererError = Object.assign(new Error("mismatch"), { code: "ARTIFACT_REUSE_REQUIRES_RESTART" });
    const h = makeStartupHarness({ rendererError, knownDead: false });
    await assert.rejects(h.context.startServer(), { code: "STALE_SERVER_UNCLEANED" });
    assert.ok(!h.calls.includes("full-boot"));
    assert.ok(!h.calls.includes("spawn"));
    assert.ok(!h.calls.includes("unlink-info"));
  });

  it("leaves an external server alone when renderer reuse requires a restart", async () => {
    const rendererError = Object.assign(new Error("stop the server before restarting HanaAgent"), { code: "ARTIFACT_REUSE_REQUIRES_RESTART" });
    const h = makeStartupHarness({ rendererError, ownerKind: "standalone" });
    await assert.rejects(h.context.startServer(), { code: "ARTIFACT_REUSE_REQUIRES_RESTART" });
    assert.deepEqual(h.calls, ["verify", "renderer-only"]);
    assert.equal(h.context.serverPort, null);
  });

  it("does not route around a busy artifact lock by restarting an owned server", async () => {
    const rendererError = Object.assign(new Error("retry after artifact operation finishes"), { code: "ARTIFACT_REUSE_BUSY" });
    const h = makeStartupHarness({ rendererError });
    await assert.rejects(h.context.startServer(), { code: "ARTIFACT_REUSE_BUSY" });
    assert.deepEqual(h.calls, ["verify", "renderer-only"]);
    assert.equal(h.context.serverPort, null);
  });

  it("does not run artifact code or signal a live untrusted server", async () => {
    const h = makeStartupHarness({ reusable: false, knownDead: false });
    await assert.rejects(h.context.startServer(), { code: "STALE_SERVER_UNCLEANED" });
    assert.deepEqual(h.calls, ["verify", "wait-exit"]);
  });

  it("retains ordinary full boot when the recorded server is dead", async () => {
    const h = makeStartupHarness({ alive: false });
    await h.context.startServer();
    assert.deepEqual(h.calls, ["unlink-info", "full-boot", "spawn"]);
  });

  it("keeps source development reuse unchanged when no seed exists", async () => {
    const h = makeStartupHarness({ isPackaged: false, hasSeed: false });
    await h.context.startServer();
    assert.deepEqual(h.calls, ["verify"]);
    assert.equal(h.context._distRenderer, "/app.asar/desktop/dist-renderer");
    assert.equal(h.context._rendererBootChannel, null);
  });

  it("clears the reuse constraint when normal server boot begins", async () => {
    const h = makeStartupHarness({ isPackaged: false, hasSeed: false });
    h.context._reusedServerArtifactVersion = "1.0.0";
    loadFunctions(h.context, ["resolvePackagedArtifactBoot"]);
    assert.equal(await h.context.resolvePackagedArtifactBoot(), null);
    assert.equal(h.context._reusedServerArtifactVersion, null);
  });

  it("rejects a packaged install without a seed before connecting or stopping the server", async () => {
    const h = makeStartupHarness({ hasSeed: false });
    await assert.rejects(h.context.startServer(), /missing its artifact seed/);
    assert.deepEqual(h.calls, ["verify"]);
    assert.equal(h.context.serverPort, null);
  });
});

const require = createRequire(path.join(process.cwd(), "package.json"));
const artifactBoot = require("./desktop/src/shared/artifact-boot.cjs");
const activation = require("./shared/artifact-core/activation.cjs");
const pointerStore = require("./shared/artifact-core/pointer-store.cjs");
const ustar = require("./shared/artifact-core/ustar.cjs");
const trainUpdateApply = require("./desktop/src/shared/train-update-apply.cjs");
const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function makeArtifactFixture(version = "1.0.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reuse-test-"));
  temporaryRoots.push(root);
  const homeDir = path.join(root, "home");
  const resourcesPath = path.join(root, "resources");
  const seedDir = path.join(resourcesPath, "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyset = [{ keyId: "reuse-test", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }];
  const rendererTree = path.join(root, "renderer-tree");
  fs.mkdirSync(rendererTree);
  fs.writeFileSync(path.join(rendererTree, "index.html"), "<!doctype html><p>verified renderer</p>");
  const archiveName = `renderer-${version}.tar.gz`;
  const archivePath = path.join(seedDir, archiveName);
  await ustar.packTree(rendererTree, archivePath);
  const entry = { version, path: archiveName, sha256: await activation.sha256File(archivePath), size: fs.statSync(archivePath).size };
  const manifest = {
    schema: 1, train: 0, channel: "stable", releasedAt: "2026-10-07T00:00:00.000Z",
    keyId: "reuse-test", minShell: version, contract: { preload: 1, serverProtocol: 1 },
    urgent: false, rollout: { percent: 100, salt: "reuse" }, mirrors: [],
    artifacts: { renderer: entry, server: { "darwin-arm64": { ...entry, path: `server-${version}-darwin-arm64.tar.gz` } } },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(seedDir, "seed-train-darwin-arm64.json"), bytes);
  fs.writeFileSync(path.join(seedDir, "seed-train-darwin-arm64.json.sig"), sign(null, bytes, privateKey));
  const bootOptions = { homeDir, resourcesPath, keyset, platformArch: "darwin-arm64", channel: "beta", reuseServerVersion: version, log() {} };
  return { root, homeDir, resourcesPath, entry, bootOptions };
}

async function writeArtifactPointer(fixture, kind, slot, version, train = 7) {
  const channel = kind === "renderer" ? "beta.renderer" : "beta";
  const suffix = kind === "renderer" ? version : `${version}-darwin-arm64`;
  const versionDir = path.join(fixture.homeDir, "artifacts", kind, suffix);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, "index.html"), `protected ${kind} ${version}`);
  fs.writeFileSync(path.join(versionDir, ".verified"), JSON.stringify({ sha256: fixture.entry.sha256, train, version }));
  const pointer = { kind, channel, version, train, versionDir, sha256: fixture.entry.sha256 };
  await pointerStore.writePointer(fixture.homeDir, channel, slot, pointer);
  return pointer;
}

function snapshotTree(root) {
  // These fixtures touch real files, so snapshot keys use host path semantics.
  const files = {};
  if (!fs.existsSync(root)) return files;
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else files[path.relative(root, file)] = stat.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : fs.readFileSync(file).toString("base64");
    }
  }
  visit(root);
  return files;
}

describe("artifact boot with an already running server", () => {
  it("resolves the compatible active renderer without promoting next or changing any bytes", async () => {
    const f = await makeArtifactFixture();
    const current = await writeArtifactPointer(f, "renderer", "current", "1.0.0");
    await writeArtifactPointer(f, "renderer", "next", "2.0.0", 8);
    await writeArtifactPointer(f, "server", "current", "1.0.0");
    await writeArtifactPointer(f, "server", "next", "2.0.0", 8);
    const before = snapshotTree(f.homeDir);
    const result = await artifactBoot.prepareArtifactRendererBoot(f.bootOptions);
    assert.equal(result.versionDir, current.versionDir);
    assert.equal(result.activatedSeed, false);
    assert.deepEqual(snapshotTree(f.homeDir), before);
  });

  it("uses a valid previous renderer without repairing an invalid current directory", async () => {
    const f = await makeArtifactFixture();
    const current = await writeArtifactPointer(f, "renderer", "current", "2.0.0", 8);
    const previous = await writeArtifactPointer(f, "renderer", "previous", "1.0.0");
    fs.unlinkSync(path.join(current.versionDir, ".verified"));
    const before = snapshotTree(f.homeDir);
    const result = await artifactBoot.prepareArtifactRendererBoot(f.bootOptions);
    assert.equal(result.versionDir, previous.versionDir);
    assert.equal(result.slot, "previous");
    assert.deepEqual(snapshotTree(f.homeDir), before);
  });

  it("extracts only a first matching renderer seed for a standalone server", async () => {
    const f = await makeArtifactFixture();
    await writeArtifactPointer(f, "server", "current", "1.0.0");
    await writeArtifactPointer(f, "server", "next", "2.0.0", 8);
    const serverBefore = snapshotTree(path.join(f.homeDir, "artifacts/server"));
    const pointerBefore = fs.readFileSync(pointerStore.pointerPath(f.homeDir, "beta", "current"), "utf8");
    const nextBefore = fs.readFileSync(pointerStore.pointerPath(f.homeDir, "beta", "next"), "utf8");
    const result = await artifactBoot.prepareArtifactRendererBoot(f.bootOptions);
    assert.equal(result.activatedSeed, true);
    assert.match(fs.readFileSync(path.join(result.versionDir, "index.html"), "utf8"), /verified renderer/);
    assert.deepEqual(snapshotTree(path.join(f.homeDir, "artifacts/server")), serverBefore);
    assert.equal(fs.readFileSync(pointerStore.pointerPath(f.homeDir, "beta", "current"), "utf8"), pointerBefore);
    assert.equal(fs.readFileSync(pointerStore.pointerPath(f.homeDir, "beta", "next"), "utf8"), nextBefore);
  });

  it("keeps renderer failure retries read-only while a reused server remains attached", async () => {
    const f = await makeArtifactFixture();
    const current = await writeArtifactPointer(f, "renderer", "current", "1.0.0");
    await writeArtifactPointer(f, "renderer", "next", "2.0.0", 8);
    await writeArtifactPointer(f, "server", "current", "1.0.0");
    await writeArtifactPointer(f, "server", "next", "2.0.0", 8);
    const before = snapshotTree(f.homeDir);
    let reloads = 0;
    const context = vm.createContext({
      artifactBoot,
      console: { log() {}, error() {}, warn() {} },
      hanakoHome: f.homeDir,
      process: { resourcesPath: f.resourcesPath, platform: "darwin", arch: "arm64" },
      _artifactBootChannel: "beta",
      _rendererBootChannel: "beta.renderer",
      _rendererBootTrain: 7,
      _reusedServerArtifactVersion: "1.0.0",
      _currentContentVersion: "1.0.0",
      _distRenderer: current.versionDir,
      loadPinnedKeyset: () => f.bootOptions.keyset,
      redactMainLogText: (value) => value,
      writeDesktopLaunchDiagnostic() {},
      setTimeout: () => { reloads++; },
    });
    loadFunctions(context, ["buildCrashFallbackNotice", "handleRendererArtifactLoadFailure"]);
    for (let attempt = 0; attempt < 4; attempt++) {
      await context.handleRendererArtifactLoadFailure({ win: { isDestroyed: () => false }, pageName: "index", label: "index", reason: "crashed" });
    }
    const after = snapshotTree(f.homeDir);
    const sentinelKey = path.join("artifacts", "beta.renderer.sentinel.json");
    assert.ok(Object.hasOwn(after, sentinelKey), "renderer failures must write the expected sentinel");
    delete after[sentinelKey];
    assert.deepEqual(after, before);
    assert.equal(reloads, 3, "crash-loop recovery must wait for a safe server restart");
    assert.equal(context._distRenderer, current.versionDir);
    assert.equal(context._currentContentVersion, "1.0.0");
  });

  it("refuses first-install work while another process holds the artifact lock", async () => {
    const f = await makeArtifactFixture();
    const lock = await pointerStore.acquireLock(f.homeDir);
    // Even a long-running updater's lock must not be stolen for reuse startup.
    fs.utimesSync(pointerStore.lockPath(f.homeDir), new Date(0), new Date(0));
    const before = snapshotTree(f.homeDir);
    try {
      await assert.rejects(artifactBoot.prepareArtifactRendererBoot(f.bootOptions), { code: "ARTIFACT_REUSE_BUSY" });
      assert.deepEqual(snapshotTree(f.homeDir), before);
    } finally {
      await lock.release();
    }
  });

  for (const competingWrite of ["next-pointer", "renderer-directory"]) {
    it(`rechecks a competing ${competingWrite} after acquiring the first-install lock`, async () => {
      const f = await makeArtifactFixture();
      const originalAcquireLock = pointerStore.acquireLock;
      let protectedState;
      pointerStore.acquireLock = async (...args) => {
        if (competingWrite === "next-pointer") await writeArtifactPointer(f, "renderer", "next", "2.0.0", 8);
        else {
          const dir = path.join(f.homeDir, "artifacts/renderer/1.0.0");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "index.html"), "another process installed this renderer");
        }
        protectedState = snapshotTree(f.homeDir);
        return originalAcquireLock(...args);
      };
      try {
        await assert.rejects(artifactBoot.prepareArtifactRendererBoot(f.bootOptions), { code: "ARTIFACT_REUSE_REQUIRES_RESTART" });
        assert.deepEqual(snapshotTree(f.homeDir), protectedState);
      } finally {
        pointerStore.acquireLock = originalAcquireLock;
      }
    });
  }

  it("rejects a bad seed signature without changing existing artifacts", async () => {
    const f = await makeArtifactFixture();
    await writeArtifactPointer(f, "renderer", "current", "1.0.0");
    fs.writeFileSync(path.join(f.resourcesPath, "seed/seed-train-darwin-arm64.json.sig"), Buffer.alloc(64));
    const before = snapshotTree(f.homeDir);
    await assert.rejects(artifactBoot.prepareArtifactRendererBoot(f.bootOptions), /signature/i);
    assert.deepEqual(snapshotTree(f.homeDir), before);
  });

  for (const rejection of ["version", "seed-version", "crash-loop", "invalid-current", "pending-next", "existing-directory", "dangling-link"]) {
    it(`rejects ${rejection} without promoting, deleting, repairing, or changing protected artifact bytes`, async () => {
      const f = await makeArtifactFixture();
      await writeArtifactPointer(f, "server", "current", "1.0.0");
      await writeArtifactPointer(f, "server", "next", "2.0.0", 8);
      if (rejection === "version") await writeArtifactPointer(f, "renderer", "current", "2.0.0");
      if (rejection === "seed-version") f.bootOptions.reuseServerVersion = "0.9.0";
      if (rejection === "crash-loop") {
        await writeArtifactPointer(f, "renderer", "current", "1.0.0");
        for (let i = 0; i < 3; i++) await activation.writeSentinel(f.homeDir, "beta.renderer", 7);
      }
      if (rejection === "invalid-current") {
        const pointer = await writeArtifactPointer(f, "renderer", "current", "1.0.0");
        fs.unlinkSync(path.join(pointer.versionDir, ".verified"));
      }
      if (rejection === "pending-next") await writeArtifactPointer(f, "renderer", "next", "2.0.0");
      if (rejection === "existing-directory" || rejection === "dangling-link") {
        const target = path.join(f.homeDir, "artifacts/renderer/1.0.0");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (rejection === "dangling-link") fs.symlinkSync(path.join(f.root, "absent-target"), target, "junction");
        else {
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, "index.html"), "external content that must remain intact");
        }
      }
      const before = snapshotTree(f.homeDir);
      await assert.rejects(artifactBoot.prepareArtifactRendererBoot(f.bootOptions), { code: "ARTIFACT_REUSE_REQUIRES_RESTART" });
      assert.deepEqual(snapshotTree(f.homeDir), before);
    });
  }
});
