import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFileWatchRegistry } from "../desktop/file-watch-registry.cjs";
import { createStableFileWatcher } from "../desktop/file-watch-adapter.cjs";

describe("file-watch-registry", () => {
  let watchMock;
  let callbacks;
  let closeFns;
  let notified;

  // 产线 file-watch-registry 用 path.resolve(filePath) 作 watch key（Windows 下 /tmp/a.txt → D:\tmp\a.txt），
  // 测试统一用解析后的绝对路径，才能跨平台命中 mock 的 callbacks/closeFns（POSIX 上 path.resolve 为恒等，无副作用）。
  const A = path.resolve("/tmp/a.txt");
  const B = path.resolve("/tmp/b.txt");

  beforeEach(() => {
    callbacks = new Map();
    closeFns = new Map();
    notified = [];
    watchMock = vi.fn((filePath, _opts, cb) => {
      callbacks.set(filePath, cb);
      const close = vi.fn();
      closeFns.set(filePath, close);
      return { close };
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("同一文件被多个 subscriber watch 时，只创建一个底层 watcher 并通知所有订阅者", () => {
    const registry = createFileWatchRegistry({
      watch: watchMock,
      notifySubscriber: (subscriberId, filePath) => notified.push({ subscriberId, filePath }),
    });

    expect(registry.watchFile(A, 1)).toBe(true);
    expect(registry.watchFile(A, 2)).toBe(true);
    expect(watchMock).toHaveBeenCalledTimes(1);

    callbacks.get(A)("change");
    vi.advanceTimersByTime(60);

    expect(notified).toEqual([
      { subscriberId: 1, filePath: A },
      { subscriberId: 2, filePath: A },
    ]);
  });

  it("移除一个 subscriber 时不会关闭仍被其他 subscriber 使用的 watcher", () => {
    const registry = createFileWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    registry.watchFile(A, 1);
    registry.watchFile(A, 2);

    expect(registry.unwatchFile(A, 1)).toBe(true);
    expect(closeFns.get(A)).not.toHaveBeenCalled();

    expect(registry.unwatchFile(A, 2)).toBe(true);
    expect(closeFns.get(A)).toHaveBeenCalledOnce();
  });

  it("unwatchAllForSubscriber 只移除该 subscriber，不影响其他文件/订阅者", () => {
    const registry = createFileWatchRegistry({
      watch: watchMock,
      notifySubscriber: () => {},
    });

    registry.watchFile(A, 1);
    registry.watchFile(B, 1);
    registry.watchFile(B, 2);

    registry.unwatchAllForSubscriber(1);

    expect(closeFns.get(A)).toHaveBeenCalledOnce();
    expect(closeFns.get(B)).not.toHaveBeenCalled();

    callbacks.get(B)("rename");
    vi.advanceTimersByTime(60);
  });

  it("底层 watch 创建失败时返回 false，且不会留下脏状态", () => {
    const registry = createFileWatchRegistry({
      watch: vi.fn(() => { throw new Error("watch failed"); }),
      notifySubscriber: () => {},
    });

    expect(registry.watchFile(A, 1)).toBe(false);
    expect(registry.unwatchFile(A, 1)).toBe(true);
  });

  it("用稳定文件 watcher 监听时，atomic replace 后仍继续通知同一路径的后续改动", async () => {
    vi.useRealTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-file-watch-"));
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "one\n", "utf-8");
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const notified = [];
    const registry = createFileWatchRegistry({
      debounceMs: 5,
      watch: (targetPath, options, onChange) => {
        const watcher = createStableFileWatcher(targetPath, options, onChange);
        watcher.on("ready", readyResolve);
        watcher.on("error", readyReject);
        return watcher;
      },
      notifySubscriber: (_subscriberId, changedPath) => {
        notified.push(fs.readFileSync(changedPath, "utf-8"));
      },
    });

    try {
      expect(registry.watchFile(filePath, 1)).toBe(true);
      await ready;
      await new Promise(resolve => setTimeout(resolve, 50));

      fs.writeFileSync(filePath, "two\n", "utf-8");
      await vi.waitFor(() => expect(notified).toContain("two\n"));

      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, "three\n", "utf-8");
      fs.renameSync(tmpPath, filePath);
      await vi.waitFor(() => expect(notified).toContain("three\n"));

      fs.writeFileSync(filePath, "four\n", "utf-8");
      await vi.waitFor(() => expect(notified).toContain("four\n"));
    } finally {
      registry.unwatchFile(filePath, 1);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
