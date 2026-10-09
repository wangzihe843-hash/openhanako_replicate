import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXPORT_DIR_NAME,
  EXPORT_SKELETON,
  exportOpenTree,
  planExportCopies,
} from "../scripts/export-open-tree.mjs";
import { runRehearsalStep } from "../scripts/rehearse-open-export.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_SCRIPT = path.join(REPOSITORY_ROOT, "scripts", "export-open-tree.mjs");

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe fixture cleanup: ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function write(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * Builds a fixture repo with a real git history, so directory-entry
 * expansion (git ls-files-based) behaves exactly like it does against the
 * real repository.
 */
function makeFixtureRepo(): string {
  const dir = tempDir("hana-export-fixture-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "fixture@test.local");
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");

  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "pkg/index.ts", "export const b = 2;\n");
  write(dir, "tmpl/one.md", "hello\n");
  write(dir, ".gitignore", "pkg/dist/\ntmpl/*.tmp\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");

  // Untracked / gitignored content that must never be swept into a
  // directory-entry expansion.
  write(dir, "pkg/dist/generated.js", "// generated, gitignored\n");
  write(dir, "tmpl/ignored.tmp", "scratch\n");

  // A "node_modules"-style literal file entry that is intentionally never
  // committed to git at all (mirrors export-manifest.json's own
  // node_modules/@earendil-works/... file entries).
  write(dir, "vendor/lib.js", "module.exports = {};\n");

  return dir;
}

function writeManifest(root: string, paths: string[]): void {
  fs.writeFileSync(
    path.join(root, "export-manifest.json"),
    JSON.stringify({ version: 1, paths }, null, 2),
  );
}

type MetadataLayout = "directory" | "pointer" | "worktree";

function makeMetadataFixture(layout: MetadataLayout) {
  let root = makeFixtureRepo();
  if (layout === "pointer") {
    const gitDir = path.join(tempDir("hana-export-metadata-"), "metadata");
    fs.renameSync(path.join(root, ".git"), gitDir);
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${gitDir.replaceAll("\\", "/")}\n`);
  } else if (layout === "worktree") {
    const checkout = path.join(tempDir("hana-export-worktree-"), "checkout");
    git(root, "worktree", "add", "-q", "--detach", checkout);
    root = checkout;
  }
  writeManifest(root, ["src/a.ts"]);
  const metadata = git(root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir")
    .trim().split(/\r?\n/).map((dir) => fs.realpathSync.native(dir));
  return { root, metadata: [...new Set(metadata)] };
}

function snapshotTree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  function visit(relative: string) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) entries[relative] = `link:${fs.readlinkSync(absolute)}`;
    else if (stat.isDirectory()) {
      entries[relative] = "directory";
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else entries[relative] = fs.readFileSync(absolute).toString("hex");
  }
  visit(".");
  return entries;
}

function expectRejectedBeforeWrites(root: string, destinations: string[], error = /overlaps|repository root/) {
  const protectedPaths = [path.join(root, ".git"), path.join(root, "src"),
    ...git(root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").trim().split(/\r?\n/)];
  const before = protectedPaths.map(snapshotTree);
  const stop = () => { throw new Error("unsafe filesystem mutation reached"); };
  const guards = [vi.spyOn(fs, "mkdirSync").mockImplementation(stop),
    vi.spyOn(fs, "mkdtempSync").mockImplementation(stop),
    vi.spyOn(fs, "renameSync").mockImplementation(stop),
    vi.spyOn(fs, "rmSync").mockImplementation(stop)];
  try {
    for (const destDir of destinations) {
      expect(() => exportOpenTree({ rootDir: root, destDir, force: true, skeleton: [] })).toThrow(error);
    }
    for (const guard of guards) expect(guard).not.toHaveBeenCalled();
  } finally {
    for (const guard of guards) guard.mockRestore();
    expect(protectedPaths.map(snapshotTree)).toEqual(before);
  }
}

function windowsShortPath(directory: string): string {
  const short = execFileSync("cmd.exe", ["/d", "/c", 'for %I in ("%HANA_EXPORT_ALIAS_DIR%") do @echo %~sI'], {
    encoding: "utf8", env: { ...process.env, HANA_EXPORT_ALIAS_DIR: directory },
  }).trim();
  const long = fs.realpathSync.native(directory);
  expect(short.toLowerCase(), "Windows fixture requires an actual 8.3 alias").not.toBe(long.toLowerCase());
  expect(fs.realpathSync.native(short)).toBe(long);
  return short;
}

describe("export-open-tree: planExportCopies path semantics", () => {
  it("expands a trailing-slash directory entry to git-tracked files only", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["pkg/"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [] });
    expect(files).toContain("pkg/index.ts");
    expect(files).not.toContain("pkg/dist/generated.js");
  });

  it("auto-detects a non-trailing-slash entry that is actually a directory and applies the same tracked-only filtering (ambiguous manifest entries like lib/yuan)", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["tmpl"]); // no trailing slash, but tmpl/ is a directory on disk
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [] });
    expect(files).toContain("tmpl/one.md");
    expect(files).not.toContain("tmpl/ignored.tmp");
  });

  it("treats a non-trailing-slash entry that is an actual file as a literal file", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [] });
    expect(files).toEqual(["src/a.ts"]);
  });

  it("copies a node_modules-style file entry verbatim without requiring git-tracked status", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["vendor/lib.js"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [] });
    expect(files).toEqual(["vendor/lib.js"]);
  });

  it("deduplicates when a manifest path and a skeleton path point at the same file", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [{ path: "src/a.ts" }] });
    expect(files).toEqual(["src/a.ts"]);
  });

  it("hard-errors when a manifest path does not exist in the repo", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["nope.ts"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    expect(() => planExportCopies({ rootDir: root, manifest, skeleton: [] })).toThrow(/does not exist/);
  });

  it("hard-errors when a manifest path resolves outside the repository root (path-escape guard)", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["../outside-secret.txt"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    expect(() => planExportCopies({ rootDir: root, manifest, skeleton: [] })).toThrow(/escapes repository root/);
  });

  it("hard-errors when a skeleton path resolves outside the repository root", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    expect(() => planExportCopies({ rootDir: root, manifest, skeleton: [{ path: "../../etc/passwd" }] }))
      .toThrow(/escapes repository root/);
  });
});

describe("export-open-tree: exportOpenTree materialization", () => {
  it("B01 rejects ancestor and source destinations before any destructive operation", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const before = fs.readFileSync(path.join(root, "src/a.ts"));
    // Never actually delete an ancestor, even if validation regresses.
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("unsafe deletion reached"); });
    for (const dest of [path.dirname(root), path.join(root, "src"), path.join(root, ".git")]) {
      expect(() => exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] })).toThrow();
    }
    expect(remove).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, "src/a.ts"))).toEqual(before);
  });

  it("B01 preserves the previous export when planning or copying fails", () => {
    const root = makeFixtureRepo();
    const dest = path.join(root, "output/export");
    write(root, "output/export/previous.txt", "old valid export");
    writeManifest(root, ["missing.ts"]);
    expect(() => exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] })).toThrow();
    expect(fs.readFileSync(path.join(dest, "previous.txt"), "utf8")).toBe("old valid export");
    writeManifest(root, ["src/a.ts"]);
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => { throw new Error("copy failed"); });
    expect(() => exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] })).toThrow(/copy failed/);
    expect(fs.readFileSync(path.join(dest, "previous.txt"), "utf8")).toBe("old valid export");
  });

  it("B01 supports force export under an independent nested output directory", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const dest = path.join(root, "output/nested/export");
    write(root, "output/nested/export/old", "old");
    exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [], log: () => {} });
    expect(fs.readFileSync(path.join(dest, "src/a.ts"))).toEqual(fs.readFileSync(path.join(root, "src/a.ts")));
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["export"]);
  });

  it("B01 rejects missing tracked inputs and malformed input paths before changing output", () => {
    const root = makeFixtureRepo();
    const dest = path.join(root, "output/export");
    write(root, "output/export/old", "old");
    fs.unlinkSync(path.join(root, "pkg/index.ts"));
    for (const inputs of [["pkg/"], ["src/a.ts/"], [path.join(root, "src/a.ts")], [".git/config"], ["../outside"], [""]]) {
      writeManifest(root, inputs);
      expect(() => exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] })).toThrow();
      expect(fs.readFileSync(path.join(dest, "old"), "utf8")).toBe("old");
    }
  });

  it("B01 protects unexported tracked source trees and declared empty input directories", () => {
    const root = makeFixtureRepo();
    fs.mkdirSync(path.join(root, "empty-input"));
    writeManifest(root, ["src/a.ts", "empty-input/"]);
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("unsafe deletion reached"); });
    for (const dest of ["pkg/new-output", "empty-input/export", ".git/nested", "src/empty"]) {
      expect(() => exportOpenTree({ rootDir: root, destDir: path.join(root, dest), force: true, skeleton: [] })).toThrow(/overlaps/);
    }
    expect(remove).not.toHaveBeenCalled();
  });

  it("B01 rejects destination links, linked parent aliases to source, and linked inputs", () => {
    const root = makeFixtureRepo();
    const outside = tempDir("hana-export-link-target-");
    write(outside, "secret.txt", "outside preserved");
    fs.symlinkSync(outside, path.join(root, "linked-input"), process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(path.join(root, "src"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    writeManifest(root, ["src/a.ts"]);
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("unsafe deletion reached"); });
    for (const dest of ["alias", "alias/new-output", "linked-input"]) {
      expect(() => exportOpenTree({ rootDir: root, destDir: path.join(root, dest), force: true, skeleton: [] })).toThrow();
    }
    writeManifest(root, ["linked-input/secret.txt"]);
    expect(() => exportOpenTree({ rootDir: root, destDir: path.join(root, "output/export"), force: true, skeleton: [] })).toThrow(/linked input/);
    expect(remove).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("outside preserved");
  });

  it("B01 protects Git metadata reached through a .git pointer file", () => {
    const root = makeFixtureRepo();
    const external = tempDir("hana-export-gitdir-");
    const gitDir = path.join(external, "metadata");
    fs.renameSync(path.join(root, ".git"), gitDir);
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${gitDir.replaceAll("\\", "/")}\n`);
    writeManifest(root, ["src/a.ts"]);
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("unsafe deletion reached"); });
    expect(() => exportOpenTree({ rootDir: root, destDir: path.join(gitDir, "new-output"), force: true, skeleton: [] })).toThrow(/overlaps/);
    expect(remove).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(gitDir, "HEAD"))).toBe(true);
  });

  it.each<MetadataLayout>(["directory", "pointer", "worktree"])("B01 rejects %s metadata, ancestors and descendants before staging", (layout) => {
    const { root, metadata } = makeMetadataFixture(layout);
    expect(metadata).toHaveLength(layout === "worktree" ? 2 : 1);
    for (const directory of metadata) write(directory, "existing-output/keep.txt", "metadata sentinel");
    expectRejectedBeforeWrites(root, metadata.flatMap((directory) => [
      directory, path.dirname(directory), path.join(directory, "existing-output"), path.join(directory, "missing/nested/output"),
    ]));
    expectRejectedBeforeWrites(root, [path.join(root, ".git")], /overlaps|must be a directory/);

    // A sibling with the same string prefix is an independent output.
    const before = metadata.map(snapshotTree);
    const destDir = `${metadata.at(-1)}-export`;
    write(destDir, "old.txt", "previous export");
    exportOpenTree({ rootDir: root, destDir, force: true, skeleton: [], log: () => {} });
    expect(fs.readFileSync(path.join(destDir, "src/a.ts"))).toEqual(fs.readFileSync(path.join(root, "src/a.ts")));
    expect(fs.existsSync(path.join(destDir, "old.txt"))).toBe(false);
    expect(metadata.map(snapshotTree)).toEqual(before);
  });

  it.each<MetadataLayout>(["directory", "pointer", "worktree"])("B01 models spelling-preserving realpath for %s metadata aliases", (layout) => {
    const { root, metadata } = makeMetadataFixture(layout);
    const alias = path.join(tempDir("hana-export-spelling-"), "METADA~1");
    fs.symlinkSync(metadata[0], alias, process.platform === "win32" ? "junction" : "dir");
    const native = fs.realpathSync.native;
    expect(native(alias)).toBe(native(metadata[0]));
    const realpath = fs.realpathSync;
    // Model the spelling retained for Windows 8.3 names without spoofing the
    // host OS. Real native short/long aliases are exercised separately below.
    const spelling = vi.spyOn(fs, "realpathSync").mockImplementation(((target, options) =>
      String(target) === alias ? alias : realpath(target, options)) as typeof fs.realpathSync);
    Object.assign(fs.realpathSync, { native });
    try {
      expectRejectedBeforeWrites(root, [path.join(alias, "missing/nested/output")], /overlaps/);
    } finally {
      spelling.mockRestore();
    }
  });

  it.runIf(process.platform === "win32").each<MetadataLayout>(["directory", "pointer", "worktree"])("B01 rejects native Windows short/long %s metadata aliases in both directions", (layout) => {
    const { root, metadata } = makeMetadataFixture(layout);
    for (const directory of metadata) write(directory, "existing-output/keep.txt", "metadata sentinel");
    const longRoot = fs.realpathSync.native(root);
    const shortRoot = windowsShortPath(root);
    for (const directory of metadata) {
      const longDir = fs.realpathSync.native(directory);
      const shortDir = windowsShortPath(directory);
      for (const [rootDir, gitDir] of [[longRoot, shortDir], [shortRoot, longDir]]) {
        expectRejectedBeforeWrites(rootDir, [gitDir, path.dirname(gitDir),
          path.join(gitDir, "existing-output"), path.join(gitDir, "missing/nested/output")]);
      }
    }
    const destDir = path.join(shortRoot, "output/independent");
    exportOpenTree({ rootDir: longRoot, destDir, skeleton: [], log: () => {} });
    exportOpenTree({ rootDir: shortRoot, destDir: fs.realpathSync.native(destDir), force: true, skeleton: [], log: () => {} });
    expect(fs.readFileSync(path.join(destDir, "src/a.ts"))).toEqual(fs.readFileSync(path.join(root, "src/a.ts")));
  }, 30_000);

  it.runIf(process.platform === "win32").each(["file", "empty directory"])("B01 protects an untracked %s declared through a native Windows short name", (kind) => {
    const root = makeFixtureRepo();
    const source = path.join(root, "Untracked Source Directory");
    fs.mkdirSync(source);
    if (kind === "file") write(source, "payload.ts", "untracked source sentinel");
    const shortName = path.basename(windowsShortPath(source));
    expect(shortName.toLowerCase()).not.toBe(path.basename(source).toLowerCase());
    const entry = kind === "file" ? `${shortName}/payload.ts` : `${shortName}/`;
    writeManifest(root, ["src/a.ts", entry]);
    const before = snapshotTree(source);
    expectRejectedBeforeWrites(root, [source, path.join(source, "missing/output")], /overlaps/);
    expect(snapshotTree(source)).toEqual(before);
    const destDir = path.join(root, "output/export");
    exportOpenTree({ rootDir: root, destDir, skeleton: [], log: () => {} });
    expect(fs.readFileSync(path.join(destDir, "src/a.ts"))).toEqual(fs.readFileSync(path.join(root, "src/a.ts")));
    if (kind === "file") expect(fs.readFileSync(path.join(destDir, entry), "utf8")).toBe("untracked source sentinel");
  });

  it("B01 protects missing unexported tracked trees while allowing independent output", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    fs.rmSync(path.join(root, "pkg"), { recursive: true });
    expectRejectedBeforeWrites(root, [path.join(root, "pkg/new-output")], /overlaps/);
    const destDir = path.join(root, "output/export");
    exportOpenTree({ rootDir: root, destDir, skeleton: [], log: () => {} });
    expect(fs.readFileSync(path.join(destDir, "src/a.ts"))).toEqual(fs.readFileSync(path.join(root, "src/a.ts")));
  });

  it("B01 rejects a filesystem root that cannot be resolved instead of looping", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const stat = fs.lstatSync;
    const destination = path.join(root, "unavailable/output");
    vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
      const rel = path.relative(String(target), destination);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return undefined;
      return stat(target, options as any);
    }) as typeof fs.lstatSync);
    expect(() => exportOpenTree({ rootDir: root, destDir: destination, force: true, skeleton: [] })).toThrow(/no existing filesystem root/);
  });

  it.runIf(process.platform === "win32")("B01 handles Windows case aliases and rejects trailing-dot destinations", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("unsafe deletion reached"); });
    for (const dest of [root.toUpperCase(), path.join(root, "SRC/child"), path.join(root, "src."), path.join(root, "src ")]) {
      expect(() => exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] })).toThrow();
    }
    expect(remove).not.toHaveBeenCalled();
  });

  it("B01 restores the previous export if committing the staged directory fails", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const dest = path.join(root, "output/export");
    write(root, "output/export/old", "old");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (path.basename(String(source)) === "tree") throw new Error("replacement denied");
      rename(source, target);
    });
    expect(() => exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] })).toThrow(/replacement denied/);
    expect(fs.readFileSync(path.join(dest, "old"), "utf8")).toBe("old");
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["export"]);
  });

  it("B01 retains and identifies the backup if Windows also refuses rollback", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const dest = path.join(root, "output/export");
    write(root, "output/export/old", "recover me");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (["tree", "previous"].includes(path.basename(String(source)))) throw new Error("replacement denied");
      rename(source, target);
    });
    expect(() => exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] })).toThrow(/previous export preserved at/);
    const staging = fs.readdirSync(path.dirname(dest)).find((name) => name.startsWith(".open-export-"))!;
    expect(fs.readFileSync(path.join(path.dirname(dest), staging, "previous/old"), "utf8")).toBe("recover me");
  });

  it("B01 preserves Unicode and whitespace in tracked file names", () => {
    const root = makeFixtureRepo();
    write(root, "tmpl/ 中文 name .md", "literal path");
    git(root, "add", "--", "tmpl/ 中文 name .md");
    writeManifest(root, ["tmpl/"]);
    const dest = path.join(root, "output/export");
    exportOpenTree({ rootDir: root, destDir: dest, skeleton: [], log: () => {} });
    expect(fs.readFileSync(path.join(dest, "tmpl/ 中文 name .md"), "utf8")).toBe("literal path");
  });
  it("copies exactly the planned file set into destDir, byte-identical content", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts", "pkg/"]);
    const dest = path.join(root, "out");
    const result = exportOpenTree({ rootDir: root, destDir: dest, skeleton: [] });

    expect(result.fileCount).toBe(2);
    expect(fs.readFileSync(path.join(dest, "src", "a.ts"), "utf-8"))
      .toBe(fs.readFileSync(path.join(root, "src", "a.ts"), "utf-8"));
    expect(fs.existsSync(path.join(dest, "pkg", "dist", "generated.js"))).toBe(false);
  });

  it("refuses to write into a non-empty destDir without --force", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const dest = path.join(root, "out");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "leftover.txt"), "stale\n");

    expect(() => exportOpenTree({ rootDir: root, destDir: dest, skeleton: [] })).toThrow(/non-empty/);
    // Untouched: the stale file is still there.
    expect(fs.existsSync(path.join(dest, "leftover.txt"))).toBe(true);
  });

  it("with force: true, wipes a non-empty destDir and re-exports cleanly (idempotent rerun)", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const dest = path.join(root, "out");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "leftover.txt"), "stale\n");

    const result = exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] });
    expect(result.fileCount).toBe(1);
    expect(fs.existsSync(path.join(dest, "leftover.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "src", "a.ts"))).toBe(true);

    // Second run with force is idempotent.
    const second = exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] });
    expect(second.fileCount).toBe(1);
  });

  it("refuses when destDir resolves to the repository root itself", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    expect(() => exportOpenTree({ rootDir: root, destDir: root, skeleton: [] })).toThrow(/must not be the repository root/);
  });
});

describe("export-open-tree: real repository (smoke)", () => {
  it("materializes the real export-manifest.json + EXPORT_SKELETON, is idempotent under --force", () => {
    const dest = path.join(tempDir("hana-export-real-"), "out");
    const first = exportOpenTree({ rootDir: REPOSITORY_ROOT, destDir: dest, log: () => {} });
    expect(first.fileCount).toBeGreaterThan(0);
    for (const expected of ["package.json", "server/main-open.ts", "scripts/build-server-open.mjs", "package-lock.json"]) {
      expect(first.files).toContain(expected);
    }

    const second = exportOpenTree({ rootDir: REPOSITORY_ROOT, destDir: dest, force: true, log: () => {} });
    expect(second.fileCount).toBe(first.fileCount);
  }, 30_000);

  it("EXPORT_SKELETON entries are all real, existing repo-relative paths", () => {
    for (const { path: relPath, reason } of EXPORT_SKELETON) {
      expect(fs.existsSync(path.join(REPOSITORY_ROOT, relPath)), `${relPath} should exist`).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("the CLI subprocess exports into a given destination directory and exits 0", () => {
    const dest = path.join(tempDir("hana-export-cli-"), "out");
    const result = spawnSync(process.execPath, [EXPORT_SCRIPT, dest, "--force"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(dest, "package.json"))).toBe(true);
  }, 30_000);

  it("the CLI subprocess exits non-zero on an unknown flag", () => {
    const dest = path.join(tempDir("hana-export-cli-bad-"), "out");
    const result = spawnSync(process.execPath, [EXPORT_SCRIPT, dest, "--not-a-real-flag"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown argument/);
  });
});

describe("rehearse-open-export: DEFAULT_EXPORT_DIR_NAME", () => {
  it("matches the .gitignore-registered export directory name", () => {
    const gitignore = fs.readFileSync(path.join(REPOSITORY_ROOT, ".gitignore"), "utf-8");
    expect(gitignore).toMatch(new RegExp(`${DEFAULT_EXPORT_DIR_NAME}/`));
  });
});

describe("rehearse-open-export: runRehearsalStep exit-code propagation", () => {
  it("B09 runs the installed npm --version using Node/PATH fallback with isolated npm configuration", () => {
    const dir = tempDir("hana-npm-version-");
    const env = { ...process.env };
    delete env.npm_execpath;
    env.npm_config_userconfig = path.join(dir, "user.npmrc");
    env.npm_config_globalconfig = path.join(dir, "global.npmrc");
    env.npm_config_cache = path.join(dir, "cache");
    fs.writeFileSync(env.npm_config_userconfig, "");
    fs.writeFileSync(env.npm_config_globalconfig, "");
    expect(runRehearsalStep({ step: "npm version only", cmd: "npm", args: ["--version"], cwd: dir, env, log: () => {} }).status).toBe(0);
  });
  it("B09 starts npm through its Node entry with literal arguments and inherited environment", () => {
    const dir = tempDir("hana-npm space-");
    const cli = path.join(dir, "npm-cli.js");
    const capture = path.join(dir, "captured.json");
    fs.writeFileSync(cli, 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), token: process.env.TEST_TOKEN, cwd: process.cwd() })); process.exit(Number(process.env.TEST_EXIT || 0));');
    const env = { ...process.env, npm_execpath: cli, CAPTURE: capture, TEST_TOKEN: "kept" };
    const args = ["ci", "--ignore-scripts=false", "space & literal $(value)"];
    runRehearsalStep({ step: "npm ci", cmd: "npm", args, cwd: dir, env, log: () => {} });
    expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({ args, token: "kept", cwd: fs.realpathSync(dir) });
    expect(() => runRehearsalStep({ step: "npm failure", cmd: "npm", args: [], cwd: dir, env: { ...env, TEST_EXIT: "7" }, log: () => {} })).toThrow(/non-zero code 7/);
  });
  it("resolves without throwing when the command exits 0", () => {
    expect(() => runRehearsalStep({
      step: "ok-step",
      cmd: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: REPOSITORY_ROOT,
      log: () => {},
    })).not.toThrow();
  });

  it("throws with the step name and exit code when the command exits non-zero", () => {
    expect(() => runRehearsalStep({
      step: "failing-step",
      cmd: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: REPOSITORY_ROOT,
      log: () => {},
    })).toThrow(/failing-step.*non-zero code 3/s);
  });

  it("throws when the command cannot be spawned at all", () => {
    expect(() => runRehearsalStep({
      step: "unspawnable-step",
      cmd: "this-binary-does-not-exist-anywhere",
      args: [],
      cwd: REPOSITORY_ROOT,
      log: () => {},
    })).toThrow(/failed to spawn/);
  });
});
