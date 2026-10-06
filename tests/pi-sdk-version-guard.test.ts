import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function guardFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pi-version-guard-"));
  temporary.push(dir);
  const write = (relative: string, value: unknown) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  const copy = (relative: string) => write(relative, fs.readFileSync(path.join(root, relative), "utf8"));
  copy("scripts/patch-pi-sdk.cjs");
  const packages = {};
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-telemetry"]) {
    const location = `node_modules/@earendil-works/${name}`;
    copy(`${location}/package.json`);
    packages[location] = { version: "1.0.3" };
  }
  for (const relative of ["index.js", "core/auth-storage.js", "core/compaction/compaction.js"]) {
    copy(`node_modules/@earendil-works/pi-coding-agent/dist/${relative}`);
  }
  write("package-lock.json", { packages });
  const run = () => {
    const result = spawnSync(process.execPath, [path.join(dir, "scripts/patch-pi-sdk.cjs")], {
      cwd: dir, encoding: "utf8", windowsHide: true,
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const snapshot = (relative = ""): Record<string, string> => Object.fromEntries(
    fs.readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap(entry => {
      const file = path.join(relative, entry.name);
      return entry.isDirectory()
        ? Object.entries(snapshot(file))
        : [[file, fs.readFileSync(path.join(dir, file), "utf8")]];
    }),
  );
  return { write, run, packages, snapshot };
}

describe("Pi installation version guard", () => {
  it("accepts the reviewed release and its actual published internal paths", () => {
    const fixture = guardFixture();
    const before = fixture.snapshot();
    expect(fixture.run()).toEqual({ status: 0, output: "[verify-pi-sdk] all checks passed\n" });
    expect(fixture.snapshot()).toEqual(before);
  });

  it("rejects an unreviewed SDK version", () => {
    const fixture = guardFixture();
    fixture.write("node_modules/@earendil-works/pi-coding-agent/package.json", { version: "1.0.4" });
    expect(fixture.run()).toMatchObject({ status: 1, output: expect.stringContaining("is not verified") });
  });

  it("rejects mixed root packages", () => {
    const fixture = guardFixture();
    fixture.write("node_modules/@earendil-works/pi-agent-core/package.json", { version: "0.87.1" });
    expect(fixture.run()).toMatchObject({ status: 1, output: expect.stringContaining("must use the same verified version") });
  });

  it("rejects a nested version disagreement in the lock", () => {
    const fixture = guardFixture();
    fixture.packages["node_modules/fixture/node_modules/@earendil-works/pi-ai"] = { version: "0.87.1" };
    fixture.write("package-lock.json", { packages: fixture.packages });
    expect(fixture.run()).toMatchObject({ status: 1, output: expect.stringContaining("mixed Pi version") });
  });

  it("rejects installed nested drift even if the lock declares the reviewed version", () => {
    const fixture = guardFixture();
    const nested = "node_modules/fixture/node_modules/@earendil-works/pi-ai";
    fixture.packages[nested] = { version: "1.0.3" };
    fixture.write("package-lock.json", { packages: fixture.packages });
    fixture.write(`${nested}/package.json`, { version: "0.87.1" });
    expect(fixture.run()).toMatchObject({ status: 1, output: expect.stringContaining("mixed installed Pi version") });
  });

  it("still rejects missing deep internals and adapter import bypasses", () => {
    const missing = guardFixture();
    missing.write("node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js", "export {};");
    expect(missing.run()).toMatchObject({ status: 1, output: expect.stringContaining("prepareCompaction missing") });
    const bypass = guardFixture();
    bypass.write("core/fixture.ts", 'import { Agent } from "@earendil-works/pi-agent-core";');
    expect(bypass.run()).toMatchObject({ status: 1, output: expect.stringContaining("production files bypass lib/pi-sdk") });
  });

  it("rejects transitive Pi-family drift", () => {
    const fixture = guardFixture();
    fixture.packages["node_modules/@earendil-works/pi-telemetry"] = { version: "1.0.4" };
    fixture.write("package-lock.json", { packages: fixture.packages });
    expect(fixture.run()).toMatchObject({ status: 1, output: expect.stringContaining("mixed Pi version") });
    fixture.packages["node_modules/@earendil-works/pi-telemetry"] = { version: "1.0.3" };
    fixture.write("package-lock.json", { packages: fixture.packages });
    fixture.write("node_modules/@earendil-works/pi-telemetry/package.json", { version: "1.0.4" });
    expect(fixture.run()).toMatchObject({ status: 1, output: expect.stringContaining("mixed installed Pi version") });
  });
});
