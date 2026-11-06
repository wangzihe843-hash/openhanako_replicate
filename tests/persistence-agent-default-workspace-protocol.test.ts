import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "agent-profile";
const WORKSPACE = "shared/default-workspace.ts";
const CONSTANTS = "shared/default-workspace-constants.ts";
const ADDED = [WORKSPACE, CONSTANTS];
const oldModules = [
  "core/agent.ts", "core/persona-source.ts", "core/first-run.ts", "shared/agent-id.ts", "shared/reserved-agent-scopes.ts", "server/index.ts", "desktop/bootstrap.cjs",
  "shared/hana-runtime-paths.ts", "shared/hana-runtime-paths.cjs", "shared/hana-root.ts",
  "core/agents-md-migration.ts", "core/engine.ts", "shared/config-schema.ts", "shared/migrate-config-scope.ts",
];
const workspaceSource = fs.readFileSync(path.join(ROOT, WORKSPACE), "utf8");
const constantsSource = fs.readFileSync(path.join(ROOT, CONSTANTS), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const review = { classification: "compatible", compatibilityReason: "Test-only dependency coverage comparison." };

function inventoryWithout(modules: string[]) {
  return {
    ...inventory,
    stores: inventory.stores.map((store: { id: string; protocolModules: string[] }) => store.id !== OWNER ? store : {
      ...store, protocolModules: store.protocolModules.filter((module) => !modules.includes(module)),
    }),
  };
}

function changedSource(module: string, text: string, before: string, after: string) {
  expect(text.split(before)).toHaveLength(2);
  return new Map([[module, text.replace(before, after)]]);
}

describe("agent profile default workspace protocol dependencies", () => {
  it("retains the committed inventory, receipt, dated exemptions and external workspace sites", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
    expect(inventory.stores).toHaveLength(65);
    expect(inventory.discoveredSites).toHaveLength(905);
    expect(inventory.exemptions).toHaveLength(32);
    const dated = inventory.exemptions.filter((e: { expiresOn: string }) => e.expiresOn === "2026-11-17");
    expect(dated).toHaveLength(6);
    expect(inventory.discoveredSites.filter((s: { exemptionId: string | null }) => dated.some((e: { id: string }) => e.id === s.exemptionId))).toHaveLength(83);
    expect(inventory.discoveredSites.filter((s: { sourceFile: string }) => s.sourceFile === WORKSPACE))
      .toEqual([
        expect.objectContaining({ kind: "mkdir", excerpt: "fs.mkdirSync(defaultPath, { recursive: true })", storeId: null, exemptionId: "external-default-workspace" }),
        expect.objectContaining({ kind: "mkdir", excerpt: "fs.mkdirSync(workspacePath, { recursive: true })", storeId: null, exemptionId: "external-default-workspace" }),
      ]);
    expect(inventory.discoveredSites).toContainEqual(expect.objectContaining({
      sourceFile: "core/first-run.ts", kind: "secret-write", storeId: OWNER, exemptionId: null,
    }));
    const profile = inventory.stores.find((store: { id: string }) => store.id === OWNER);
    expect(profile.pathPatterns).toContain("agents/{agentId}/config.yaml");
    expect(profile.firstPossibleOpenPhase).toBe("first_run_seed");
    expect(profile.firstPossibleWritePhase).toBe("first_run_seed");
    expect(profile.protocolModules).toEqual([...oldModules.slice(0, 11), ...ADDED, ...oldModules.slice(11)]);
  });

  it("changes no owner, site mapping, exemption or startup phase when the registrations are removed", () => {
    const stores = PERSISTENT_STORES.map((store) => store.id !== OWNER ? store : {
      ...store, protocolModules: store.protocolModules.filter((module) => !ADDED.includes(module)),
    });
    const previous = scanPersistentStores({ rootDir: ROOT, stores });
    expect(previous.inventory).toEqual(inventoryWithout(ADDED));
    expect(previous.inventory.stores.find((store: { id: string }) => store.id === OWNER).protocolModules).toEqual(oldModules);
    expect(previous.inventory.discoveredSites).toEqual(inventory.discoveredSites);
    expect(previous.inventory.exemptions).toEqual(inventory.exemptions);
    expect(previous.startupReceipt).toEqual(receipt);
  });

  it("changes only the profile registry and schema entries in the fingerprint payload", async () => {
    const previous = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: inventoryWithout(ADDED), review });
    const { registry: previousRegistry, schemas: previousSchemas, payloadFingerprint: previousHash, review: previousReview, ...previousRest } = previous;
    const { registry, schemas, payloadFingerprint, review: actualReview, ...rest } = committed;
    expect(rest).toEqual(previousRest);
    expect(rest.dataEpoch).toBe(1);
    expect(payloadFingerprint).not.toBe(previousHash);
    expect(actualReview.classification).toBe("compatible");
    expect(actualReview.compatibilityReason).toMatch(/attribute exactly two.*Cron migration writes.*cron-automation/i);
    expect(actualReview.compatibilityReason).toMatch(/persisted formats.*unchanged/i);
    expect(actualReview.compatibilityReason).toMatch(/whole file/i);
    expect(previousReview.classification).toBe("compatible");
    expect(registry.filter((store: { id: string }) => store.id !== OWNER)).toEqual(previousRegistry.filter((store: { id: string }) => store.id !== OWNER));
    const profile = registry.find((store: { id: string }) => store.id === OWNER);
    const previousProfile = previousRegistry.find((store: { id: string }) => store.id === OWNER);
    expect({ ...profile, protocolModules: previousProfile.protocolModules }).toEqual(previousProfile);
    expect(profile.protocolModules.filter((module: string) => !ADDED.includes(module))).toEqual(previousProfile.protocolModules);
    expect(schemas.filter((schema: { storeId: string }) => schema.storeId !== OWNER)).toEqual(previousSchemas.filter((schema: { storeId: string }) => schema.storeId !== OWNER));
    const schema = schemas.find((entry: { storeId: string }) => entry.storeId === OWNER);
    const previousSchema = previousSchemas.find((entry: { storeId: string }) => entry.storeId === OWNER);
    expect({ ...schema, protocolModules: previousSchema.protocolModules }).toEqual(previousSchema);
    expect(schema.protocolModules.filter((entry: { module: string }) => !ADDED.includes(entry.module))).toEqual(previousSchema.protocolModules);
    for (const module of ADDED) {
      expect(schema.protocolModules).toContainEqual({ module, sourceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    }
  });

  it.each([
    ["heartbeat interval 31 to 37", CONSTANTS, constantsSource, "DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 31", "DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 37"],
    ["workspace Desktop to Documents", WORKSPACE, workspaceSource, 'path.join(homeDir, "Desktop", DEFAULT_WORKSPACE_DIRNAME)', 'path.join(homeDir, "Documents", DEFAULT_WORKSPACE_DIRNAME)'],
    // The protocol hash covers the whole file, including unrelated social defaults.
    ["unrelated social threshold 80 to 81", CONSTANTS, constantsSource, "DEFAULT_SOCIAL_GLOBAL_THRESHOLD = 80", "DEFAULT_SOCIAL_GLOBAL_THRESHOLD = 81"],
  ])("rejects %s in %s", async (_case, module, text, before, after) => {
    const sourceOverrides = changedSource(module, text, before, after);
    const modified = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review });
    expect(modified.schemas.filter((schema: { storeId: string }) => JSON.stringify(schema) !== JSON.stringify(committed.schemas.find((entry: { storeId: string }) => entry.storeId === schema.storeId)))
      .map((schema: { storeId: string }) => schema.storeId)).toEqual([OWNER]);
    expect(modified.registry).toEqual(committed.registry);
    expect(modified.siteMappings).toEqual(committed.siteMappings);
    expect(modified.exemptions).toEqual(committed.exemptions);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it.each([
    [WORKSPACE, workspaceSource, 'return path.join(homeDir, "Desktop", DEFAULT_WORKSPACE_DIRNAME);', 'return /* @__PURE__ */ path.join(homeDir, "Desktop", DEFAULT_WORKSPACE_DIRNAME);'],
    [CONSTANTS, constantsSource, "DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 31;", "DEFAULT_HEARTBEAT_INTERVAL_MINUTES = /* @__PURE__ */ Number(31);"],
  ])("rejects an effective build annotation in %s", async (module, text, before, after) => {
    const sourceOverrides = changedSource(module, text, before, after);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides }))
      .rejects.toThrow(/effective PURE or NO_SIDE_EFFECTS build annotation/);
  });

  it.each([[WORKSPACE, workspaceSource], [CONSTANTS, constantsSource]])("accepts ordinary comment and line drift in %s", async (module, text) => {
    const sourceOverrides = new Map([[module, `// Ordinary explanatory comment.\n\n${text}`]]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).resolves.toEqual(committed);
  });

  it("keeps all inventory sites stable when both files gain comments and lines", () => {
    const sourceOverrides = new Map([[WORKSPACE, `// Ordinary comment.\n\n${workspaceSource}`], [CONSTANTS, `// Ordinary comment.\n\n${constantsSource}`]]);
    const actual = scanPersistentStores({ rootDir: ROOT, sourceOverrides });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
  });

  it.each([
    [CONSTANTS, constantsSource, "DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 31", "DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 37"],
    [WORKSPACE, workspaceSource, 'path.join(homeDir, "Desktop", DEFAULT_WORKSPACE_DIRNAME)', 'path.join(homeDir, "Documents", DEFAULT_WORKSPACE_DIRNAME)'],
  ])("demonstrates lost coverage if %s is unregistered", async (module, text, before, after) => {
    const previousInventory = inventoryWithout([module]);
    const previous = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, review });
    const sourceOverrides = changedSource(module, text, before, after);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, committedFingerprint: previous, sourceOverrides })).resolves.toEqual(previous);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, committedFingerprint: committed })).rejects.toThrow(/fingerprint mismatch/);
  });
});
