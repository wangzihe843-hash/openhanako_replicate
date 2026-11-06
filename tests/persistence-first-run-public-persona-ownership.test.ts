import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFirstRun } from "../core/first-run.ts";
import { expandStorePathPattern } from "../core/data-epoch-checkpoint-provider.ts";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/first-run.ts";
const SERVER = "server/index.ts";
const RESOLVER = "shared/hana-runtime-paths.cjs";
const OWNER = "agent-profile";
const EXEMPTION = "cross-store-first-run-bootstrap";
const reason = "Copies the default agent public persona template during first-run seeding or repair.";
const call = "fs.copyFileSync(publicAgentsSrc, path.join(agentDir, PUBLIC_PERSONA_FILE_NAME))";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const server = fs.readFileSync(path.join(ROOT, SERVER), "utf8");
const resolver = fs.readFileSync(path.join(ROOT, RESOLVER), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const noOwner = PERSISTENT_STORES.map(s => s.id !== OWNER ? s : { ...s, siteRules: s.siteRules.filter(r => r.reason !== reason) });
const escapedCall = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(e => e.id !== EXEMPTION ? e : { ...e, linePattern: `(?:${e.linePattern})|(?:^${escapedCall}$)` });
const overrides = (text: string) => new Map([[MODULE, text]]);
const tempDirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup(configLocale = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-public-persona-"));
  tempDirs.push(root);
  const home = path.join(root, "hana-home"), product = path.join(root, "product");
  fs.mkdirSync(product, { recursive: true });
  fs.writeFileSync(path.join(product, "config.example.yaml"), `agent:\n  name: Hanako\n${configLocale ? `locale: ${configLocale}\n` : ""}`);
  vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "os-home"));
  return { home, product, target: path.join(home, "agents", "hanako", "AGENTS.public.md") };
}
function template(product: string, lang: string, text: string) {
  const dir = path.join(product, "agents-public-templates", lang);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hanako.md"), text);
}

describe("first-run public persona ownership", () => {
  it("changes only the single intended row and preserves all other mappings", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
    const previous = scanPersistentStores({ rootDir: ROOT, stores: noOwner, exemptions: priorExemptions });
    expect(previous.inventory.discoveredSites).toHaveLength(905);
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    const changed = previous.inventory.discoveredSites.map((before, i) => ({ before, after: actual.inventory.discoveredSites[i] })).filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(changed).toHaveLength(1);
    const { before, after } = changed[0];
    expect(before).toMatchObject({ sourceFile: MODULE, kind: "copy-file", excerpt: call, ordinal: 0, storeId: null, exemptionId: EXEMPTION });
    expect(after).toMatchObject({ sourceFile: MODULE, kind: "copy-file", excerpt: call, ordinal: 0, storeId: OWNER, exemptionId: null, reason });
    expect({ ...before, reason: after.reason, storeId: after.storeId, exemptionId: after.exemptionId }).toEqual(after);
    expect(previous.inventory.stores).toEqual(actual.inventory.stores);
    expect(previous.startupReceipt).toEqual(actual.startupReceipt);
    const dated = actual.inventory.exemptions.filter(e => e.expiresOn === "2026-11-17");
    expect(dated).toHaveLength(6);
    expect(actual.inventory.discoveredSites.filter(s => dated.some(e => e.id === s.exemptionId))).toHaveLength(87);
    expect(actual.inventory.discoveredSites.filter(s => s.exemptionId === EXEMPTION)).toHaveLength(10);
  });

  it("rejects the copy site without an owner or exemption", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner })).toThrow(/unregistered persistence site/);
  });

  it("rejects the copy site with both an owner and exemption", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions })).toThrow(/ambiguous persistence site/);
  });

  it("detects a deleted copy target", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, "void 0")) })).toThrow(/dangling/);
  });

  it("detects a duplicated copy target", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, `${call}; ${call}`)) }).inventory).not.toEqual(inventory);
  });

  it("detects an unknown copy target", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, `${call}; fs.copyFileSync(publicAgentsSrc, "unknown")`)) })).toThrow(/unregistered persistence site/);
  });

  it("accepts the committed fingerprint and comment-only drift", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toEqual(committed);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides: overrides(`// comment\n${source}`) })).resolves.toEqual(committed);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides: new Map([[RESOLVER, `// comment\n${resolver}`]]) })).resolves.toEqual(committed);
  });
  it("rejects a resolver that ignores the supplied home for each bound schema", async () => {
    const before = 'const raw = input || path.join(homeDir, ".hanako");';
    expect(resolver.split(before)).toHaveLength(2);
    const sourceOverrides = new Map([[RESOLVER, resolver.replace(before, 'const raw = path.join(homeDir, ".hanako");')]]);
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only source mutation." } });
    const changed = mutation.schemas.filter((s: { storeId: string }) => JSON.stringify(s) !== JSON.stringify(committed.schemas.find((x: { storeId: string }) => x.storeId === s.storeId))).map((s: { storeId: string }) => s.storeId);
    expect(changed).toEqual(["agent-profile", "server-runtime-info", "user-preferences"]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });
  it.each([
    [MODULE, 'path.join(agentsDir, agentId)', 'path.join(agentsDir, "other")'],
    [MODULE, '`${langDir}${agentId}.md`', '`${langDir}other.md`'],
    [MODULE, 'String(locale || "en").startsWith("zh")', 'String(locale || "en").startsWith("ja")'],
    [MODULE, 'if (publicAgentsSrc)', 'if (false)'],
    [SERVER, 'const hanakoHome = resolveHanakoHome(process.env.HANA_HOME);', 'const hanakoHome = resolveHanakoHome(undefined);'],
    [SERVER, 'ensureFirstRun(hanakoHome, productDir)', 'ensureFirstRun(productDir, productDir)'],
  ])("fingerprints the shared execution contract in %s: %s", async (module, before, after) => {
    const text = module === MODULE ? source : server;
    expect(text.split(before)).toHaveLength(2);
    const sourceOverrides = new Map([[module, text.replace(before, after)]]);
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only source mutation." } });
    const changed = mutation.schemas.filter((s: { storeId: string; sourceHash: string }) => JSON.stringify(s) !== JSON.stringify(committed.schemas.find((x: { storeId: string }) => x.storeId === s.storeId))).map((s: { storeId: string }) => s.storeId);
    expect(changed).toContain(OWNER);
    expect(changed).toContain("user-preferences");
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it.each([
    ["zh-CN", "zh", "zh"], ["en-US", "en", "en"], ["fr", "en", "en"],
  ])("seeds %s using its matching or fallback template", (locale, _label, expected) => {
    const { home, product, target } = setup(locale);
    template(product, "", "zh"); template(product, "en", "en");
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target, "utf8")).toBe(expected);
    const owners = PERSISTENT_STORES.filter(s => s.pathPatterns.some(p => expandStorePathPattern(home, p).some(m => m.relPath === "agents/hanako/AGENTS.public.md")));
    expect(owners.map(s => s.id)).toEqual([OWNER]);
    fs.writeFileSync(target, "custom");
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target, "utf8")).toBe("custom");
  });
  it("uses preferences locale when repairing a damaged default config", () => {
    const { home, product, target } = setup();
    template(product, "", "zh"); template(product, "en", "en");
    fs.mkdirSync(path.join(home, "user"), { recursive: true });
    fs.writeFileSync(path.join(home, "user", "preferences.json"), '{"locale":"zh-CN"}');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(target), "config.yaml"), "agent: [broken\n");
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target, "utf8")).toBe("zh");
  });
  it("prefers config locale over preferences and falls back when the localized template is missing", () => {
    const { home, product, target } = setup("en-US");
    template(product, "", "generic");
    fs.mkdirSync(path.join(home, "user"), { recursive: true });
    fs.writeFileSync(path.join(home, "user", "preferences.json"), '{"locale":"zh-CN"}');
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target, "utf8")).toBe("generic");
  });
  it("prefers the config locale when both localized templates exist", () => {
    const { home, product, target } = setup("en-US");
    template(product, "", "zh"); template(product, "en", "en");
    fs.mkdirSync(path.join(home, "user"), { recursive: true });
    fs.writeFileSync(path.join(home, "user", "preferences.json"), '{"locale":"zh-CN"}');
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target, "utf8")).toBe("en");
  });
  it("leaves the target absent when no template exists", () => {
    const { home, product, target } = setup();
    ensureFirstRun(home, product);
    expect(fs.existsSync(target)).toBe(false);
  });
  it("can overwrite an existing persona when repairing damaged default config", () => {
    const { home, product, target } = setup();
    template(product, "", "replacement");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "custom");
    fs.writeFileSync(path.join(path.dirname(target), "config.yaml"), "agent: [broken\n");
    const report = ensureFirstRun(home, product);
    expect(report.repairedDefaultAgent).toBe(true);
    expect(fs.readFileSync(report.defaultConfigBackupPath!, "utf8")).toBe("agent: [broken\n");
    expect(fs.readFileSync(target, "utf8")).toBe("replacement");
  });
  it("can leave a partial target after a failed copy and does not claim to repair it on retry", () => {
    const { home, product, target } = setup();
    template(product, "", "replacement");
    const copy = fs.copyFileSync.bind(fs);
    const spy = vi.spyOn(fs, "copyFileSync").mockImplementation(((src, dst, flags) => {
      if (dst === target) { fs.writeFileSync(dst, "partial"); throw new Error("simulated copy failure"); }
      return copy(src, dst, flags);
    }) as typeof fs.copyFileSync);
    expect(() => ensureFirstRun(home, product)).toThrow("simulated copy failure");
    spy.mockRestore();
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target, "utf8")).toBe("partial");
  });
});
