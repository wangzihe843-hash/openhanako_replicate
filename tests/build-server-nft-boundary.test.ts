import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeFileTrace } from "@vercel/nft";
import { pruneServerNodeModulesViaNft } from "../scripts/build-server-phases.mjs";

vi.mock("@vercel/nft", () => ({ nodeFileTrace: vi.fn() }));

const fixtureParent = path.resolve(".cache");
const fixtures: string[] = [];

function isOutside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
}

afterEach(() => {
  vi.resetAllMocks();
  for (const fixture of fixtures.splice(0)) {
    const resolved = path.resolve(fixture);
    if (path.dirname(resolved) !== fixtureParent
      || !path.basename(resolved).startsWith("hana-nft-boundary-")
      || fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error("Refused non-owned NFT fixture cleanup");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("packaged server NFT tracing boundary", () => {
  it("keeps packaged dependencies and assets while excluding same-volume and cross-volume external files", async () => {
    fs.mkdirSync(fixtureParent, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(fixtureParent, "hana-nft-boundary-"));
    fixtures.push(fixture);
    const outDir = path.join(fixture, "server");
    fs.mkdirSync(path.join(outDir, "bundle"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    for (const name of ["kept-fixture", "unused-fixture"]) {
      const packageDir = path.join(outDir, "node_modules", name);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
        name, version: "1.0.0", type: "module", exports: "./index.js",
      }));
      fs.writeFileSync(path.join(packageDir, "index.js"), "export const value = 'fixture';\n");
    }
    const insideAsset = path.join(outDir, "bundle", "inside.txt");
    fs.writeFileSync(insideAsset, "packaged asset");

    // These two external files exist only through the trace callbacks below.
    // No filesystem operation touches another volume or a user directory.
    const alternateRoot = process.platform === "win32"
      ? (path.parse(outDir).root.toUpperCase() === "C:\\" ? "D:\\" : "C:\\")
      : path.parse(outDir).root;
    const virtualExternal = path.join(alternateRoot, "hana-nft-virtual-external", "asset.txt");
    const virtualSibling = path.join(fixture, "same-volume-external.txt");
    const virtualFiles = new Set([virtualExternal, virtualSibling].map((item) => path.resolve(item)));
    fs.writeFileSync(path.join(outDir, "bundle", "index.js"), [
      'import "kept-fixture";',
      'import fs from "node:fs";',
      `fs.readFileSync(${JSON.stringify(insideAsset)});`,
      `fs.readFileSync(${JSON.stringify(virtualSibling)});`,
      `fs.readFileSync(${JSON.stringify(virtualExternal)});`,
    ].join("\n"));

    const actual = await vi.importActual<typeof import("@vercel/nft")>("@vercel/nft");
    let tracedFiles: string[] = [];
    const virtualLookups = new Set<string>();
    vi.mocked(nodeFileTrace).mockImplementation(async (entries, options) => {
      const result = await actual.nodeFileTrace(entries, {
        ...options,
        readFile: async (candidate) => {
          if (isOutside(outDir, candidate)) return null;
          if (options?.readFile) return options.readFile(candidate);
          try { return await fs.promises.readFile(candidate, "utf-8"); }
          catch { return null; }
        },
        stat: async (candidate) => {
          if (virtualFiles.has(path.resolve(candidate))) {
            virtualLookups.add(path.resolve(candidate));
            return { isFile: () => true, isDirectory: () => false } as fs.Stats;
          }
          if (isOutside(outDir, candidate)) return null;
          try { return await fs.promises.stat(candidate); }
          catch { return null; }
        },
        readlink: async (candidate) => {
          if (isOutside(outDir, candidate)) return null;
          try {
            const stat = await fs.promises.lstat(candidate);
            return stat.isSymbolicLink() ? await fs.promises.readlink(candidate) : null;
          } catch { return null; }
        },
      });
      tracedFiles = [...result.fileList];
      return result;
    });

    await pruneServerNodeModulesViaNft({
      outDir,
      env: { HANA_BUILD_SERVER_NFT_TRACE: "1" },
      nftRoots: ["bundle/index.js"],
      externalPackageNames: ["kept-fixture"],
      runWithTargetNode: () => {},
      log: () => {},
    });

    expect(virtualLookups).toEqual(virtualFiles);
    expect(tracedFiles).toContain(path.join("bundle", "inside.txt"));
    expect(tracedFiles).toContain(path.join("node_modules", "kept-fixture", "index.js"));
    expect(tracedFiles.filter((item) => isOutside(outDir, path.resolve(outDir, item)))).toEqual([]);
    expect(fs.readFileSync(insideAsset, "utf-8")).toBe("packaged asset");
    expect(fs.existsSync(path.join(outDir, "node_modules", "kept-fixture", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "node_modules", "unused-fixture", "index.js"))).toBe(false);
  });
});
