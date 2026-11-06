import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint, writePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/migrations.ts";
const OWNER = "agent-phone";
const EXEMPTION = "cross-store-legacy-migrations";
const CALLS = [
  "atomicWriteSync(projectionPath, nextProjection)",
  "fs.mkdirSync(runtimeDir, { recursive: true })",
  'atomicWriteSync(runtimePath, JSON.stringify(nextRuntime, null, 2) + "\\n")',
];
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const store = PERSISTENT_STORES.find(entry => entry.id === OWNER)!;
const rules = store.siteRules.filter(entry => entry.sourceFile === MODULE);
const priorStores = PERSISTENT_STORES.map(entry => entry.id !== OWNER ? entry : {
  ...entry, siteRules: entry.siteRules.filter(rule => rule.sourceFile !== MODULE),
  protocolModules: ["lib/conversations/agent-phone-runtime.ts", "hub/agent-executor.ts"],
  firstPossibleWritePhase: "runtime_ready" as const,
});
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(entry => entry.id !== EXEMPTION ? entry : { ...entry, linePattern: entry.linePattern!.replace("(?!(?:atomicWriteSync\\(projectionPath, nextProjection\\)|fs\\.mkdirSync\\(runtimeDir, \\{ recursive: true \\}\\)|atomicWriteSync\\(runtimePath, JSON\\.stringify\\(nextRuntime, null, 2\\) \\+ \"\\\\n\"\\))$)", "") });
const review = { classification: "compatible", compatibilityReason: "Test-only Agent Phone attribution mutation." };
vi.setConfig({ testTimeout: 30_000 });

function replaceOnce(text: string, from: string, to: string) {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
}
function overrides(text: string) { return new Map([[MODULE, text]]); }
function differences(before, after) {
  expect(before).toHaveLength(after.length);
  return before.flatMap((row, index) => JSON.stringify(row) === JSON.stringify(after[index]) ? [] : [{ before: row, after: after[index] }]);
}
function metadata() {
  const actual = scanPersistentStores({ rootDir: ROOT });
  expect(actual.inventory).toEqual(inventory);
  expect(actual.startupReceipt).toEqual(receipt);
  return actual;
}
async function reject(sourceOverrides, pattern = /agent phone migration protocol|persistence schema fingerprint mismatch/) {
  // A stale supplied inventory must not hide changes to the bounded source.
  await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, committedFingerprint: committed })).rejects.toThrow(pattern);
}

describe("Agent Phone migration persistence ownership", () => {
  it("moves exactly three identities with unchanged paths, policies, other rows and expiry", () => {
    const actual = metadata();
    const previous = scanPersistentStores({ rootDir: ROOT, stores: priorStores, exemptions: priorExemptions });
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    expect(actual.inventory.stores).toHaveLength(65);
    expect(actual.inventory.exemptions).toHaveLength(32);
    const changed = differences(previous.inventory.discoveredSites, actual.inventory.discoveredSites);
    expect(changed).toHaveLength(3);
    expect(changed.map(row => row.after.excerpt).sort()).toEqual([...CALLS].sort());
    for (const { before, after } of changed) {
      expect(before).toMatchObject({ sourceFile: MODULE, ordinal: 0, storeId: null, exemptionId: EXEMPTION });
      expect(after).toEqual({ ...before, storeId: OWNER, exemptionId: null, reason: rules[0].reason });
    }
    const stores = differences(previous.inventory.stores, actual.inventory.stores);
    expect(stores).toHaveLength(1);
    expect(stores[0].after).toEqual({ ...stores[0].before, firstPossibleWritePhase: "engine_init_legacy_migrations", protocolModules: store.protocolModules });
    const phases = differences(previous.startupReceipt.stores, actual.startupReceipt.stores);
    expect(phases).toHaveLength(1);
    expect(phases[0].after).toEqual({ ...phases[0].before, firstPossibleWritePhase: "engine_init_legacy_migrations" });
    expect(actual.inventory.exemptions.map(entry => [entry.id, entry.expiresOn])).toEqual(previous.inventory.exemptions.map(entry => [entry.id, entry.expiresOn]));
    expect(previous.inventory.discoveredSites.filter(row => row.exemptionId === EXEMPTION)).toHaveLength(67);
    expect(actual.inventory.discoveredSites.filter(row => row.exemptionId === EXEMPTION)).toHaveLength(64);
    const dated = new Set(actual.inventory.exemptions.filter(entry => entry.expiresOn === "2026-11-17").map(entry => entry.id));
    expect(previous.inventory.discoveredSites.filter(row => dated.has(row.exemptionId))).toHaveLength(84);
    expect(actual.inventory.discoveredSites.filter(row => dated.has(row.exemptionId))).toHaveLength(81);
  });

  it("recomputes the committed fingerprint including both bounded source fragments", async () => {
    metadata();
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toEqual(committed);
    const phone = committed.schemas.find(entry => entry.storeId === OWNER);
    expect(phone.migrationProtocol.migrationId).toBe(32);
    expect(phone.migrationProtocol.sources.map(entry => entry.module)).toEqual([MODULE, "core/engine.ts"]);
    expect(phone.migrationProtocol.sources[0].scopes).toContain("migrations[32]");
    expect(phone.migrationProtocol.sources[0].scopes).not.toContain("migrateSubagentDirectThreadSemantics");
    expect(phone.protocolModules.map(entry => entry.module)).toEqual([
      "hub/agent-executor.ts", "lib/conversations/agent-phone-runtime.ts", "shared/link-aware-fs.ts", "shared/safe-fs.ts",
    ]);
    expect(committed.dataEpoch).toBe(1);
  });

  it("rejects removed and duplicate ownership and the old overlapping exemption", async () => {
    for (const rule of rules) {
      const stores = PERSISTENT_STORES.map(entry => entry.id !== OWNER ? entry : { ...entry, siteRules: entry.siteRules.filter(row => row !== rule) });
      expect(() => scanPersistentStores({ rootDir: ROOT, stores })).toThrow(/unregistered persistence site/);
    }
    const stores = PERSISTENT_STORES.map(entry => entry.id !== "channels" ? entry : { ...entry, siteRules: [...entry.siteRules, ...rules] });
    expect(() => scanPersistentStores({ rootDir: ROOT, stores })).toThrow(/ambiguous persistence site/);
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions })).toThrow(/ambiguous persistence site/);
    const omitted = scanPersistentStores({ rootDir: ROOT, stores: priorStores, exemptions: priorExemptions }).inventory;
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: omitted, committedFingerprint: committed })).rejects.toThrow(/persistence schema fingerprint mismatch/);
  });

  it.each(CALLS)("rejects deletion or replacement of %s even with a stale inventory", async call => {
    for (const replacement of ["void 0", call.replace(/projectionPath|runtimeDir|runtimePath/, "otherTarget")]) {
      const sourceOverrides = overrides(replaceOnce(source, call, replacement));
      expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides })).toThrow(/dangling persistence rule/);
      await reject(sourceOverrides, /agent phone migration protocol: missing, duplicate or moved call/);
    }
  });

  it.each(CALLS)("rejects a fourth identical call to %s in the formal fingerprint path", async call => {
    const sourceOverrides = overrides(`${source}\nfunction fourth(projectionPath, nextProjection, runtimePath, nextRuntime, runtimeDir) { ${call}; }\n`);
    const extra = scanPersistentStores({ rootDir: ROOT, sourceOverrides });
    expect(extra.inventory.discoveredSites).toHaveLength(906);
    expect(extra.inventory.discoveredSites.filter(row => row.sourceFile === MODULE && row.excerpt === call)).toHaveLength(2);
    await reject(sourceOverrides, /agent phone migration protocol: missing, duplicate or moved call/);
  });

  it("rejects a call moved into another function and an extra effect inside #32", async () => {
    const moved = replaceOnce(source, CALLS[0], "void 0") + `\nfunction other(projectionPath, nextProjection) { ${CALLS[0]}; }\n`;
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(moved) }).inventory).toEqual(inventory);
    await reject(overrides(moved), /agent phone migration protocol: missing, duplicate or moved call/);
    await reject(overrides(replaceOnce(source, CALLS[2], `${CALLS[2]}; fs.writeFileSync(runtimePath, "extra")`)), /persistence schema fingerprint mismatch/);
  });

  it.each([
    ['path.join(agentDir, "phone", "conversations")', 'path.join(agentDir, "phone", "wrong-conversations")'],
    ['path.join(agentDir, "phone", "session-runtime")', 'path.join(agentDir, "phone", "wrong-runtime")'],
    ['`${safeConversationStem(conversationId)}.json`', '`${safeConversationStem(conversationId)}.wrong`'],
    ['const AGENT_PHONE_RUNTIME_KEYS = new Set([\n  "phoneSessionFile",', 'const AGENT_PHONE_RUNTIME_KEYS = new Set([\n  "otherSessionFile",'],
    ['if (key && keys.has(key)) {', 'if (key && !keys.has(key)) {'],
    ['agentId: frontmatter.meta.get("agentId") || existing.agentId || agentEntry.name,', 'agentId: agentEntry.name,'],
    ['migrations[v](ctx);', 'migrations[v]({ ...ctx, agentsDir: ctx.hanakoHome });'],
  ])("fingerprints bounded semantic drift: %s", async (from, to) => {
    const sourceOverrides = overrides(replaceOnce(source, from, to));
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
    await reject(sourceOverrides, /persistence schema fingerprint mismatch/);
  });

  it.each([
    ["slot", source.replace("32: migrateAgentPhoneRuntimeOutOfProjection,", "32: cleanupSummarizerCompilerRemnants,")],
    ["extra caller", `${source}\nfunction extraCaller(ctx) { migrateAgentPhoneRuntimeOutOfProjection(ctx); }\n`],
    ["alias", `${source}\nconst alias = migrateAgentPhoneRuntimeOutOfProjection;\n`],
    ["constant mutation", `${source}\nAGENT_PHONE_RUNTIME_KEYS.clear();\n`],
    ["duplicate constant", `${source}\nconst AGENT_PHONE_RUNTIME_KEYS = new Set();\n`],
    ["helper provenance", source.replace('import { safeConversationStem } from "../lib/conversations/agent-phone-projection.ts";', 'import { safeConversationStem } from "../wrong.ts";')],
  ])("rejects %s at the actual generator entry", async (_name, text) => {
    expect(text).not.toBe(source);
    await reject(overrides(text), /agent phone migration protocol/);
  });

  it.each([
    ["spread", '...Object.fromEntries([[32, (_ctx: unknown) => {}]]),'],
    ["computed number", '[16 + 16]: cleanupSummarizerCompilerRemnants,'],
    ["computed string", '["32"]: cleanupSummarizerCompilerRemnants,'],
    ["string", '"32": cleanupSummarizerCompilerRemnants,'],
    ["getter", 'get 32() { return cleanupSummarizerCompilerRemnants; },'],
    ["method", '32(_ctx: unknown) {},'],
    ["duplicate numeric key", '32: migrateAgentPhoneRuntimeOutOfProjection,'],
  ])("rejects a later %s registry override through all fingerprint entry points", async (_name, property) => {
    const marker = "  53: migrateCleanEnvelopeSessionTitles,\n};";
    const text = replaceOnce(source, marker, `  53: migrateCleanEnvelopeSessionTitles,\n  ${property}\n};`);
    const sourceOverrides = overrides(text);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
    const pattern = /agent phone migration protocol: (unknown registry property shape|duplicate registry id)/;
    await reject(sourceOverrides, pattern);
    await expect(generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review })).rejects.toThrow(pattern);
    const output = path.join(ROOT, ".cache", "phone-registry-preservation.json");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(committed));
    fs.writeFileSync(output, bytes);
    try {
      // No new review: r1 incorrectly accepted the unchanged payload here.
      await expect(writePersistenceSchemaFingerprint({ rootDir: ROOT, outputPath: output, inventory, sourceOverrides })).rejects.toThrow(pattern);
      expect(fs.readFileSync(output)).toEqual(bytes);
    } finally { fs.rmSync(output, { force: true }); }
  });

  it.each([
    ["core/engine.ts", 'agentsDir: this.agentsDir,\n        prefs: this._prefs,\n        providerRegistry: this._models.providerRegistry,', 'agentsDir: this.hanakoHome,\n        prefs: this._prefs,\n        providerRegistry: this._models.providerRegistry,', /persistence schema fingerprint mismatch/],
    ["core/engine.ts", "async init(log: any = () => {})", "async changedPhase(log: any = () => {})", /outside Engine.init/],
    ["shared/safe-fs.ts", 'const tmp = filePath + ".tmp";', 'const tmp = filePath + ".other-stage";', /persistence schema fingerprint mismatch/],
    ["shared/link-aware-fs.ts", "export function readDirectoryLikeDirentsSync", "export function changedDirectorySelector", /persistence schema fingerprint mismatch/],
    ["lib/conversations/agent-phone-projection.ts", '.slice(0, 80) || "conversation"', '.slice(0, 81) || "conversation"', /persistence schema fingerprint mismatch/],
  ])("detects caller or helper drift in %s", async (module, from, to, pattern) => {
    const text = fs.readFileSync(path.join(ROOT, module), "utf8");
    await reject(new Map([[module, replaceOnce(text, from, to)]]), pattern);
  });

  it("rejects a valid deferred startup callback rather than treating it as the init phase", async () => {
    const module = "core/engine.ts";
    const text = fs.readFileSync(path.join(ROOT, module), "utf8");
    const start = text.indexOf('const registryStep = runBestEffortStartupMigrationStep("migration-registry"');
    const end = text.indexOf("}), log);", start) + "}), log);".length;
    expect(start).toBeGreaterThan(0);
    const call = text.slice(start, end);
    const deferred = replaceOnce(replaceOnce(call, "() => runMigrations({", "() => { const deferred = () => runMigrations({"), "}), log);", "}); return deferred; }, log);");
    await reject(new Map([[module, replaceOnce(text, call, deferred)]]), /agent phone migration protocol: startup wrapper drift/);
  });

  it("accepts line/comment drift and unselected migration code without hashing the whole module", async () => {
    const sourceOverrides = overrides(`// ordinary comment\n\n${source}\nfunction unrelatedToPhone() { return 123; }\n`);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, committedFingerprint: committed })).resolves.toEqual(committed);
  });

  it("rejects absent source before writing an existing fingerprint file", async () => {
    const output = path.join(ROOT, ".cache", "phone-fingerprint-preservation.json");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(committed));
    fs.writeFileSync(output, bytes);
    try {
      await expect(writePersistenceSchemaFingerprint({ rootDir: ROOT, outputPath: output, inventory, sourceOverrides: overrides(""), review })).rejects.toThrow(/agent phone migration protocol/);
      expect(fs.readFileSync(output)).toEqual(bytes);
    } finally { fs.rmSync(output, { force: true }); }
  });

  it("binds the startup phase to the direct Engine.init invocation without executing migrations", () => {
    const engine = fs.readFileSync(path.join(ROOT, "core/engine.ts"), "utf8");
    expect(engine.indexOf('runBestEffortStartupMigrationStep("migration-registry"')).toBeLessThan(engine.indexOf("await this._models.init()"));
    expect(store.firstPossibleWritePhase).toBe("engine_init_legacy_migrations");
    expect(store.pathPatterns).toEqual(["agents/{agentId}/phone/conversations/{conversationId}.md", "agents/{agentId}/phone/session-runtime/{conversationId}.json"]);
  });
});
