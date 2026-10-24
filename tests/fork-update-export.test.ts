import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { exportOpenTree, planExportCopies, EXPORT_SKELETON } from "../scripts/export-open-tree.mjs";
import { buildCliBundle } from "../scripts/build-server-phases.mjs";
const root = process.cwd();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function verifyExportedCli(throughAlias: boolean) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf8"));
  const priorManifest = { ...manifest, paths: manifest.paths.filter((p: string) => p !== "shared/update-policy.cjs") };
  const prior = new Set(planExportCopies({ rootDir: root, manifest: priorManifest, skeleton: EXPORT_SKELETON }));
  const current = planExportCopies({ rootDir: root, manifest, skeleton: EXPORT_SKELETON });
  expect(current.filter((p: string) => !prior.has(p))).toEqual(["shared/update-policy.cjs"]);
  const allocated = fs.mkdtempSync(path.join(os.tmpdir(), "fork-export-cli-"));
  const realRoot = fs.realpathSync(allocated); dirs.push(realRoot);
  const alias = path.join(realRoot, "temporary-directory-alias");
  if (throughAlias) fs.symlinkSync(realRoot, alias, process.platform === "win32" ? "junction" : "dir");
  // Node resolves the entry module through symlinks; invoke that same canonical
  // path so the CLI self-entry check actually calls main(), including on macOS.
  const temp = fs.realpathSync(throughAlias ? alias : allocated);
  const exported = path.join(temp, "open"); exportOpenTree({ rootDir: root, destDir: exported, log: () => {} });
  expect(fs.readFileSync(path.join(exported, "shared/update-policy.cjs"), "utf8")).toBe(fs.readFileSync(path.join(root, "shared/update-policy.cjs"), "utf8"));
  // Provision dependencies in this temporary exported tree, as npm ci would.
  fs.rmSync(path.join(exported, "node_modules"), { recursive: true, force: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(exported, "node_modules"), "dir");
  const dist = path.join(temp, "dist"); const bundle = path.join(dist, "bundle"); fs.mkdirSync(bundle, { recursive: true });
  buildCliBundle({ rootDir: exported, bundleOutDir: bundle, log: () => {} });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dist, "node_modules"), "dir");
  const cli = path.join(bundle, "cli.js");
  expect(fs.realpathSync(cli)).toBe(cli);
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dist, encoding: "utf8", timeout: 10_000, env: { ...process.env, HANA_HOME: path.join(temp, "home") } });
  const help = run("--help");
  const helpDetails = JSON.stringify({ cli, realPath: fs.realpathSync(cli), stdout: help.stdout, stderr: help.stderr, signal: help.signal });
  expect(help.error).toBeUndefined(); expect(help.status, helpDetails).toBe(0);
  expect(help.stdout, helpDetails).toContain("Hana CLI");
  expect(help.stdout, helpDetails).toContain("hana bundle pull");
  const pull = run("bundle", "pull");
  const pullDetails = JSON.stringify({ cli, realPath: fs.realpathSync(cli), stdout: pull.stdout, stderr: pull.stderr, signal: pull.signal });
  expect(pull.error).toBeUndefined(); expect(pull.status, pullDetails).toBe(1);
  expect(pull.stdout, pullDetails).toBe("");
  expect(pull.stderr.trim(), pullDetails).toBe("Online updates are unavailable in this fork. Upgrade using this project's instructions.");
  expect(pull.stderr).not.toContain("Cannot find module");
}

it("exports only the approved policy addition and runs the packaged CLI with updates disabled", () => {
  verifyExportedCli(false);
}, 30_000);

it("executes the exported CLI when its temporary directory is supplied through an alias", () => {
  verifyExportedCli(true);
}, 30_000);
