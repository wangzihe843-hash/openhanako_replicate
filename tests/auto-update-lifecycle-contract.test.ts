import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();

// ── Mocks（必须在 import 之前声明）──
//
// auto-updater.cjs 在 require 时会 require("electron") 和 require("electron-updater")。
// 这里和 tests/auto-updater.test.js 用同一套 stub，让被测模块加载后能跑 installDownloadedUpdate
// 但绝不真的关进程或安装更新。
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

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: {
    isPackaged: true,
    getVersion: () => "1.0.0",
    getPath: (name) => {
      if (name === "exe") return "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent";
      if (name === "userData") return "/tmp/test-userdata";
      return "/tmp";
    },
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}));

describe("auto-update lifecycle contract", () => {
  it("does not install a downloaded update implicitly from the app quit path", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).not.toContain('installDownloadedUpdate("app-quit")');
    expect(mainSource).not.toContain("getUpdateState().status === \"downloaded\"");
  });

  describe("installDownloadedUpdate precondition guard", () => {
    let mod;

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.resetModules();
      mod = await import("../desktop/auto-updater.cjs");
    });

    // 这条断言锁死 auto-updater.cjs:123-128 的 precondition：未 downloaded 时拒绝安装。
    // 即使将来 main.cjs（或别处）真的接入了 quit-path 自动安装，只要默认 state 没就绪也安全；
    // 反之，如果有人把这个守门干掉（比如改成不分状态都走 quitAndInstall），下面的 mock
    // 调用计数就会涨，测试立刻报警。
    it("refuses to install when no update has been downloaded, regardless of source", async () => {
      // 默认 state 是 idle —— 没经历过任何 update-downloaded 事件。
      // 跑 app-quit / manual / on-idle 三种典型 source，全部应被拒。
      const sources = ["app-quit", "manual", "on-idle"];
      const results = await Promise.all(sources.map(s => mod.installDownloadedUpdate(s)));

      for (const r of results) {
        expect(r).toBe(false);
      }
      // 任何 source 都不允许触达 quitAndInstall。
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(0);
      // state 不应被升级到 installing。
      expect(mod.getState().status).toBe("idle");
    });

    it("refuses to install from app-quit source specifically, even without arguments fallback", async () => {
      // 单独再覆盖一次 app-quit，避免上一条用 Promise.all 并行掩盖单独路径异常。
      const result = await mod.installDownloadedUpdate("app-quit");
      expect(result).toBe(false);
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });
  });
});
