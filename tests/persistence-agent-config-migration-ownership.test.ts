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
const OWNER = "agent-profile";
const EXEMPTION = "cross-store-legacy-migrations";
const REASON = "Writes the existing per-agent configuration in legacy migrations #47 and #48.";
const CALL = String.raw`writeSecretFileSync( configPath, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"", }), )`;
const TITLE_CALL = "atomicWriteSync(titlePath, JSON.stringify(titles, null, 2))";
const FUNCTIONS = [
  "migrateStableDingTalkCredentialsToLegacyAuthMode",
  "preserveStableCompatibleWorkspaceSkillDiscovery",
] as const;
type TargetFunction = typeof FUNCTIONS[number];

// Migration modules are parsed as text only. No migration, credential writer,
// Engine, or Electron module is imported or executed by these test helpers.
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const parsed = ts.createSourceFile(MODULE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const noOwner = PERSISTENT_STORES.map(store => store.id !== OWNER ? store : {
  ...store, siteRules: store.siteRules.filter(rule => rule.reason !== REASON),
});
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(exemption => exemption.id !== EXEMPTION ? exemption : {
  // Reconstruct only this pair's former exemption. Keep the delivered #53
  // titlePath exclusion instead of restoring a whole-file exemption.
  ...exemption, linePattern: "^(?!.*\\btitlePath\\b)",
});
const review = { classification: "compatible", compatibilityReason: "Test-only reconstruction of the two agent config migration mappings before attribution." };

vi.setConfig({ testTimeout: 30_000 });

function formalCall(functionName: TargetFunction) {
  const declaration = parsed.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
  ));
  if (!declaration?.body) throw new Error(`Missing migration function: ${functionName}`);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "writeSecretFileSync") calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  expect(calls, functionName).toHaveLength(1);
  const call = calls[0];
  const raw = call.getText(parsed);
  expect(raw.trim().replace(/\s+/g, " "), functionName).toBe(CALL);
  return { start: call.getStart(parsed), end: call.getEnd(), raw, declaration };
}

function changedCall(functionName: TargetFunction, replace: (raw: string) => string) {
  const call = formalCall(functionName);
  return new Map([[MODULE, source.slice(0, call.start) + replace(call.raw) + source.slice(call.end)]]);
}

function pairRows(value) {
  return value.discoveredSites.filter(site => site.sourceFile === MODULE && site.kind === "secret-write" && site.excerpt === CALL);
}

function changedRows(before, after) {
  expect(before).toHaveLength(after.length);
  return before.map((row, index) => ({ before: row, after: after[index] }))
    .filter(({ before: oldRow, after: newRow }) => JSON.stringify(oldRow) !== JSON.stringify(newRow));
}

function stableFingerprintFields(fingerprint) {
  const unchanged = { ...fingerprint };
  for (const key of ["exemptions", "siteMappings", "payloadFingerprint", "review"]) delete unchanged[key];
  return unchanged;
}

function assertCurrentMetadata() {
  const actual = scanPersistentStores({ rootDir: ROOT });
  expect(actual.inventory).toEqual(inventory);
  expect(actual.startupReceipt).toEqual(receipt);
  return actual;
}

async function assertFingerprintRejects(mutatedInventory, sourceOverrides: Map<string, string>) {
  const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: mutatedInventory, sourceOverrides, review });
  expect(mutation.schemas).toEqual(committed.schemas);
  expect(mutation.registry).toEqual(committed.registry);
  expect(mutation.dataEpoch).toBe(1);
  expect(mutation.payloadFingerprint).not.toBe(committed.payloadFingerprint);
  await expect(assertCommittedPersistenceSchemaFingerprint({
    rootDir: ROOT, inventory: mutatedInventory, committedFingerprint: committed, sourceOverrides,
  })).rejects.toThrow(`persistence schema fingerprint mismatch: committed ${committed.payloadFingerprint}, generated ${mutation.payloadFingerprint}`);
}

describe("agent config migration #47/#48 persistence ownership", () => {
  it("moves exactly the two existing secret writes without changing descriptors or phases", () => {
    const actual = assertCurrentMetadata();
    const previous = scanPersistentStores({ rootDir: ROOT, stores: noOwner, exemptions: priorExemptions });
    for (const value of [previous.inventory, actual.inventory]) {
      expect(value.stores).toHaveLength(65);
      expect(value.discoveredSites).toHaveLength(905);
      expect(value.exemptions).toHaveLength(32);
    }
    const ownerRules = PERSISTENT_STORES.find(store => store.id === OWNER)?.siteRules.filter(rule => rule.reason === REASON);
    expect(ownerRules).toHaveLength(1);
    expect(ownerRules?.[0]).toMatchObject({ sourceFile: MODULE, kinds: ["secret-write"] });
    expect(pairRows(previous.inventory)).toEqual([0, 1].map(ordinal => ({
      ...pairRows(previous.inventory)[0], ordinal, storeId: null, exemptionId: EXEMPTION,
    })));
    expect(pairRows(actual.inventory)).toEqual([0, 1].map(ordinal => ({
      ...pairRows(previous.inventory)[0], ordinal, storeId: OWNER, exemptionId: null, reason: REASON,
    })));
    const changed = changedRows(previous.inventory.discoveredSites, actual.inventory.discoveredSites);
    expect(changed).toHaveLength(2);
    for (const { before, after } of changed) {
      expect(before).toMatchObject({ sourceFile: MODULE, kind: "secret-write", excerpt: CALL, storeId: null, exemptionId: EXEMPTION });
      expect(after).toEqual({ ...before, storeId: OWNER, exemptionId: null, reason: REASON });
    }
    expect(actual.inventory.stores).toEqual(previous.inventory.stores);
    expect(actual.startupReceipt).toEqual(previous.startupReceipt);
    const exemptionChanges = changedRows(previous.inventory.exemptions, actual.inventory.exemptions);
    expect(exemptionChanges).toHaveLength(1);
    expect(exemptionChanges[0].before).toMatchObject({ id: EXEMPTION, expiresOn: "2026-11-17", linePattern: "^(?!.*\\btitlePath\\b)" });
    expect(exemptionChanges[0].after).toEqual({ ...exemptionChanges[0].before, linePattern: exemptionChanges[0].after.linePattern });
    const datedIds = new Set(actual.inventory.exemptions.filter(exemption => exemption.expiresOn === "2026-11-17").map(exemption => exemption.id));
    expect(datedIds.size).toBe(6);
    expect(previous.inventory.discoveredSites.filter(site => datedIds.has(site.exemptionId))).toHaveLength(87);
    expect(actual.inventory.discoveredSites.filter(site => datedIds.has(site.exemptionId))).toHaveLength(85);
    expect(previous.inventory.discoveredSites.filter(site => site.exemptionId === EXEMPTION)).toHaveLength(69);
    expect(actual.inventory.discoveredSites.filter(site => site.exemptionId === EXEMPTION)).toHaveLength(67);
  });

  it("changes only the two fingerprint mappings, narrowed exemption, and compatible review", async () => {
    assertCurrentMetadata();
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed })).resolves.toEqual(committed);
    const previousInventory = scanPersistentStores({ rootDir: ROOT, stores: noOwner, exemptions: priorExemptions }).inventory;
    const previous = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, review });
    expect(stableFingerprintFields(previous)).toEqual(stableFingerprintFields(committed));
    expect(previous.schemas).toEqual(committed.schemas);
    expect(committed.schemas).toHaveLength(65);
    expect(JSON.stringify(committed.schemas)).not.toContain(MODULE);
    expect(committed.review.classification).toBe("compatible");
    expect(committed.review.payloadFingerprint).toBe(committed.payloadFingerprint);
    expect(committed.dataEpoch).toBe(1);
    const changed = changedRows(previous.siteMappings, committed.siteMappings);
    expect(changed).toHaveLength(2);
    expect(changed.map(({ before }) => before.ordinal)).toEqual([0, 1]);
    for (const { before, after } of changed) {
      expect(before).toMatchObject({ sourceFile: MODULE, kind: "secret-write", storeId: null, exemptionId: EXEMPTION });
      expect(after).toEqual({ ...before, storeId: OWNER, exemptionId: null, reason: REASON });
    }
    expect(changedRows(previous.exemptions, committed.exemptions)).toHaveLength(1);
    expect(committed.exemptions).toEqual(inventory.exemptions);
    await assertFingerprintRejects(previousInventory, new Map());
  });

  it("rejects the pair without its owner instead of relying on an unrelated failure", () => {
    assertCurrentMetadata();
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner }))
      .toThrow(/unregistered persistence site: core\/migrations[.]ts:\d+ secret-write writeSecretFileSync\( configPath, YAML[.]dump\(config,/);
  });

  it("rejects simultaneous pair ownership and the previous legacy exemption", () => {
    assertCurrentMetadata();
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions }))
      .toThrow(/ambiguous persistence site: core\/migrations[.]ts:\d+ secret-write matches store:agent-profile, exemption:cross-store-legacy-migrations/);
  });

  it.each(FUNCTIONS)("detects deletion of the call in %s although the shared rule still matches", async functionName => {
    assertCurrentMetadata();
    const sourceOverrides = changedCall(functionName, () => "void 0");
    const mutated = scanPersistentStores({ rootDir: ROOT, sourceOverrides });
    expect(mutated.inventory.discoveredSites).toHaveLength(904);
    expect(pairRows(mutated.inventory)).toHaveLength(1);
    expect(pairRows(mutated.inventory)[0]).toMatchObject({ ordinal: 0, storeId: OWNER, exemptionId: null });
    expect(mutated.startupReceipt).toEqual(receipt);
    await assertFingerprintRejects(mutated.inventory, sourceOverrides);
  });

  it.each(FUNCTIONS)("detects duplication of the call in %s through exact multiplicity and the fingerprint", async functionName => {
    assertCurrentMetadata();
    const sourceOverrides = changedCall(functionName, raw => `${raw};\n      ${raw}`);
    const mutated = scanPersistentStores({ rootDir: ROOT, sourceOverrides });
    expect(mutated.inventory.discoveredSites).toHaveLength(906);
    expect(pairRows(mutated.inventory)).toEqual([0, 1, 2].map(ordinal => ({ ...pairRows(inventory)[0], ordinal })));
    expect(mutated.startupReceipt).toEqual(receipt);
    await assertFingerprintRejects(mutated.inventory, sourceOverrides);
  });

  it("rejects deletion of both calls through the dangling exact owner rule", () => {
    assertCurrentMetadata();
    let neither = source;
    for (const call of FUNCTIONS.map(formalCall).sort((left, right) => right.start - left.start)) {
      neither = neither.slice(0, call.start) + "void 0" + neither.slice(call.end);
    }
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: new Map([[MODULE, neither]]) }))
      .toThrow(/dangling persistence rule for store agent-profile: core\/migrations[.]ts/);
  });

  describe.each(FUNCTIONS)("formal call drift in %s", functionName => {
    it.each([
      ["payload", "YAML.dump(config,", "YAML.dump(otherConfig,"],
      ["kind", "writeSecretFileSync(", "fs.writeFileSync("],
      ["target", "configPath,", "otherConfigPath,"],
    ])("detects %s changes even when the inherited legacy exemption accepts the changed expression", async (_label, before, after) => {
      assertCurrentMetadata();
      const original = formalCall(functionName);
      expect(original.raw.split(before)).toHaveLength(2);
      const replacement = original.raw.replace(before, after);
      const sourceOverrides = changedCall(functionName, () => replacement);
      const mutated = scanPersistentStores({ rootDir: ROOT, sourceOverrides });
      expect(mutated.inventory.discoveredSites).toHaveLength(905);
      expect(pairRows(mutated.inventory)).toHaveLength(1);
      expect(mutated.inventory.discoveredSites.filter(site => site.sourceFile === MODULE && site.excerpt === replacement.trim().replace(/\s+/g, " ")))
        .toEqual([expect.objectContaining({ storeId: null, exemptionId: EXEMPTION })]);
      expect(mutated.inventory).not.toEqual(inventory);
      expect(mutated.startupReceipt).toEqual(receipt);
      await assertFingerprintRejects(mutated.inventory, sourceOverrides);
    });
  });

  it("accepts ordinary comment and line movement without changing metadata or fingerprint", async () => {
    assertCurrentMetadata();
    const sourceOverrides = new Map([[MODULE, `// Comment-only displacement before the migration registry.\n\n${source}`]]);
    const moved = scanPersistentStores({ rootDir: ROOT, sourceOverrides });
    expect(moved.inventory).toEqual(inventory);
    expect(moved.startupReceipt).toEqual(receipt);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: moved.inventory, committedFingerprint: committed, sourceOverrides })).resolves.toEqual(committed);
  });

  it("retains the delivered #53 title owner and its exclusion from legacy migration coverage", () => {
    const actual = assertCurrentMetadata();
    const previous = scanPersistentStores({ rootDir: ROOT, stores: noOwner, exemptions: priorExemptions });
    const titles = value => value.discoveredSites.filter(site => site.sourceFile === MODULE && site.excerpt === TITLE_CALL);
    expect(titles(actual.inventory)).toEqual([expect.objectContaining({ kind: "atomic-write", storeId: "session-sidecars", exemptionId: null, ordinal: 0 })]);
    expect(titles(previous.inventory)).toEqual(titles(actual.inventory));
    const sourceOverrides = new Map([[MODULE, `${source}\nfs.writeFileSync(titlePath, "extra");\n`]]);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides }))
      .toThrow(/unregistered persistence site: core\/migrations[.]ts:\d+ write-file fs[.]writeFileSync\(titlePath,/);
  });

  it("locates the two real agent config writes and their existing dispatch without executing migrations", () => {
    expect(source).toContain("47: migrateStableDingTalkCredentialsToLegacyAuthMode,");
    expect(source).toContain("48: preserveStableCompatibleWorkspaceSkillDiscovery,");
    for (const functionName of FUNCTIONS) {
      const { declaration } = formalCall(functionName);
      const body = declaration.getText(parsed);
      expect(body).toContain("if (!fs.lstatSync(agentsDir).isDirectory())");
      expect(body).toContain("if (!entry.isDirectory()) continue;");
      expect(body).toContain('const configPath = path.join(agentsDir, entry.name, "config.yaml");');
      expect(body).toContain("fs.lstatSync(configPath)");
      expect(body).toContain(".isFile()");
    }
    expect(PERSISTENT_STORES.filter(store => store.pathPatterns.includes("agents/{agentId}/config.yaml")).map(store => store.id)).toEqual([OWNER]);
    const owner = PERSISTENT_STORES.find(store => store.id === OWNER);
    expect(owner).toMatchObject({ ownerModule: "core/agent-manager.ts", firstPossibleOpenPhase: "first_run_seed", firstPossibleWritePhase: "first_run_seed" });
    expect(owner?.migrationEntry).toEqual(["lib/compat/checks/config-yaml.ts", "core/agents-md-migration.ts"]);
    expect(owner?.protocolModules).not.toContain(MODULE);
  });
});
