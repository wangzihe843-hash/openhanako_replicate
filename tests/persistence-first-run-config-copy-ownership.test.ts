import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFirstRun } from "../core/first-run.ts";
import { expandStorePathPattern } from "../core/data-epoch-checkpoint-provider.ts";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { resolveHanakoHome } from "../shared/hana-runtime-paths.ts";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/first-run.ts";
const SERVER = "server/index.ts";
const PRODUCT_ROOT = "shared/hana-root.ts";
const HOME_FORWARDER = "shared/hana-runtime-paths.ts";
const OWNER = "agent-profile";
const EXEMPTION = "cross-store-first-run-bootstrap";
const reason = "Copies the default agent configuration template during first-run seeding or repair.";
const call = "fs.copyFileSync(configSrc, cfgDest)";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const server = fs.readFileSync(path.join(ROOT, SERVER), "utf8");
const productRoot = fs.readFileSync(path.join(ROOT, PRODUCT_ROOT), "utf8");
const homeForwarder = fs.readFileSync(path.join(ROOT, HOME_FORWARDER), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const noOwner = PERSISTENT_STORES.map(s => s.id !== OWNER ? s : { ...s, siteRules: s.siteRules.filter(r => r.reason !== reason) });
const escapedCall = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(e => e.id !== EXEMPTION ? e : { ...e, linePattern: `(?:${e.linePattern})|(?:^${escapedCall}$)` });
const overrides = (text: string) => new Map([[MODULE, text]]);
const tempDirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function mutatedHomeForwarder() {
  const original = "  resolveHanakoHome,\n";
  expect(homeForwarder.split(original)).toHaveLength(2);
  return homeForwarder.replace(original, "  resolveHanakoHome: baseResolveHanakoHome,\n") + `\nexport const resolveHanakoHome = (input?: string, homeDir?: string) => {\n  const resolved = baseResolveHanakoHome(input, homeDir);\n  return input?.startsWith("~/") ? resolved : runtimePaths.resolveHanakoHome(\`\${resolved}/other-root\`, homeDir);\n};\n`;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-first-run-config-copy-"));
  tempDirs.push(root);
  const home = path.join(root, "hana-home"), product = path.join(root, "product");
  const template = path.join(product, "config.example.yaml");
  const target = path.join(home, "agents", "hanako", "config.yaml");
  const bytes = "agent:\n  name: Hanako\n  yuan: hanako\n";
  fs.mkdirSync(product, { recursive: true });
  fs.writeFileSync(template, bytes);
  vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "os-home"));
  return { home, product, template, target, bytes };
}

describe("first-run config template copy ownership", () => {
  it("moves exactly the copy site and preserves all other mappings and the expiry", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    const previous = scanPersistentStores({ rootDir: ROOT, stores: noOwner, exemptions: priorExemptions });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
    expect(previous.inventory.discoveredSites).toHaveLength(905);
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    const changed = previous.inventory.discoveredSites.map((before, i) => ({ before, after: actual.inventory.discoveredSites[i] }))
      .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(changed).toHaveLength(1);
    const { before, after } = changed[0];
    expect(before).toMatchObject({ sourceFile: MODULE, kind: "copy-file", excerpt: call, ordinal: 0, storeId: null, exemptionId: EXEMPTION });
    expect(after).toMatchObject({ sourceFile: MODULE, kind: "copy-file", excerpt: call, ordinal: 0, storeId: OWNER, exemptionId: null, reason });
    expect({ ...before, reason: after.reason, storeId: after.storeId, exemptionId: after.exemptionId }).toEqual(after);
    expect(previous.inventory.stores).toEqual(actual.inventory.stores);
    expect(previous.startupReceipt).toEqual(actual.startupReceipt);
    expect(previous.inventory.exemptions.filter(e => e.id !== EXEMPTION)).toEqual(actual.inventory.exemptions.filter(e => e.id !== EXEMPTION));
    const previousExemption = previous.inventory.exemptions.find(e => e.id === EXEMPTION)!;
    const actualExemption = actual.inventory.exemptions.find(e => e.id === EXEMPTION)!;
    expect({ ...previousExemption, linePattern: actualExemption.linePattern }).toEqual(actualExemption);
    expect(actualExemption.expiresOn).toBe("2026-11-17");
    const dated = actual.inventory.exemptions.filter(e => e.expiresOn === "2026-11-17");
    expect(dated).toHaveLength(6);
    expect(actual.inventory.discoveredSites.filter(s => dated.some(e => e.id === s.exemptionId))).toHaveLength(80);
    expect(actual.inventory.discoveredSites.filter(s => s.exemptionId === EXEMPTION)).toHaveLength(9);
    expect(actual.inventory.discoveredSites.filter(s => s.sourceFile === MODULE && s.exemptionId === EXEMPTION).map(s => s.kind)).not.toContain("secret-write");
    expect(actual.inventory.discoveredSites.filter(s => s.sourceFile === MODULE && s.exemptionId === EXEMPTION).map(s => s.kind)).toContain("rename");
  });

  it("rejects the copy site without an owner or exemption", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner })).toThrow(/unregistered persistence site/);
  });

  it("rejects the copy site with both an owner and exemption", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions })).toThrow(/ambiguous persistence site/);
  });

  it("detects a deleted copy site", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, "void 0")) })).toThrow(/dangling/);
  });

  it("detects a duplicated copy site", () => {
    expect(source.split(call)).toHaveLength(2);
    const duplicate = scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, `${call}; ${call}`)) }).inventory;
    expect(duplicate).not.toEqual(inventory);
    expect(duplicate.discoveredSites.filter(s => s.sourceFile === MODULE && s.excerpt === call && s.storeId === OWNER)).toHaveLength(2);
  });

  it("rejects an unknown copy target", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, `${call}; fs.copyFileSync(configSrc, "unknown")`)) })).toThrow(/unregistered persistence site/);
  });

  it("accepts the committed fingerprint and comment-only drift", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed })).resolves.toEqual(committed);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides: overrides(`// comment\n${source}`) })).resolves.toEqual(committed);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides: new Map([[PRODUCT_ROOT, `// comment\n${productRoot}`]]) })).resolves.toEqual(committed);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides: new Map([[HOME_FORWARDER, `// comment\n${homeForwarder}`]]) })).resolves.toEqual(committed);
  });

  it("uses a type-correct forwarder probe that preserves tilde paths but redirects absolute homes", () => {
    const mutated = mutatedHomeForwarder();
    const configPath = path.join(ROOT, "tsconfig.node.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT, undefined, configPath);
    const adapterPath = path.join(ROOT, HOME_FORWARDER);
    const host = ts.createCompilerHost(parsed.options);
    const readFile = host.readFile.bind(host);
    const canonical = (file: string) => ts.sys.useCaseSensitiveFileNames ? path.resolve(file) : path.resolve(file).toLowerCase();
    host.readFile = (file) => canonical(file) === canonical(adapterPath) ? mutated : readFile(file);
    const program = ts.createProgram([adapterPath], parsed.options, host);
    const adapter = program.getSourceFile(adapterPath)!;
    expect(program.getSyntacticDiagnostics(adapter)).toEqual([]);
    expect(program.getSemanticDiagnostics(adapter)).toEqual([]);
    const compiled = ts.transpileModule(mutated, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }, reportDiagnostics: true });
    expect(compiled.diagnostics).toEqual([]);
    const module = { exports: {} as Record<string, (...args: string[]) => string> };
    vm.runInNewContext(compiled.outputText, { exports: module.exports, module, require: createRequire(adapterPath) });
    const home = path.join(os.tmpdir(), "hana-forwarder-probe-home");
    const absolute = path.join(os.tmpdir(), "independent-example");
    expect(resolveHanakoHome("~/.hanako-dev", home)).toBe(path.join(home, ".hanako-dev"));
    expect(resolveHanakoHome(absolute, home)).toBe(absolute);
    expect(module.exports.resolveHanakoHome("~/.hanako-dev", home)).toBe(path.join(home, ".hanako-dev"));
    expect(module.exports.resolveHanakoHome(absolute, home)).toBe(path.join(absolute, "other-root"));
  });

  it("keeps the persistence inventory unchanged when the home forwarder drifts", () => {
    const sourceOverrides = new Map([[HOME_FORWARDER, mutatedHomeForwarder()]]);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
  });

  it("rejects home-forwarder drift through all three related fingerprints", async () => {
    const sourceOverrides = new Map([[HOME_FORWARDER, mutatedHomeForwarder()]]);
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only home forwarder mutation." } });
    const changed = mutation.schemas.filter((s: { storeId: string }) => JSON.stringify(s) !== JSON.stringify(committed.schemas.find((x: { storeId: string }) => x.storeId === s.storeId))).map((s: { storeId: string }) => s.storeId);
    expect(changed).toEqual(["agent-profile", "server-runtime-info", "user-preferences"]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it("keeps the persistence inventory unchanged when the product-root resolver drifts", () => {
    const before = "return path.join(HANA_ROOT, ...segments);";
    expect(productRoot.split(before)).toHaveLength(2);
    const sourceOverrides = new Map([[PRODUCT_ROOT, productRoot.replace(before, 'return path.join(HANA_ROOT, "other-root", ...segments);')]]);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
  });

  it("rejects product-root drift through every related fingerprint", async () => {
    const before = "return path.join(HANA_ROOT, ...segments);";
    expect(productRoot.split(before)).toHaveLength(2);
    const sourceOverrides = new Map([[PRODUCT_ROOT, productRoot.replace(before, 'return path.join(HANA_ROOT, "other-root", ...segments);')]]);
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only product root mutation." } });
    const changed = mutation.schemas.filter((s: { storeId: string }) => JSON.stringify(s) !== JSON.stringify(committed.schemas.find((x: { storeId: string }) => x.storeId === s.storeId))).map((s: { storeId: string }) => s.storeId);
    expect(changed).toEqual(["agent-profile", "server-runtime-info", "user-preferences"]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it.each([
    [PRODUCT_ROOT, productRoot, 'process.env.HANA_ROOT || path.resolve(__dirname, "..")', 'path.resolve(__dirname, "..")'],
    [SERVER, server, 'const productDir = fromRoot("lib");', 'const productDir = fromRoot("other-lib");'],
    [SERVER, server, 'fs.readFileSync(fromRoot("package.json"), "utf-8")', 'fs.readFileSync(fromRoot("other.json"), "utf-8")'],
    [SERVER, server, 'ensureFirstRun(hanakoHome, productDir)', 'ensureFirstRun(hanakoHome, hanakoHome)'],
    [SERVER, server, 'import { ensureFirstRun } from "../core/first-run.ts";', 'import { ensureFirstRun } from "../core/other-first-run.ts";'],
    [SERVER, server, 'import { resolveHanakoHome } from "../shared/hana-runtime-paths.ts";', 'import { resolveHanakoHome } from "../shared/other-runtime-paths.ts";'],
    [SERVER, server, 'import { fromRoot } from "../shared/hana-root.ts";', 'import { fromRoot } from "../shared/other-hana-root.ts";'],
    [HOME_FORWARDER, homeForwarder, 'import runtimePaths from "./hana-runtime-paths.cjs";', 'import runtimePaths from "./other-runtime-paths.cjs";'],
  ])("rejects startup path-chain drift in %s", async (module, text, before, after) => {
    expect(text.split(before)).toHaveLength(2);
    const sourceOverrides = new Map([[module, text.replace(before, after)]]);
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only template root mutation." } });
    const changed = mutation.schemas.filter((s: { storeId: string }) => JSON.stringify(s) !== JSON.stringify(committed.schemas.find((x: { storeId: string }) => x.storeId === s.storeId))).map((s: { storeId: string }) => s.storeId);
    expect(changed).toEqual(["agent-profile", "server-runtime-info", "user-preferences"]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it.each([
    ['const agentId = "hanako";', 'const agentId = "other";'],
    ['const agentsDir = path.join(hanakoHome, "agents");', 'const agentsDir = path.join(hanakoHome, "other");'],
    ['const cfgDest = path.join(agentDir, "config.yaml");', 'const cfgDest = path.join(agentDir, "other.yaml");'],
    ['const configSrc = path.join(productDir, "config.example.yaml");', 'const configSrc = path.join(productDir, "other.yaml");'],
    ['seedDefaultAgent(agentsDir, productDir, userDir);', 'seedDefaultAgent(userDir, productDir, userDir);'],
    ['seedDefaultAgent(agentsDir, productDir, userDir);', 'seedDefaultAgent(agentsDir, userDir, userDir);'],
    ['if (!hasAgent || needsDefaultAgentRepair) {', 'if (!hasAgent && needsDefaultAgentRepair) {'],
  ])("fingerprints config-copy contract drift: %s", async (before, after) => {
    expect(source.split(before)).toHaveLength(2);
    const sourceOverrides = overrides(source.replace(before, after));
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only first-run copy contract mutation." } });
    expect(mutation.schemas.find((s: { storeId: string }) => s.storeId === OWNER)).not.toEqual(committed.schemas.find((s: { storeId: string }) => s.storeId === OWNER));
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it("copies the exact template to the sole profile owner and does not reseed a valid default", () => {
    const { home, product, template, target, bytes } = setup();
    const copy = fs.copyFileSync.bind(fs);
    const captured: { src: string; dst: string; bytes: string }[] = [];
    const spy = vi.spyOn(fs, "copyFileSync").mockImplementation(((src, dst, flags) => {
      copy(src, dst, flags);
      if (String(dst) === target) captured.push({ src: String(src), dst: String(dst), bytes: fs.readFileSync(dst, "utf8") });
    }) as typeof fs.copyFileSync);
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(true);
    expect(captured).toEqual([{ src: template, dst: target, bytes }]);
    const owners = PERSISTENT_STORES.filter(s => s.pathPatterns.some(p => expandStorePathPattern(home, p).some(m => m.relPath === "agents/hanako/config.yaml")));
    expect(owners.map(s => s.id)).toEqual([OWNER]);
    fs.writeFileSync(target, "agent:\n  name: Custom\n");
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("agent:\n  name: Custom\n");
    expect(spy.mock.calls.filter(([, dst]) => String(dst) === target)).toHaveLength(1);
  });

  it("repairs a missing default config even when another valid agent exists", () => {
    const { home, product, target } = setup();
    const other = path.join(home, "agents", "other", "config.yaml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "agent:\n  name: Other\n");
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(other, "utf8")).toBe("agent:\n  name: Other\n");
  });

  it("does not seed a missing default when another valid agent exists", () => {
    const { home, product, target } = setup();
    const other = path.join(home, "agents", "other", "config.yaml");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "agent: {}\n");
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("fails before the copy when the template is missing", () => {
    const { home, product, template, target } = setup();
    fs.rmSync(template);
    expect(() => ensureFirstRun(home, product)).toThrow("first-run template missing");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("can leave a partial valid config after a failed copy without repairing it on retry", () => {
    const { home, product, target } = setup();
    const copy = fs.copyFileSync.bind(fs);
    const spy = vi.spyOn(fs, "copyFileSync").mockImplementation(((src, dst, flags) => {
      if (String(dst) === target) { fs.writeFileSync(dst, "agent: {}\n"); throw new Error("simulated copy failure"); }
      return copy(src, dst, flags);
    }) as typeof fs.copyFileSync);
    expect(() => ensureFirstRun(home, product)).toThrow("simulated copy failure");
    spy.mockRestore();
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("agent: {}\n");
  });
});
