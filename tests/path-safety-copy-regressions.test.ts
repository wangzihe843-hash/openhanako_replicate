import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsProvider } from "../lib/resource-io/providers/local-fs-provider.ts";
import { MountProvider } from "../lib/resource-io/providers/mount-provider.ts";
import { ResourceAccessPolicy } from "../lib/resource-io/resource-access-policy.ts";
import { ResourceIO } from "../lib/resource-io/resource-io.ts";
import { PathGuard } from "../lib/sandbox/path-guard.ts";
import { deriveSandboxPolicy } from "../lib/sandbox/policy.ts";
import { copyFileRefToPath } from "../lib/file-ref/resource-io.ts";

vi.mock("../lib/i18n.ts", () => ({ t: (key: string) => key }));
vi.mock("../lib/debug-log.ts", () => ({ createModuleLogger: () => ({ warn() {}, error() {}, info() {} }) }));

describe.runIf(process.platform !== "win32")("file-copy path confinement", () => {
  let root: string;
  let workspace: string;
  let outside: string;
  let source: string;
  let policy: ResourceAccessPolicy;
  let provider: LocalFsProvider;
  let guard: PathGuard;
  let mount: MountProvider;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hana-copy-regression-")));
    workspace = path.join(root, "workspace");
    outside = path.join(root, "outside");
    const hanakoHome = path.join(root, "synthetic-home");
    const agentDir = path.join(hanakoHome, "agents", "fixture");
    for (const dir of [workspace, outside, agentDir]) fs.mkdirSync(dir, { recursive: true });
    source = path.join(workspace, "source.txt");
    fs.writeFileSync(source, "synthetic copy payload");
    policy = new ResourceAccessPolicy({ cwd: workspace, workspace, agentDir, hanakoHome, getSandboxEnabled: () => true });
    guard = new PathGuard(deriveSandboxPolicy({ agentDir, hanakoHome, workspace, mode: "standard" }));
    provider = new LocalFsProvider({ cwd: workspace, guard: policy });
    mount = new MountProvider({ hanakoHome, studioId: "fixture", localFsProviderFactory: (options) => new LocalFsProvider(options) });
    // Isolate registry lookup only; mount resolution, guard and copy remain real.
    vi.spyOn(mount, "mountForRef").mockReturnValue({ rootLocator: { path: workspace }, sourceKind: "storage", provider: "local_fs", capabilities: ["read", "write"] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const local = (p: string) => ({ kind: "local-file" as const, path: p });
  const mounted = (p: string) => ({ kind: "mount" as const, mountId: "fixture", path: path.relative(workspace, p) });
  const entrypoints = ["provider", "resource-io", "file-ref", "mount"] as const;
  function copy(entrypoint: typeof entrypoints[number], target: string) {
    if (entrypoint === "file-ref") return copyFileRefToPath({ from: { type: "path", path: source }, targetPath: target, conflictPolicy: "overwrite", cwd: workspace, allowedRoots: [workspace], sourceAllowedRoots: [workspace] });
    if (entrypoint === "mount") return mount.copy(mounted(source), mounted(target));
    if (entrypoint === "resource-io") return new ResourceIO({ providers: { local_fs: provider } }).copy(local(source), local(target));
    return provider.copy(local(source), local(target));
  }

  it.each(entrypoints)("%s rejects a dangling destination before creating its external target", async (entrypoint) => {
    const external = path.join(outside, "missing.txt");
    const link = path.join(workspace, "destination.txt");
    fs.symlinkSync(external, link);
    await expect(copy(entrypoint, link)).rejects.toThrow();
    expect(fs.existsSync(external)).toBe(false);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("rejects relative/chained dangling links and direct guard checks fail closed", async () => {
    const external = path.join(outside, "missing.txt");
    const link = path.join(workspace, "destination.txt");
    const chain = path.join(workspace, "chain.txt");
    fs.symlinkSync(path.relative(workspace, external), link);
    fs.symlinkSync("destination.txt", chain);
    expect(guard.check(link, "write").allowed).toBe(false);
    expect(policy.check(chain, "write").allowed).toBe(false);
    await expect(provider.copy(local(source), local(chain))).rejects.toThrow();
    expect(fs.existsSync(external)).toBe(false);
  });

  it.each(entrypoints)("%s rejects dangling parent components", async (entrypoint) => {
    const external = path.join(outside, "missing-directory");
    fs.symlinkSync(external, path.join(workspace, "parent"));
    expect(guard.check(path.join(workspace, "parent", "deep", "target.txt"), "write").allowed).toBe(false);
    await expect(copy(entrypoint, path.join(workspace, "parent", "deep", "target.txt"))).rejects.toThrow();
    expect(fs.existsSync(external)).toBe(false);
  });

  it.each(entrypoints)("%s denies an existing external parent link without changing external data", async (entrypoint) => {
    const external = path.join(outside, "target.txt");
    fs.writeFileSync(external, "unchanged");
    fs.symlinkSync(outside, path.join(workspace, "parent"));
    await expect(copy(entrypoint, path.join(workspace, "parent", "target.txt"))).rejects.toThrow();
    expect(fs.readFileSync(external, "utf8")).toBe("unchanged");
  });

  it("denies direct external targets through actual policy and file-ref authorization", async () => {
    const external = path.join(outside, "target.txt");
    expect(policy.check(external, "write").allowed).toBe(false);
    await expect(copy("provider", external)).rejects.toMatchObject({ code: "resource_access_denied" });
    await expect(copy("file-ref", external)).rejects.toThrow(/outside allowed roots/);
    expect(fs.existsSync(external)).toBe(false);
  });

  it.each(entrypoints)("%s preserves creation, overwrite and valid in-root file/parent links", async (entrypoint) => {
    const ordinary = path.join(workspace, "new", "deep", "target.txt");
    await copy(entrypoint, ordinary);
    expect(fs.readFileSync(ordinary, "utf8")).toBe("synthetic copy payload");
    fs.writeFileSync(ordinary, "old");
    await copy(entrypoint, ordinary);
    fs.symlinkSync(ordinary, path.join(workspace, "valid-link.txt"));
    await copy(entrypoint, path.join(workspace, "valid-link.txt"));
    fs.symlinkSync(path.join(workspace, "new"), path.join(workspace, "valid-parent"));
    await copy(entrypoint, path.join(workspace, "valid-parent", "another", "target.txt"));
    expect(fs.readFileSync(ordinary, "utf8")).toBe("synthetic copy payload");
    expect(fs.lstatSync(path.join(workspace, "valid-link.txt")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "new", "another", "target.txt"), "utf8")).toBe("synthetic copy payload");
  });

  it("preserves file-ref fail and rename conflict policies", async () => {
    const options = { from: { type: "path", path: source }, targetPath: source, cwd: workspace, allowedRoots: [workspace] };
    await expect(copyFileRefToPath(options)).rejects.toThrow(/already exists/);
    const renamed = await copyFileRefToPath({ ...options, conflictPolicy: "rename" });
    expect(renamed.filePath).toBe(path.join(workspace, "source-2.txt"));
    expect(fs.readFileSync(renamed.filePath, "utf8")).toBe("synthetic copy payload");
  });

  it("does not turn permission or symlink-cycle errors into writable missing paths", async () => {
    const denied = path.join(workspace, "unreadable", "target.txt");
    const realpath = fs.realpathSync;
    vi.spyOn(fs, "realpathSync").mockImplementation((...[p, ...args]: Parameters<typeof fs.realpathSync>) => {
      if (String(p) === denied) throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
      return realpath(p, ...args);
    });
    await expect(copy("provider", denied)).rejects.toThrow(/synthetic EACCES/);
    expect(fs.existsSync(path.dirname(denied))).toBe(false);
    fs.symlinkSync("cycle", path.join(workspace, "cycle"));
    await expect(copy("provider", path.join(workspace, "cycle"))).rejects.toThrow();
  });
});
