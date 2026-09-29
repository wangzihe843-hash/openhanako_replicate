/**
 * Isolated Windows smoke for the real desktop main and pet windows.
 * Run after build:client: node scripts/smoke-desktop-main-pet.cjs
 * The worker imports the production bootstrap, but runs with a temporary data
 * home and appData path. No provider credentials or model requests are used.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { SERVER_INFO_MAX_WAIT_MS } = require("../desktop/src/shared/server-readiness.cjs");

const root = path.resolve(__dirname, "..");
const home = process.env.HANA_HOME;
const rendererErrors = [];
// A source-mode Windows cold start can spend longer than a UI action timeout
// reading modules. Allow the same bounded startup budget as the application.
const UI_TIMEOUT_MS = 45000;
const STARTUP_TIMEOUT_MS = SERVER_INFO_MAX_WAIT_MS + UI_TIMEOUT_MS;

function assertOwnedSmokeHome(directory) {
  const resolved = fs.realpathSync(directory);
  const tempRoot = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved), tempRoot, "smoke home must be a direct child of the system temp directory");
  assert.match(path.basename(resolved), /^hana-main-pet-smoke-[^\\/]+$/);
  return resolved;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(label, probe, timeoutMs = UI_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch { /* The renderer may still be loading. */ }
    await sleep(125);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runWorker() {
  const { app, BrowserWindow } = require("electron");
  assert.equal(process.platform, "win32", "this smoke exercises Windows desktop pet behavior");
  assert.ok(home, "worker requires an isolated smoke home");
  assertOwnedSmokeHome(home);

  // configureClientSingleInstance derives userData from appData; keep both
  // Electron cache and the Hana data tree inside the disposable smoke home.
  const appData = path.join(home, "electron-appdata");
  fs.mkdirSync(appData, { recursive: true });
  app.setPath("appData", appData);

  // Keep real windows visible to Electron lifecycle checks without taking focus
  // or showing pixels on the user's desktop.
  const showInactive = BrowserWindow.prototype.showInactive;
  BrowserWindow.prototype.show = function smokeShowInactive() { return showInactive.call(this); };
  BrowserWindow.prototype.focus = function smokeDoNotFocus() {};
  app.on("browser-window-created", (_event, win) => {
    try { win.setOpacity(0); win.setSkipTaskbar(true); } catch {}
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("preload-error", (_event, preload, error) => {
      rendererErrors.push(`preload ${preload}: ${error?.stack || error}`);
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) rendererErrors.push(`load ${url}: ${code} ${description}`);
    });
    contents.on("render-process-gone", (_event, details) => {
      rendererErrors.push(`renderer gone: ${details?.reason || "unknown"}`);
    });
    contents.on("console-message", (event) => {
      if (event.level === "error" && /uncaught|\[hana-launch\] init-failed/i.test(event.message || "")) {
        rendererErrors.push(`console: ${event.message}`);
      }
    });
  });

  const failSafe = setTimeout(() => {
    process.stderr.write("desktop main/pet smoke: graceful quit timed out\n");
    app.exit(1);
  }, STARTUP_TIMEOUT_MS + 90000);
  failSafe.unref();

  require(path.join(root, "desktop/bootstrap.cjs"));
  await app.whenReady();
  const windowFor = (page) => BrowserWindow.getAllWindows().find((win) =>
    !win.isDestroyed() && win.webContents.getURL().split("?")[0].endsWith(`/${page}.html`));
  const readyWindow = (page, bridge, timeoutMs = UI_TIMEOUT_MS) => waitFor(`${page} window and ${bridge} preload`, async () => {
    const win = windowFor(page);
    if (!win || win.webContents.isLoadingMainFrame()) return null;
    return await win.webContents.executeJavaScript(`typeof window.${bridge} === 'object'`) ? win : null;
  }, timeoutMs);

  const main = await readyWindow("index", "hana", STARTUP_TIMEOUT_MS);
  const pet = await readyWindow("pet", "hanaPet");
  assert.equal(await main.webContents.executeJavaScript("typeof window.applyTheme"), "function",
    "the main window must load the built theme runtime");
  await waitFor("main React app shell", () => main.webContents.executeJavaScript(
    "Boolean(document.querySelector('#react-root .app-shell .app'))",
  ));
  await waitFor("pet React controls", () => pet.webContents.executeJavaScript(
    "Boolean(document.querySelector('#pet-root main[data-state] nav button'))",
  ));
  assert.deepEqual(rendererErrors, [], "main and pet renderers should load without uncaught errors");
  const petUrl = pet.webContents.getURL();
  const otherLocalPage = pathToFileURL(path.join(root, "desktop/dist-renderer/index.html")).href;
  await pet.webContents.executeJavaScript(`new Promise((resolve) => {
    const link = document.createElement('a');
    link.href = ${JSON.stringify(otherLocalPage)};
    document.body.appendChild(link);
    link.click();
    setTimeout(resolve, 300);
  })`);
  assert.equal(pet.webContents.getURL(), petUrl,
    "the privileged pet preload must not follow renderer-originated links to another local page");
  assert.equal(pet.isVisible(), true, "saved visible pet state should restore after main window creation");
  const mainPort = await main.webContents.executeJavaScript("window.hana.getServerPort()");
  const petConnection = await pet.webContents.executeJavaScript("window.hanaPet.getConnection()");
  assert.ok(Number.isSafeInteger(mainPort) && mainPort > 0, "main should connect to the real local server");
  assert.equal(petConnection?.port, mainPort, "pet and main must use the same server");
  assert.ok(petConnection?.token, "pet preload should receive the local server credential");

  const context = {
    agentId: "smoke-agent", agentName: "Smoke Character", sessionPath: "/smoke-session",
    sessionId: "smoke-session-id", connected: false, streaming: false,
    awaitingApproval: false, inlineError: false,
  };
  // The real main renderer can immediately follow with its own current-session
  // snapshot. Record the event itself so that sync is proven even if that later
  // snapshot supersedes the smoke context before the next poll.
  await pet.webContents.executeJavaScript(
    "window.__smokePetContexts = []; window.hanaPet.onContext((value) => { window.__smokePetContexts.push(value?.sessionId); }); true",
  );
  await main.webContents.executeJavaScript(`window.hana.petSyncContext(${JSON.stringify(context)})`);
  await waitFor("pet context synchronization", () => pet.webContents.executeJavaScript(
    "window.__smokePetContexts.includes('smoke-session-id')",
  ));

  // A second renderer with the same preload must not inherit the trusted pet's
  // localhost credential or mutate the real pet's options.
  const rogue = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "desktop/src/pet-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await rogue.loadFile(path.join(root, "desktop/dist-renderer/pet.html"));
  const rejected = await rogue.webContents.executeJavaScript(`Promise.all([
    window.hanaPet.getState(), window.hanaPet.getConnection(),
    window.hanaPet.hide(), window.hanaPet.setOptions({ paused: true }),
  ])`);
  assert.deepEqual(rejected, [null, null, null, null], "untrusted renderer must receive no pet context or credential");
  assert.equal((await pet.webContents.executeJavaScript("window.hanaPet.getState()"))?.paused, false);
  rogue.destroy();

  await pet.webContents.executeJavaScript("window.hanaPet.hide()");
  await waitFor("pet hidden on request", () => !pet.isVisible());
  await main.webContents.executeJavaScript("window.hana.petShow()");
  await waitFor("pet shown from the main window", () => pet.isVisible());
  await main.webContents.executeJavaScript("window.hana.petSetOptions({ clickThrough: true })");
  assert.equal((await pet.webContents.executeJavaScript("window.hanaPet.getState()"))?.clickThrough, true);
  await main.webContents.executeJavaScript("window.hana.petSetOptions({ clickThrough: false })");
  assert.equal((await pet.webContents.executeJavaScript("window.hanaPet.getState()"))?.clickThrough, false);

  main.close();
  await waitFor("main hidden after close", () => !main.isVisible());
  assert.equal(pet.isVisible(), true, "closing the main window must leave the pet alive");
  await pet.webContents.executeJavaScript("window.hanaPet.openMain()");
  await waitFor("main restored from pet", () => main.isVisible());
  assert.deepEqual(rendererErrors, [], "desktop renderers should remain free of uncaught errors");

  process.stdout.write("desktop main/pet smoke: startup, preload, IPC, close/reopen passed\n");
  app.quit();
}

async function runController() {
  assert.equal(process.platform, "win32", "this smoke is Windows-only");
  for (const artifact of [
    "desktop/preload.bundle.cjs",
    "desktop/dist-splash/splash.html",
    "desktop/dist-renderer/index.html",
    "desktop/dist-renderer/pet.html",
    "desktop/dist-renderer/lib/theme.js",
  ]) {
    assert.ok(fs.existsSync(path.join(root, artifact)),
      `missing built ${artifact}; run npm run build:client first`);
  }
  const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-main-pet-smoke-"));
  assertOwnedSmokeHome(smokeHome);
  const userDir = path.join(smokeHome, "user");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "preferences.json"), JSON.stringify({ setupComplete: true }));
  fs.writeFileSync(path.join(userDir, "pet-window-state.json"), JSON.stringify({ visible: true }));

  // scripts/launch.js supplies the absolute Node runtime in normal dev mode.
  // The smoke invokes Electron directly, so provide the same contract here.
  const env = { ...process.env, HANA_HOME: smokeHome, HANA_DEV_NODE_BIN: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_URL;
  delete env.HANA_ARTIFACT_MANIFEST;
  const child = spawn(require("electron"), [__filename, "--worker"], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = (output + String(chunk)).slice(-16000); });
  }
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, STARTUP_TIMEOUT_MS + 105000);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(timedOut, false, `Electron smoke timed out\n${output}`);
    assert.equal(exitCode, 0, `Electron smoke failed with exit code ${exitCode}\n${output}`);
    assert.match(output, /desktop main\/pet smoke: startup, preload, IPC, close\/reopen passed/);
    assert.equal(fs.existsSync(path.join(smokeHome, "server-info.json")), false,
      "graceful Electron quit should remove its isolated server discovery file");
    process.stdout.write("desktop main/pet smoke: startup, theme, preload, IPC, close/reopen and isolated shutdown passed\n");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    // Failure may call app.exit(1), which bypasses main's graceful server
    // shutdown. Only terminate a server that still proves ownership of this
    // fresh smoke home and names this exact Electron process as its owner.
    const infoPath = path.join(smokeHome, "server-info.json");
    if (fs.existsSync(infoPath)) {
      let info = null;
      try { info = JSON.parse(fs.readFileSync(infoPath, "utf8")); } catch {}
      const owned = info?.ownerKind === "desktop" && info?.ownerPid === child.pid
        && Number.isSafeInteger(info?.pid) && info.pid > 0;
      if (!owned) throw new Error(`Unverified smoke server record; preserving ${smokeHome}`);
      const { probeServerInfo } = require("../shared/server-info-probe.cjs");
      const probe = await probeServerInfo({ info, timeoutMs: 1000 });
      if (probe.status === "alive-same-home") {
        try { process.kill(info.pid, "SIGTERM"); } catch {}
        await waitFor("owned smoke server exit", async () =>
          (await probeServerInfo({ info, timeoutMs: 500 })).status === "dead", 5000);
      } else if (probe.status !== "dead") {
        throw new Error(`Smoke server identity is ${probe.status}; preserving ${smokeHome}`);
      }
    }
    assertOwnedSmokeHome(smokeHome);
    fs.rmSync(smokeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv.includes("--worker")) {
  runWorker().catch((error) => {
    process.stderr.write(`desktop main/pet smoke failed: ${error.stack || error}\nrenderer errors: ${JSON.stringify(rendererErrors)}\n`);
    try { require("electron").app.exit(1); } catch { process.exit(1); }
  });
} else {
  runController().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
