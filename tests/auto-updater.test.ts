import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks（必须在 import 之前声明）──

const mockAutoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  installDirectory: undefined,
  checkForUpdates: vi.fn().mockResolvedValue({}),
  downloadUpdate: vi.fn().mockResolvedValue(null),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn(),
};

const mockWindows = [];
let mockExePath = "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => mockWindows) },
  app: {
    isPackaged: true,
    getVersion: () => "1.0.0",
    getPath: (name) => {
      if (name === "exe") return mockExePath;
      if (name === "userData") return "/tmp/test-userdata";
      return "/tmp";
    },
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}));

describe("auto-updater", () => {
  let handlers;
  let ipcHandlers;
  let mod;
  let ipcMain;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    handlers = {};
    ipcHandlers = {};
    mockWindows.length = 0;

    mockAutoUpdater.on.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });
    mockAutoUpdater.autoDownload = true;
    mockAutoUpdater.autoInstallOnAppQuit = true;
    mockAutoUpdater.allowPrerelease = false;
    mockAutoUpdater.installDirectory = undefined;
    mockExePath = "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent";
    delete process.env.HANA_UPDATE_FEED_URL;
    delete process.env.HANA_UPDATE_SOURCE;
    delete process.env.HANA_UPDATE_PROVIDER;
    delete process.env.HANA_UPDATE_DIGEST_BASE_URL;
    delete process.env.HANA_ATOMGIT_UPDATE_FEED_URL;
    delete process.env.HANA_ATOMGIT_RELEASE_BASE_URL;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue("not found"),
      json: vi.fn(),
    }));

    ({ ipcMain } = await import("electron"));
    ipcMain.handle.mockImplementation((name, handler) => {
      ipcHandlers[name] = handler;
    });

    mod = await import("../desktop/auto-updater.cjs");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createMockWindow() {
    return {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
  }

  function initWithMockWindow(opts = {}) {
    const win = createMockWindow();
    mockWindows.push(win);
    mod.initAutoUpdater(win, opts);
    return win;
  }

  function createDestroyedWindow() {
    const win = {
      isDestroyed: () => true,
      webContents: { send: vi.fn() },
    };
    return win;
  }

  it("should configure autoUpdater correctly", () => {
    initWithMockWindow();
    expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://gitcode.com/liliMozi/OpenHanako-Releases/releases/download/latest/",
    });
    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("resolves AtomGit as the default feed with GitHub fallback", () => {
    const config = mod.resolveUpdateFeedConfig({});
    expect(config.feedURL).toEqual({
      provider: "generic",
      url: "https://gitcode.com/liliMozi/OpenHanako-Releases/releases/download/latest/",
    });
    expect(config.fallbackConfigs).toHaveLength(1);
    expect(config.fallbackConfigs[0].feedURL).toEqual({
      provider: "github",
      owner: "liliMozi",
      repo: "openhanako",
    });
  });

  it("resolves AtomGit as a generic update feed with matching digest URLs", () => {
    const config = mod.resolveUpdateFeedConfig({ HANA_UPDATE_SOURCE: "atomgit" });
    expect(config.feedURL).toEqual({
      provider: "generic",
      url: "https://gitcode.com/liliMozi/OpenHanako-Releases/releases/download/latest/",
    });
    expect(mod.buildReleaseDigestUrl("0.425.4", config)).toBe(
      "https://gitcode.com/liliMozi/OpenHanako-Releases/releases/download/v0.425.4/release-digest.v1.json",
    );
  });

  it("can force GitHub as the only update feed", () => {
    const config = mod.resolveUpdateFeedConfig({ HANA_UPDATE_SOURCE: "github" });
    expect(config.feedURL).toEqual({
      provider: "github",
      owner: "liliMozi",
      repo: "openhanako",
    });
    expect(config.fallbackConfigs).toEqual([]);
  });

  it("loads digest from the generic feed directory when an explicit feed URL is configured", () => {
    const config = mod.resolveUpdateFeedConfig({ HANA_UPDATE_FEED_URL: "https://updates.example.com/hana/stable" });
    expect(config.feedURL).toEqual({
      provider: "generic",
      url: "https://updates.example.com/hana/stable/",
    });
    expect(mod.buildReleaseDigestUrl("0.425.4", config)).toBe(
      "https://updates.example.com/hana/stable/release-digest.v1.json",
    );
  });

  it("pins the NSIS install directory to the running exe directory on Windows", async () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.resetModules();
      mockExePath = "/tmp/HanaAgent/HanaAgent.exe";
      mod = await import("../desktop/auto-updater.cjs");

      initWithMockWindow();

      expect(mockAutoUpdater.installDirectory).toBe("/tmp/HanaAgent");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("should map update-available to available state", async () => {
    initWithMockWindow();
    if (handlers["update-available"]) {
      await handlers["update-available"]({ version: "2.0.0", releaseNotes: "New features" });
    }
    const state = mod.getState();
    expect(state.version).toBe("2.0.0");
    expect(["available", "downloading", "error"]).toContain(state.status);
  });

  it("should map update-not-available to latest state", () => {
    initWithMockWindow();
    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }
    expect(mod.getState().status).toBe("latest");
  });

  it("falls back to GitHub when the default AtomGit check fails", async () => {
    mockAutoUpdater.checkForUpdates
      .mockRejectedValueOnce(new Error("Cannot find latest.yml in the latest release artifacts"))
      .mockResolvedValueOnce({});

    initWithMockWindow();
    await ipcHandlers["auto-update-check"]();

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(mockAutoUpdater.setFeedURL).toHaveBeenNthCalledWith(1, {
      provider: "generic",
      url: "https://gitcode.com/liliMozi/OpenHanako-Releases/releases/download/latest/",
    });
    expect(mockAutoUpdater.setFeedURL).toHaveBeenNthCalledWith(2, {
      provider: "generic",
      url: "https://gitcode.com/liliMozi/OpenHanako-Releases/releases/download/latest/",
    });
    expect(mockAutoUpdater.setFeedURL).toHaveBeenNthCalledWith(3, {
      provider: "github",
      owner: "liliMozi",
      repo: "openhanako",
    });
    expect(mod.getState().updateSource).toEqual({
      provider: "github",
      owner: "liliMozi",
      repo: "openhanako",
    });
  });

  it("treats missing latest metadata as no update available instead of an update error", () => {
    initWithMockWindow();
    if (handlers["checking-for-update"]) handlers["checking-for-update"]();

    if (handlers.error) {
      handlers.error(new Error("Cannot find latest.yml in the latest release artifacts"));
    }

    expect(mod.getState()).toEqual(expect.objectContaining({
      status: "latest",
      error: null,
    }));
  });

  it("should set allowPrerelease on channel change", () => {
    initWithMockWindow();
    mod.setUpdateChannel("beta");
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
    mod.setUpdateChannel("stable");
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
  });

  it("should map download-progress to downloading state", () => {
    initWithMockWindow();
    if (handlers["download-progress"]) {
      handlers["download-progress"]({
        percent: 42.5, bytesPerSecond: 1024000, transferred: 50000, total: 120000,
      });
    }
    const state = mod.getState();
    expect(state.status).toBe("downloading");
    expect(state.progress.percent).toBe(43);
  });

  it("should map update-downloaded to downloaded state", () => {
    initWithMockWindow();
    if (handlers["update-downloaded"]) {
      handlers["update-downloaded"]({ version: "2.0.0" });
    }
    expect(mod.getState().status).toBe("downloaded");
  });

  it("loads release digest metadata without changing the downloaded update contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        tag: "v2.0.0",
        version: "2.0.0",
        previousTag: "v1.9.9",
        generatedAt: "2026-07-05T00:00:00.000Z",
        noUserFacingChanges: false,
        summary: { zh: "更新更清楚", en: "Clearer updates" },
        counts: { feature: 1, fix: 0, improvement: 0, migration: 0 },
        items: [
          {
            id: "digest",
            kind: "feature",
            importance: "high",
            title: { zh: "更新摘要", en: "Update digest" },
            summary: { zh: "About 页能看到更新内容", en: "The About page shows update content" },
            details: [],
            sources: [],
          },
        ],
      }),
    }));
    initWithMockWindow();

    if (handlers["update-downloaded"]) {
      handlers["update-downloaded"]({ version: "2.0.0" });
    }

    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(mod.getState()).toEqual(expect.objectContaining({
      status: "downloaded",
      version: "2.0.0",
      digest: expect.objectContaining({
        summary: { zh: "更新更清楚", en: "Clearer updates" },
      }),
    }));
  });

  it("broadcasts update state to every live renderer window", () => {
    const win1 = initWithMockWindow();
    const win2 = createMockWindow();
    const destroyed = createDestroyedWindow();
    mockWindows.push(win2, destroyed);

    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }

    expect(win1.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
    expect(win2.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("second init reuses process-level setup without narrowing broadcasts to one window", () => {
    const win1 = initWithMockWindow();
    const win2 = createMockWindow();
    mockWindows.push(win2);

    mod.initAutoUpdater(win2);

    expect(mockAutoUpdater.on).toHaveBeenCalledTimes(6);
    expect(ipcMain.handle).toHaveBeenCalledTimes(5);

    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }

    expect(win1.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
    expect(win2.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
  });

  it("installDownloadedUpdate enters installing state and schedules quitAndInstall on the next tick", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      vi.resetModules();
      mod = await import("../desktop/auto-updater.cjs");
      handlers = {};
      mockAutoUpdater.on.mockImplementation((event, handler) => {
        handlers[event] = handler;
      });

      const shutdownServer = vi.fn(() => new Promise(() => {}));
      const setIsUpdating = vi.fn();
      const win = initWithMockWindow({ shutdownServer, setIsUpdating });

      if (handlers["update-downloaded"]) {
        handlers["update-downloaded"]({ version: "2.0.0" });
      }

      const installPromise = mod.installDownloadedUpdate("manual");
      await Promise.resolve();

      expect(setIsUpdating).toHaveBeenCalledWith(true);
      expect(shutdownServer).not.toHaveBeenCalled();
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      await new Promise(resolve => setImmediate(resolve));
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
      expect(mod.getState()).toEqual(expect.objectContaining({ status: "installing", version: "2.0.0" }));
      expect(win.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "installing" }));
      await expect(installPromise).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("manual install IPC uses the same immediate install path", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      vi.resetModules();
      mod = await import("../desktop/auto-updater.cjs");
      handlers = {};
      ipcHandlers = {};
      mockAutoUpdater.on.mockImplementation((event, handler) => {
        handlers[event] = handler;
      });
      const { ipcMain: freshIpcMain } = await import("electron");
      vi.mocked(freshIpcMain.handle).mockImplementation((name, handler) => {
        ipcHandlers[name] = handler;
      });

      const shutdownServer = vi.fn(() => new Promise(() => {}));
      initWithMockWindow({ shutdownServer });

      if (handlers["update-downloaded"]) {
        handlers["update-downloaded"]({ version: "2.0.0" });
      }

      const installPromise = ipcHandlers["auto-update-install"]();
      await Promise.resolve();

      expect(shutdownServer).not.toHaveBeenCalled();
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      await new Promise(resolve => setImmediate(resolve));
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
      await expect(installPromise).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("uses a visible installer window for Windows updates", async () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.resetModules();
      mockExePath = "/tmp/HanaAgent/HanaAgent.exe";
      mod = await import("../desktop/auto-updater.cjs");

      initWithMockWindow();

      if (handlers["update-downloaded"]) {
        handlers["update-downloaded"]({ version: "2.0.0" });
      }

      const installPromise = mod.installDownloadedUpdate("manual");
      await Promise.resolve();
      await new Promise(resolve => setImmediate(resolve));

      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
      await expect(installPromise).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
