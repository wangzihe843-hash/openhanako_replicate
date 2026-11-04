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
  it("pins the seven upload sites, other 898 sites, paths and startup receipt", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
    expect(actual.inventory.stores).toHaveLength(65);
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    const other = actual.inventory.discoveredSites.filter((site: { sourceFile: string }) => site.sourceFile !== MODULE);
    expect(other).toHaveLength(898);
    // Pins exact non-upload rows after the first-run ownership reviews and all registered store path patterns.
    expect(digest(other)).toBe("3dba9b0c08bae8249768811e37aecae0548ab9de6bd606a023381024b1b767a7");
    expect(digest(actual.inventory.stores.map((s: { id: string; pathPatterns: string[] }) => [s.id, s.pathPatterns]))).toBe("c01545dd61d741bb1f3ad259081292443f3b673671274d50ad65a59c0cda8f53");
    const sites = actual.inventory.discoveredSites.filter((site: { sourceFile: string }) => site.sourceFile === MODULE);
    expect(sites.map((s: { kind: string; excerpt: string; storeId: string | null; exemptionId: string | null }) => [s.kind, s.excerpt, s.storeId, s.exemptionId])).toEqual([
      ["copy-file", "fs.copyFile(srcPath, legacyUploadPath)", "legacy-upload-cache", null],
      ["copy-file", "fs.copyFile(srcPath, sessionFilePath)", "session-files", null],
      ["mkdir", "fs.mkdir(legacyUploadsDir, { recursive: true })", "legacy-upload-cache", null],
      ["mkdir", "fs.mkdir(sessionFilesDir, { recursive: true })", "session-files", null],
      ["remove-path", "fs.rm(fullPath, { recursive: true, force: true })", "legacy-upload-cache", null],
      ["write-file", "fs.writeFile(legacyUploadPath, buf)", "legacy-upload-cache", null],
      ["write-file", "fs.writeFile(sessionFilePath, buf)", "session-files", null],
    ]);
    expect(PERSISTENCE_EXEMPTIONS.some((e) => e.id === "conditional-upload-target")).toBe(false);
    expect(PERSISTENT_STORES.find((s) => s.id === "session-files")?.protocolModules).toContain(MODULE);
  });

  it("rejects a missing owner", () => {
    const noOwner = PERSISTENT_STORES.map((s) => s.id !== "session-files" ? s : { ...s, siteRules: s.siteRules.filter((r) => r.linePattern !== "sessionFilesDir") });
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner })).toThrow(/unregistered persistence site/);
  });

  it("rejects an overlapping exemption", () => {
    const wide = [...PERSISTENCE_EXEMPTIONS, { id: "test-upload-overlap", ownerModule: MODULE, sourceFile: MODULE, reason: "Test-only overlapping exemption.", expiresOn: "2027-01-31", kinds: ["mkdir"], linePattern: "sessionFilesDir" }];
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: wide })).toThrow(/ambiguous persistence site/);
  });

  it.each(["sessionFilesDir", "legacyUploadsDir"])("rejects a missing mkdir for %s", (dir) => {
    const statement = `await fs.mkdir(${dir}, { recursive: true });`;
    expect(source.split(statement)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, `void ${dir};`)) })).toThrow(/dangling/);
  });

  it.each([
    "await fs.copyFile(srcPath, sessionFilePath);", "await fs.copyFile(srcPath, legacyUploadPath);",
    "await fs.writeFile(sessionFilePath, buf);", "await fs.writeFile(legacyUploadPath, buf);",
  ])("detects a missing or duplicated upload operation: %s", (statement) => {
    expect(source.split(statement)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, "void destPath;")) })).toThrow(/dangling/);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, `${statement}\n        ${statement}`)) }).inventory).not.toEqual(inventory);
  });

  it("rejects an unknown write", () => {
    const write = "await fs.writeFile(sessionFilePath, buf);";
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(write, `${write}\n        await fs.writeFile("unknown", buf);`)) })).toThrow(/unregistered persistence site/);
  });

  it("accepts the committed fingerprint", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toBeDefined();
  });

  it("accepts comment-only drift", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides: overrides(`// comment only\n${source}`) })).resolves.toBeDefined();
  });

  it.each([
    ['path.join(engine.hanakoHome, "uploads")', 'path.join(engine.hanakoHome, "other")'],
    ["shouldCleanOldUploads: false", "shouldCleanOldUploads: true"],
    ["if (sessionPath) {", "if (!sessionPath) {"],
    [`if (uploadTarget.storageKind === "managed_cache") {\n          const sessionFilePath = destPath;\n          await fs.copyFile`, `if (uploadTarget.storageKind !== "managed_cache") {\n          const sessionFilePath = destPath;\n          await fs.copyFile`],
    [`if (uploadTarget.storageKind === "managed_cache") {\n          const sessionFilePath = destPath;\n          await fs.writeFile`, `if (uploadTarget.storageKind !== "managed_cache") {\n          const sessionFilePath = destPath;\n          await fs.writeFile`],
    [`const sessionFilePath = destPath;\n          await fs.copyFile`, `const sessionFilePath = path.join(uploadsDir, "other");\n          await fs.copyFile`],
    [`const legacyUploadPath = destPath;\n          await fs.copyFile`, `const legacyUploadPath = path.join(uploadsDir, "other");\n          await fs.copyFile`],
    [`const sessionFilePath = destPath;\n          await fs.writeFile`, `const sessionFilePath = path.join(uploadsDir, "other");\n          await fs.writeFile`],
    [`const legacyUploadPath = destPath;\n          await fs.writeFile`, `const legacyUploadPath = path.join(uploadsDir, "other");\n          await fs.writeFile`],
  ])("fingerprints routing change: %s", async (before, after) => {
    expect(source.split(before)).toHaveLength(2);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides: overrides(source.replace(before, after)) })).rejects.toThrow(/fingerprint mismatch/);
  });
});
