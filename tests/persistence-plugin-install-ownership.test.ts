import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { assertCommittedPersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "server/routes/plugins.ts";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const overrides = (text: string) => new Map([[MODULE, text]]);
const staging = "fs.rmSync(installStagingDir, { recursive: true, force: true })";
const extract = "fs.rmSync(extractDir, { recursive: true, force: true })";

describe("plugin install cleanup ownership", () => {
  it("pins each target, owner, exemption and date", () => {
    const { inventory: actual } = scanPersistentStores({ rootDir: ROOT });
    expect(actual).toEqual(inventory);
    expect(actual.discoveredSites.filter((s) => s.sourceFile === MODULE && [staging, extract].includes(s.excerpt)).map((s) => [s.excerpt, s.storeId, s.exemptionId])).toEqual([
      [extract, null, "conditional-plugin-install-cleanup"], [staging, "installed-plugins", null],
    ]);
    expect(PERSISTENCE_EXEMPTIONS.find((e) => e.id === "conditional-plugin-install-cleanup")).toMatchObject({ expiresOn: "2026-11-17", linePattern: "rmSync\\(extractDir" });
    expect(PERSISTENT_STORES.find((s) => s.id === "installed-plugins")?.protocolModules).toContain(MODULE);
  });
  it("rejects a missing owner", () => {
    const stores = PERSISTENT_STORES.map((s) => s.id !== "installed-plugins" ? s : { ...s, siteRules: s.siteRules.map((r) => r.sourceFile !== MODULE ? r : { ...r, linePattern: r.linePattern?.replace("|installStagingDir", "") }) });
    expect(() => scanPersistentStores({ rootDir: ROOT, stores })).toThrow(/unregistered persistence site/);
  });
  it("rejects an overlapping owner and exemption", () => {
    const exemptions = [...PERSISTENCE_EXEMPTIONS, { id: "test-overlap", ownerModule: MODULE, sourceFile: MODULE, reason: "Test overlap", expiresOn: "2027-01-31", kinds: ["remove-path"], linePattern: "rmSync\\(installStagingDir" }];
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions })).toThrow(/ambiguous persistence site/);
  });
  it.each([staging, extract])("detects removal of %s", (statement) => {
    expect(source.split(statement)).toHaveLength(2);
    if (statement === extract) {
      expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, "void 0")) })).toThrow(/dangling/);
    } else {
      expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, "void 0")) }).inventory).not.toEqual(inventory);
    }
  });
  it.each([staging, extract])("detects duplication of %s", (statement) => {
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, `${statement}; ${statement}`)) }).inventory).not.toEqual(inventory);
  });
  it("rejects an unknown cleanup target", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(staging, 'fs.rmSync("unknown", { recursive: true, force: true })')) })).toThrow(/unregistered persistence site/);
  });
  it.each([
    ['path.join(userPluginsDir, ".installing-")', 'path.join(os.tmpdir(), ".installing-")'],
    ['path.join(os.tmpdir(), "plugin-install-")', 'path.join(userPluginsDir, "plugin-install-")'],
    ["cleanupPluginInstallDirs(stagedDir, extractDir)", "cleanupPluginInstallDirs(targetDir, extractDir)"],
    ["cleanupPluginInstallDirs(installStagingDir, extractDir)", "cleanupPluginInstallDirs(extractDir, installStagingDir)"],
  ])("fingerprints target or call mutation %s", async (before, after) => {
    expect(source.split(before)).toHaveLength(2);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides: overrides(source.replace(before, after)) })).rejects.toThrow(/fingerprint mismatch/);
  });
  it("accepts comment-only drift", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides: overrides(`// comment\n${source}`) })).resolves.toBeDefined();
  });
});
