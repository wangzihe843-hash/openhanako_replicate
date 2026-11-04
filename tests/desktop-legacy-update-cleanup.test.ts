import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filename = path.resolve("desktop/auto-updater.cjs");
const source = fs.readFileSync(filename, "utf8");
const require = createRequire(filename);
let root: string;
let osHome: string;
let legacy: string;
let active: string;
let userData: string;
const marker = (dir: string) => path.join(dir, "last-update-version");
const mkdir = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); return dir; };
const linkDirectory = (target: string, alias: string) => fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
const error = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

function load({ enabled = true, packaged = true, platform = process.platform, exe = path.join(root, "HanaAgent") } = {}) {
  const removals: Promise<void>[] = [];
  const disk = {
    ...fs,
    mkdirSync: vi.fn(fs.mkdirSync), renameSync: vi.fn(fs.renameSync),
    unlinkSync: vi.fn(fs.unlinkSync), rmdirSync: vi.fn(fs.rmdirSync),
    lstatSync: vi.fn(fs.lstatSync), writeFileSync: vi.fn(fs.writeFileSync),
    promises: { ...fs.promises, rm: vi.fn((target: fs.PathLike, options: fs.RmOptions) => {
      const result = fs.promises.rm(target, options); removals.push(result); return result;
    }) },
  };
  const updater = { on: vi.fn(), setFeedURL: vi.fn() };
  const timer = vi.fn();
  const mod = { exports: {} as {
    cleanForTest: (home: string) => Promise<void>;
    initAutoUpdater: (win: null, options: { hanakoHome: string }) => void;
  } };
  const context = vm.createContext({ module: mod, console: { log: vi.fn() }, process: { platform, env: {} },
    setInterval: timer, setImmediate,
    require: (id: string) => {
      if (id === "electron") return { ipcMain: { handle: vi.fn() }, BrowserWindow: { getAllWindows: () => [] },
        app: { isPackaged: packaged, getVersion: () => "2.0.0", getPath: (name: string) => name === "exe" ? exe : userData } };
      if (id === "electron-updater") return { autoUpdater: updater };
      if (id === "fs") return disk;
      if (id === "os") return { homedir: () => osHome };
      if (id === "../shared/update-policy.cjs") return { ...require(id), onlineUpdatesEnabled: enabled };
      return require(id);
    },
  });
  // Access the private cleanup in the VM only; production exports stay unchanged.
  vm.runInContext(`${source}\nmodule.exports.cleanForTest = home => { _hanakoHome = home; return cleanUpdateCache(); };`, context, { filename });
  return { disk, updater, timer, clean: (home = active) => mod.exports.cleanForTest(home),
    init: async (home = active) => { mod.exports.initAutoUpdater(null, { hanakoHome: home }); await Promise.all(removals); } };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-legacy-update-"));
  osHome = mkdir(path.join(root, "os-home"));
  legacy = mkdir(path.join(osHome, ".hanako-dev"));
  active = mkdir(path.join(root, "active"));
  userData = mkdir(path.join(root, "electron"));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("fixed legacy update version migration", () => {
  it("renames before removing the empty source directory and detects the old version", async () => {
    fs.writeFileSync(marker(legacy), "1.0.0");
    const pending = mkdir(path.join(userData, "pending"));
    fs.writeFileSync(path.join(pending, "cache"), "old");
    const s = load(); await s.clean(path.join(active, "missing", "home"));
    expect(s.disk.renameSync).toHaveBeenCalledExactlyOnceWith(marker(legacy), marker(path.join(active, "missing", "home")));
    expect(s.disk.unlinkSync).not.toHaveBeenCalled();
    expect(s.disk.rmdirSync).toHaveBeenCalledExactlyOnceWith(legacy);
    expect(s.disk.renameSync.mock.invocationCallOrder[0]).toBeLessThan(s.disk.rmdirSync.mock.invocationCallOrder[0]);
    expect(s.disk.rmdirSync.mock.invocationCallOrder[0]).toBeLessThan(s.disk.writeFileSync.mock.invocationCallOrder[0]);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(marker(path.join(active, "missing", "home")), "utf8")).toBe("2.0.0");
    expect(fs.existsSync(pending)).toBe(false);
  });
  it("keeps the current marker and unlinks the obsolete source before rmdir", async () => {
    fs.writeFileSync(marker(legacy), "obsolete"); fs.writeFileSync(marker(active), "2.0.0");
    const pending = mkdir(path.join(userData, "pending")); fs.writeFileSync(path.join(pending, "cache"), "keep");
    const s = load(); await s.clean();
    expect(s.disk.renameSync).not.toHaveBeenCalled();
    expect(s.disk.unlinkSync).toHaveBeenCalledExactlyOnceWith(marker(legacy));
    expect(s.disk.unlinkSync.mock.invocationCallOrder[0]).toBeLessThan(s.disk.rmdirSync.mock.invocationCallOrder[0]);
    expect(fs.readFileSync(marker(active), "utf8")).toBe("2.0.0");
    expect(fs.readFileSync(path.join(pending, "cache"), "utf8")).toBe("keep");
  });
  it("preserves unrelated files and adjacent legacy directories", async () => {
    fs.writeFileSync(marker(legacy), "1.0.0"); fs.writeFileSync(path.join(legacy, "private"), "keep");
    const adjacent = mkdir(path.join(osHome, ".hanako-dev-other")); fs.writeFileSync(marker(adjacent), "keep");
    const s = load(); await s.clean();
    expect(fs.readFileSync(path.join(legacy, "private"), "utf8")).toBe("keep");
    expect(fs.readFileSync(marker(adjacent), "utf8")).toBe("keep");
    expect(s.disk.rmdirSync).toHaveBeenCalledExactlyOnceWith(legacy);
  });
  it("does not remove an existing empty legacy directory with no marker", async () => {
    const s = load(); await s.clean();
    expect(s.disk.renameSync).not.toHaveBeenCalled(); expect(s.disk.unlinkSync).not.toHaveBeenCalled(); expect(s.disk.rmdirSync).not.toHaveBeenCalled();
    expect(fs.existsSync(legacy)).toBe(true);
  });
  it("accepts a missing legacy directory without creating it", async () => {
    fs.rmdirSync(legacy); const s = load(); await s.clean();
    expect(fs.existsSync(legacy)).toBe(false); expect(fs.readFileSync(marker(active), "utf8")).toBe("2.0.0");
    expect(s.disk.rmdirSync).not.toHaveBeenCalled();
  });
  it.each(["same path", "active alias", "legacy alias", "parent alias"])("preserves the current marker through %s", async kind => {
    let home = legacy;
    if (kind === "active alias") { home = path.join(root, "active-alias"); linkDirectory(legacy, home); }
    if (kind === "legacy alias") { fs.rmdirSync(legacy); linkDirectory(active, legacy); home = active; }
    if (kind === "parent alias") { const alias = path.join(root, "parent-alias"); linkDirectory(osHome, alias); home = path.join(alias, ".hanako-dev"); }
    fs.writeFileSync(marker(home), "1.0.0");
    const pending = mkdir(path.join(userData, "pending")); fs.writeFileSync(path.join(pending, "cache"), "old");
    const s = load(); await s.clean(home);
    expect(s.disk.renameSync).not.toHaveBeenCalled(); expect(s.disk.unlinkSync).not.toHaveBeenCalled(); expect(s.disk.rmdirSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(marker(home), "utf8")).toBe("2.0.0"); expect(fs.existsSync(pending)).toBe(false);
  });
  it("migrates through a distinct directory alias using the fixed source path", async () => {
    fs.rmdirSync(legacy); const backing = mkdir(path.join(root, "legacy-backing")); linkDirectory(backing, legacy);
    fs.writeFileSync(marker(backing), "1.0.0"); const s = load(); await s.clean();
    expect(s.disk.renameSync).toHaveBeenCalledExactlyOnceWith(marker(legacy), marker(active));
    expect(fs.readFileSync(marker(active), "utf8")).toBe("2.0.0"); expect(fs.readdirSync(backing)).toEqual([]);
  });
  it("uses native directory identity without case folding", async () => {
    const upper = mkdir(path.join(root, "CaseHome")); const lower = mkdir(path.join(root, "casehome"));
    fs.rmdirSync(legacy); linkDirectory(upper, legacy); fs.writeFileSync(marker(upper), "1.0.0");
    const s = load(); await s.clean(lower);
    if (fs.realpathSync.native(upper) === fs.realpathSync.native(lower)) expect(s.disk.renameSync).not.toHaveBeenCalled();
    else expect(s.disk.renameSync).toHaveBeenCalledExactlyOnceWith(marker(legacy), marker(lower));
  });

  it.each(["source directory", "source hardlink", "target directory", "target hardlink"])("preserves the source for %s", async kind => {
    const external = path.join(root, "external"); fs.writeFileSync(external, "keep");
    if (kind === "source directory") mkdir(marker(legacy));
    else if (kind === "source hardlink") fs.linkSync(external, marker(legacy));
    else fs.writeFileSync(marker(legacy), "old");
    if (kind === "target directory") mkdir(marker(active));
    if (kind === "target hardlink") fs.linkSync(external, marker(active));
    const s = load(); await s.clean();
    expect(s.disk.renameSync).not.toHaveBeenCalled(); expect(s.disk.unlinkSync).not.toHaveBeenCalled(); expect(s.disk.rmdirSync).not.toHaveBeenCalled();
    expect(fs.lstatSync(marker(legacy)).isDirectory()).toBe(kind === "source directory");
    if (kind !== "source directory") expect(fs.readFileSync(marker(legacy), "utf8")).toBe(kind === "source hardlink" ? "keep" : "old");
    expect(fs.readFileSync(external, "utf8")).toBe("keep");
  });
  it.skipIf(process.platform === "win32").each(["source symlink", "target symlink", "source fifo"])("preserves the source for %s", async kind => {
    const external = path.join(root, "external"); fs.writeFileSync(external, "keep");
    if (kind === "source symlink") fs.symlinkSync(external, marker(legacy));
    else if (kind === "source fifo") execFileSync("mkfifo", [marker(legacy)]);
    else { fs.writeFileSync(marker(legacy), "old"); fs.symlinkSync(external, marker(active)); }
    const s = load(); await s.clean();
    expect(s.disk.renameSync).not.toHaveBeenCalled(); expect(s.disk.unlinkSync).not.toHaveBeenCalled(); expect(s.disk.rmdirSync).not.toHaveBeenCalled();
    expect(fs.lstatSync(marker(legacy)).isSymbolicLink()).toBe(kind === "source symlink");
    if (kind === "source fifo") expect(fs.lstatSync(marker(legacy)).isFIFO()).toBe(true);
    expect(fs.readFileSync(external, "utf8")).toBe("keep");
  });
  it.each(["legacy file", "active file", "dangling legacy", "legacy loop"])("retains the source when resolving %s fails", async kind => {
    fs.writeFileSync(marker(legacy), "old");
    if (kind === "legacy file") { fs.rmSync(legacy, { recursive: true }); fs.writeFileSync(legacy, "keep"); }
    if (kind === "active file") { fs.rmdirSync(active); fs.writeFileSync(active, "keep"); }
    if (kind === "dangling legacy" || kind === "legacy loop") { fs.rmSync(legacy, { recursive: true }); linkDirectory(kind === "legacy loop" ? legacy : path.join(root, "absent"), legacy); }
    const s = load(); await s.clean();
    expect(s.disk.renameSync).not.toHaveBeenCalled(); expect(s.disk.unlinkSync).not.toHaveBeenCalled(); expect(s.disk.rmdirSync).not.toHaveBeenCalled();
    if (kind === "active file") expect(fs.readFileSync(marker(legacy), "utf8")).toBe("old");
    if (kind === "legacy file") expect(fs.readFileSync(legacy, "utf8")).toBe("keep");
  });
  it.each(["EACCES", "EPERM", "ELOOP", "ENOTDIR"])("retains the source on canonicalization %s", async code => {
    fs.writeFileSync(marker(legacy), "old"); const s = load();
    s.disk.lstatSync.mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]) === legacy) throw error(code);
      return fs.lstatSync(...args);
    });
    await s.clean(); expect(fs.readFileSync(marker(legacy), "utf8")).toBe("old");
    expect(s.disk.renameSync).not.toHaveBeenCalled(); expect(s.disk.unlinkSync).not.toHaveBeenCalled(); expect(s.disk.rmdirSync).not.toHaveBeenCalled();
  });
  it("retains the source when the destination probe fails instead of treating it as absent", async () => {
    fs.writeFileSync(marker(legacy), "old"); const s = load();
    s.disk.lstatSync.mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]) === marker(active)) throw error("EACCES");
      return fs.lstatSync(...args);
    });
    await s.clean(); expect(fs.readFileSync(marker(legacy), "utf8")).toBe("old");
    expect(s.disk.renameSync).not.toHaveBeenCalled(); expect(s.disk.unlinkSync).not.toHaveBeenCalled(); expect(s.disk.rmdirSync).not.toHaveBeenCalled();
  });
  it.each(["native realpath", "canonical stat"])("retains the source when %s is denied", async probe => {
    fs.writeFileSync(marker(legacy), "old"); const s = load();
    const canonicalLegacy = fs.realpathSync.native(legacy);
    if (probe === "native realpath") {
      const original = fs.realpathSync.native;
      vi.spyOn(s.disk.realpathSync, "native").mockImplementation((...args: Parameters<typeof original>) => {
        if (String(args[0]) === legacy) throw error("EACCES");
        return original(...args);
      });
    } else {
      vi.spyOn(s.disk, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
        if (String(args[0]) === canonicalLegacy) throw error("EACCES");
        return fs.statSync(...args);
      });
    }
    await s.clean(); expect(fs.readFileSync(marker(legacy), "utf8")).toBe("old");
    expect(s.disk.renameSync).not.toHaveBeenCalled(); expect(s.disk.unlinkSync).not.toHaveBeenCalled(); expect(s.disk.rmdirSync).not.toHaveBeenCalled();
  });
  it.each(["mkdir", "rename", "EXDEV", "unlink", "rmdir"])("preserves the existing failure boundary for %s", async operation => {
    fs.writeFileSync(marker(legacy), "old"); if (operation === "unlink") fs.writeFileSync(marker(active), "1.0.0");
    const s = load();
    if (operation === "mkdir") s.disk.mkdirSync.mockImplementation(() => { throw error("EACCES"); });
    if (operation === "rename" || operation === "EXDEV") s.disk.renameSync.mockImplementation(() => { throw error(operation === "EXDEV" ? "EXDEV" : "EACCES"); });
    if (operation === "unlink") s.disk.unlinkSync.mockImplementation(() => { throw error("EACCES"); });
    if (operation === "rmdir") s.disk.rmdirSync.mockImplementation(() => { throw error("EACCES"); });
    await expect(s.clean()).resolves.toBeUndefined();
    expect(fs.existsSync(legacy)).toBe(true);
    if (operation !== "rmdir") { expect(fs.readFileSync(marker(legacy), "utf8")).toBe("old"); expect(s.disk.rmdirSync).not.toHaveBeenCalled(); }
    else { expect(fs.existsSync(marker(legacy))).toBe(false); expect(fs.readFileSync(marker(active), "utf8")).toBe("2.0.0"); }
  });
});

describe("legacy migration startup boundaries", () => {
  it.each([true, false])("does no filesystem migration with online updates disabled, packaged=%s", async packaged => {
    fs.writeFileSync(marker(legacy), "old"); fs.writeFileSync(marker(active), "old-current");
    const s = load({ enabled: false, packaged }); await s.init();
    expect(fs.readFileSync(marker(legacy), "utf8")).toBe("old"); expect(fs.readFileSync(marker(active), "utf8")).toBe("old-current");
    for (const op of [s.disk.lstatSync, s.disk.mkdirSync, s.disk.renameSync, s.disk.unlinkSync, s.disk.rmdirSync, s.disk.writeFileSync, s.disk.promises.rm, s.timer, s.updater.setFeedURL]) expect(op).not.toHaveBeenCalled();
  });
  it.each(["development", "mounted dmg"])("does not migrate in %s", async kind => {
    fs.writeFileSync(marker(legacy), "old");
    const s = load({ packaged: kind !== "development", platform: "darwin", exe: kind === "mounted dmg" ? "/Volumes/HanaAgent/HanaAgent" : path.join(root, "HanaAgent") });
    await s.init(); expect(fs.readFileSync(marker(legacy), "utf8")).toBe("old"); expect(s.disk.lstatSync).not.toHaveBeenCalled(); expect(s.updater.setFeedURL).not.toHaveBeenCalled();
  });
  it("runs the migration only once for an enabled packaged startup", async () => {
    fs.writeFileSync(marker(legacy), "1.0.0");
    const s = load(); await s.init(); await s.init();
    expect(s.disk.renameSync).toHaveBeenCalledTimes(1); expect(s.updater.setFeedURL).toHaveBeenCalledTimes(1); expect(s.timer).toHaveBeenCalledTimes(1);
  });
  it("preserves an aliased active marker and cleans the changed-version cache through startup", async () => {
    const alias = path.join(root, "startup-alias"); linkDirectory(legacy, alias);
    fs.writeFileSync(marker(legacy), "1.0.0"); const pending = mkdir(path.join(userData, "pending")); fs.writeFileSync(path.join(pending, "cache"), "old");
    const s = load(); await s.init(alias);
    expect(s.disk.renameSync).not.toHaveBeenCalled(); expect(s.disk.unlinkSync).not.toHaveBeenCalled(); expect(s.disk.rmdirSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(marker(legacy), "utf8")).toBe("2.0.0"); expect(fs.existsSync(pending)).toBe(false);
  });
});
