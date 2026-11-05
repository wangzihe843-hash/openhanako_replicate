import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFirstRun } from "../core/first-run.ts";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import { isValidAgentId } from "../shared/agent-id.ts";
import { isReservedAgentScopeId } from "../shared/reserved-agent-scopes.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "agent-profile";
const AGENT_ID = "shared/agent-id.ts";
const RESERVED = "shared/reserved-agent-scopes.ts";
const ADDED = [AGENT_ID, RESERVED];
const sources = new Map(ADDED.map((module) => [module, fs.readFileSync(path.join(ROOT, module), "utf8")]));
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const review = { classification: "compatible", compatibilityReason: "Test-only dependency coverage comparison." };
const tempDirs: string[] = [];
const mutations = [
  [AGENT_ID, '  if (typeof value !== "string") return false;', '  if (typeof value !== "string") return false;\n  if (value === "hanako") return false;'],
  [RESERVED, 'return /^__.+__$/.test(id);', 'return id === "hanako" || /^__.+__$/.test(id);'],
];

afterEach(() => {
  vi.doUnmock("../shared/agent-id.ts");
  vi.doUnmock("../shared/reserved-agent-scopes.ts");
  vi.resetModules();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function changedSource(module: string, before: string, after: string) {
  const text = sources.get(module)!;
  expect(text.split(before)).toHaveLength(2);
  return text.replace(before, after);
}

function withoutModules(modules: string[]) {
  return {
    ...inventory,
    stores: inventory.stores.map((store: { id: string; protocolModules: string[] }) => store.id !== OWNER ? store : {
      ...store, protocolModules: store.protocolModules.filter((module) => !modules.includes(module)),
    }),
  };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-first-run-id-protocol-"));
  tempDirs.push(root);
  const home = path.join(root, "home"), product = path.join(root, "product");
  const target = path.join(home, "agents", "hanako", "config.yaml");
  const original = "agent:\n  name: User Customization\n  yuan: hanako\n";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(product, { recursive: true });
  fs.writeFileSync(target, original);
  fs.writeFileSync(path.join(product, "config.example.yaml"), "agent:\n  name: Seed Template\n  yuan: hanako\n");
  vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "os-home"));
  return { home, product, target, original };
}

// Execute the actual classifier source with just the selected mutation applied.
// The first-run module itself remains unchanged and imports these test modules.
function compileClassifier(text: string, dependencies: Record<string, object> = {}) {
  const output = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(output, {
    exports,
    require: (specifier: string) => {
      if (!(specifier in dependencies)) throw new Error(`unexpected classifier dependency: ${specifier}`);
      return dependencies[specifier];
    },
  });
  return exports;
}

describe("first-run agent ID classification protocol dependencies", () => {
  it("registers only the two profile dependencies without changing sites, exemptions or startup receipt", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
    expect(inventory.stores).toHaveLength(65);
    expect(inventory.discoveredSites).toHaveLength(905);
    expect(inventory.exemptions).toHaveLength(32);
    const dated = inventory.exemptions.filter((entry: { expiresOn: string }) => entry.expiresOn === "2026-11-17");
    expect(dated).toHaveLength(6);
    expect(inventory.discoveredSites.filter((site: { exemptionId: string | null }) => dated.some((entry: { id: string }) => entry.id === site.exemptionId))).toHaveLength(89);
    expect(inventory.discoveredSites.filter((site: { exemptionId: string | null }) => site.exemptionId === "cross-store-first-run-bootstrap")).toHaveLength(11);
  });

  it("removes only the two registrations from the previous inventory", () => {
    const previousStores = PERSISTENT_STORES.map((store) => store.id !== OWNER ? store : {
      ...store, protocolModules: store.protocolModules.filter((module) => !ADDED.includes(module)),
    });
    const previous = scanPersistentStores({ rootDir: ROOT, stores: previousStores });
    expect(previous.inventory).toEqual(withoutModules(ADDED));
    expect(previous.startupReceipt).toEqual(receipt);
  });

  it("changes only the profile entries in the schema fingerprint", async () => {
    const previous = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: withoutModules(ADDED), review });
    const { registry: previousRegistry, schemas: previousSchemas, payloadFingerprint: previousHash, review: previousReview, ...previousRest } = previous;
    const { registry, schemas, payloadFingerprint, review: actualReview, ...rest } = committed;
    expect(rest).toEqual(previousRest);
    expect(rest.dataEpoch).toBe(1);
    expect(payloadFingerprint).not.toBe(previousHash);
    expect(previousReview.classification).toBe("compatible");
    expect(actualReview.classification).toBe("compatible");
    expect(actualReview.compatibilityReason).toMatch(/classifies.*avatar.*agent-profile/i);
    expect(actualReview.compatibilityReason).toMatch(/whole file/i);
    expect(registry.filter((store: { id: string }) => store.id !== OWNER)).toEqual(previousRegistry.filter((store: { id: string }) => store.id !== OWNER));
    expect(schemas.filter((schema: { storeId: string }) => schema.storeId !== OWNER)).toEqual(previousSchemas.filter((schema: { storeId: string }) => schema.storeId !== OWNER));
    const profile = registry.find((store: { id: string }) => store.id === OWNER);
    const previousProfile = previousRegistry.find((store: { id: string }) => store.id === OWNER);
    expect({ ...profile, protocolModules: previousProfile.protocolModules }).toEqual(previousProfile);
    expect(profile.protocolModules.filter((module: string) => !ADDED.includes(module))).toEqual(previousProfile.protocolModules);
    const schema = schemas.find((entry: { storeId: string }) => entry.storeId === OWNER);
    const previousSchema = previousSchemas.find((entry: { storeId: string }) => entry.storeId === OWNER);
    expect({ ...schema, protocolModules: previousSchema.protocolModules }).toEqual(previousSchema);
    expect(schema.protocolModules.filter((entry: { module: string }) => !ADDED.includes(entry.module))).toEqual(previousSchema.protocolModules);
    for (const module of ADDED) expect(schema.protocolModules).toContainEqual({ module, sourceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
  });

  it("leaves an existing valid default configuration untouched on normal startup", () => {
    const { home, product, target, original } = setup();
    expect(isValidAgentId("hanako")).toBe(true);
    expect(isReservedAgentScopeId("hanako")).toBe(false);
    const result = ensureFirstRun(home, product);
    expect(result.repairedDefaultAgent).toBe(false);
    expect(result.defaultConfigBackupPath).toBeNull();
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith("config.yaml.broken-"))).toEqual([]);
  });

  it.each(mutations)("shows the real first-run consequence when %s excludes the valid default", async (module, before, after) => {
    const changed = changedSource(module, before, after);
    const reserved = compileClassifier(module === RESERVED ? changed : sources.get(RESERVED)!);
    const agentId = compileClassifier(module === AGENT_ID ? changed : sources.get(AGENT_ID)!, { "./reserved-agent-scopes.ts": reserved });
    expect((agentId.isValidAgentId as (value: string) => boolean)("hanako")).toBe(module !== AGENT_ID);
    expect((reserved.isReservedAgentScopeId as (value: string) => boolean)("hanako")).toBe(module === RESERVED);
    vi.resetModules();
    vi.doMock("../shared/agent-id.ts", () => agentId);
    vi.doMock("../shared/reserved-agent-scopes.ts", () => reserved);
    const { ensureFirstRun: mutatedFirstRun } = await import("../core/first-run.ts");
    const { home, product, target, original } = setup();
    const result = mutatedFirstRun(home, product);
    expect(result.repairedDefaultAgent).toBe(true);
    expect(result.defaultConfigBackupPath).toBeNull();
    expect(fs.readFileSync(target, "utf8")).not.toBe(original);
    expect(fs.readFileSync(target, "utf8")).toContain("Seed Template");
    expect(fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith("config.yaml.broken-"))).toEqual([]);
  });

  it.each(mutations)("the default fingerprint rejects the same %s mutation", async (module, before, after) => {
    const sourceOverrides = new Map([[module, changedSource(module, before, after)]]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides })).rejects.toThrow(/persistence schema fingerprint mismatch/);
  });

  it.each(mutations)("shows the %s mutation would be missed without its registration", async (module, before, after) => {
    const previousInventory = withoutModules([module]);
    const previous = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, review });
    const sourceOverrides = new Map([[module, changedSource(module, before, after)]]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, committedFingerprint: previous, sourceOverrides })).resolves.toEqual(previous);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, committedFingerprint: committed })).rejects.toThrow(/persistence schema fingerprint mismatch/);
    const changed = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review });
    expect(changed.schemas.filter((schema: { storeId: string }) => JSON.stringify(schema) !== JSON.stringify(committed.schemas.find((entry: { storeId: string }) => entry.storeId === schema.storeId)))
      .map((schema: { storeId: string }) => schema.storeId)).toEqual([OWNER]);
    expect(changed.registry).toEqual(committed.registry);
    expect(changed.siteMappings).toEqual(committed.siteMappings);
    expect(changed.exemptions).toEqual(committed.exemptions);
  });

  it("also requires review for unrelated executable changes in a registered whole file", async () => {
    const sourceOverrides = new Map([[AGENT_ID, changedSource(AGENT_ID, 'this.name = "InvalidAgentIdError";', 'this.name = "ChangedAgentIdError";')]]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides }))
      .rejects.toThrow(/persistence schema fingerprint mismatch/);
  });

  it.each(ADDED)("accepts ordinary comment and line drift in %s", async (module) => {
    const sourceOverrides = new Map([[module, `// Ordinary comment.\n\n${sources.get(module)!}`]]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).resolves.toEqual(committed);
  });

  it("preserves the inventory and startup receipt with comments and line drift in both files", () => {
    const sourceOverrides = new Map(ADDED.map((module) => [module, `// Ordinary comment.\n\n${sources.get(module)!}`]));
    const result = scanPersistentStores({ rootDir: ROOT, sourceOverrides });
    expect(result.inventory).toEqual(inventory);
    expect(result.startupReceipt).toEqual(receipt);
  });

  it.each([
    [AGENT_ID, 'WINDOWS_RESERVED_NAMES.has(value.toLowerCase())', '/* @__PURE__ */ WINDOWS_RESERVED_NAMES.has(value.toLowerCase())'],
    [RESERVED, '/^__.+__$/.test(id)', '/* @__PURE__ */ /^__.+__$/.test(id)'],
    [AGENT_ID, 'export function isValidAgentId(', '/* #__NO_SIDE_EFFECTS__ */ export function isValidAgentId('],
    [RESERVED, 'export function isReservedAgentScopeId(', '/* #__NO_SIDE_EFFECTS__ */ export function isReservedAgentScopeId('],
  ])("rejects an effective build annotation in %s", async (module, before, after) => {
    const sourceOverrides = new Map([[module, changedSource(module, before, after)]]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides }))
      .rejects.toThrow(/effective PURE or NO_SIDE_EFFECTS build annotation/);
  });
});
