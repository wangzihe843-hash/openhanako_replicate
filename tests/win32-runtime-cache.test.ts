import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectWin32PowerShellFlavor,
  getSandboxPowerShellProbeResult,
  prepareSandboxRuntime,
  resetSandboxPowerShellProbeCacheForTests,
  sandboxRuntimeCacheRoot,
  setSandboxPowerShellProbeResult,
} from "../lib/sandbox/win32-runtime-cache.ts";

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-runtime-cache-test-"));
  tempRoots.push(root);
  return root;
}

function touch(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("win32 sandbox runtime cache", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      const resolved = path.resolve(root);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir())
        || !path.basename(resolved).startsWith("hana-runtime-cache-test-")
        || fs.lstatSync(resolved).isSymbolicLink()) throw new Error("Refused non-fixture runtime cache cleanup");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mirrors bundled Git under HANA_HOME and rewrites all runtime paths", () => {
    const tempRoot = makeTempRoot();
    const hanakoHome = path.join(tempRoot, "home");
    const sourceRoot = path.join(tempRoot, "Program Files", "Hanako", "resources", "git");
    const sourceGit = path.join(sourceRoot, "cmd", "git.exe");
    touch(sourceGit, "git");
    touch(path.join(sourceRoot, "bin", "bash.exe"), "bash");

    const prepared = prepareSandboxRuntime({
      bundledRoot: sourceRoot,
      git: sourceGit,
    }, {
      hanakoHome,
      kind: "git",
    });

    const cacheRoot = sandboxRuntimeCacheRoot(hanakoHome);
    expect(prepared.bundledRoot.startsWith(cacheRoot)).toBe(true);
    expect(prepared.git).toBe(path.join(prepared.bundledRoot, "cmd", "git.exe"));
    expect(prepared.git).not.toBe(sourceGit);
    expect(fs.existsSync(prepared.git)).toBe(true);
    expect(path.relative(hanakoHome, prepared.git).startsWith("..")).toBe(false);
  });

  it("copies Node and its runtime companions without copying the containing directory", () => {
    const tempRoot = makeTempRoot();
    const sourceRoot = path.join(tempRoot, "Program Files", "Hanako", "resources", "server");
    // A portable node.exe can share a parent with HANA_HOME, including a drive
    // root. Mirroring that parent would recurse into the destination itself.
    const hanakoHome = path.join(sourceRoot, "home");
    const sourceNode = path.join(sourceRoot, "hana-server.exe");
    touch(sourceNode, "node");
    touch(path.join(sourceRoot, "node.dll"), "dll");
    touch(path.join(sourceRoot, "icudt77l.dat"), "icu");
    touch(path.join(sourceRoot, "npm.cmd"), "npm launcher");
    touch(path.join(sourceRoot, "npx.ps1"), "npx launcher");
    touch(path.join(sourceRoot, "corepack.cmd"), "corepack launcher");
    touch(path.join(sourceRoot, "node_modules", "npm", "bin", "npm-cli.js"), "npm");
    touch(path.join(sourceRoot, "node_modules", "corepack", "dist", "corepack.js"), "corepack");
    touch(path.join(sourceRoot, "node_modules", "unrelated", "index.js"), "unrelated");
    touch(path.join(sourceRoot, "private", "config.json"), "private");
    touch(path.join(sourceRoot, "unrelated.txt"), "unrelated");
    touch(path.join(hanakoHome, "personal-data.txt"), "private");

    const prepared = prepareSandboxRuntime({
      executable: sourceNode,
    }, {
      hanakoHome,
      kind: "node",
    });

    const cacheRoot = sandboxRuntimeCacheRoot(hanakoHome);
    expect(prepared.executable.startsWith(cacheRoot)).toBe(true);
    expect(prepared.executable).not.toBe(sourceNode);
    expect(fs.existsSync(prepared.executable)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(prepared.executable), "node.dll"))).toBe(true);
    expect(path.relative(hanakoHome, prepared.executable).startsWith("..")).toBe(false);
    const cachedRoot = path.dirname(prepared.executable);
    for (const file of [
      "icudt77l.dat", "npm.cmd", "npx.ps1", "corepack.cmd",
      "node_modules/npm/bin/npm-cli.js", "node_modules/corepack/dist/corepack.js",
    ]) expect(fs.existsSync(path.join(cachedRoot, file))).toBe(true);
    for (const file of ["private", "home", "unrelated.txt", "node_modules/unrelated"]) {
      expect(fs.existsSync(path.join(cachedRoot, file))).toBe(false);
    }
  });

  it("invalidates a Node cache when a companion DLL changes", () => {
    const tempRoot = makeTempRoot();
    const sourceRoot = path.join(tempRoot, "node");
    const executable = path.join(sourceRoot, "node.exe");
    const dll = path.join(sourceRoot, "node.dll");
    const options = { hanakoHome: path.join(tempRoot, "home"), kind: "node" };
    touch(executable, "node");
    touch(dll, "old");
    const first = prepareSandboxRuntime({ executable }, options);
    touch(dll, "updated DLL");
    const second = prepareSandboxRuntime({ executable }, options);
    expect(second.executable).not.toBe(first.executable);
    expect(fs.readFileSync(path.join(path.dirname(second.executable), "node.dll"), "utf8")).toBe("updated DLL");
    expect(prepareSandboxRuntime(second, options)).toEqual(second);
  });

  it("rejects a volume root declared as a complete bundled runtime", () => {
    const tempRoot = makeTempRoot();
    const root = path.parse(tempRoot).root;
    const copy = vi.spyOn(fs, "cpSync").mockImplementation(() => { throw new Error("Unexpected directory copy"); });
    try {
      expect(() => prepareSandboxRuntime({ bundledRoot: root, git: path.join(root, "git.exe") }, {
        hanakoHome: path.join(tempRoot, "home"), kind: "git",
      })).toThrow(/volume root/i);
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
    }
  });

  it("requires an explicit complete runtime root for unknown runtime kinds", () => {
    const tempRoot = makeTempRoot();
    const executable = path.join(tempRoot, "custom.exe");
    touch(executable, "custom");
    expect(() => prepareSandboxRuntime({ executable }, {
      hanakoHome: path.join(tempRoot, "home"), kind: "custom",
    })).toThrow(/explicit bundledRoot.*custom/i);
  });

  it("reuses a valid cached runtime instead of copying on every command", () => {
    const tempRoot = makeTempRoot();
    const hanakoHome = path.join(tempRoot, "home");
    const sourceRoot = path.join(tempRoot, "Program Files", "Hanako", "resources", "git");
    const sourceGit = path.join(sourceRoot, "cmd", "git.exe");
    touch(sourceGit, "git");

    const first = prepareSandboxRuntime({
      bundledRoot: sourceRoot,
      git: sourceGit,
    }, {
      hanakoHome,
      kind: "git",
    });
    const marker = path.join(first.bundledRoot, ".hana-sandbox-runtime.json");
    const markerBefore = fs.statSync(marker).mtimeMs;

    const second = prepareSandboxRuntime({
      bundledRoot: sourceRoot,
      git: sourceGit,
    }, {
      hanakoHome,
      kind: "git",
    });

    expect(second).toEqual(first);
    expect(fs.statSync(marker).mtimeMs).toBe(markerBefore);
  });
});

describe("sandbox PowerShell startup probe cache", () => {
  afterEach(() => {
    resetSandboxPowerShellProbeCacheForTests();
  });

  it("returns null for an executable that has not been probed yet", () => {
    expect(getSandboxPowerShellProbeResult("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBeNull();
  });

  it("caches a probe verdict per executable path independently", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const legacy = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    setSandboxPowerShellProbeResult(pwsh, "unsupported");
    setSandboxPowerShellProbeResult(legacy, "ok");

    expect(getSandboxPowerShellProbeResult(pwsh)).toBe("unsupported");
    expect(getSandboxPowerShellProbeResult(legacy)).toBe("ok");
  });

  it("is case-insensitive on Windows-style paths", () => {
    const executable = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    setSandboxPowerShellProbeResult(executable, "ok");
    expect(getSandboxPowerShellProbeResult(executable.toUpperCase())).toBe("ok");
  });
});

describe("win32 PowerShell flavor detection for the exec_command tool description", () => {
  it("returns null on non-win32 platforms without probing", () => {
    const spawn = vi.fn();
    expect(detectWin32PowerShellFlavor({ platform: "darwin", spawn })).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns pwsh when where.exe finds pwsh.exe on PATH", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n" }));
    expect(detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any })).toBe("pwsh");
  });

  it("returns windows-powershell when where.exe does not find pwsh.exe", () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: "" }));
    expect(detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any })).toBe("windows-powershell");
  });

  it("returns windows-powershell when the probe throws", () => {
    const spawn = vi.fn(() => { throw new Error("boom"); });
    expect(detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any })).toBe("windows-powershell");
  });

  it("probes fresh on every call instead of memoizing across tool-set builds", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "pwsh.exe\r\n" }));
    detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any });
    detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("queries where.exe pwsh.exe with a bounded timeout and a hidden window", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "pwsh.exe\r\n" }));
    detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any });
    expect(spawn).toHaveBeenCalledWith("where.exe", ["pwsh.exe"], expect.objectContaining({
      timeout: 3000,
      windowsHide: true,
    }));
  });
});
