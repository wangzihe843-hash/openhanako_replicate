import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../scripts/build-shell.mjs";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("child_process", () => ({ execFileSync }));
vi.mock("../scripts/build-computer-use-helper.mjs", () => ({
  // These tests exercise the shared Node CLI chain without invoking Swift.
  shouldBuildComputerUseHelper: () => false,
  buildComputerUseHelper: vi.fn(),
}));

const ROOT = path.resolve(import.meta.dirname, "..");
const osTag = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : process.platform;
const seedName = `seed-train-${process.platform}-${process.arch}.json`;
const seedDir = path.join(ROOT, "dist-server-artifact", `${osTag}-${process.arch}`);
const distDir = path.join(ROOT, "dist");
const resourcesDir = path.join(distDir, "shell smoke & package");
const asarPath = path.join(resourcesDir, "app.asar");
const shellManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "shell-surface-manifest.json"), "utf8"));
const asarEntries: string[] = shellManifest.asarFiles
  .filter((entry: { kind: string }) => entry.kind !== "exclusion")
  .map((entry: { builderEntry: string }) => `/${entry.builderEntry.replace(/\*.*/, "fixture.js")}`);

function dirent(name: string, directory = false) {
  return { name, isDirectory: () => directory, isFile: () => !directory };
}

beforeEach(() => {
  execFileSync.mockReset().mockReturnValue(asarEntries.join("\n"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const existsSync = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => {
    const name = String(file);
    if ([distDir, resourcesDir, path.join(seedDir, seedName),
      path.join(resourcesDir, "seed", seedName), path.join(resourcesDir, "seed", `${seedName}.sig`)].includes(name)) return true;
    return existsSync(file);
  });
  const readdirSync = fs.readdirSync;
  vi.spyOn(fs, "readdirSync").mockImplementation(((directory, ...args) => {
    if (String(directory) === seedDir) return [seedName, `${seedName}.sig`];
    if (String(directory) === distDir) return [dirent(path.basename(resourcesDir), true)];
    if (String(directory) === resourcesDir) return [dirent("app.asar")];
    return Reflect.apply(readdirSync, fs, [directory, ...args]);
  }) as typeof fs.readdirSync);
  const statSync = fs.statSync;
  vi.spyOn(fs, "statSync").mockImplementation(((file, ...args) => {
    if (path.dirname(String(file)) === seedDir) return { size: 100, mtimeMs: 123 };
    return Reflect.apply(statSync, fs, [file, ...args]);
  }) as typeof fs.statSync);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("build:shell portable Node CLI execution", () => {
  it("uses installed JavaScript entrypoints, literal argument arrays and the stripped child environment for the whole build", async () => {
    vi.stubEnv("HANA_SIGN_KEY", "private-key-must-not-reach-children");
    vi.stubEnv("HANA_SIGN_KEYSET", "public-keyset-with spaces.json");

    await main();

    const vite = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
    const builder = path.join(ROOT, "node_modules", "electron-builder", "cli.js");
    const asar = path.join(ROOT, "node_modules", "@electron", "asar", "bin", "asar.js");
    expect(execFileSync.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [process.execPath, [vite, "build", "--config", "vite.config.main.js"]],
      [process.execPath, [vite, "build", "--config", "vite.config.preload.js"]],
      [process.execPath, [vite, "build", "--config", "vite.config.splash.ts"]],
      [process.execPath, [path.join(ROOT, "scripts", "verify-seed-kit.mjs")]],
      [process.execPath, [builder, "--dir"]],
      [process.execPath, [asar, "list", asarPath]],
    ]);
    for (const [, , options] of execFileSync.mock.calls) {
      expect(options.cwd).toBe(ROOT);
      expect(options.shell).not.toBe(true);
      expect(options.env).not.toHaveProperty("HANA_SIGN_KEY");
      expect(options.env.HANA_SIGN_KEYSET).toBe("public-keyset-with spaces.json");
    }
    expect(execFileSync.mock.calls.at(-1)?.[2].encoding).toBe("utf8");
    expect(process.env.HANA_SIGN_KEY).toBe("private-key-must-not-reach-children");

    // Catch dependency layout changes instead of silently restoring .bin shims.
    for (const [packageName, binaryName, cli] of [
      ["vite", "vite", vite], ["electron-builder", "electron-builder", builder], ["@electron/asar", "asar", asar],
    ]) {
      const packageDir = path.join(ROOT, "node_modules", packageName);
      const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
      expect(path.resolve(packageDir, pkg.bin[binaryName])).toBe(cli);
      expect(fs.existsSync(cli)).toBe(true);
    }
  });

  it("accepts Windows asar listing separators and CRLF without dropping manifest checks", async () => {
    execFileSync.mockReturnValue(`${asarEntries.join("\r\n").replace(/\//g, "\\")}\r\n`);
    await expect(main()).resolves.toBeUndefined();
  });

  it("still rejects missing shell entries with a Windows-style listing", async () => {
    execFileSync.mockReturnValue(asarEntries.filter((entry) => entry !== "/desktop/bootstrap.cjs").join("\r\n").replace(/\//g, "\\"));
    await expect(main()).rejects.toThrow("shell file(s) missing from asar: desktop/bootstrap.cjs");
  });

  it("still rejects renderer leaks with a Windows-style listing", async () => {
    execFileSync.mockReturnValue([...asarEntries, "/desktop/dist-renderer/index.html"].join("\r\n").replace(/\//g, "\\"));
    await expect(main()).rejects.toThrow("renderer bundle leaked into the asar");
  });

  it("stops before packaging when the signed seed kit is absent", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await expect(main()).rejects.toThrow("no signed seed kit found");
    expect(execFileSync).toHaveBeenCalledTimes(3);
    expect(execFileSync.mock.calls.every(([, args]) => args[0].endsWith(path.join("vite", "bin", "vite.js")))).toBe(true);
  });

  it("propagates subprocess errors without trying a shell or continuing the build", async () => {
    const failure = new Error("build:main failed");
    execFileSync.mockImplementationOnce(() => { throw failure; });
    await expect(main()).rejects.toBe(failure);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
