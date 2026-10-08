import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const root = process.cwd();
const entitlementsPath = "desktop/entitlements.mac.plist";
const microphoneKey = "com.apple.security.device.audio-input";
const runtimeKeys = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.allow-dyld-environment-variables",
];

// This small, flat Boolean plist is checked without adding a parser dependency.
// Ignore XML comments so a commented-out entitlement cannot satisfy the contract.
const plist = fs.readFileSync(path.join(root, entitlementsPath), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "");
const keys = Array.from(plist.matchAll(/<key>\s*([^<]+?)\s*<\/key>/g), (match) => match[1]);
const entries = Array.from(
  plist.matchAll(/<key>\s*([^<]+?)\s*<\/key>\s*<(true|false)\s*\/>/g),
  (match) => [match[1], match[2] === "true"] as const,
);

describe("macOS microphone packaging contract", () => {
  it("uses the explicit microphone entitlement file for hardened app and helper signing", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(pkg.build.mac.hardenedRuntime, true);
    assert.equal(pkg.build.mac.entitlements, entitlementsPath);
    assert.equal(pkg.build.mac.entitlementsInherit, entitlementsPath);
  });

  it("declares microphone input exactly once as Boolean true", () => {
    assert.deepEqual(keys.filter((key) => key === microphoneKey), [microphoneKey]);
    assert.deepEqual(entries.filter(([key]) => key === microphoneKey), [[microphoneKey, true]]);
  });

  it("preserves the existing Electron runtime entitlements as Boolean true", () => {
    for (const runtimeKey of runtimeKeys) {
      assert.deepEqual(keys.filter((key) => key === runtimeKey), [runtimeKey]);
      assert.deepEqual(entries.filter(([key]) => key === runtimeKey), [[runtimeKey, true]]);
    }
  });

  it("adds no unrelated entitlements", () => {
    const allowedKeys = new Set([...runtimeKeys, microphoneKey]);
    assert.deepEqual(keys.filter((key) => !allowedKeys.has(key)), []);
    assert.deepEqual(entries.map(([key]) => key), keys);
  });
});
