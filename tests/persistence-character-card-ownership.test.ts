import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "lib/character-cards/service.ts";
const OWNER = "character-card-staging";
const RETIRED = "character-card-copy-helper";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const overrides = (text: string) => new Map([[MODULE, text]]);
const oldExemption = {
  id: RETIRED, ownerModule: MODULE, sourceFile: MODULE,
  reason: "The file-local copy helper is flow-dependent: callers target either token-scoped card staging or an explicitly registered skill destination.",
  expiresOn: "2026-11-17", kinds: ["mkdir", "copy-file"],
  linePattern: "(?:path[.]dirname\\(dst\\)|sourcePath, dst)",
};
const newReasons = [
  "Copies a non-PNG asset inside a token-scoped character-card import/export package.",
  "Ensures the asset directory inside a token-scoped character-card import/export package.",
];
const previousStores = PERSISTENT_STORES.map((store) => store.id !== OWNER ? store : {
  ...store, siteRules: store.siteRules.filter((rule) => !newReasons.includes(rule.reason)),
});
describe("character-card persistence ownership", () => {
  it("moves exactly the two physical sites from the retired exemption and preserves all other rows", () => {
    const { inventory: actual, startupReceipt } = scanPersistentStores({ rootDir: ROOT });
    expect(actual).toEqual(inventory);
    expect(actual.stores).toHaveLength(65);
    expect(actual.discoveredSites).toHaveLength(905);
    expect(actual.exemptions).toHaveLength(32);
    const targets = actual.discoveredSites.filter((s: { sourceFile: string; reason: string }) => s.sourceFile === MODULE && newReasons.includes(s.reason));
    expect(targets.map((s: { kind: string; excerpt: string; storeId: string; exemptionId: string | null; ordinal: number }) => [s.kind, s.excerpt, s.storeId, s.exemptionId, s.ordinal])).toEqual([
      ["copy-file", "fs.copyFileSync(sourcePath, dst)", OWNER, null, 0],
      ["mkdir", "fs.mkdirSync(path.dirname(dst), { recursive: true })", OWNER, null, 0],
    ]);
    expect(actual.exemptions.some((e: { id: string }) => e.id === RETIRED)).toBe(false);
    const remaining = actual.exemptions.filter((e: { expiresOn: string }) => e.expiresOn === "2026-11-17");
    const ids = new Set(remaining.map((e: { id: string }) => e.id));
    expect(remaining).toHaveLength(6);
    expect(actual.discoveredSites.filter((s: { exemptionId: string | null }) => ids.has(s.exemptionId))).toHaveLength(87);
    expect(remaining.map((e: { id: string }) => [e.id, actual.discoveredSites.filter((s: { exemptionId: string | null }) => s.exemptionId === e.id).length])).toEqual([
      ["compat-directory-seeding", 1], ["conditional-plugin-install-cleanup", 1],
      ["config-scope-migration-helper", 1],
      ["cross-store-first-run-bootstrap", 10], ["cross-store-legacy-migrations", 69],
      ["data-epoch-durable-json-primitive", 5],
    ]);
    const previous = scanPersistentStores({ rootDir: ROOT, stores: previousStores, exemptions: [...PERSISTENCE_EXEMPTIONS, oldExemption] });
    const changed = previous.inventory.discoveredSites.map((before: unknown, i: number) => ({ before, after: actual.discoveredSites[i] }))
      .filter(({ before, after }: { before: unknown; after: unknown }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(changed).toHaveLength(2);
    for (const { before, after } of changed) {
      expect(before).toMatchObject({ sourceFile: MODULE, storeId: null, exemptionId: RETIRED });
      expect(after).toMatchObject({ sourceFile: MODULE, storeId: OWNER, exemptionId: null });
      expect({ ...before, reason: after.reason, storeId: after.storeId, exemptionId: after.exemptionId }).toEqual(after);
    }
    expect(previous.inventory.stores).toEqual(actual.stores);
    expect(previous.inventory.exemptions.filter((e: { id: string }) => e.id !== RETIRED)).toEqual(actual.exemptions);
    expect(previous.startupReceipt).toEqual(startupReceipt);
  });

  it("rejects a card asset site without its owner", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: previousStores })).toThrow(/unregistered persistence site/);
  });

  it("rejects a card asset site with overlapping ownership", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: [...PERSISTENCE_EXEMPTIONS, oldExemption] })).toThrow(/ambiguous persistence site/);
  });

  it("accepts the original source", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toEqual(committed);
  });

  it("accepts comment-only drift", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides: overrides(`// comment-only drift\n${source}`) })).resolves.toEqual(committed);
  });

  it.each([
    ["import root", '"character-card-imports"', '"character-card-imports-other"'],
    ["export root", '"character-card-exports"', '"character-card-exports-other"'],
    ["relative target", '`assets/${targetBaseName}${ext}`', '`other/${targetBaseName}${ext}`'],
    ["fixed basename", '"hana-default-avatar"', '"other-default-avatar"'],
    ["helper alias", '    copyPlanAsset(plan, defaultAvatarForYuan(yuan),', '    const alias = copyPlanAsset;\n    alias(plan, defaultAvatarForYuan(yuan),'],
    ["helper export", 'export { CharacterCardError };', 'export { CharacterCardError, copyPlanAsset };'],
    ["constructor exposure", '    createImportPlanFromPath,\n', '    createImportPlanFromPath,\n    createExportPackagePlan,\n'],
  ])("rejects %s source-contract drift even when the physical inventory is unchanged", async (_label, before, after) => {
    expect(source.split(before)).toHaveLength(2);
    const sourceOverrides = overrides(source.replace(before, after));
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only changed character-card protocol." } });
    const oldSchema = committed.schemas.find((s: { storeId: string }) => s.storeId === OWNER);
    const newSchema = mutation.schemas.find((s: { storeId: string }) => s.storeId === OWNER);
    expect(newSchema.sourceHash).not.toBe(oldSchema.sourceHash);
    expect(mutation.schemas.filter((s: { storeId: string }) => s.storeId !== OWNER)).toEqual(committed.schemas.filter((s: { storeId: string }) => s.storeId !== OWNER));
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(`persistence schema fingerprint mismatch: committed ${committed.payloadFingerprint}, generated ${mutation.payloadFingerprint}`);
  });

  it("rejects a deleted owned write", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace("    fs.copyFileSync(sourcePath, dst);", "    void dst;")) })).toThrow(/dangling/);
  });

  it("rejects an unregistered added write", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace("    fs.copyFileSync(sourcePath, dst);", '    fs.copyFileSync(sourcePath, dst);\n    fs.writeFileSync("unknown-target", "extra");')) })).toThrow(/unregistered persistence site/);
  });
});
