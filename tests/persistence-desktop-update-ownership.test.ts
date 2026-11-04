import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { assertCommittedPersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "desktop/auto-updater.cjs";
const OWNER = "desktop-window-version-state";
const RETIRED = "desktop-legacy-update-path-cleanup";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const overrides = (text: string) => new Map([[MODULE, text]]);
const statements = ["fs.rmdirSync(wrongDir)", "fs.unlinkSync(wrongFile)"];
const oldExemption = { id: RETIRED, ownerModule: MODULE, sourceFile: MODULE,
  reason: "Deletes the exact legacy last-update-version source and its now-empty legacy directory outside the active HANA_HOME.",
  expiresOn: "2026-11-17", kinds: ["remove-path"], linePattern: "(?:wrongFile|wrongDir)" };
const withoutOwner = PERSISTENT_STORES.map(s => s.id !== OWNER ? s : { ...s,
  siteRules: s.siteRules.filter(r => !(r.sourceFile === MODULE && r.kinds.includes("remove-path"))) });

describe("desktop legacy update cleanup ownership", () => {
  it("moves exactly two cleanup rows and preserves every other mapping and startup phase", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    expect(actual.inventory).toEqual(inventory); expect(actual.startupReceipt).toEqual(receipt);
    expect(actual.inventory.stores).toHaveLength(65); expect(actual.inventory.discoveredSites).toHaveLength(905); expect(actual.inventory.exemptions).toHaveLength(32);
    const targets = actual.inventory.discoveredSites.filter(s => s.sourceFile === MODULE && statements.includes(s.excerpt));
    expect(targets.map(s => [s.kind, s.excerpt, s.storeId, s.exemptionId])).toEqual(statements.map(s => ["remove-path", s, OWNER, null]));
    expect(PERSISTENCE_EXEMPTIONS.some(e => e.id === RETIRED)).toBe(false);
    const previous = scanPersistentStores({ rootDir: ROOT, stores: withoutOwner, exemptions: [...PERSISTENCE_EXEMPTIONS, oldExemption] });
    const changed = previous.inventory.discoveredSites.map((before, i) => ({ before, after: actual.inventory.discoveredSites[i] }))
      .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(changed).toHaveLength(2);
    for (const { before, after } of changed) {
      expect(before).toMatchObject({ sourceFile: MODULE, storeId: null, exemptionId: RETIRED });
      expect(after).toMatchObject({ sourceFile: MODULE, storeId: OWNER, exemptionId: null });
      expect({ ...before, reason: after.reason, storeId: after.storeId, exemptionId: after.exemptionId }).toEqual(after);
    }
    expect(previous.inventory.exemptions.filter(e => e.id !== RETIRED)).toEqual(actual.inventory.exemptions);
    expect(previous.inventory.stores).toEqual(actual.inventory.stores); expect(previous.startupReceipt).toEqual(actual.startupReceipt);
    const store = PERSISTENT_STORES.find(s => s.id === OWNER)!;
    expect(store.pathPatterns).toEqual(["user/window-state.json", "user/quick-chat-window-state.json", "user/pet-window-state.json", "user/last-seen-version.json", "last-update-version"]);
    expect(store.checkpointPolicy).toBe("Optional compatible shell metadata; it is not required for restoring durable agent/session state.");
    expect(store.restorePolicy).toBe("Read through each desktop owner; invalid or absent shell metadata is recreated from safe defaults.");
    expect(store.affectedByEpochMigration).toBe(false);
    expect(store.protocolModules).toEqual([MODULE, "desktop/src/shared/user-data-identity.cjs"]);
    expect(store.migrationEntry).toEqual(["desktop/auto-updater.cjs: fixed ~/.hanako-dev/last-update-version migration and empty-source-directory cleanup after native directory identity comparison"]);
  });
  it("rejects missing ownership", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: withoutOwner })).toThrow(/unregistered persistence site/);
  });
  it("rejects overlapping ownership", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: [...PERSISTENCE_EXEMPTIONS, oldExemption] })).toThrow(/ambiguous persistence site/);
  });
  it.each(statements)("detects removal or duplication of %s", statement => {
    expect(source.split(statement)).toHaveLength(2);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, "void 0")) }).inventory).not.toEqual(inventory);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, `${statement}; ${statement}`)) }).inventory).not.toEqual(inventory);
  });
  it.each(statements)("rejects unknown target for %s", statement => {
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(statement, statement.replace(/wrongFile|wrongDir/, '"unknown"'))) })).toThrow(/unregistered persistence site/);
  });
  it("accepts the committed fingerprint", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toBeDefined();
  });
  it("accepts comment-only drift", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides: overrides(`// comment\n${source}`) })).resolves.toBeDefined();
  });
  it.each([
    ['path.join(require("os").homedir(), ".hanako-dev")', 'path.join(require("os").homedir(), ".other")'],
    ['path.join(wrongDir, "last-update-version")', 'path.join(wrongDir, "other")'],
    ["canonicalizeDesktopHome(wrongDir, fs) !== canonicalizeDesktopHome(dataDir, fs)", "wrongDir !== dataDir"],
    ["wrongStat.isFile() && wrongStat.nlink === 1", "true"],
    ['err.code !== "ENOENT"', 'err.code !== "EACCES"'],
    ["!versionStat.isFile() || versionStat.nlink !== 1", "false"],
    ["if (!updatePolicy.onlineUpdatesEnabled) return;\n\n  // 开发环境", "if (false) return;\n\n  // 开发环境"],
  ])("fingerprints fixed-source, identity, safety and activation drift: %s", async (before, after) => {
    expect(source.split(before)).toHaveLength(2);
    const sourceOverrides = overrides(source.replace(before, after));
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });
  it("fingerprints the reused native canonicalizer", async () => {
    const module = "desktop/src/shared/user-data-identity.cjs";
    const text = fs.readFileSync(path.join(ROOT, module), "utf8");
    const before = "return path.join(canonical, ...suffix);";
    expect(text.split(before)).toHaveLength(2);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT,
      sourceOverrides: new Map([[module, text.replace(before, "return path.join(canonical, ...suffix).toLowerCase();")]]) })).rejects.toThrow(/fingerprint mismatch/);
  });
});
