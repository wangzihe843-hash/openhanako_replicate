import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { discoverSites, scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GPU = "desktop/src/shared/gpu-startup-policy.cjs";
const OWNER = "desktop-gpu-startup-state";
const retired = "desktop-gpu-json-primitive";
const source = fs.readFileSync(path.join(ROOT, GPU), "utf8");
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const overrides = (text: string) => new Map([[GPU, text]]);
const review = { classification: "compatible", compatibilityReason: "Test-only comparison of a changed GPU contract." };

vi.setConfig({ testTimeout: 30_000 });

describe("GPU persistence ownership", () => {
  it("generates the committed inventory on the real UTC date and retires exactly the three GPU primitive sites", () => {
    const { inventory: actual } = scanPersistentStores({ rootDir: ROOT });
    expect(actual).toEqual(inventory);
    expect(actual.stores).toHaveLength(65);
    expect(actual.discoveredSites).toHaveLength(905);
    expect(actual.exemptions.some((item: { id: string }) => item.id === retired)).toBe(false);
    const targets = actual.discoveredSites.filter((site: { sourceFile: string; storeId: string; kind: string }) =>
      site.sourceFile === GPU && site.storeId === OWNER && ["mkdir", "write-file", "rename"].includes(site.kind));
    expect(targets.map((site: { kind: string; excerpt: string }) => [site.kind, site.excerpt])).toEqual([
      ["mkdir", "fs.mkdirSync(path.dirname(filePath), { recursive: true })"],
      ["rename", "fs.renameSync(tmpPath, filePath)"],
      ["write-file", 'fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\\n", "utf-8")'],
    ]);
    const remaining = actual.exemptions.filter((item: { expiresOn: string }) => item.expiresOn === "2026-11-17");
    const remainingIds = new Set(remaining.map((item: { id: string }) => item.id));
    expect(remaining).toHaveLength(6);
    expect(actual.discoveredSites.filter((site: { exemptionId: string | null }) => remainingIds.has(site.exemptionId)).length).toBe(92);

    // Reconstruct the previous rules only in memory, then compare every row.
    const previousStores = PERSISTENT_STORES.map((store) => store.id !== OWNER ? store : {
      ...store, siteRules: store.siteRules.filter((rule) => rule.kinds?.includes("atomic-write")),
    });
    const oldExemption = {
      id: retired, ownerModule: GPU, sourceFile: GPU,
      reason: "Generic atomic JSON primitive has no independent store ownership; its writeJson call sites are assigned to the GPU state or preferences owner.",
      expiresOn: "2026-11-17", kinds: ["mkdir", "write-file", "rename"],
      linePattern: "(?:path[.]dirname\\(filePath\\)|tmpPath, JSON|stringify|tmpPath, filePath)",
    };
    const { inventory: previous } = scanPersistentStores({ rootDir: ROOT, stores: previousStores, exemptions: [...PERSISTENCE_EXEMPTIONS, oldExemption] });
    const changed = previous.discoveredSites.map((site: unknown, index: number) => ({ before: site, after: actual.discoveredSites[index] }))
      .filter(({ before, after }: { before: unknown; after: unknown }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(changed).toHaveLength(3);
    for (const { before, after } of changed) {
      expect(before).toMatchObject({ sourceFile: GPU, storeId: null, exemptionId: retired });
      expect(after).toMatchObject({ sourceFile: GPU, storeId: OWNER, exemptionId: null });
      expect({ ...before, reason: after.reason, storeId: after.storeId, exemptionId: after.exemptionId }).toEqual(after);
    }
    expect(previous.stores).toEqual(actual.stores);
    expect(previous.exemptions.filter((item: { id: string }) => item.id !== retired)).toEqual(actual.exemptions);
  });

  it("keeps the reviewed pin through comment and line drift", async () => {
    const sourceOverrides = overrides(`// comment-only drift\n\n${source}`);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).resolves.toEqual(committed);
  });

  it.each([
    ["final target", 'path.join("user", "gpu-startup.json")', 'path.join("user", "preferences.json")'],
    ["temporary target", '`${filePath}.${process.pid}.tmp`', '`${filePath}.${process.pid}.other`'],
    ["alias call", '  writeJson(getGpuStartupStatePath(hanakoHome), {', '  const alias = writeJson;\n  alias(getGpuStartupStatePath(hanakoHome), {'],
    ["helper export", 'module.exports = {', 'module.exports = {\n  writeJson,'],
    ["remove write", '  fs.renameSync(tmpPath, filePath);', '  void tmpPath;'],
    ["add write", '  fs.renameSync(tmpPath, filePath);', '  fs.renameSync(tmpPath, filePath);\n  fs.writeFileSync(filePath, "extra");'],
  ])("rejects %s drift through the GPU source contract", async (_label, before, after) => {
    expect(source.split(before)).toHaveLength(2);
    // The same committed tree and same inventory must pass before each mutation.
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides: overrides(source) })).resolves.toEqual(committed);
    const sourceOverrides = overrides(source.replace(before, after));
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review });
    const oldGpu = committed.schemas.find((entry: { storeId: string }) => entry.storeId === OWNER);
    const newGpu = mutation.schemas.find((entry: { storeId: string }) => entry.storeId === OWNER);
    expect(newGpu.sourceHash).not.toBe(oldGpu.sourceHash);
    expect(mutation.schemas.filter((entry: { storeId: string }) => entry.storeId !== OWNER)).toEqual(committed.schemas.filter((entry: { storeId: string }) => entry.storeId !== OWNER));
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides }))
      .rejects.toThrow(`persistence schema fingerprint mismatch: committed ${committed.payloadFingerprint}, generated ${mutation.payloadFingerprint}`);
  });

  it("detects additions and removals of physical write sites", () => {
    const gpuSites = (text: string) => discoverSites(ROOT, overrides(text)).filter((site: { sourceFile: string }) => site.sourceFile === GPU);
    const original = gpuSites(source);
    const removed = gpuSites(source.replace('  fs.renameSync(tmpPath, filePath);', '  void tmpPath;'));
    const added = gpuSites(source.replace('  fs.renameSync(tmpPath, filePath);', '  fs.renameSync(tmpPath, filePath);\n  fs.writeFileSync(filePath, "extra");'));
    expect(removed).toHaveLength(original.length - 1);
    expect(added).toHaveLength(original.length + 1);
  });
});
