import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { assertCommittedPersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "server/routes/upload.ts";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const overrides = (value: string) => new Map([[MODULE, value]]);
vi.setConfig({ testTimeout: 30_000 });

describe("upload directory ownership", () => {
  it("pins the two owners, remaining narrow exception, other 898 sites, paths and startup receipt", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
    expect(actual.inventory.stores).toHaveLength(65);
    expect(actual.inventory.discoveredSites).toHaveLength(903);
    const other = actual.inventory.discoveredSites.filter((site: { sourceFile: string }) => site.sourceFile !== MODULE);
    expect(other).toHaveLength(898);
    // Baseline 858ef1c8: exact JSON rows and all registered store path patterns.
    expect(digest(other)).toBe("92ea096c72ac43f3d0bc65fd4b1e9f9603e128a62f3d750c25ca2357a0e05da2");
    expect(digest(actual.inventory.stores.map((s: { id: string; pathPatterns: string[] }) => [s.id, s.pathPatterns]))).toBe("c01545dd61d741bb1f3ad259081292443f3b673671274d50ad65a59c0cda8f53");
    const sites = actual.inventory.discoveredSites.filter((site: { sourceFile: string }) => site.sourceFile === MODULE);
    expect(sites.map((s: { kind: string; excerpt: string; storeId: string | null; exemptionId: string | null }) => [s.kind, s.excerpt, s.storeId, s.exemptionId])).toEqual([
      ["copy-file", "fs.copyFile(srcPath, destPath)", null, "conditional-upload-target"],
      ["mkdir", "fs.mkdir(legacyUploadsDir, { recursive: true })", "legacy-upload-cache", null],
      ["mkdir", "fs.mkdir(sessionFilesDir, { recursive: true })", "session-files", null],
      ["remove-path", "fs.rm(fullPath, { recursive: true, force: true })", "legacy-upload-cache", null],
      ["write-file", "fs.writeFile(destPath, buf)", null, "conditional-upload-target"],
    ]);
    const exception = PERSISTENCE_EXEMPTIONS.find((e) => e.id === "conditional-upload-target");
    expect(exception?.expiresOn).toBe("2026-11-17");
    expect(exception?.kinds).toEqual(["copy-file", "write-file"]);
    expect(PERSISTENT_STORES.find((s) => s.id === "session-files")?.protocolModules).toContain(MODULE);
  });

  it("rejects missing owner, overlapping exemption, missing mkdir and unknown writes", () => {
    const noOwner = PERSISTENT_STORES.map((s) => s.id !== "session-files" ? s : { ...s, siteRules: s.siteRules.filter((r) => r.linePattern !== "sessionFilesDir") });
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner })).toThrow(/unregistered persistence site/);
    const wide = PERSISTENCE_EXEMPTIONS.map((e) => e.id !== "conditional-upload-target" ? e : { ...e, kinds: ["mkdir", "copy-file", "write-file"], linePattern: undefined });
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: wide })).toThrow(/ambiguous persistence site/);
    for (const dir of ["sessionFilesDir", "legacyUploadsDir"]) {
      const statement = `await fs.mkdir(${dir}, { recursive: true });`;
      expect(source.split(statement)).toHaveLength(2);
      expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, `void ${dir};`)) })).toThrow(/dangling/);
    }
    const write = "await fs.writeFile(destPath, buf);";
    expect(source.split(write)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(write, `${write}\n        await fs.writeFile("unknown", buf);`)) })).toThrow(/unregistered persistence site/);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(write, `${write}\n        ${write}`)) }).inventory).not.toEqual(inventory);
    const copy = "await fs.copyFile(srcPath, destPath);";
    expect(source.split(copy)).toHaveLength(2);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(copy, "void destPath;")) }).inventory).not.toEqual(inventory);
  });

  it("fingerprints routing changes while accepting comment-only drift", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toBeDefined();
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides: overrides(`// comment only\n${source}`) })).resolves.toBeDefined();
    for (const [before, after] of [
      ['path.join(engine.hanakoHome, "uploads")', 'path.join(engine.hanakoHome, "other")'],
      ["shouldCleanOldUploads: false", "shouldCleanOldUploads: true"],
      ["if (sessionPath) {", "if (!sessionPath) {"],
    ]) {
      expect(source.split(before)).toHaveLength(2);
      await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides: overrides(source.replace(before, after)) })).rejects.toThrow(/fingerprint mismatch/);
    }
  });
});
