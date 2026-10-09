import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, it } from "vitest";

// Execute the production pet functions with only Electron/host I/O replaced.
// No app boot, native permission requests, server, or user files are involved.
const root = process.cwd();
const source = fs.readFileSync(path.join(root, "desktop/main.cjs"), "utf8");
const require = createRequire(path.join(root, "package.json"));
const helpers = require("./desktop/src/shared/pet-window-state.cjs");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${name}`);
  return source.slice(start, end + 2);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function makeHarness(platform = "darwin", saved = {}) {
  // VM paths follow the simulated platform; source reads above use the host path.
  const fixturePath = platform === "win32" ? path.win32 : path.posix;
  const fixtureRoot = platform === "win32" ? "C:\\" : "/";
  const desktopDir = fixturePath.join(fixtureRoot, "repo", "desktop");
  const hanakoHome = fixturePath.join(fixtureRoot, "pet-test-home");
  const windows: FakeWindow[] = [];
  const timers = new Map<object, { callback: () => void; delay: number }>();
  const files = new Map<string, string>();
  const handlers = new Map<string, (...args) => unknown>();
  const diskOperations = [];
  const displays = [{ id: 1, workArea: { x: 72, y: 38, width: 1440, height: 906 }, scaleFactor: 2 }];
  const statePath = fixturePath.join(hanakoHome, "user", "pet-window-state.json");
  files.set(statePath, JSON.stringify(saved));
  class FakeContents extends EventEmitter {
    mainFrame = {};
    sent = [];
    openHandler;
    url = "file:///test/pet.html";
    isDestroyed() { return false; }
    getURL() { return this.url; }
    send(...args) { this.sent.push(clone(args)); }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
  }
  class FakeWindow extends EventEmitter {
    options;
    bounds;
    webContents = new FakeContents();
    destroyed = false;
    visible = false;
    minimized = false;
    shown = 0;
    inactiveShown = 0;
    focusCalls = 0;
    setBoundsCalls = 0;
    topCalls = [];
    ignoreCalls = [];
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.setBoundsCalls++; this.bounds = { ...bounds }; this.emit("move"); }
    setAlwaysOnTop(...args) { this.topCalls.push(clone(args)); }
    setIgnoreMouseEvents(...args) { this.ignoreCalls.push(clone(args)); }
    showInactive() { this.visible = true; this.inactiveShown++; }
    show() { this.visible = true; this.shown++; }
    focus() { this.focusCalls++; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (!prevented) this.destroy();
    }
  }
  const main = new FakeWindow({ x: 0, y: 38, width: 900, height: 800 });
  const tray = { menu: [], refreshes: 0, isDestroyed: () => false,
    setContextMenu(menu) { this.menu = menu; this.refreshes++; } };
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => displays,
    getDisplayNearestPoint: () => displays[0],
    getCursorScreenPoint: () => ({ x: 800, y: 400 }),
  });
  let dockShows = 0;
  const context = vm.createContext({
    ...helpers, path: fixturePath, process: { platform, pid: 12345 }, __dirname: desktopDir,
    hanakoHome, mainWindow: main, petWindow: null,
    isQuitting: false, _isUpdating: false, forceQuitApp: false, isExitingServer: false,
    screen, powerMonitor: new EventEmitter(), BrowserWindow: FakeWindow, tray,
    Menu: { buildFromTemplate: (items) => items },
    app: { dock: { show() { dockShows++; } }, quit() {} },
    mt: (key, _vars, fallback) => fallback || key,
    showPrimaryWindow() {}, createSettingsWindow() {}, triggerArtifactRepairFlow: async () => {},
    attachRendererLaunchDiagnostics() {}, attachRendererArtifactCrashSentinel() {},
    applyTransparentWindowBackground() {}, loadWindowURL() {},
    redactMainLogText: (value) => value, console: { warn() {}, error() {} },
    serverPort: 19800, serverToken: "pet-test-token",
    wrapIpcHandler: (channel, callback) => handlers.set(channel, callback),
    fs: {
      readFileSync: (file) => { if (!files.has(file)) throw new Error("ENOENT"); return files.get(file); },
      mkdirSync: (...args) => diskOperations.push(["mkdir", ...args]),
      writeFileSync: (file, data) => { files.set(file, data); diskOperations.push(["write", file]); },
      renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); diskOperations.push(["rename", from, to]); },
      unlinkSync: (file) => files.delete(file),
    },
    setTimeout: (callback, delay) => { const timer = {}; timers.set(timer, { callback, delay }); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
  });
  const start = source.indexOf("const petWindowStatePath =");
  const end = source.indexOf("function registerQuickChatShortcut(", start);
  assert.ok(start !== -1 && end > start, "production pet section is present");
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(["buildTrayMenu", "refreshTrayMenu"].map(extractFunction).join("\n"), context);
  const ipcStart = source.indexOf("function isPetMainSender(");
  const ipcEnd = source.indexOf('wrapIpcBestEffortHandler("open-settings"', ipcStart);
  assert.ok(ipcStart !== -1 && ipcEnd > ipcStart);
  vm.runInContext(source.slice(ipcStart, ipcEnd), context);
  function timerFor(delay) { return [...timers.entries()].find(([, entry]) => entry.delay === delay); }
  function runTimer(delay) {
    const next = timerFor(delay);
    assert.ok(next, `missing timer ${delay}`);
    timers.delete(next[0]); next[1].callback();
  }
  function eventFor(win) { return { sender: win.webContents, senderFrame: win.webContents.mainFrame }; }
  function invoke(channel, event, ...args) {
    const handler = handlers.get(channel); assert.ok(handler, channel); return handler(event, ...args);
  }
  return { context, windows, main, tray, timers, timerFor, runTimer, files, statePath, displays,
    diskOperations, eventFor, invoke, dockShows: () => dockShows };
}

describe("desktop pet platform lifecycle", () => {
  for (const platform of ["darwin", "win32"]) {
    it(`${platform}: creates a singleton without stealing focus and retains renderer isolation`, () => {
      const h = makeHarness(platform);
      assert.equal(h.context.getPetWindowState().supported, true);
      h.context.showPetWindow(); h.context.showPetWindow();
      const pet = h.context.petWindow;
      assert.equal(h.windows.length, 2);
      assert.equal(pet.inactiveShown, 2);
      assert.equal(pet.shown, 0); assert.equal(pet.focusCalls, 0);
      assert.equal(h.dockShows(), 0, "showing only the pet must not unhide the Dock");
      assert.equal(pet.options.transparent, true); assert.equal(pet.options.frame, false);
      assert.deepEqual(clone(pet.options.webPreferences), {
        preload: platform === "win32" ? "C:\\repo\\desktop\\src\\pet-preload.cjs" : "/repo/desktop/src/pet-preload.cjs",
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      });
      assert.equal(pet.options.type, platform === "darwin" ? "panel" : undefined);
      assert.equal(pet.options.acceptFirstMouse, platform === "darwin" ? true : undefined);
      assert.equal(pet.options.focusable, undefined, "keep default keyboard accessibility");
      assert.deepEqual(pet.ignoreCalls[0], [false, { forward: true }]);
      assert.deepEqual(pet.topCalls[0], [true, "floating"]);
    });

    it(`${platform}: saves visibility, options and DIP bounds, flushes on quit, restores the same values`, () => {
      const h = makeHarness(platform);
      h.context.showPetWindow();
      h.context.setPetOptions({ paused: true, clickThrough: true, alwaysOnTop: false });
      h.context.petWindow.bounds = { x: 360, y: 150, width: 220, height: 252 };
      h.context.petWindow.emit("move");
      h.context.isQuitting = true;
      h.context.flushPetWindowState();
      assert.equal(h.timers.size, 0);
      const saved = JSON.parse(h.files.get(h.statePath));
      assert.deepEqual(saved, { version: 1, bounds: { x: 360, y: 150, width: 220, height: 252 },
        visible: true, paused: true, clickThrough: true, alwaysOnTop: false });
      assert.equal(h.files.size, 1, "atomic write leaves no temporary file");
      const next = makeHarness(platform, saved);
      next.context.showPetWindow();
      assert.deepEqual(next.context.petWindow.getBounds(), saved.bounds);
      assert.deepEqual(next.context.petWindow.ignoreCalls[0], [true, { forward: true }]);
      assert.deepEqual(next.context.petWindow.topCalls[0], [false, "floating"]);
      next.context.hidePetWindow(); next.context.flushPetWindowState();
      assert.equal(JSON.parse(next.files.get(next.statePath)).visible, false);
    });

    it(`${platform}: native close hides and quit close destroys`, () => {
      const h = makeHarness(platform); h.context.showPetWindow();
      const pet = h.context.petWindow;
      pet.close(); assert.equal(pet.isDestroyed(), false); assert.equal(pet.isVisible(), false);
      h.context.showPetWindow(); assert.equal(h.context.petWindow, pet);
      h.context.isQuitting = true; pet.close(); assert.equal(h.context.petWindow, null);
    });

    it(`${platform}: display changes and resume recover bounds, retaining the existing event paths`, () => {
      const h = makeHarness(platform); h.context.registerPetDisplayObservers(); h.context.showPetWindow();
      const pet = h.context.petWindow;
      for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
        pet.bounds = { x: -1500, y: -900, width: 220, height: 252 };
        pet.emit("move"); h.context.screen.emit(event);
        assert.deepEqual(pet.getBounds(), { x: 72, y: 38, width: 220, height: 252 });
      }
      pet.bounds = { x: 3000, y: 3000, width: 220, height: 252 };
      h.context.powerMonitor.emit("resume");
      assert.deepEqual(pet.getBounds(), { x: 1292, y: 692, width: 220, height: 252 });
      assert.ok(pet.webContents.sent.some(([channel]) => channel === "pet-resumed"));
    });

    it(`${platform}: navigation and all pet IPC reject a rogue window or subframe`, () => {
      const h = makeHarness(platform); h.context.showPetWindow();
      const pet = h.context.petWindow;
      let denied = 0;
      pet.webContents.emit("will-navigate", { url: "file:///test/index.html", preventDefault() { denied++; } });
      assert.equal(denied, 1);
      pet.webContents.emit("will-navigate", { url: pet.webContents.getURL(), preventDefault() { denied++; } });
      assert.equal(denied, 1);
      assert.equal(pet.webContents.openHandler().action, "deny");
      const trustedPet = h.eventFor(pet); const trustedMain = h.eventFor(h.main);
      assert.deepEqual(clone(h.invoke("pet-connection", trustedPet)), { port: 19800, token: "pet-test-token" });
      assert.equal(h.invoke("pet-connection", trustedMain), null);
      for (const event of [{ sender: {}, senderFrame: {} }, { sender: pet.webContents, senderFrame: {} }]) {
        for (const channel of ["pet-state", "pet-connection", "pet-show", "pet-hide", "pet-set-options"]) {
          assert.equal(h.invoke(channel, event, { paused: true }), null, channel);
        }
        assert.equal(h.invoke("pet-sync-context", event, { agentId: "rogue", sessionPath: "/rogue" }), false);
        h.invoke("pet-open-main", event); assert.equal(h.main.focusCalls, 0);
      }
      assert.equal(h.invoke("pet-show", trustedPet), null);
      assert.equal(h.invoke("pet-sync-context", trustedPet, {}), false);
      assert.equal(h.context.getPetWindowState().paused, false);
    });

    it(`${platform}: opening a pet session restores main and only macOS unhides the Dock`, () => {
      const h = makeHarness(platform); h.context.showPetWindow(); h.main.minimized = true;
      const context = { agentId: "agent-a", sessionPath: "/session-a", connected: true };
      h.invoke("pet-sync-context", h.eventFor(h.main), context);
      h.invoke("pet-open-main", h.eventFor(h.context.petWindow));
      assert.equal(h.main.minimized, false); assert.equal(h.main.visible, true); assert.equal(h.main.focusCalls, 1);
      assert.equal(h.dockShows(), platform === "darwin" ? 1 : 0);
      assert.ok(h.main.webContents.sent.some(([channel, payload]) =>
        channel === "quick-chat-open-session" && payload.sessionPath === context.sessionPath));
    });
  }

  it("leaves Linux unsupported without creating windows, observers or writes", () => {
    const h = makeHarness("linux"); h.context.showPetWindow(); h.context.registerPetDisplayObservers();
    h.context.setPetOptions({ paused: true }); h.context.flushPetWindowState();
    assert.equal(h.context.getPetWindowState().supported, false);
    assert.equal(h.context.petWindow, null); assert.equal(h.timers.size, 0);
    assert.equal(h.diskOperations.length, 0); assert.deepEqual(h.context.screen.eventNames(), []);
  });

  it("debounces macOS moves instead of clamping on each moved alias", () => {
    const h = makeHarness(); h.context.showPetWindow();
    const pet = h.context.petWindow;
    pet.bounds = { x: -50, y: -50, width: 220, height: 252 }; pet.emit("move");
    const first = h.timerFor(200)[0];
    pet.emit("moved"); assert.equal(pet.setBoundsCalls, 0);
    pet.bounds.x = -90; pet.emit("move");
    assert.equal(h.timers.has(first), false, "new movement replaces the pending settle check");
    assert.equal(pet.setBoundsCalls, 0);
    h.runTimer(200);
    assert.deepEqual(pet.getBounds(), { x: 72, y: 38, width: 220, height: 252 });
    h.runTimer(200); assert.equal(pet.setBoundsCalls, 1, "corrective move settles without a loop");
  });

  it("keeps Windows clamping on its existing moved event", () => {
    const h = makeHarness("win32"); h.context.showPetWindow();
    const pet = h.context.petWindow;
    pet.bounds.x = -90; pet.emit("move");
    assert.equal(h.timerFor(200), undefined); assert.equal(pet.setBoundsCalls, 0);
    pet.emit("moved"); assert.equal(pet.setBoundsCalls, 1); assert.equal(pet.bounds.x, 72);
  });

  it("cancels macOS delayed clamps on destruction and suppresses them while quitting/updating", () => {
    for (const flag of ["isQuitting", "_isUpdating", "forceQuitApp"]) {
      const h = makeHarness(); h.context.showPetWindow(); const pet = h.context.petWindow;
      pet.bounds.x = -90; pet.emit("move"); h.context[flag] = true; h.runTimer(200);
      assert.equal(pet.setBoundsCalls, 0, flag);
    }
    const h = makeHarness(); h.context.showPetWindow(); h.context.petWindow.emit("move");
    h.context.petWindow.destroy(); assert.equal(h.timerFor(200), undefined);
  });

  it("restores saved pet visibility at main creation on both supported platforms", () => {
    const match = source.match(/ {2}if \(isPetPlatformSupported\(process.platform\) && petOptions.visible\) \{\n[\s\S]*?\n {2}\}/);
    assert.ok(match, "main creation must restore saved pet visibility through the shared platform guard");
    for (const platform of ["darwin", "win32", "linux"]) {
      for (const visible of [true, false]) {
        const h = makeHarness(platform, { visible }); vm.runInContext(match[0], h.context);
        if (visible && platform !== "linux") { h.runTimer(0); assert.equal(h.context.getPetWindowState().visible, true); }
        else assert.equal(h.timerFor(0), undefined);
      }
    }
  });
});

describe("macOS pet menu recovery", () => {
  it("offers a recovery control even without a session and refreshes on primary-click-visible state", () => {
    const h = makeHarness(); h.context.refreshTrayMenu();
    const item = (id) => h.tray.menu.find((entry) => entry.id === id);
    assert.equal(item("pet-toggle").label, "Show Desktop Pet");
    item("pet-toggle").click(); assert.equal(h.context.getPetWindowState().context, null);
    assert.equal(item("pet-toggle").label, "Hide Desktop Pet");
    h.context.setPetOptions({ clickThrough: true });
    assert.equal(item("pet-restore-clicks").enabled, true);
    h.main.hide(); item("pet-restore-clicks").click();
    assert.equal(h.context.getPetWindowState().clickThrough, false);
    assert.equal(h.main.visible, false, "mouse recovery should not open main");
    assert.equal(item("pet-restore-clicks").enabled, false);
    item("pet-toggle").click(); assert.equal(h.context.getPetWindowState().visible, false);
    assert.equal(item("pet-toggle").label, "Show Desktop Pet");
  });

  it("keeps saved click-through recoverable before a pet/main window exists", () => {
    const h = makeHarness("darwin", { visible: false, clickThrough: true });
    h.context.mainWindow = null; h.context.refreshTrayMenu();
    const toggle = h.tray.menu.find((entry) => entry.id === "pet-toggle");
    const restore = h.tray.menu.find((entry) => entry.id === "pet-restore-clicks");
    assert.equal(toggle.enabled, false); toggle.click(); assert.equal(h.context.petWindow, null);
    assert.equal(restore.enabled, true); restore.click(); h.context.flushPetWindowState();
    assert.equal(JSON.parse(h.files.get(h.statePath)).clickThrough, false);
  });

  it("retains recovery entries through the same locale-change refresh path", () => {
    const h = makeHarness("darwin", { clickThrough: true });
    h.context.mt = (key) => `new-locale:${key}`; h.context.refreshTrayMenu();
    assert.equal(h.tray.menu.find((entry) => entry.id === "pet-restore-clicks").label, "new-locale:tray.petRestoreClicks");
    const localeBranch = source.slice(source.indexOf('if (type === "locale-changed")'), source.indexOf('// 获取头像本地路径'));
    assert.match(localeBranch, /resetMainI18n\(\);[\s\S]*refreshTrayMenu\(\);/);
    assert.doesNotMatch(localeBranch, /Menu\.buildFromTemplate/);
  });

  it("keeps Windows and Linux menus unchanged", () => {
    for (const platform of ["win32", "linux"]) {
      const h = makeHarness(platform); h.context.refreshTrayMenu();
      assert.deepEqual(clone(h.tray.menu.map((entry) => entry.label || entry.type)), [
        "Show HanaAgent", "Settings", "separator", "Repair Components…", "separator", "Quit",
      ]);
    }
  });

  it("ships translated recovery labels in all five existing locales", () => {
    for (const locale of ["zh", "zh-TW", "en", "ja", "ko"]) {
      const data = JSON.parse(fs.readFileSync(path.join(root, "desktop/src/locales", `${locale}.json`), "utf8"));
      for (const key of ["petShow", "petHide", "petRestoreClicks"]) assert.ok(data.main.tray[key]?.trim(), `${locale}.${key}`);
    }
  });

  it("suppresses the separate notification permission flow in the Darwin native smoke before bootstrap", () => {
    const smoke = fs.readFileSync(path.join(root, "scripts/smoke-desktop-main-pet.cjs"), "utf8");
    const notificationStub = smoke.indexOf('if (process.platform === "darwin") Notification.isSupported = () => false;');
    assert.ok(notificationStub !== -1 && notificationStub < smoke.indexOf('require(path.join(root, "desktop/bootstrap.cjs"))'));
    assert.doesNotMatch(extractFunction("createPetWindow"), /setVisibleOnAllWorkspaces|request.*Access|askForMediaAccess|setActivationPolicy/);
  });
});
