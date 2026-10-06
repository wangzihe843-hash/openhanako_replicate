import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFERRED_BRIDGE_SDK_PACKAGES,
  resolveDeferredBridgeSdkEntrypoints,
} from "../scripts/build-server-deps.mjs";
import { pruneServerNodeModulesViaNft } from "../scripts/build-server-phases.mjs";

const fixtures: string[] = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-deferred-sdk-"));
  fixtures.push(root);
  const outDir = path.join(root, "runtime");
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
  return { root, outDir };
}

function writePackage(root: string, name: string, source: string) {
  const dir = path.join(root, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.cjs" }));
  fs.writeFileSync(path.join(dir, "index.cjs"), source);
}

afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("deferred bridge SDK distribution", () => {
  it.each(DEFERRED_BRIDGE_SDK_PACKAGES)("keeps %s transitives when bundled createRequire is renamed", async (sdk) => {
    const { outDir } = makeFixture();
    writePackage(outDir, sdk, 'module.exports = require("bridge-transitive-fixture");');
    writePackage(outDir, "bridge-transitive-fixture", 'module.exports = "bridge-sdk-ok";');
    writePackage(outDir, "unrelated-fixture", 'module.exports = "unused";');
    fs.writeFileSync(path.join(outDir, "bundle.mjs"), [
      'import { createRequire as renamedCreateRequire } from "node:module";',
      'const renamedRequire = renamedCreateRequire(import.meta.url);',
      `export function load() { return renamedRequire(${JSON.stringify(sdk)}); }`,
    ].join("\n"));
    fs.writeFileSync(path.join(outDir, "check.mjs"), [
      'import assert from "node:assert/strict";',
      'import { load } from "./bundle.mjs";',
      'assert.equal(load(), "bridge-sdk-ok");',
    ].join("\n"));

    await pruneServerNodeModulesViaNft({
      outDir,
      env: { HANA_BUILD_SERVER_NFT_TRACE: "1" },
      nftRoots: ["bundle.mjs"],
      externalPackageNames: [sdk],
      runWithTargetNode: () => {},
      log: () => {},
    });

    expect(fs.existsSync(path.join(outDir, "node_modules/bridge-transitive-fixture/index.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "node_modules/unrelated-fixture/index.cjs"))).toBe(false);
    expect(() => execFileSync(process.execPath, ["check.mjs"], { cwd: outDir, windowsHide: true, stdio: "pipe" }))
      .not.toThrow();
  });

  it("rejects a SDK resolved from an ancestor installation", () => {
    const { root, outDir } = makeFixture();
    const sdk = DEFERRED_BRIDGE_SDK_PACKAGES[0];
    writePackage(root, sdk, "module.exports = {};");
    expect(() => resolveDeferredBridgeSdkEntrypoints(outDir, [sdk])).toThrow(/outside its runtime tree/);
  });

  it("fails a forced trace when a declared SDK entrypoint is missing", async () => {
    const { outDir } = makeFixture();
    fs.writeFileSync(path.join(outDir, "bundle.mjs"), "export {};\n");
    await expect(pruneServerNodeModulesViaNft({
      outDir,
      env: { HANA_BUILD_SERVER_NFT_TRACE: "1" },
      nftRoots: ["bundle.mjs"],
      externalPackageNames: [DEFERRED_BRIDGE_SDK_PACKAGES[0]],
      runWithTargetNode: () => {},
      log: () => {},
    })).rejects.toThrow(/Cannot find module/);
  });
});
