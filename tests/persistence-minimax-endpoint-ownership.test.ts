import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCTION_ROOTS, scanPersistentStores, writeReceipts } from "../scripts/scan-persistent-stores.mjs";
import { assertMiniMaxEndpointReceipt } from "../scripts/persistence-minimax-endpoint.mjs";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint, writePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { PERSISTENT_STORES, PERSISTENCE_EXEMPTIONS } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/migrations.ts";
const EXEMPTION = "cross-store-legacy-migrations";
const EXPRESSION = "writeSecretFileSync(ymlPath, yamlStr)";
const text = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(e => { const previous = { ...e }; delete previous.excludedSites; return previous; });
const priorStores = PERSISTENT_STORES.map(s => s.id === "provider-state" ? { ...s, protocolModules: [] } : s);
const review = { classification: "compatible", compatibilityReason: "Test-only MiniMax endpoint ownership comparison." };
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function mutate(before: string, after: string, module = MODULE) {
  const original = module === MODULE ? text : fs.readFileSync(path.join(ROOT, module), "utf8");
  expect(original.includes(before)).toBe(true);
  return new Map([[module, original.replace(before, after)]]);
}

describe("MiniMax #35 exact persistence ownership", () => {
  const commentSourceOverrides = new Map([[MODULE, `// Ordinary source comment.\n\n${text}`]]);

  it("moves one occurrence, preserves both peer exemptions and all remaining sites", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    const previous = scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions, stores: priorStores });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    const changed = previous.inventory.discoveredSites.map((before, i) => ({ before, after: actual.inventory.discoveredSites[i] }))
      .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(changed).toHaveLength(1);
    expect(changed[0].before).toMatchObject({ sourceFile: MODULE, kind: "secret-write", excerpt: EXPRESSION, ordinal: 0, exemptionId: EXEMPTION, storeId: null });
    expect(changed[0].after).toMatchObject({ storeId: "provider-state", exemptionId: null, minimaxEndpointBinding: {
      scope: "migrateMiniMaxTokenPlanAnthropicEndpoint", root: "ctx.hanakoHome", targets: ["added-models.yaml.tmp", "added-models.yaml"],
    } });
    const peers = actual.inventory.discoveredSites.filter(s => s.sourceFile === MODULE && s.excerpt === EXPRESSION);
    expect(peers.map(s => [s.ordinal, s.storeId, s.exemptionId])).toEqual([[0, "provider-state", null], [1, null, EXEMPTION], [2, null, EXEMPTION]]);
    expect(previous.inventory.discoveredSites.filter(s => s.exemptionId === EXEMPTION)).toHaveLength(62);
    expect(actual.inventory.discoveredSites.filter(s => s.exemptionId === EXEMPTION)).toHaveLength(61);
    expect(actual.startupReceipt).toEqual(previous.startupReceipt);
    expect(actual.inventory.exemptions.map(e => [e.id, e.expiresOn])).toEqual(previous.inventory.exemptions.map(e => [e.id, e.expiresOn]));
    expect(actual.inventory.stores.map(s => [s.id, s.pathPatterns])).toEqual(previous.inventory.stores.map(s => [s.id, s.pathPatterns]));
  });

  it("accepts the committed receipt", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toEqual(committed);
  });

  it("accepts ordinary comment/line movement in the inventory", () => {
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: commentSourceOverrides }).inventory).toEqual(inventory);
  });

  it("accepts ordinary comment/line movement in the committed fingerprint", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides: commentSourceOverrides })).resolves.toEqual(committed);
  });

  it.each([
    ['path.join(hanakoHome, "added-models.yaml")', 'path.join(hanakoHome, "other.yaml")'],
    ['const { hanakoHome, log } = ctx;\n  const ymlPath', 'const { agentsDir: hanakoHome, log } = ctx;\n  const ymlPath'],
    ["MINIMAX_TOKEN_PLAN_LEGACY_BASE_URLS.has(baseUrl)", "true"],
    ['const MINIMAX_TOKEN_PLAN_PROVIDER_ID = "minimax-token-plan"', 'const MINIMAX_TOKEN_PLAN_PROVIDER_ID = "minimax"'],
    ["35: migrateMiniMaxTokenPlanAnthropicEndpoint", "35: migrateVisionToImage"],
    [EXPRESSION, "void 0"],
    [EXPRESSION, `${EXPRESSION}; ${EXPRESSION}`],
    ["function migrateMiniMaxTokenPlanAnthropicEndpoint(ctx)", "function renamedMiniMaxEndpoint(ctx)"],
    ["const migrations = {", "const migrations = {\n  999: migrateVisionToImage,"],
  ])("rejects unreviewed executable closure: %s", (before, after) => {
    const sourceOverrides = mutate(before, after);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides })).toThrow(/MiniMax #35 ownership/);
  });

  it.each(["shared/safe-fs.ts", "shared/secret-fs.ts"])("rejects changed helper %s", module => {
    const original = fs.readFileSync(path.join(ROOT, module), "utf8");
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: new Map([[module, `${original}\nthrow Error("unreviewed module effect");`]]) })).toThrow(/MiniMax #35 ownership/);
  });

  it.each(["missing", "owner", "target", "protocol"])("rejects an unproved provider-state %s", mode => {
    const stores = structuredClone([...PERSISTENT_STORES]);
    const owner = stores.find(s => s.id === "provider-state");
    if (mode === "missing") stores.splice(stores.indexOf(owner), 1);
    if (mode === "owner") owner.ownerModule = "core/migrations.ts";
    if (mode === "target") { owner.pathPatterns = ["other-provider.yaml"]; owner.pathPattern = owner.pathPatterns[0]; }
    if (mode === "protocol") owner.protocolModules = [];
    expect(() => scanPersistentStores({ rootDir: ROOT, stores })).toThrow(/MiniMax #35 ownership/);
  });

  it.each([1, 2, -1])("rejects redirecting the exclusion to occurrence %s", occurrence => {
    const exemptions = structuredClone(PERSISTENCE_EXEMPTIONS);
    exemptions.find(e => e.id === EXEMPTION).excludedSites[0].occurrence = occurrence;
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions })).toThrow(/unknown occurrence exclusion/);
  });

  it.each(["target", "missing-target", "binding", "owner", "extra-peer", "excluded", "site", "entire-group"])("rejects forged supplied receipt %s before writing", async mode => {
    const forged = structuredClone(inventory);
    const site = forged.discoveredSites.find(s => s.sourceFile === MODULE && s.excerpt === EXPRESSION && s.ordinal === 0);
    if (mode === "target") site.minimaxEndpointBinding.targets[1] = "other.yaml";
    if (mode === "missing-target") site.minimaxEndpointBinding.targets.pop();
    if (mode === "binding") delete site.minimaxEndpointBinding;
    if (mode === "owner") site.storeId = "agent-profile";
    if (mode === "extra-peer") forged.discoveredSites.find(s => s.sourceFile === MODULE && s.excerpt === EXPRESSION && s.ordinal === 1).minimaxEndpointBinding = structuredClone(site.minimaxEndpointBinding);
    if (["excluded", "entire-group"].includes(mode)) delete forged.exemptions.find(e => e.id === EXEMPTION).excludedSites;
    if (["site", "entire-group"].includes(mode)) forged.discoveredSites.splice(forged.discoveredSites.indexOf(site), 1);
    await expect(generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: forged, review })).rejects.toThrow(/MiniMax #35 ownership/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-receipt-preserve-")); temporary.push(dir);
    const outputPath = path.join(dir, "fingerprint.json"); fs.writeFileSync(outputPath, "original bytes");
    await expect(writePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: forged, outputPath, review })).rejects.toThrow(/MiniMax #35 ownership/);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("original bytes");
  });

  it.each([1, 2].flatMap(ordinal => ["owner", "exemption", "reason", "all", "receipt-reason"].map(mode => ({ ordinal, mode }))))(
    "preserves peer $ordinal's trusted exemption without a binding field: $mode", async ({ ordinal, mode }) => {
      const forged = structuredClone(inventory);
      const peer = forged.discoveredSites.find(s => s.sourceFile === MODULE && s.excerpt === EXPRESSION && s.ordinal === ordinal);
      const primary = forged.discoveredSites.find(s => s.sourceFile === MODULE && s.excerpt === EXPRESSION && s.ordinal === 0);
      expect(peer.minimaxEndpointBinding).toBeUndefined();
      if (["owner", "all"].includes(mode)) peer.storeId = "provider-state";
      if (["exemption", "all"].includes(mode)) peer.exemptionId = null;
      if (["reason", "all", "receipt-reason"].includes(mode)) peer.reason = primary.reason;
      if (mode === "receipt-reason") forged.exemptions.find(e => e.id === EXEMPTION).reason = primary.reason;
      const error = new RegExp(`peer occurrence ${ordinal} lost its legacy ownership`);
      expect(() => assertMiniMaxEndpointReceipt({ rootDir: ROOT, inventory: forged })).toThrow(error);
      await expect(generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: forged, review })).rejects.toThrow(error);
      await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: forged, committedFingerprint: committed })).rejects.toThrow(error);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-peer-preserve-")); temporary.push(dir);
      const outputPath = path.join(dir, "fingerprint.json"), before = Buffer.from(JSON.stringify(committed));
      fs.writeFileSync(outputPath, before);
      await expect(writePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: forged, outputPath, review })).rejects.toThrow(error);
      expect(fs.readFileSync(outputPath)).toEqual(before);
    },
  );

  it.each([false, true])("rejects custom old rules before scanner publication (existing outputs=%s)", existing => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-scan-publication-")); temporary.push(rootDir);
    for (const directory of PRODUCTION_ROOTS) fs.symlinkSync(path.join(ROOT, directory), path.join(rootDir, directory), "dir");
    const build = path.join(rootDir, "build");
    const files = ["persistence-store-inventory.json", "persistence-startup-receipt.json", "persistence-schema-fingerprint.json"];
    const before = files.map((file, index) => Buffer.from(JSON.stringify({ file, index }) + "\n"));
    if (existing) { fs.mkdirSync(build); files.forEach((file, index) => fs.writeFileSync(path.join(build, file), before[index])); }
    const scan = scanPersistentStores({ rootDir, stores: priorStores, exemptions: priorExemptions });
    expect(scan.inventory.discoveredSites.find(s => s.sourceFile === MODULE && s.excerpt === EXPRESSION && s.ordinal === 0))
      .toMatchObject({ storeId: null, exemptionId: EXEMPTION });
    expect(() => writeReceipts({ rootDir, stores: priorStores, exemptions: priorExemptions })).toThrow(/receipt omitted the registered #35 binding/);
    if (existing) expect(files.map(file => fs.readFileSync(path.join(build, file)))).toEqual(before);
    else expect(fs.existsSync(build)).toBe(false);
  });

  it("failed scanner publication preserves all committed files", () => {
    const files = ["persistence-store-inventory.json", "persistence-startup-receipt.json", "persistence-schema-fingerprint.json"].map(f => path.join(ROOT, "build", f));
    const before = files.map(f => fs.readFileSync(f));
    expect(() => writeReceipts({ rootDir: ROOT, sourceOverrides: mutate(EXPRESSION, "void 0") })).toThrow(/MiniMax #35 ownership/);
    expect(files.map(f => fs.readFileSync(f))).toEqual(before);
  });

  it("applies the source proof to supplied inventories and to unrelated module mutations", async () => {
    const sourceOverrides = new Map([[MODULE, text + '\nmigrations[35] = migrateVisionToImage;\n']]);
    await expect(generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review })).rejects.toThrow(/unreviewed executable source/);
    await expect(generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides: Object.fromEntries(sourceOverrides), review })).rejects.toThrow(/unreviewed executable source/);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: mutate("atomicWriteSync(titlePath, JSON.stringify(titles, null, 2))", "void 0") })).toThrow(/unreviewed executable source/);
  });
});
