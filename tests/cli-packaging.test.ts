import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCliBundle, copyServerBootstrap, writeServerWrapperScripts } from "../scripts/build-server-phases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
let scratch: string;
let packageDir: string;
let packageAlias: string;
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
  packageAlias = path.join(scratch, "package alias");
  fs.symlinkSync(packageDir, packageAlias, isWin ? "junction" : "dir");
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

function runWrapper(args: string[], cwd: string, directory = packageDir) {
  const wrapper = path.join(directory, isWin ? "hana.cmd" : "hana");
  // All arguments below are fixed test literals. Use cmd.exe for the actual
  // Windows wrapper; direct execution of bundle/cli.js is not the contract.
  return isWin
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${wrapper}" ${args.join(" ")}"`], {
      cwd, env, encoding: "utf8", timeout: 20_000, windowsVerbatimArguments: true,
    })
    : spawnSync(wrapper, args, { cwd, env, encoding: "utf8", timeout: 20_000 });
}

describe("packaged CLI shared by full and open builds", () => {
  for (const form of ["canonical", "directory alias", "relative alias", "dot segments", "preserved main alias"] as const) {
    it(`executes help, disabled pull and invalid commands through the ${form}`, () => {
      const aliasEntry = path.join(packageAlias, "bundle", "cli.js");
      const entry = form === "canonical" ? path.join(packageDir, "bundle", "cli.js")
        : form === "relative alias" ? path.relative(unrelatedCwd, aliasEntry)
        : form === "dot segments" ? `${packageAlias}/bundle/../bundle/./cli.js` : aliasEntry;
      const flags = form === "preserved main alias" ? ["--preserve-symlinks-main"] : [];
      const run = (args: string[]) => spawnSync(process.execPath, [...flags, entry, ...args], {
        cwd: unrelatedCwd, env, encoding: "utf8", timeout: 20_000,
      });
      const help = run(["--help"]);
      const details = JSON.stringify({ entry, flags, status: help.status, stdout: help.stdout, stderr: help.stderr });
      expect(help.error).toBeUndefined();
      expect(help.status, details).toBe(0);
      expect(help.stdout, details).toContain("Hana CLI");
      expect(help.stdout, details).toContain("hana bundle pull");
      expect(help.stderr).toBe("");
      const pull = run(["bundle", "pull"]);
      expect(pull.error).toBeUndefined();
      expect(pull.status, pull.stdout + pull.stderr).toBe(1);
      expect(pull.stdout).toBe("");
      expect(pull.stderr.trim()).toBe("Online updates are unavailable in this fork. Upgrade using this project's instructions.");
      const invalid = run(["not-a-command"]);
      expect(invalid.error).toBeUndefined();
      expect(invalid.status, invalid.stdout + invalid.stderr).toBe(1);
      expect(invalid.stdout).toContain("Hana CLI");
      expect(invalid.stderr).toContain("unknown command: not-a-command");
      expect(fs.readdirSync(env.HANA_HOME!)).toEqual([]);
    });
  }

  for (const importedPath of ["canonical", "directory alias"] as const) {
    it.each(["absent", "unrelated file", "missing file", "directory"])(
      `does not start the ${importedPath} module when imported with an %s argv entry`,
      (entryKind) => {
        const argvEntry = entryKind === "unrelated file" ? path.join(packageDir, "package.json")
          : entryKind === "missing file" ? path.join(unrelatedCwd, "missing-cli.js") : unrelatedCwd;
        const cli = path.join(importedPath === "canonical" ? packageDir : packageAlias, "bundle", "cli.js");
        const script = [
          `process.argv = ${entryKind === "absent" ? "[process.execPath]" : JSON.stringify([process.execPath, argvEntry, "bundle", "pull"])};`,
          `const cli = await import(${JSON.stringify(pathToFileURL(cli).href)});`,
          'if (typeof cli.main !== "function") throw new Error("missing main export");',
          'console.log("import-only");',
        ].join("\n");
        const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
          cwd: unrelatedCwd, env, encoding: "utf8", timeout: 20_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toBe("import-only\n");
        expect(result.stderr).toBe("");
        expect(fs.readdirSync(env.HANA_HOME!)).toEqual([]);
      },
    );
  }

  it("reports a missing direct entry as a Node error", () => {
    const result = spawnSync(process.execPath, [path.join(packageAlias, "bundle", "missing-cli.js"), "--help"], {
      cwd: unrelatedCwd, env, encoding: "utf8", timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("MODULE_NOT_FOUND");
  });

  for (const location of ["package", "unrelated"] as const) {
    it(`executes help and refuses pull through the directory alias wrapper from ${location} cwd`, () => {
      const cwd = location === "package" ? packageAlias : unrelatedCwd;
      const help = runWrapper(["--help"], cwd, packageAlias);
      expect(help.error).toBeUndefined();
      expect(help.status, help.stdout + help.stderr).toBe(0);
      expect(help.stdout).toContain("Hana CLI");
      expect(help.stdout).toContain("hana bundle pull");
      const pull = runWrapper(["bundle", "pull"], cwd, packageAlias);
      expect(pull.error).toBeUndefined();
      expect(pull.status, pull.stdout + pull.stderr).toBe(1);
      expect(pull.stdout).toBe("");
      expect(pull.stderr.trim()).toBe("Online updates are unavailable in this fork. Upgrade using this project's instructions.");
      expect(fs.readdirSync(env.HANA_HOME!)).toEqual([]);
    });
  }

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
