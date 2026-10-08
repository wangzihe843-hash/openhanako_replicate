import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const entry = new URL("../Start-HanaAgent-Dev.command", import.meta.url);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Exercise the actual macOS shell entry without installing packages, starting
// Electron, reading the real HOME, or executing a user's shell profile.
describe.skipIf(process.platform !== "darwin")("Mac Finder development launcher", () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-command-test-"));
    temporaryRoots.push(root);
    const repo = path.join(root, "项目 with spaces 'quote' $(touch INJECTED) `touch ALSO_INJECTED`");
    const home = path.join(root, "isolated home");
    const bin = path.join(home, `.local/node-v24.21.0-darwin-${process.arch}/bin`);
    const resultPath = path.join(root, "invocation.json");
    for (const directory of [repo, home, bin, path.join(repo, "scripts"), path.join(repo, "node_modules/vite/bin"), path.join(repo, "node_modules/electron")]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const command = path.join(repo, "Start-HanaAgent-Dev.command");
    fs.copyFileSync(entry, command);
    fs.chmodSync(command, 0o755);
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { start: "fixture" } }));
    fs.writeFileSync(path.join(repo, "scripts/launch.js"), "");
    fs.writeFileSync(path.join(repo, "node_modules/vite/bin/vite.js"), "");
    fs.writeFileSync(path.join(repo, "node_modules/electron/cli.js"), "");
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    // A harmless npm stand-in records the process boundary. Only the entry's
    // command choice/environment are under test; this is not native acceptance.
    fs.writeFileSync(path.join(bin, "npm"), `
      const fs = require("node:fs");
      fs.writeFileSync(process.env.FIXTURE_RESULT, JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME,
        hanaHome: process.env.HANA_HOME, node: process.env.HANA_DEV_NODE_BIN,
        path: process.env.PATH, execPath: process.execPath
      }));
      process.exit(Number(process.env.FIXTURE_EXIT || 0));
    `);
    // A login/profile source would leave a sentinel in the disposable HOME.
    for (const profile of [".bash_profile", ".bashrc", ".zprofile", ".zshrc"]) {
      fs.writeFileSync(path.join(home, profile), 'touch "$HOME/PROFILE_WAS_LOADED"\n');
    }
    const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", FIXTURE_RESULT: resultPath };
    const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(command, [], {
      cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 10000,
    });
    const invocation = () => JSON.parse(fs.readFileSync(resultPath, "utf8"));
    return { root, repo, home, bin, command, resultPath, run, invocation };
  }

  it("is executable and finds Node in an isolated HOME with Finder's minimal PATH and quoted paths", () => {
    expect(fs.statSync(entry).mode & 0o111).not.toBe(0);
    const f = fixture();
    const result = f.run();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(f.invocation()).toMatchObject({
      args: ["start"], cwd: fs.realpathSync(f.repo), home: f.home,
      node: path.join(fs.realpathSync(f.bin), "node"), execPath: process.execPath,
    });
    expect(f.invocation().hanaHome).toBeUndefined(); // Existing launch.js owns the default.
    expect(f.invocation().path.split(path.delimiter)[0]).toBe(fs.realpathSync(f.bin));
    expect(fs.existsSync(path.join(f.home, "PROFILE_WAS_LOADED"))).toBe(false);
    for (const directory of [f.root, f.repo]) {
      expect(fs.existsSync(path.join(directory, "INJECTED"))).toBe(false);
      expect(fs.existsSync(path.join(directory, "ALSO_INJECTED"))).toBe(false);
    }
  });

  it("uses a validated explicit Node and preserves an explicit development data directory", () => {
    const f = fixture();
    const hanaHome = path.join(f.home, "separate data");
    const result = f.run({ HANA_DEV_NODE_BIN: path.join(f.bin, "node"), HANA_HOME: hanaHome });
    expect(result.status, result.stderr).toBe(0);
    expect(f.invocation().hanaHome).toBe(hanaHome);
  });

  it("also finds a compatible installation on PATH without a user-local Node directory", () => {
    const f = fixture();
    const pathBin = path.join(f.home, "custom node bin");
    fs.renameSync(f.bin, pathBin);
    const result = f.run({ PATH: `${pathBin}:/usr/bin:/bin:/usr/sbin:/sbin` });
    expect(result.status, result.stderr).toBe(0);
    expect(f.invocation().node).toBe(path.join(fs.realpathSync(pathBin), "node"));
  });

  it.each(["v22.20.0", "v24.11.1", "v25.0.0"])("rejects an explicitly configured incompatible Node %s before npm", (version) => {
    const f = fixture();
    const incompatible = path.join(f.bin, "incompatible-node");
    // Evaluate the entry's real version predicate with an incompatible runtime
    // version; the host Node executes only this isolated probe.
    fs.writeFileSync(incompatible, `#!${process.execPath}\nconst vm = require('node:vm'); vm.runInNewContext(process.argv[3], { process: { versions: { node: '${version.slice(1)}' }, exit: code => process.exit(code) } });\n`);
    fs.chmodSync(incompatible, 0o755);
    const result = f.run({ HANA_DEV_NODE_BIN: incompatible });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HANA_DEV_NODE_BIN");
    expect(fs.existsSync(f.resultPath)).toBe(false);
  });

  it("stops on a missing explicitly selected Node instead of silently using a different installation", () => {
    const f = fixture();
    const result = f.run({ HANA_DEV_NODE_BIN: path.join(f.home, "missing node") });
    expect(result.status).toBe(1);
    expect(fs.existsSync(f.resultPath)).toBe(false);
  });

  it("rejects a Node installation without its own npm", () => {
    const f = fixture();
    fs.rmSync(path.join(f.bin, "npm"));
    const result = f.run({ HANA_DEV_NODE_BIN: path.join(f.bin, "node") });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm");
    expect(fs.existsSync(f.resultPath)).toBe(false);
  });

  it("reports missing dependencies without invoking npm", () => {
    const f = fixture();
    fs.rmSync(path.join(f.repo, "node_modules"), { recursive: true });
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm ci");
    expect(fs.existsSync(f.resultPath)).toBe(false);
  });

  it("keeps npm's failure exit code and reports it without installing or retrying", () => {
    const f = fixture();
    const result = f.run({ FIXTURE_EXIT: "17" });
    expect(result.status, `${result.error || ""}\n${result.stderr}`).toBe(17);
    expect(result.stderr).toContain("17");
    expect(f.invocation().args).toEqual(["start"]);
  });

  it("rejects a detached entry before running npm", () => {
    const f = fixture();
    fs.rmSync(path.join(f.repo, "scripts/launch.js"));
    const result = f.run();
    expect(result.status).toBe(1);
    expect(fs.existsSync(f.resultPath)).toBe(false);
  });
});
