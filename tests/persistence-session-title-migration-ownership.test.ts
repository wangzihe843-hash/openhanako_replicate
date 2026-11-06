import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/migrations.ts";
const OWNER = "session-sidecars";
const EXEMPTION = "cross-store-legacy-migrations";
const reason = "Removes injected-envelope titles from the registered per-agent session title sidecar in migration #53.";
const call = "atomicWriteSync(titlePath, JSON.stringify(titles, null, 2))";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const noOwner = PERSISTENT_STORES.map(store => store.id !== OWNER ? store : {
  ...store, siteRules: store.siteRules.filter(rule => rule.reason !== reason),
});
const priorStores = noOwner.map(store => store.id !== OWNER ? store : {
  ...store, firstPossibleWritePhase: "runtime_ready" as const,
});
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(exemption => {
  const previous = { ...exemption };
  if (previous.id === EXEMPTION) previous.linePattern = previous.linePattern?.replace("(?!.*\\btitlePath\\b)", "");
  return previous;
});
const overrides = (text: string) => new Map([[MODULE, text]]);
const review = { classification: "compatible", compatibilityReason: "Test-only reconstruction of session title migration ownership before attribution." };

// #35 conservatively pins this whole module. Retain the original #53 matcher
// oracle in a fixture without the #35 exclusion, and also assert that the full
// production proof rejects each executable mutation before using that fixture.
const titleMutationExemptions = PERSISTENCE_EXEMPTIONS.map(e => { const copy = { ...e }; delete copy.excludedSites; return copy; });
function scanTitleMutation(sourceOverrides) {
  expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides })).toThrow(/MiniMax #35 ownership/);
  return scanPersistentStores({ rootDir: ROOT, sourceOverrides, exemptions: titleMutationExemptions });
}

vi.setConfig({ testTimeout: 30_000 });

function assertCurrentMetadata() {
  const actual = scanPersistentStores({ rootDir: ROOT });
  expect(actual.inventory).toEqual(inventory);
  expect(actual.startupReceipt).toEqual(receipt);
  return actual;
}

function changedRows(before, after) {
  expect(before).toHaveLength(after.length);
  return before.map((row, index) => ({ before: row, after: after[index] }))
    .filter(({ before: oldRow, after: newRow }) => JSON.stringify(oldRow) !== JSON.stringify(newRow));
}

function withoutFingerprintChanges(fingerprint) {
  const unchanged = { ...fingerprint };
  for (const key of ["exemptions", "registry", "siteMappings", "payloadFingerprint", "review"]) delete unchanged[key];
  return unchanged;
}

function changedSource(replacement: string) {
  expect(source.split(call)).toHaveLength(2);
  const changed = source.replace(call, replacement);
  expect(changed).not.toBe(source);
  return overrides(changed);
}

describe("session title migration persistence ownership", () => {
  it("moves exactly the #53 write and only corrects the sidecar write phase", () => {
    const actual = assertCurrentMetadata();
    const previous = scanPersistentStores({ rootDir: ROOT, stores: priorStores, exemptions: priorExemptions });
    expect(previous.inventory.discoveredSites).toHaveLength(905);
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    expect(actual.inventory.stores).toHaveLength(65);
    expect(actual.inventory.exemptions).toHaveLength(32);

    const changed = changedRows(previous.inventory.discoveredSites, actual.inventory.discoveredSites);
    expect(changed).toHaveLength(1);
    const { before, after } = changed[0];
    expect(before).toMatchObject({ sourceFile: MODULE, kind: "atomic-write", excerpt: call, ordinal: 0, storeId: null, exemptionId: EXEMPTION });
    expect(after).toMatchObject({ sourceFile: MODULE, kind: "atomic-write", excerpt: call, ordinal: 0, storeId: OWNER, exemptionId: null, reason });
    expect({ ...before, reason: after.reason, storeId: after.storeId, exemptionId: after.exemptionId }).toEqual(after);

    const storeChanges = changedRows(previous.inventory.stores, actual.inventory.stores);
    expect(storeChanges).toHaveLength(1);
    expect(storeChanges[0].before).toMatchObject({ id: OWNER, firstPossibleWritePhase: "runtime_ready", protocolModules: [] });
    expect(storeChanges[0].after).toEqual({ ...storeChanges[0].before, firstPossibleWritePhase: "engine_construct" });
    const receiptChanges = changedRows(previous.startupReceipt.stores, actual.startupReceipt.stores);
    expect(receiptChanges).toHaveLength(1);
    expect(receiptChanges[0].before.id).toBe(OWNER);
    expect(receiptChanges[0].after).toEqual({ ...receiptChanges[0].before, firstPossibleWritePhase: "engine_construct" });
    expect({ ...previous.startupReceipt, stores: actual.startupReceipt.stores }).toEqual(actual.startupReceipt);

    const exemptionChanges = changedRows(previous.inventory.exemptions, actual.inventory.exemptions);
    expect(exemptionChanges).toHaveLength(1);
    expect(exemptionChanges[0].before).toMatchObject({ id: EXEMPTION, expiresOn: "2026-11-17" });
    expect(exemptionChanges[0].after).toEqual({ ...exemptionChanges[0].before, linePattern: PERSISTENCE_EXEMPTIONS.find(entry => entry.id === EXEMPTION)?.linePattern });
    expect(previous.inventory.discoveredSites.filter(site => site.exemptionId === EXEMPTION)).toHaveLength(67);
    expect(actual.inventory.discoveredSites.filter(site => site.exemptionId === EXEMPTION)).toHaveLength(66);
    const datedIds = new Set(actual.inventory.exemptions.filter(exemption => exemption.expiresOn === "2026-11-17").map(exemption => exemption.id));
    expect(datedIds.size).toBe(6);
    expect(previous.inventory.discoveredSites.filter(site => datedIds.has(site.exemptionId))).toHaveLength(84);
    expect(actual.inventory.discoveredSites.filter(site => datedIds.has(site.exemptionId))).toHaveLength(83);
    assertCurrentMetadata();
  });

  it("changes only the registry phase, one site mapping, and the narrowed exemption in the fingerprint", async () => {
    assertCurrentMetadata();
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed })).resolves.toEqual(committed);
    const previousInventory = scanPersistentStores({ rootDir: ROOT, stores: priorStores, exemptions: priorExemptions }).inventory;
    const previous = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, review });
    expect(previous.dataEpoch).toBe(1);
    expect(committed.dataEpoch).toBe(1);
    expect(previous.schemas).toEqual(committed.schemas);
    expect(previous.payloadFingerprint).not.toBe(committed.payloadFingerprint);
    expect(withoutFingerprintChanges(previous)).toEqual(withoutFingerprintChanges(committed));

    const registryChanges = changedRows(previous.registry, committed.registry);
    expect(registryChanges).toHaveLength(1);
    expect(registryChanges[0].before.id).toBe(OWNER);
    expect(registryChanges[0].after).toEqual({ ...registryChanges[0].before, firstPossibleWritePhase: "engine_construct" });
    const siteChanges = changedRows(previous.siteMappings, committed.siteMappings);
    expect(siteChanges).toHaveLength(1);
    expect(siteChanges[0].before).toMatchObject({ sourceFile: MODULE, kind: "atomic-write", ordinal: 0, exemptionId: EXEMPTION, storeId: null });
    expect(siteChanges[0].after).toEqual({ ...siteChanges[0].before, exemptionId: null, storeId: OWNER, reason });
    const exemptionChanges = changedRows(previous.exemptions, committed.exemptions);
    expect(exemptionChanges).toHaveLength(1);
    expect(exemptionChanges[0].before.id).toBe(EXEMPTION);
    expect(exemptionChanges[0].after).toEqual({ ...exemptionChanges[0].before, linePattern: PERSISTENCE_EXEMPTIONS.find(entry => entry.id === EXEMPTION)?.linePattern });
    assertCurrentMetadata();
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed })).resolves.toEqual(committed);
  });

  it("rejects a missing owner without relying on an unrelated scanner failure", () => {
    assertCurrentMetadata();
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner }))
      .toThrow(/unregistered persistence site: core\/migrations\.ts:\d+ atomic-write atomicWriteSync\(titlePath,/);
    assertCurrentMetadata();
  });

  it("rejects overlapping owner and legacy exemption", () => {
    assertCurrentMetadata();
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions }))
      .toThrow(/ambiguous persistence site: core\/migrations\.ts:\d+ atomic-write matches store:session-sidecars, exemption:cross-store-legacy-migrations/);
    assertCurrentMetadata();
  });

  it.each([
    ["deleted", "void 0"],
    ["replaced by an ordinary write", 'fs.writeFileSync(titlePath, JSON.stringify(titles, null, 2))'],
  ])("detects the formal atomic call being %s through the dangling exact rule", (_label, replacement) => {
    assertCurrentMetadata();
    const sourceOverrides = changedSource(replacement);
    expect(() => scanTitleMutation(sourceOverrides))
      .toThrow(/dangling persistence rule for store session-sidecars: core\/migrations\.ts/);
    assertCurrentMetadata();
  });

  it.each([
    ["ordinary", 'fs.writeFileSync(titlePath, "extra")', "write-file"],
    ["secret", 'writeSecretFileSync(titlePath, "extra")', "secret-write"],
    ["rename", 'fs.renameSync(titlePath, "unknown")', "rename"],
    ["different atomic expression", 'atomicWriteSync(titlePath, "extra")', "atomic-write"],
  ])("rejects an added %s titlePath write while the formal call still exists", (_label, added, kind) => {
    assertCurrentMetadata();
    const sourceOverrides = changedSource(`${call};\n    ${added}`);
    expect(sourceOverrides.get(MODULE)?.split(call)).toHaveLength(2);
    expect(() => scanTitleMutation(sourceOverrides))
      .toThrow(new RegExp(`unregistered persistence site: core/migrations[.]ts:\\d+ ${kind} `));
    assertCurrentMetadata();
  });

  it("detects a duplicate formal write in the inventory and fingerprint", async () => {
    assertCurrentMetadata();
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed })).resolves.toEqual(committed);
    const sourceOverrides = changedSource(`${call};\n    ${call}`);
    const duplicate = scanTitleMutation(sourceOverrides).inventory;
    expect(duplicate.discoveredSites).toHaveLength(906);
    expect(duplicate.discoveredSites.filter(site => site.sourceFile === MODULE && site.excerpt === call))
      .toEqual([0, 1].map(ordinal => ({ ...inventory.discoveredSites.find(site => site.sourceFile === MODULE && site.excerpt === call), ordinal })));
    // The full module is now a finite #35 proof: even an explicit compatible
    // review cannot reseal a changed module through this synthetic inventory.
    await expect(generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: duplicate, sourceOverrides, review })).rejects.toThrow(/MiniMax #35 ownership/);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/MiniMax #35 ownership/);
    assertCurrentMetadata();
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed })).resolves.toEqual(committed);
  });

  it("accepts comment and line movement without changing the metadata or fingerprint", async () => {
    assertCurrentMetadata();
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed })).resolves.toEqual(committed);
    const sourceOverrides = overrides(`// Ordinary comment before the migration registry.\n\n${source}`);
    const shifted = scanPersistentStores({ rootDir: ROOT, sourceOverrides });
    expect(shifted.inventory).toEqual(inventory);
    expect(shifted.startupReceipt).toEqual(receipt);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: shifted.inventory, committedFingerprint: committed, sourceOverrides })).resolves.toEqual(committed);
    assertCurrentMetadata();
  });

  it("guards the title path and the constructor-time legacy backfill chain without executing migrations", () => {
    // These are static regression guards. With protocolModules still empty,
    // this patch does not claim semantic fingerprint coverage of this chain.
    expect(source).toContain("53: migrateCleanEnvelopeSessionTitles,");
    expect(source).toContain('const titlePath = path.join(agentsDir, dir.name, "sessions", "session-titles.json");');
    expect(source).toContain("for (const titlePath of collectAgentSessionTitlePaths(agentsDir))");
    expect(PERSISTENT_STORES.filter(store => store.pathPatterns.includes("agents/{agentId}/sessions/session-titles.json")).map(store => store.id)).toEqual([OWNER]);
    const sidecars = PERSISTENT_STORES.find(store => store.id === OWNER);
    expect(sidecars).toMatchObject({ firstPossibleWritePhase: "engine_construct", protocolModules: [] });
    expect(sidecars?.migrationEntry).toEqual(["core/session-manifest/legacy-migration.ts", MODULE]);

    const engine = fs.readFileSync(path.join(ROOT, "core/engine.ts"), "utf8");
    const constructor = engine.slice(engine.indexOf("  constructor({"), engine.indexOf("    this._currentTurnNativeMedia ="));
    expect(constructor).toContain("this._sessionManifestStore = this._openSessionManifestStore();");
    expect(constructor).toContain("this._sessionManifestMigration = this._runSessionManifestStartupMigration();");
    const startupMethod = engine.slice(engine.indexOf("  _runSessionManifestStartupMigration() {"), engine.indexOf("   * 聚合三路 session"));
    expect(startupMethod).toContain("const result = ensureLegacySessionManifestMigration({");
    expect(startupMethod).toContain("hanaHome: this.hanakoHome,");
    const startup = fs.readFileSync(path.join(ROOT, "core/session-manifest/startup-migration.ts"), "utf8");
    expect(startup).toContain('import { migrateLegacySessions } from "./legacy-migration.ts";');
    expect(startup.split("const migrate = opts.migrate || migrateLegacySessions;")).toHaveLength(3);
    expect(startup.split("const result = migrate({")).toHaveLength(3);
    const legacy = fs.readFileSync(path.join(ROOT, "core/session-manifest/legacy-migration.ts"), "utf8");
    expect(legacy).toContain('const titlesPath = path.join(row.titleSessionDir, "session-titles.json");');
    expect(legacy.split("backfillLegacyTitleSessionIdKey(")).toHaveLength(4);
    expect(legacy).toContain("fs.writeFileSync(titlesPath, JSON.stringify(titles, null, 2));");
  });
});
