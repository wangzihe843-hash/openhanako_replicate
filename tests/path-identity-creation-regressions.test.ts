import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowsShortPath } from "./helpers/windows-short-path.ts";
import { resolveFilesystemPathForCreationSync } from "../shared/link-aware-fs.ts";
import { PathGuard } from "../lib/sandbox/path-guard.ts";
import { deriveSandboxPolicy } from "../lib/sandbox/policy.ts";
import { copyFileRefToPath } from "../lib/file-ref/resource-io.ts";
import { ResourceAccessPolicy } from "../lib/resource-io/resource-access-policy.ts";
import { LocalFsProvider } from "../lib/resource-io/providers/local-fs-provider.ts";
import { MountProvider } from "../lib/resource-io/providers/mount-provider.ts";
import { ResourceIO } from "../lib/resource-io/resource-io.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { createFileTool } from "../lib/tools/file-tool.ts";

vi.mock("../lib/i18n.ts", () => ({ t: (key: string) => key }));
vi.mock("../lib/debug-log.ts", () => ({ createModuleLogger: () => ({ warn() {}, error() {}, info() {} }) }));
vi.mock("../lib/document-extract/index.ts", () => ({ extractDocument: vi.fn() }));

// Windows exercises real 8.3 names, case aliases and junctions without changing
// machine settings. Other hosts model only the JS/native spelling discrepancy;
// all files, links, authorization checks, copies and registry writes remain real.
describe("creation paths across filesystem identities", () => {
  let fixture: string;
  let longRoot: string;
  let shortRoot: string;
  let workspace: string;
  let workspaceLong: string;
  let outside: string;
  let hanakoHome: string;
  let agentDir: string;
  let source: string;
  let sessionPath: string;
  let guard: PathGuard;
  let provider: LocalFsProvider;
  let mount: MountProvider;
  let authorized: string[];
  const local = (p: string) => ({ kind: "local-file" as const, path: p });
  const linkDirectory = (target: string, link: string) => fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

  beforeEach(() => {
    fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hana-path-identity-")));
    longRoot = path.join(fixture, "Runner Long Identity");
    fs.mkdirSync(longRoot);
    if (process.platform === "win32") {
      shortRoot = windowsShortPath(longRoot);
      expect(shortRoot).toMatch(/~\d/);
      expect(shortRoot.toLowerCase()).not.toBe(longRoot.toLowerCase());
    } else {
      shortRoot = path.join(fixture, "RUNNER~1");
      linkDirectory(longRoot, shortRoot);
      const ordinary = fs.realpathSync;
      const native = fs.realpathSync.native;
      const spy = vi.spyOn(fs, "realpathSync").mockImplementation((...args: Parameters<typeof fs.realpathSync>) => {
        const resolved = ordinary(...args);
        if (typeof resolved !== "string") return resolved;
        const relative = path.relative(longRoot, resolved);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
          ? path.join(shortRoot, relative) : resolved;
      });
      Object.assign(spy, { native });
    }
    expect(fs.realpathSync.native(shortRoot)).toBe(longRoot);
    expect(fs.realpathSync(shortRoot)).not.toBe(fs.realpathSync.native(shortRoot));
    workspace = path.join(shortRoot, "Workspace");
    workspaceLong = path.join(longRoot, "Workspace");
    outside = path.join(shortRoot, "Outside");
    hanakoHome = path.join(shortRoot, "HanaHome");
    agentDir = path.join(hanakoHome, "agents", "fixture");
    for (const dir of [workspace, outside, agentDir]) fs.mkdirSync(dir, { recursive: true });
    source = path.join(workspace, "Source.txt");
    fs.writeFileSync(source, "synthetic identity payload");
    sessionPath = path.join(agentDir, "sessions", "fixture.jsonl");
    fs.mkdirSync(path.dirname(sessionPath));
    fs.writeFileSync(sessionPath, "{}\n");
    authorized = [];
    guard = new PathGuard(deriveSandboxPolicy({ hanakoHome, agentDir, workspace, mode: "standard" }));
    provider = new LocalFsProvider({ cwd: workspace, guard: new ResourceAccessPolicy({
      cwd: workspace, workspace, hanakoHome, agentDir,
      getAuthorizedFolders: () => authorized, getSandboxEnabled: () => true,
    }) });
    mount = new MountProvider({ hanakoHome, studioId: "fixture", localFsProviderFactory: (options) => new LocalFsProvider(options) });
    vi.spyOn(mount, "mountForRef").mockReturnValue({ rootLocator: { path: workspace }, sourceKind: "storage", provider: "local_fs", capabilities: ["read", "write"] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
  });

  it("authorizes missing descendants through short, long and Windows case aliases", () => {
    const spellings = [workspace, workspaceLong];
    if (process.platform === "win32") spellings.push(workspace.toUpperCase(), workspaceLong.toLowerCase());
    for (const root of spellings) {
      const target = path.join(root, "New", "Deep", "MixedCase.txt");
      expect(guard.check(target, "write")).toEqual({
        allowed: true, canonicalPath: path.join(workspaceLong, "New", "Deep", "MixedCase.txt"),
      });
    }
    expect(guard.check(path.join(shortRoot, "Workspace-sibling", "New.txt"), "write").allowed).toBe(false);
  });

  it("allows a newly authorized missing root and observes revocation without rebuilding the provider", async () => {
    const newRoot = path.join(shortRoot, "NewGrant", "Nested");
    const target = path.join(newRoot, "New", "MixedCase.txt");
    await expect(provider.write(local(target), "denied")).rejects.toMatchObject({ code: "resource_access_denied" });
    authorized = [path.join(longRoot, "NewGrant", "Nested")];
    await provider.write(local(target), "authorized");
    expect(fs.readFileSync(target, "utf8")).toBe("authorized");
    authorized = [];
    await expect(provider.write(local(target), "revoked")).rejects.toMatchObject({ code: "resource_access_denied" });
    expect(fs.readFileSync(target, "utf8")).toBe("authorized");
  });

  it("copies and persists a SessionFile through live grants, retaining path spelling and ownership", async () => {
    const registry = new SessionFileRegistry();
    const sessionId = "sess_identity_fixture";
    const original = registry.registerFile({ sessionId, sessionPath, filePath: source });
    const tool = createFileTool({
      getCwd: () => workspace, getSessionPath: () => sessionPath,
      getAuthorizedFolders: () => authorized,
      resolveSessionFile: (id, options) => registry.get(id, options),
      registerSessionFile: (options) => registry.registerFile(options),
    });
    const target = path.join(outside, "New", "Deep", "MixedCase.txt");
    const params = { action: "copy", fileId: original.id, sessionId, targetPath: target };
    expect((await tool.execute("denied", params)).details).toEqual({});
    expect(fs.existsSync(target)).toBe(false);
    authorized = [path.join(longRoot, "Outside")];
    const copied = await tool.execute("allowed", params);
    expect(copied.details).toMatchObject({ filePath: target, sessionFile: { sessionId, storageKind: "external", operations: ["copied"] } });
    expect(fs.readFileSync(target, "utf8")).toBe("synthetic identity payload");
    const fileId = (copied.details as { sessionFile: { id: string } }).sessionFile.id;
    const reloaded = new SessionFileRegistry().get(fileId, { sessionId, sessionPath });
    expect(reloaded).toMatchObject({ sessionId, filePath: target, realPath: fs.realpathSync.native(target), storageKind: "external", operations: ["copied"] });
    expect(new SessionFileRegistry().get(fileId, { sessionId: "unrelated_session", sessionPath })).toBeNull();
    authorized = [];
    expect((await tool.execute("revoked", { ...params, targetPath: path.join(outside, "Revoked.txt") })).details).toEqual({});
    expect(fs.existsSync(path.join(outside, "Revoked.txt"))).toBe(false);
  });

  it("canonicalizes a missing file-ref grant from its existing native ancestor", async () => {
    const newRoot = path.join(shortRoot, "NewGrant", "Nested");
    const target = path.join(longRoot, "NewGrant", "Nested", "Deep", "MixedCase.txt");
    await copyFileRefToPath({ from: { type: "path", path: source }, sourceAllowedRoots: [workspaceLong], targetPath: target, allowedRoots: [newRoot] });
    expect(fs.readFileSync(target, "utf8")).toBe("synthetic identity payload");
  });

  const entrypoints = ["provider", "resource-io", "file-ref", "mount"] as const;
  function copy(entrypoint: typeof entrypoints[number], target: string) {
    if (entrypoint === "file-ref") return copyFileRefToPath({ from: { type: "path", path: source }, sourceAllowedRoots: [workspaceLong], targetPath: target, allowedRoots: [workspaceLong], conflictPolicy: "overwrite" });
    if (entrypoint === "resource-io") return new ResourceIO({ providers: { local_fs: provider } }).copy(local(source), local(target));
    if (entrypoint === "mount") return mount.copy({ kind: "mount", mountId: "fixture", path: "Source.txt" }, { kind: "mount", mountId: "fixture", path: path.relative(workspace, target) });
    return provider.copy(local(source), local(target));
  }

  it.each(entrypoints)("%s creates nested destinations and follows authorized directory links", async (entrypoint) => {
    const nested = path.join(workspace, "New", "Deep", "MixedCase.txt");
    await copy(entrypoint, nested);
    expect(fs.readFileSync(nested, "utf8")).toBe("synthetic identity payload");
    linkDirectory(path.join(workspace, "New"), path.join(workspace, "Alias"));
    const linked = path.join(workspace, "Alias", "Another", "MixedCase.txt");
    await copy(entrypoint, linked);
    expect(fs.readFileSync(linked, "utf8")).toBe("synthetic identity payload");
  });

  it.each(entrypoints)("%s rejects a dangling junction leaf and parent before creating anything outside", async (entrypoint) => {
    const missing = path.join(outside, "Missing");
    const link = path.join(workspace, "Dangling");
    linkDirectory(missing, link);
    for (const target of [link, path.join(link, "New", "Target.txt")]) {
      expect(guard.check(target, "write").allowed).toBe(false);
      await expect(copy(entrypoint, target)).rejects.toThrow();
      expect(fs.existsSync(missing)).toBe(false);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    }
  });

  it.each(entrypoints)("%s rejects relative/chained dangling file links and preserves valid file links", async (entrypoint) => {
    const missing = path.join(outside, "Missing.txt");
    const leaf = path.join(workspace, "Dangling.txt");
    const chain = path.join(workspace, "Chain.txt");
    fs.symlinkSync(path.relative(workspace, missing), leaf, "file");
    fs.symlinkSync("Dangling.txt", chain, "file");
    for (const target of [leaf, chain]) {
      expect(guard.check(target, "write").allowed).toBe(false);
      await expect(copy(entrypoint, target)).rejects.toThrow();
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    }
    expect(fs.existsSync(missing)).toBe(false);
    const existing = path.join(workspace, "Existing.txt");
    const valid = path.join(workspace, "Valid.txt");
    fs.writeFileSync(existing, "old");
    fs.symlinkSync("Existing.txt", valid, "file");
    await copy(entrypoint, valid);
    expect(fs.readFileSync(existing, "utf8")).toBe("synthetic identity payload");
    expect(fs.lstatSync(valid).isSymbolicLink()).toBe(true);
  });

  it("allows dangling-leaf metadata and deletion without authorizing its missing target", async () => {
    const missing = path.join(outside, "Missing.txt");
    const leaf = path.join(workspace, "Dangling.txt");
    fs.symlinkSync(missing, leaf, "file");
    expect(guard.check(leaf, "write").allowed).toBe(false);
    expect(guard.check(path.join(leaf, "Child.txt"), "write").allowed).toBe(false);
    expect(guard.check(leaf, "delete")).toEqual({ allowed: true, canonicalPath: path.join(workspaceLong, "Dangling.txt") });
    expect(await provider.stat(local(leaf))).toMatchObject({ exists: false });
    await provider.delete(local(leaf));
    expect(() => fs.lstatSync(leaf)).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it.each(entrypoints)("%s rejects existing out-of-root junctions and preserves outside data", async (entrypoint) => {
    const external = path.join(outside, "Target.txt");
    fs.writeFileSync(external, "unchanged");
    linkDirectory(outside, path.join(workspace, "Escape"));
    for (const name of ["Target.txt", "New/Target.txt"]) {
      await expect(copy(entrypoint, path.join(workspace, "Escape", name))).rejects.toThrow();
    }
    expect(fs.readFileSync(external, "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(outside, "New"))).toBe(false);
  });

  it("retains source authorization and checks the conflict-selected dangling destination", async () => {
    const externalSource = path.join(outside, "Source.txt");
    fs.writeFileSync(externalSource, "private synthetic source");
    linkDirectory(outside, path.join(workspace, "Escape"));
    await expect(copyFileRefToPath({ from: { type: "path", path: path.join(workspace, "Escape", "Source.txt") }, sourceAllowedRoots: [workspace], allowedRoots: [workspace], targetPath: path.join(workspace, "Copy.txt") })).rejects.toThrow(/copy source is outside allowed roots/);
    const target = path.join(workspace, "Conflict.txt");
    fs.writeFileSync(target, "original");
    const selected = path.join(workspace, "Conflict-2.txt");
    const missing = path.join(outside, "Missing");
    linkDirectory(missing, selected);
    await expect(copyFileRefToPath({ from: { type: "path", path: source }, sourceAllowedRoots: [workspace], targetPath: target, allowedRoots: [workspace], conflictPolicy: "rename" })).rejects.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(fs.lstatSync(selected).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("keeps sensitive and read-only paths ahead of workspace grants, including linked targets", async () => {
    const sensitiveTarget = path.join(workspace, "BrowserFixture");
    const readonlyTarget = path.join(workspace, "SessionFixture");
    fs.mkdirSync(sensitiveTarget);
    fs.mkdirSync(readonlyTarget);
    linkDirectory(sensitiveTarget, path.join(hanakoHome, "browser-data"));
    linkDirectory(readonlyTarget, path.join(hanakoHome, "session-files"));
    const auth = path.join(hanakoHome, "auth.json");
    fs.writeFileSync(auth, "synthetic credentials");
    expect(guard.check(auth, "read").allowed).toBe(false);
    expect(guard.check(path.join(sensitiveTarget, "New.txt"), "read").allowed).toBe(false);
    expect(guard.check(path.join(readonlyTarget, "New.txt"), "write").allowed).toBe(false);
    const config = path.join(agentDir, "config.yaml");
    fs.writeFileSync(config, "synthetic: original\n");
    for (const sandboxEnabled of [true, false]) {
      const managedProvider = new LocalFsProvider({ cwd: workspace, guard: new ResourceAccessPolicy({ cwd: workspace, workspace, hanakoHome, agentDir, getAuthorizedFolders: () => [hanakoHome], getSandboxEnabled: () => sandboxEnabled }) });
      await expect(managedProvider.write(local(config), "changed")).rejects.toMatchObject({ code: "resource_access_denied", reason: "managed_config_denied" });
    }
    expect(fs.readFileSync(config, "utf8")).toBe("synthetic: original\n");
  });

  it.each(["EACCES", "EPERM", "ELOOP", "ENOTDIR"])("fails closed on native %s even if ordinary realpath would succeed", async (code) => {
    const native = fs.realpathSync.native;
    const target = path.join(workspace, "Denied.txt");
    vi.spyOn(fs.realpathSync, "native").mockImplementation((...args: Parameters<typeof fs.realpathSync.native>) => {
      if (String(args[0]) === workspace || String(args[0]) === workspaceLong) throw Object.assign(new Error(`synthetic ${code}`), { code });
      return native(...args);
    });
    expect(guard.check(target, "write").allowed).toBe(false);
    await expect(copyFileRefToPath({ from: { type: "path", path: source }, targetPath: target, allowedRoots: [workspace] })).rejects.toMatchObject({ code });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("preserves the provider path representation used by managed config checks", () => {
    const target = path.join(workspace, "New", "MixedCase.txt");
    expect(resolveFilesystemPathForCreationSync(target)).toBe(target);
  });
});
