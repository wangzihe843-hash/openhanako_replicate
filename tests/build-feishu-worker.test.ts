import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import * as phases from "../scripts/build-server-phases.mjs";
import { CLOSURE_ROOTS, scanDynamicCallSites } from "../scripts/compute-cli-closure.mjs";
import { declaredOpenBuildInputPaths } from "../scripts/build-server-open.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-feishu-build-"));
  roots.push(rootDir);
  fs.mkdirSync(path.join(rootDir, "lib/bridge"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(rootDir, "vite.config.server.js"), [
    'export default {build:{rollupOptions:{external:["@larksuiteoapi/node-sdk","node:worker_threads","node:module"]}}};',
  ].join("\n"));
  fs.writeFileSync(path.join(rootDir, "lib/bridge/feishu-worker.ts"), [
    'import { parentPort } from "node:worker_threads";',
    'import { createRequire } from "node:module";',
    'const require = createRequire(import.meta.url);',
    'parentPort!.postMessage("ready");',
    'parentPort!.on("message", () => {',
    '  try { parentPort!.postMessage(require("@larksuiteoapi/node-sdk")); }',
    '  catch (error) { parentPort!.postMessage({code:error.code}); }',
    '});',
  ].join("\n"));
  const outDir = path.join(rootDir, "runtime");
  const bundleOutDir = path.join(outDir, "bundle");
  fs.mkdirSync(bundleOutDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "package.json"), '{"type":"module"}');
  return { rootDir, outDir, bundleOutDir };
}

function writePackage(outDir: string, name: string, source: string) {
  const packageDir = path.join(outDir, "node_modules", name);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.cjs" }));
  fs.writeFileSync(path.join(packageDir, "index.cjs"), source);
}

describe("Feishu Worker distribution", () => {
  it("builds a separate executable Worker whose optional SDK loads only on demand", async () => {
    const { rootDir, bundleOutDir } = fixture();
    await phases.buildFeishuWorkerBundle({ rootDir, bundleOutDir, log: () => {} });
    const entry = path.join(bundleOutDir, "feishu-worker.js");
    const worker = new Worker(entry);
    try {
      expect(await once(worker, "message")).toEqual(["ready"]);
      const response = once(worker, "message");
      worker.postMessage("load");
      expect(await response).toEqual([{ code: "MODULE_NOT_FOUND" }]);
    } finally {
      await worker.terminate();
    }
    fs.unlinkSync(entry);
    const missing = new Worker(entry);
    expect(await once(missing, "error")).toEqual([expect.objectContaining({ code: "MODULE_NOT_FOUND" })]);
    await missing.terminate();
  });

  it("rejects a missing source entry instead of silently shipping only the main bundle", async () => {
    const { rootDir, bundleOutDir } = fixture();
    fs.unlinkSync(path.join(rootDir, "lib/bridge/feishu-worker.ts"));
    await expect(phases.buildFeishuWorkerBundle({ rootDir, bundleOutDir, log: () => {} }))
      .rejects.toThrow(/feishu-worker\.ts/);
    expect(fs.existsSync(path.join(bundleOutDir, "feishu-worker.js"))).toBe(false);
  });

  it("keeps Worker-only dependencies and deferred SDK transitives after pruning", async () => {
    const { rootDir, outDir, bundleOutDir } = fixture();
    fs.writeFileSync(path.join(rootDir, "vite.config.server.js"), [
      'export default {build:{rollupOptions:{external:["worker-only-fixture", "node:worker_threads"]}}};',
    ].join("\n"));
    fs.writeFileSync(path.join(rootDir, "lib/bridge/feishu-worker.ts"), [
      'import { parentPort } from "node:worker_threads";',
      'import value from "worker-only-fixture";',
      'parentPort!.postMessage(value);',
    ].join("\n"));
    fs.writeFileSync(path.join(bundleOutDir, "index.js"), "export {};\n");
    writePackage(outDir, "worker-only-fixture", 'module.exports = require("worker-transitive-fixture");');
    writePackage(outDir, "worker-transitive-fixture", 'module.exports = "worker-runtime-ok";');
    writePackage(outDir, "@larksuiteoapi/node-sdk", 'module.exports = require("sdk-transitive-fixture");');
    writePackage(outDir, "sdk-transitive-fixture", 'module.exports = "sdk-runtime-ok";');
    writePackage(outDir, "unrelated-fixture", 'module.exports = "unused";');
    await phases.buildFeishuWorkerBundle({ rootDir, bundleOutDir, log: () => {} });
    await phases.pruneServerNodeModulesViaNft({
      outDir,
      nftRoots: ["bundle/index.js", "bundle/feishu-worker.js"],
      externalPackageNames: ["worker-only-fixture", "@larksuiteoapi/node-sdk"],
      env: { HANA_BUILD_SERVER_NFT_TRACE: "1" },
      runWithTargetNode: () => {},
      log: () => {},
    });
    expect(fs.existsSync(path.join(outDir, "node_modules/sdk-transitive-fixture/index.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "node_modules/unrelated-fixture/index.cjs"))).toBe(false);
    const worker = new Worker(path.join(bundleOutDir, "feishu-worker.js"));
    try {
      expect(await once(worker, "message")).toEqual(["worker-runtime-ok"]);
    } finally {
      await worker.terminate();
    }
  });

  it.each(["0", "1"])("rejects a missing Worker artifact before dependency pruning (trace=%s)", async (trace) => {
    const { outDir } = fixture();
    fs.mkdirSync(path.join(outDir, "node_modules"));
    await expect(phases.pruneServerNodeModulesViaNft({
      outDir,
      nftRoots: ["bundle/feishu-worker.js"],
      externalPackageNames: [],
      env: { HANA_BUILD_SERVER_NFT_TRACE: trace },
      runWithTargetNode: () => {},
      log: () => {},
    })).rejects.toThrow(/required runtime root.*bundle\/feishu-worker\.js/);
  });

  it("traces the Worker source and its deferred SDK as independent runtime roots", () => {
    expect(CLOSURE_ROOTS).toContainEqual(expect.objectContaining({
      id: "feishu-worker", path: "lib/bridge/feishu-worker.ts", inputType: "dynamic-process-root",
    }));
    expect(CLOSURE_ROOTS).toContainEqual(expect.objectContaining({
      id: "nft-feishu-worker", path: "lib/bridge/feishu-worker.ts", inputType: "nft-runtime-trace",
      deferredPackages: ["@larksuiteoapi/node-sdk"],
    }));
    expect(declaredOpenBuildInputPaths()).toContain("lib/bridge/feishu-worker.ts");
  });

  it("detects nonliteral Worker entries so changing the runtime path fails closed", () => {
    expect(scanDynamicCallSites({
      relPath: "lib/bridge/feishu-worker-adapter.ts",
      sourceText: 'new Worker(resolveFeishuWorkerUrl(), { stdout: true });',
    })).toEqual([expect.objectContaining({
      kind: "worker-spawn", callee: "Worker", argText: "resolveFeishuWorkerUrl()",
    })]);
  });
});
