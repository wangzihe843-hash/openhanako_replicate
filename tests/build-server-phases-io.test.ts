import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeFileTrace } from "@vercel/nft";
import { pruneServerNodeModulesViaNft } from "../scripts/build-server-phases.mjs";

vi.mock("@vercel/nft", () => ({ nodeFileTrace: vi.fn() }));
const fixtureParent = path.resolve(".cache");
const fixtures: string[] = [];

function makeFixture(packageName?: string) {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, "hana-build-phase-io-"));
  fixtures.push(root);
  if (packageName) {
    const packageDir = path.join(root, "node_modules", packageName);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ main: "index.cjs" }));
    fs.writeFileSync(path.join(packageDir, "index.cjs"), "module.exports = {};\n");
  }
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const fixture of fixtures.splice(0)) {
    const resolved = path.resolve(fixture);
    if (path.dirname(resolved) !== fixtureParent || !path.basename(resolved).startsWith("hana-build-phase-io-")
      || fs.lstatSync(resolved).isSymbolicLink()) throw new Error("Refused non-owned fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("shared server build I/O safeguards", () => {
  it.each([
    ["better-sqlite3", ".better-sqlite3-smoke.mjs"],
    ["@node-rs/jieba", ".jieba-smoke.mjs"],
    ["@firecrawl/anydoc", ".anydoc-smoke.mjs"],
  ])("retries temporary write exhaustion before running %s native smoke", async (packageName, scriptName) => {
    const outDir = makeFixture(packageName);
    const originalWrite = fs.writeFileSync.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, contents, options) => {
      if (String(file) === path.join(outDir, scriptName) && ++attempts <= 2) {
        throw Object.assign(new Error("fixture temporary handle exhaustion"), { code: attempts === 1 ? "EMFILE" : "ENFILE" });
      }
      return originalWrite(file, contents, options);
    });
    const runWithTargetNode = vi.fn((script) => {
      expect(script).toBe(scriptName);
      expect(fs.readFileSync(path.join(outDir, script), "utf-8").length).toBeGreaterThan(0);
    });
    vi.useFakeTimers();
    const build = pruneServerNodeModulesViaNft({
      outDir, nftRoots: [], externalPackageNames: [packageName], runWithTargetNode,
      env: { HANA_BUILD_SERVER_NFT_TRACE: "0" }, log: () => {},
    });
    await vi.runAllTimersAsync();
    await build;
    expect(attempts).toBe(3);
    expect(runWithTargetNode).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(outDir, scriptName))).toBe(false);
  });

  it("preserves dependencies when tracing cannot read a source file", async () => {
    const outDir = makeFixture("unlisted-fixture");
    const marker = path.join(outDir, "node_modules", "unlisted-fixture", "index.cjs");
    const source = path.join(outDir, "entry.js");
    fs.writeFileSync(source, "export {};\n");
    const originalRead = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation((file, options) => {
      if (String(file) === source) return Promise.reject(Object.assign(new Error("fixture denied"), { code: "EACCES" }));
      return originalRead(file, options);
    });
    vi.mocked(nodeFileTrace).mockImplementation(async (_entries, options) => {
      await options?.readFile?.(source);
      return { fileList: new Set(), esmFileList: new Set(), reasons: new Map(), warnings: new Set() };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pruneServerNodeModulesViaNft({
      outDir, nftRoots: ["entry.js"], externalPackageNames: [], runWithTargetNode: () => {},
      platform: "win32", env: { HANA_BUILD_SERVER_NFT_TRACE: "1" }, log: () => {},
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fixture denied"));
    expect(fs.existsSync(marker)).toBe(true);
    expect(vi.mocked(nodeFileTrace).mock.calls[0][1]?.fileIOConcurrency).toBe(64);
  });
});
