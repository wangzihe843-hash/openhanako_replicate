import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeFileTrace } from "@vercel/nft";
import { applyPlatformPackageTrim, pruneServerNodeModulesViaNft } from "../scripts/build-server-phases.mjs";
import { traceNftRoot } from "../scripts/compute-cli-closure.mjs";

vi.mock("@vercel/nft", () => ({ nodeFileTrace: vi.fn() }));

const fixtureParent = path.resolve(".cache");
const fixtures: string[] = [];

function createFixture(): string {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent, "hana-nft-boundary-")));
  fixtures.push(fixture);
  return fixture;
}

function writeFixture(root: string, name: string, contents: string) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

async function useRealTrace() {
  const actual = await vi.importActual<typeof import("@vercel/nft")>("@vercel/nft");
  vi.mocked(nodeFileTrace).mockImplementation(async (entries, options) => {
    const result = await actual.nodeFileTrace(entries, options);
    expect([...result.warnings]).toEqual([]);
    return result;
  });
}

function writeConditionalPackage(root: string) {
  writeFixture(root, "node_modules/conditional-fixture/package.json", JSON.stringify({
    name: "conditional-fixture", version: "1.0.0",
    // Import comes first, as it does in Underscore's real conditional exports.
    exports: { node: { import: "./import.mjs", require: "./require.cjs" } },
  }));
  writeFixture(root, "node_modules/conditional-fixture/import.mjs", "export const value = 'esm';\n");
  writeFixture(root, "node_modules/conditional-fixture/require.cjs", "exports.value = 'cjs';\n");
  writeFixture(root, "node_modules/conditional-fixture/unused.js", "throw new Error('unused');\n");
}

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
  it.each([
    ["require", "const {value} = require('conditional-fixture'); console.log(value);", "cjs\n", ["require.cjs"]],
    ["import", "import {value} from 'conditional-fixture'; console.log(value);", "esm\n", ["import.mjs"]],
    ["mixed", "console.log(require('conditional-fixture').value); import('conditional-fixture').then(({value}) => console.log(value));", "cjs\nesm\n", ["require.cjs", "import.mjs"]],
  ])("executes %s conditional exports after real NFT pruning", async (mode, source, output, kept) => {
    const outDir = createFixture();
    writeConditionalPackage(outDir);
    const entry = mode === "import" ? "entry.mjs" : "entry.cjs";
    writeFixture(outDir, entry, source as string);
    await useRealTrace();
    await pruneServerNodeModulesViaNft({
      outDir, nftRoots: [entry], externalPackageNames: [],
      env: { HANA_BUILD_SERVER_NFT_TRACE: "1" }, runWithTargetNode: () => {}, log: () => {},
    });
    expect(execFileSync(process.execPath, [entry], { cwd: outDir, encoding: "utf-8" })).toBe(output);
    for (const file of ["require.cjs", "import.mjs", "unused.js"]) {
      expect(fs.existsSync(path.join(outDir, "node_modules/conditional-fixture", file))).toBe(kept.includes(file));
    }
  });

  it("executes a CLI census containing both require and import branches after pruning to its file list", async () => {
    const outDir = createFixture();
    writeConditionalPackage(outDir);
    writeFixture(outDir, "node_modules/require-parent/package.json", JSON.stringify({ name: "require-parent", main: "index.cjs" }));
    writeFixture(outDir, "node_modules/require-parent/index.cjs", "module.exports = require('conditional-fixture').value;\n");
    writeFixture(outDir, "entry.mjs", "import cjs from 'require-parent'; import {value} from 'conditional-fixture'; console.log(cjs, value);\n");
    await useRealTrace();
    const { files, warnings } = await traceNftRoot({ rootDir: outDir, root: { id: "fixture", path: "entry.mjs" } });
    expect(warnings).toEqual([]);
    const kept = new Set(files);
    const nmDir = path.join(outDir, "node_modules");
    for (const file of fs.readdirSync(nmDir, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const full = path.join(file.parentPath, file.name);
      if (!kept.has(path.relative(outDir, full).split(path.sep).join("/"))) fs.unlinkSync(full);
    }
    expect(execFileSync(process.execPath, ["entry.mjs"], { cwd: outDir, encoding: "utf-8" })).toBe("cjs esm\n");
    expect(fs.existsSync(path.join(nmDir, "conditional-fixture/unused.js"))).toBe(false);
  });

  it("preserves notices only for reached packages through NFT and platform trimming", async () => {
    const outDir = createFixture();
    writeConditionalPackage(outDir);
    writeFixture(outDir, "entry.cjs", "require('conditional-fixture');\n");
    writeFixture(outDir, "node_modules/conditional-fixture/require.cjs", "module.exports = require('@scope/notice-peer');\n");
    const nested = "conditional-fixture/node_modules/@scope/notice-peer";
    writeFixture(outDir, `node_modules/${nested}/package.json`, JSON.stringify({ name: "@scope/notice-peer", main: "index.cjs" }));
    writeFixture(outDir, `node_modules/${nested}/index.cjs`, "module.exports = {};\n");
    const notices = ["LICENSE", "LiCeNcE.md", "COPYING.txt", "NOTICE.markdown", "legal/LICENSE-MIT"];
    for (const prefix of ["conditional-fixture", nested, "unused-fixture", "conditional-fixture/node_modules/unused-nested"]) {
      for (const name of notices) writeFixture(outDir, `node_modules/${prefix}/${name}`, `notice: ${name}`);
      writeFixture(outDir, `node_modules/${prefix}/README.md`, "unused documentation");
    }
    await useRealTrace();
    await pruneServerNodeModulesViaNft({
      outDir, nftRoots: ["entry.cjs"], externalPackageNames: [],
      env: { HANA_BUILD_SERVER_NFT_TRACE: "1" }, runWithTargetNode: () => {}, log: () => {},
    });
    applyPlatformPackageTrim({ outDir, platform: process.platform, arch: process.arch, log: () => {} });
    for (const prefix of ["conditional-fixture", nested]) {
      for (const name of notices) {
        expect(fs.readFileSync(path.join(outDir, "node_modules", prefix, name), "utf-8")).toBe(`notice: ${name}`);
      }
    }
    for (const name of ["unused-fixture", "conditional-fixture/node_modules/unused-nested", "conditional-fixture/README.md", "conditional-fixture/unused.js"]) {
      expect(fs.existsSync(path.join(outDir, "node_modules", name))).toBe(false);
    }
  });

  it("parses a real DOCX with the packaged Mammoth smoke and fails if its CJS dependency disappears", async () => {
    const outDir = createFixture();
    const repoRoot = fs.realpathSync(path.resolve("."));
    const pending = [createRequire(path.join(repoRoot, "package.json")).resolve("mammoth/package.json")];
    const copied = new Set<string>();
    while (pending.length) {
      const manifestPath = pending.pop()!;
      if (copied.has(manifestPath)) continue;
      copied.add(manifestPath);
      const sourceDir = path.dirname(manifestPath);
      fs.cpSync(sourceDir, path.join(outDir, path.relative(repoRoot, sourceDir)), { recursive: true });
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      const require = createRequire(manifestPath);
      for (const name of Object.keys(manifest.dependencies || {})) pending.push(require.resolve(`${name}/package.json`));
    }
    writeFixture(outDir, "entry.mjs", "import mammoth from 'mammoth'; console.log(typeof mammoth.extractRawText);\n");
    await useRealTrace();
    const smokeOutputs: string[] = [];
    const runWithTargetNode = (script: string) => {
      smokeOutputs.push(execFileSync(process.execPath, [script], { cwd: outDir, encoding: "utf-8", stdio: "pipe" }));
    };
    await pruneServerNodeModulesViaNft({
      outDir, nftRoots: ["entry.mjs"], externalPackageNames: ["mammoth"],
      env: { HANA_BUILD_SERVER_NFT_TRACE: "1" }, runWithTargetNode, log: () => {},
    });
    expect(smokeOutputs).toEqual([expect.stringContaining("mammoth DOCX runtime smoke passed")]);
    expect(fs.existsSync(path.join(outDir, ".mammoth-smoke.mjs"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "node_modules/underscore/underscore-node.cjs"))).toBe(true);
    applyPlatformPackageTrim({ outDir, platform: process.platform, arch: process.arch, log: () => {} });
    await pruneServerNodeModulesViaNft({
      outDir, nftRoots: ["entry.mjs"], externalPackageNames: ["mammoth"],
      env: { HANA_BUILD_SERVER_NFT_TRACE: "0" }, runWithTargetNode, log: () => {},
    });
    fs.unlinkSync(path.join(outDir, "node_modules/underscore/underscore-node.cjs"));
    await expect(pruneServerNodeModulesViaNft({
      outDir, nftRoots: ["entry.mjs"], externalPackageNames: ["mammoth"],
      env: { HANA_BUILD_SERVER_NFT_TRACE: "0" }, runWithTargetNode, log: () => {},
    })).rejects.toThrow(/underscore-node.cjs/);
    expect(fs.existsSync(path.join(outDir, ".mammoth-smoke.mjs"))).toBe(false);
  });

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
