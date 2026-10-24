import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCliBundle, copyServerBootstrap, writeServerWrapperScripts } from "../scripts/build-server-phases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
let scratch: string;
let packageDir: string;
let unrelatedCwd: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  // Outside the source checkout: neither relative requires nor node_modules
  // resolution can accidentally borrow files from the developer's tree.
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hana-cli-packaging-")));
  const buildDir = path.join(scratch, "build");
  fs.mkdirSync(path.join(buildDir, "bundle"), { recursive: true });
  buildCliBundle({ rootDir: ROOT, bundleOutDir: path.join(buildDir, "bundle"), log: () => {} });
  copyServerBootstrap({ rootDir: ROOT, outDir: buildDir, log: () => {} });
  fs.writeFileSync(path.join(buildDir, "package.json"), '{"type":"module"}\n');
  fs.cpSync(path.join(ROOT, "node_modules", "ws"), path.join(buildDir, "node_modules", "ws"), { recursive: true });
  const node = path.join(buildDir, isWin ? "hana-server.exe" : "node");
  fs.copyFileSync(process.execPath, node);
  if (!isWin) fs.chmodSync(node, 0o755);
  writeServerWrapperScripts({ outDir: buildDir, isWin, log: () => {} });

  packageDir = path.join(scratch, "relocated package");
  fs.renameSync(buildDir, packageDir);
  unrelatedCwd = path.join(scratch, "unrelated cwd");
  fs.mkdirSync(unrelatedCwd);
  env = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE"]) {
    const entry = Object.entries(process.env).find(([name]) => name.toUpperCase() === key);
    if (entry) env[entry[0]] = entry[1];
  }
  for (const key of [
    "HOME", "USERPROFILE", "HANA_HOME", "PI_CODING_AGENT_DIR", "APPDATA", "LOCALAPPDATA",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR",
  ]) {
    env[key] = path.join(scratch, key.toLowerCase());
    fs.mkdirSync(env[key]);
  }
  env.HANAKO_HOME = env.HANA_HOME;
  env.TMP = env.TEMP = env.TMPDIR;
  // The official wrapper must set its own package paths.
  env.HANA_ROOT = path.join(scratch, "missing-source");
  env.HANA_SERVER_ENTRY = path.join(env.HANA_ROOT, "server", "main-full.ts");
}, 60_000);

afterAll(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

function runWrapper(args: string[], cwd: string) {
  const wrapper = path.join(packageDir, isWin ? "hana.cmd" : "hana");
  // All arguments below are fixed test literals. Use cmd.exe for the actual
  // Windows wrapper; direct execution of bundle/cli.js is not the contract.
  return isWin
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${wrapper}" ${args.join(" ")}"`], {
      cwd, env, encoding: "utf8", timeout: 20_000, windowsVerbatimArguments: true,
    })
    : spawnSync(wrapper, args, { cwd, env, encoding: "utf8", timeout: 20_000 });
}

describe("packaged CLI shared by full and open builds", () => {
  for (const location of ["package", "unrelated"] as const) {
    it.each([
      { args: ["--help"], output: /hana serve/ },
      { args: ["bundle", "status"], output: /^Online updates are unavailable in this fork\. Upgrade using this project's instructions\.\s*$/ },
      { args: ["data", "diagnose"], output: /Kernel DATA_EPOCH/ },
    ])(`runs $args through the relocated wrapper from ${location} cwd`, ({ args, output }) => {
      const result = runWrapper(args, location === "package" ? packageDir : unrelatedCwd);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toMatch(output);
      expect(fs.readdirSync(env.HANA_HOME!)).toEqual([]);
    });
  }

  for (const location of ["package", "unrelated"] as const) {
    it(`refuses online pull explicitly through the relocated wrapper from ${location} cwd`, () => {
      const result = runWrapper(["bundle", "pull"], location === "package" ? packageDir : unrelatedCwd);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("Online updates are unavailable in this fork. Upgrade using this project's instructions.");
      expect(result.stderr).not.toContain("Cannot find module");
      expect(fs.readdirSync(env.HANA_HOME!)).toEqual([]);
    });
  }

  it.each(["shared/artifact-core/activation.cjs", "shared/artifact-core/pinned-keyset.json"])(
    "cannot borrow missing %s from the source checkout",
    (relativePath) => {
      const file = path.join(packageDir, relativePath);
      fs.renameSync(file, `${file}.held`);
      try {
        const result = runWrapper(["--help"], unrelatedCwd);
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Cannot find module");
        expect(result.stderr).toContain(path.basename(relativePath));
      } finally {
        fs.renameSync(`${file}.held`, file);
      }
    },
  );
});
