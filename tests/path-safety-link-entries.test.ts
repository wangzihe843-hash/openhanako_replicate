import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsProvider } from "../lib/resource-io/providers/local-fs-provider.ts";
import { MountProvider } from "../lib/resource-io/providers/mount-provider.ts";
import { ResourceAccessPolicy } from "../lib/resource-io/resource-access-policy.ts";

vi.mock("../lib/i18n.ts", () => ({ t: (key: string) => key }));

describe.runIf(process.platform !== "win32")("dangling link entry compatibility", () => {
  let root: string;
  let workspace: string;
  let outside: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hana-link-entry-")));
    workspace = path.join(root, "workspace");
    outside = path.join(root, "outside", "missing.txt");
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.dirname(outside));
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  for (const mode of ["unguarded", "sandbox-disabled", "sandbox-enabled", "mount"] as const) {
    function fixture() {
      const link = path.join(workspace, "dangling.txt");
      fs.symlinkSync(outside, link);
      const policy = new ResourceAccessPolicy({ cwd: workspace, workspace, agentDir: workspace, hanakoHome: path.join(root, "home"), getSandboxEnabled: () => mode === "sandbox-enabled" });
      if (mode !== "mount") return { link, provider: new LocalFsProvider({ cwd: workspace, ...(mode === "unguarded" ? {} : { guard: policy }) }), ref: { kind: "local-file" as const, path: link } };
      const provider = new MountProvider({ hanakoHome: path.join(root, "home"), studioId: "fixture", localFsProviderFactory: (options) => new LocalFsProvider(options) });
      vi.spyOn(provider, "mountForRef").mockReturnValue({ rootLocator: { path: workspace }, sourceKind: "storage", provider: "local_fs", capabilities: ["read", "write"] });
      return { link, provider, ref: { kind: "mount" as const, mountId: "fixture", path: "dangling.txt" } };
    }
    it(`${mode}: stat reports a missing target`, async () => {
      const { link, provider, ref } = fixture();
      expect(await provider.stat(ref)).toMatchObject({ exists: false });
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(outside)).toBe(false);
    });
    it(`${mode}: delete removes only the dangling entry`, async () => {
      const { link, provider, ref } = fixture();
      await provider.delete(ref);
      expect(() => fs.lstatSync(link)).toThrow();
      expect(fs.existsSync(outside)).toBe(false);
    });
    it(`${mode}: stat of a child of a regular file retains authorization`, async () => {
      const { provider, ref } = fixture();
      const file = path.join(workspace, "regular.txt");
      fs.writeFileSync(file, "synthetic file");
      const child = { ...ref, path: mode === "mount" ? "regular.txt/child.txt" : path.join(file, "child.txt") };
      if (mode === "sandbox-enabled") {
        // Standard PathGuard denied this invalid path before the security fix.
        await expect(provider.stat(child)).rejects.toMatchObject({ code: "resource_access_denied", status: 403 });
      } else {
        expect(await provider.stat(child)).toMatchObject({ exists: false });
      }
      await expect(provider.write(child, "must not write")).rejects.toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe("synthetic file");
    });
    for (const operation of ["rename", "move"] as const) {
      it(`${mode}: ${operation} reports a dangling destination as an existing entry`, async () => {
        const { link, provider, ref } = fixture();
        const source = path.join(workspace, "source.txt");
        fs.writeFileSync(source, "synthetic source");
        const from = { ...ref, path: mode === "mount" ? "source.txt" : source };
        await expect(provider[operation](from, ref)).rejects.toMatchObject({ code: "target_already_exists", status: 409 });
        expect(fs.readFileSync(source, "utf8")).toBe("synthetic source");
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(outside)).toBe(false);
      });
      it(`${mode}: ${operation} still rejects a dangling parent`, async () => {
        const { link, provider, ref } = fixture();
        const source = path.join(workspace, "source.txt");
        fs.writeFileSync(source, "synthetic source");
        const from = { ...ref, path: mode === "mount" ? "source.txt" : source };
        const target = { ...ref, path: mode === "mount" ? "dangling.txt/child.txt" : path.join(link, "child.txt") };
        await expect(provider[operation](from, target)).rejects.toThrow();
        expect(fs.readFileSync(source, "utf8")).toBe("synthetic source");
        expect(fs.existsSync(outside)).toBe(false);
      });
    }
  }

  it("stat does not treat permission errors as missing paths", async () => {
    const target = path.join(workspace, "target.txt");
    const realpath = fs.realpathSync;
    vi.spyOn(fs, "realpathSync").mockImplementation((p, options) => {
      if (String(p) === target) throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
      return realpath(p, options);
    });
    await expect(new LocalFsProvider({ cwd: workspace }).stat({ kind: "local-file", path: target }))
      .rejects.toMatchObject({ code: "EACCES" });
  });

  it("move to an unauthorized dangling entry still returns an authority denial", async () => {
    const source = path.join(workspace, "source.txt");
    const link = path.join(root, "outside", "dangling.txt");
    fs.writeFileSync(source, "synthetic source");
    fs.symlinkSync(outside, link);
    const policy = new ResourceAccessPolicy({ cwd: workspace, workspace, agentDir: workspace, hanakoHome: path.join(root, "home"), getSandboxEnabled: () => true });
    const provider = new LocalFsProvider({ cwd: workspace, guard: policy });
    await expect(provider.move({ kind: "local-file", path: source }, { kind: "local-file", path: link }))
      .rejects.toMatchObject({ code: "resource_access_denied", status: 403 });
    expect(fs.readFileSync(source, "utf8")).toBe("synthetic source");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
  });
});
