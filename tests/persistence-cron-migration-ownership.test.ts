import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/migrations.ts";
const OWNER = "cron-automation";
const EXEMPTION = "cross-store-legacy-migrations";
const CALL = 'atomicWriteSync(jobsPath, JSON.stringify({ ...data, jobs }, null, 2) + "\\n")';
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const cron = PERSISTENT_STORES.find(store => store.id === OWNER)!;
const rule = cron.siteRules.find(entry => entry.sourceFile === MODULE)!;
const noOwner = PERSISTENT_STORES.map(store => store.id !== OWNER ? store : {
  ...store, siteRules: store.siteRules.filter(entry => entry !== rule),
});
const priorStores = noOwner.map(store => store.id !== OWNER ? store : {
  ...store, protocolModules: [], firstPossibleWritePhase: "runtime_ready" as const,
  migrationEntry: ["core/migrations.ts cron migrations"],
});
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(entry => entry.id !== EXEMPTION ? entry : {
  ...entry, linePattern: entry.linePattern!.replace("(?!atomicWriteSync\\(jobsPath, JSON\\.stringify\\(\\{ \\.\\.\\.data, jobs \\}, null, 2\\) \\+ \"\\\\n\"\\)$)", ""),
});
const review = { classification: "compatible", compatibilityReason: "Test-only Cron migration attribution mutation." };
const overrides = (text: string) => new Map([[MODULE, text]]);
vi.setConfig({ testTimeout: 30_000 });

function changedRows(before, after) {
  expect(before).toHaveLength(after.length);
  return before.map((row, i) => ({ before: row, after: after[i] }))
    .filter(pair => JSON.stringify(pair.before) !== JSON.stringify(pair.after));
}

function assertMetadata() {
  const actual = scanPersistentStores({ rootDir: ROOT });
  expect(actual.inventory).toEqual(inventory);
  expect(actual.startupReceipt).toEqual(receipt);
  return actual;
}

async function rejectsChangedFingerprint(sourceOverrides) {
  const changedInventory = scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory;
  await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: changedInventory, sourceOverrides, committedFingerprint: committed }))
    .rejects.toThrow(/persistence schema fingerprint mismatch/);
  return changedInventory;
}

// This finite guard covers caller paths/slots in the migration composition file.
// It does not claim that the schema fingerprint hashes all of migrations.ts.
function assertCallerPaths(text: string) {
  const ast = ts.createSourceFile(MODULE, text, ts.ScriptTarget.Latest, true);
  const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(fn => [fn.name?.text, fn.getText(ast)]));
  for (const name of ["migrateCronJobsToAutomationReadModel", "migrateDirectNotifyAutomationsToAgentRuns"]) {
    const body = functions.get(name)!;
    expect(body).toContain('paths.push(path.join(studiosDir, entry.name, "desk", "cron-jobs.json"));');
    expect(body).toContain('paths.push(path.join(agentsDir, entry.name, "desk", "cron-jobs.json"));');
    expect(body).toContain("patchCronJobsFileForAutomation(jobsPath, log)");
  }
  const body = functions.get("repairAutomationOwnershipAfterAgentRunConsolidation")!;
  expect(body).toContain('jobsPath: path.join(studiosDir, entry.name, "desk", "cron-jobs.json")');
  expect(body).toContain('jobsPath: path.join(agentsDir, entry.name, "desk", "cron-jobs.json")');
  expect(body).toContain("repairAutomationOwnershipFile(store.jobsPath, store.fallbackAgentId, log)");
  for (const [id, name] of [[30, "migrateCronJobsToAutomationReadModel"], [38, "migrateDirectNotifyAutomationsToAgentRuns"], [39, "repairAutomationOwnershipAfterAgentRunConsolidation"]]) {
    expect(text).toContain(`${id}: ${name},`);
  }
}

describe("Cron migration persistence ownership", () => {
  it("moves exactly both atomic sites while retaining every identity, path, policy and expiry", () => {
    const actual = assertMetadata();
    const previous = scanPersistentStores({ rootDir: ROOT, stores: priorStores, exemptions: priorExemptions });
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    expect(actual.inventory.stores).toHaveLength(65);
    expect(actual.inventory.exemptions).toHaveLength(32);
    const changes = changedRows(previous.inventory.discoveredSites, actual.inventory.discoveredSites);
    expect(changes).toHaveLength(2);
    expect(changes.map(pair => pair.after.ordinal)).toEqual([0, 1]);
    for (const { before, after } of changes) {
      expect(before).toMatchObject({ sourceFile: MODULE, kind: "atomic-write", excerpt: CALL, storeId: null, exemptionId: EXEMPTION });
      expect(after).toEqual({ ...before, storeId: OWNER, exemptionId: null, reason: rule.reason });
    }
    const stores = changedRows(previous.inventory.stores, actual.inventory.stores);
    expect(stores).toHaveLength(1);
    expect(stores[0].after).toEqual({ ...stores[0].before, migrationEntry: cron.migrationEntry, protocolModules: cron.protocolModules, firstPossibleWritePhase: "engine_init_legacy_migrations" });
    const phases = changedRows(previous.startupReceipt.stores, actual.startupReceipt.stores);
    expect(phases).toHaveLength(1);
    expect(phases[0].before.id).toBe(OWNER);
    expect(phases[0].after).toEqual({ ...phases[0].before, firstPossibleWritePhase: "engine_init_legacy_migrations" });
    expect({ ...previous.startupReceipt, stores: actual.startupReceipt.stores }).toEqual(actual.startupReceipt);
    expect(changedRows(previous.inventory.exemptions, actual.inventory.exemptions)).toEqual([
      { before: previous.inventory.exemptions.find(entry => entry.id === EXEMPTION), after: actual.inventory.exemptions.find(entry => entry.id === EXEMPTION) },
    ]);
    expect(actual.inventory.exemptions.map(entry => [entry.id, entry.expiresOn])).toEqual(previous.inventory.exemptions.map(entry => [entry.id, entry.expiresOn]));
    expect(previous.inventory.discoveredSites.filter(site => site.exemptionId === EXEMPTION)).toHaveLength(66);
    expect(actual.inventory.discoveredSites.filter(site => site.exemptionId === EXEMPTION)).toHaveLength(64);
    const dated = new Set(actual.inventory.exemptions.filter(entry => entry.expiresOn === "2026-11-17").map(entry => entry.id));
    expect(previous.inventory.discoveredSites.filter(site => dated.has(site.exemptionId))).toHaveLength(83);
    expect(actual.inventory.discoveredSites.filter(site => dated.has(site.exemptionId))).toHaveLength(81);
    const cronModelWrites = actual.inventory.discoveredSites.filter(site => site.sourceFile === MODULE && (
      site.excerpt === 'fs.renameSync(tmp, jobsPath)' || site.excerpt === 'fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\\n", "utf-8")'
    ));
    expect(cronModelWrites.map(site => site.kind).sort()).toEqual(["rename", "write-file"]);
    expect(cronModelWrites.every(site => site.exemptionId === EXEMPTION)).toBe(true);
  });

  it("changes only the Cron schema dependencies, registry, two mappings and narrowed exemption", async () => {
    assertMetadata();
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toEqual(committed);
    const previousInventory = scanPersistentStores({ rootDir: ROOT, stores: priorStores, exemptions: priorExemptions }).inventory;
    const previous = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, review });
    expect(previous.dataEpoch).toBe(committed.dataEpoch);
    expect(changedRows(previous.registry, committed.registry)).toHaveLength(1);
    expect(changedRows(previous.siteMappings, committed.siteMappings)).toHaveLength(2);
    expect(changedRows(previous.exemptions, committed.exemptions)).toHaveLength(1);
    expect(changedRows(previous.schemas, committed.schemas)).toHaveLength(1);
    expect(committed.schemas.filter(schema => schema.storeId !== OWNER)).toEqual(previous.schemas.filter(schema => schema.storeId !== OWNER));
    expect(committed.schemas.find(schema => schema.storeId === OWNER)).toEqual({
      ...previous.schemas.find(schema => schema.storeId === OWNER),
      protocolModules: committed.schemas.find(schema => schema.storeId === OWNER).protocolModules,
    });
    expect(committed.schemas.find(schema => schema.storeId === OWNER).protocolModules.map(entry => entry.module)).toEqual([
      "lib/desk/agent-run-automation.ts", "lib/desk/automation-normalizer.ts", "shared/safe-fs.ts",
    ]);
  });

  it("rejects missing or overlapping ownership", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner })).toThrow(/unregistered persistence site: core\/migrations[.]ts:\d+ atomic-write atomicWriteSync\(jobsPath/);
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions })).toThrow(/ambiguous persistence site/);
    const duplicate = PERSISTENT_STORES.map(store => store.id !== "session-sidecars" ? store : { ...store, siteRules: [...store.siteRules, rule] });
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: duplicate })).toThrow(/ambiguous persistence site/);
  });

  it.each([0, 1])("detects deletion or a wrong target at occurrence %i", async ordinal => {
    expect(source.split(CALL)).toHaveLength(3);
    const offset = ordinal === 0 ? source.indexOf(CALL) : source.lastIndexOf(CALL);
    for (const replacement of ["void jobsPath", CALL.replace("jobsPath", "otherJobsPath")]) {
      await rejectsChangedFingerprint(overrides(source.slice(0, offset) + replacement + source.slice(offset + CALL.length)));
    }
  });

  it("rejects both deleted calls through the dangling rule", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replaceAll(CALL, "void jobsPath")) })).toThrow(/dangling persistence rule for store cron-automation/);
  });

  it("detects an identical third write through the inventory and committed fingerprint", async () => {
    const changed = await rejectsChangedFingerprint(overrides(`${source}\nfunction extraCronPublisher(jobsPath, data, jobs) { ${CALL}; }\n`));
    expect(changed.discoveredSites).toHaveLength(906);
    expect(changed.discoveredSites.filter(site => site.sourceFile === MODULE && site.excerpt === CALL).map(site => site.ordinal)).toEqual([0, 1, 2]);
  });

  it.each([
    ["lib/desk/automation-normalizer.ts", "AUTOMATION_SCHEMA_VERSION = 4", "AUTOMATION_SCHEMA_VERSION = 5"],
    ["lib/desk/agent-run-automation.ts", 'return JSON.stringify(value ?? {});', 'return JSON.stringify(value ?? null);'],
    ["shared/safe-fs.ts", 'const tmp = filePath + ".tmp";', 'const tmp = filePath + ".other-stage";'],
  ])("detects executable dependency drift in %s with an unchanged inventory", async (module, before, after) => {
    const text = fs.readFileSync(path.join(ROOT, module), "utf8");
    expect(text.split(before)).toHaveLength(2);
    const sourceOverrides = new Map([[module, text.replace(before, after)]]);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
    const changed = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review });
    expect(changed.schemas.find(schema => schema.storeId === OWNER)).not.toEqual(committed.schemas.find(schema => schema.storeId === OWNER));
    await rejectsChangedFingerprint(sourceOverrides);
  });

  it("accepts ordinary comments and line movement", async () => {
    const sourceOverrides = new Map([MODULE, ...cron.protocolModules].map(module => [module, `// comment only\n\n${fs.readFileSync(path.join(ROOT, module), "utf8")}`]));
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, committedFingerprint: committed })).resolves.toEqual(committed);
  });

  it("guards actual callers, paths and init phase without running other migrations", () => {
    assertCallerPaths(source);
    for (const root of ["studiosDir", "agentsDir"]) {
      const before = `path.join(${root}, entry.name, "desk", "cron-jobs.json")`;
      expect(() => assertCallerPaths(source.replace(before, before.replace("cron-jobs.json", "wrong.json")))).toThrow();
    }
    expect(cron.pathPatterns).toEqual([
      "agents/{agentId}/desk/cron-jobs.json", "agents/{agentId}/desk/cron-runs/{runId}.json",
      "studios/{studioId}/desk/cron-jobs.json", "studios/{studioId}/desk/cron-runs/{runId}.json",
    ]);
    const engine = fs.readFileSync(path.join(ROOT, "core/engine.ts"), "utf8");
    const init = engine.slice(engine.indexOf("  async init(log:"), engine.indexOf("  async initPlugins("));
    expect(init).toContain('runBestEffortStartupMigrationStep("migration-registry", () => runMigrations({');
    expect(init.indexOf("runMigrations({")).toBeLessThan(init.indexOf("await this._models.init();"));
    expect(cron.firstPossibleWritePhase).toBe("engine_init_legacy_migrations");
    expect(cron.protocolModules).not.toContain(MODULE);
    // Recovery is the existing CronStore protocol, not a new migration rollback.
    const reader = fs.readFileSync(path.join(ROOT, "lib/desk/cron-store.ts"), "utf8");
    expect(reader).toContain('const tmpPath = this._jobsPath + ".tmp";');
    expect(reader).toContain("const data = parseCronStoreDocument(tmpBytes);");
    expect(reader).toContain("fs.renameSync(tmpPath, this._jobsPath);");
  });
});
