import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { checkCandidate, REVIEW_BRANCH } from "../scripts/pi-1.2.0/activate.mjs";

const root = path.resolve(import.meta.dirname, "..");
const metadata = JSON.parse(fs.readFileSync(path.join(root, "scripts/pi-1.2.0/candidate.json"), "utf8"));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("isolated Pi candidate activation", () => {
  it("refuses activation before the seven-package cooling deadline", () => {
    expect(() => checkCandidate({ rootDir: root, now: Date.parse(metadata.earliestActivation) - 1 })).toThrow(/until/);
  });

  it("applies only the declared candidate files in a disposable fixture without installing dependencies", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-candidate-patch-")); dirs.push(dir);
    for (const file of [...Object.keys(metadata.files), '.npmrc', '.gitattributes', 'scripts/pi-1.2.0/candidate.json', 'scripts/pi-1.2.0/candidate.patch']) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    // Outside a Git repository, apply ignores .gitattributes and Windows'
    // autocrlf setting rewrites the sealed LF bytes. Match the real checkout.
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: dir, encoding: 'utf8' });
    expect(initialized.status, initialized.stderr).toBe(0);
    const checked = checkCandidate({ rootDir: dir, now: Date.parse(metadata.earliestActivation) });
    if (!checked.applied) {
      const result = spawnSync('git', ['-c', 'core.autocrlf=true', 'apply', checked.patchFile], { cwd: dir, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(checkCandidate({ rootDir: dir, now: Date.parse(metadata.earliestActivation) }).applied).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const name of ['pi-agent-core', 'pi-ai', 'pi-coding-agent']) expect(pkg.dependencies[`@earendil-works/${name}`]).toBe('1.2.0');
    for (const { name } of metadata.packages) expect(pkg.overrides[name]).toBe('1.2.0');
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.npmrc'), 'utf8')).toBe(fs.readFileSync(path.join(root, '.npmrc'), 'utf8'));
    expect(fs.readFileSync(path.join(dir, 'scripts/build-server-deps.mjs'), 'utf8')).not.toContain('"@earendil-works/chord"');
    fs.appendFileSync(path.join(dir, 'scripts/patch-pi-sdk.cjs'), '\n// unrelated edit\n');
    expect(() => checkCandidate({ rootDir: dir, now: Date.parse(metadata.earliestActivation) })).toThrow(/Unreviewed edit/);
  });

  it.each(['patch', 'metadata', 'partial application', 'content', 'line endings'])("rejects %s drift in the sealed handoff", (drift) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-candidate-drift-")); dirs.push(dir);
    for (const file of [...Object.keys(metadata.files), '.npmrc', 'scripts/pi-1.2.0/candidate.json', 'scripts/pi-1.2.0/candidate.patch']) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    const now = Date.parse(metadata.earliestActivation);
    const checked = checkCandidate({ rootDir: dir, now });
    if (drift === 'patch') fs.appendFileSync(checked.patchFile, '\n');
    if (drift === 'metadata') {
      const changed = structuredClone(metadata);
      changed.files['package.json'] = { before: '0'.repeat(64), after: '0'.repeat(64) };
      fs.writeFileSync(path.join(dir, 'scripts/pi-1.2.0/candidate.json'), JSON.stringify(changed));
    }
    if (drift === 'partial application') {
      const args = ['-c', 'core.autocrlf=false', 'apply', ...(checked.applied ? ['--reverse'] : []), '--include=package.json', checked.patchFile];
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
    if (drift === 'content') fs.appendFileSync(path.join(dir, 'package.json'), ' ');
    if (drift === 'line endings') {
      const file = path.join(dir, 'package.json');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
    }
    expect(() => checkCandidate({ rootDir: dir, now })).toThrow(
      drift === 'patch' ? /checksum mismatch/ : drift === 'partial application' ? /partially applied/ : /Unreviewed edit/);
  });

  it("triggers ordinary CI for only the explicit review branch addition", () => {
    const ci = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')) as {
      on: { push: { branches: string[] } }; permissions: Record<string, string>;
    };
    expect(ci.on.push.branches).toContain(REVIEW_BRANCH);
    expect(ci.on.push.branches.some((branch: string) => branch.includes('*'))).toBe(false);
    expect(ci.permissions).toEqual({ contents: 'read' });
  });
});
