import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFirstRun } from "../core/first-run.ts";
import { expandStorePathPattern } from "../core/data-epoch-checkpoint-provider.ts";
import { assertCommittedPersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/first-run.ts";
const OWNER = "user-preferences";
const EXEMPTION = "cross-store-first-run-bootstrap";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server/index.ts"), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const owned = 'fs.writeFileSync( prefsPath, JSON.stringify({ primaryAgent: "hanako", }, null, 2) + "\\n", "utf-8", )';
const call = `fs.writeFileSync(\n      prefsPath,\n      JSON.stringify({\n        primaryAgent: "hanako",\n      }, null, 2) + "\\n",\n      "utf-8",\n    )`;
const reason = "Seeds the missing user preferences document on first run.";
const withoutOwner = PERSISTENT_STORES.map(s => s.id !== OWNER ? s : { ...s, siteRules: s.siteRules.filter(r => r.reason !== reason) });
const broadExemptions = PERSISTENCE_EXEMPTIONS.map(e => e.id !== EXEMPTION ? e : { ...e, kinds: undefined, linePattern: undefined });
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(e => e.id !== EXEMPTION ? e : { ...e, linePattern: `(?:${e.linePattern})|(?:^fs\\.writeFileSync\\( prefsPath,)` });
const overrides = (text: string) => new Map([[MODULE, text]]);
const tempDirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-first-run-preferences-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const product = path.join(root, "product");
  fs.mkdirSync(path.join(home, "agents", "existing"), { recursive: true });
  fs.writeFileSync(path.join(home, "agents", "existing", "config.yaml"), "agent: {}\n");
  fs.mkdirSync(product);
  return { home, product, target: path.join(home, "user", "preferences.json") };
}

describe("first-run preferences ownership", () => {
  it("moves exactly one site and keeps all other mappings and the expiry", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
    const previous = scanPersistentStores({ rootDir: ROOT, stores: withoutOwner, exemptions: priorExemptions });
    const changed = previous.inventory.discoveredSites.map((before, i) => ({ before, after: actual.inventory.discoveredSites[i] }))
      .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(changed).toHaveLength(1);
    const { before, after } = changed[0];
    expect(before).toMatchObject({ sourceFile: MODULE, kind: "write-file", excerpt: owned, storeId: null, exemptionId: EXEMPTION });
    expect(after).toMatchObject({ sourceFile: MODULE, kind: "write-file", excerpt: owned, storeId: OWNER, exemptionId: null, reason });
    expect({ ...before, storeId: after.storeId, exemptionId: after.exemptionId, reason: after.reason }).toEqual(after);
    expect(previous.inventory.stores).toEqual(actual.inventory.stores);
    expect(previous.startupReceipt).toEqual(actual.startupReceipt);
    const exemptions = actual.inventory.exemptions.filter(e => e.expiresOn === "2026-11-17");
    expect(exemptions).toHaveLength(6);
    expect(actual.inventory.discoveredSites.filter(s => exemptions.some(e => e.id === s.exemptionId))).toHaveLength(83);
    expect(actual.inventory.discoveredSites.filter(s => s.exemptionId === EXEMPTION)).toHaveLength(9);
    expect(actual.inventory.exemptions.find(e => e.id === EXEMPTION)?.expiresOn).toBe("2026-11-17");
  });

  it("rejects a preferences write without its owner", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: withoutOwner })).toThrow(/unregistered persistence site/);
  });

  it("rejects overlapping preferences ownership", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: broadExemptions })).toThrow(/ambiguous persistence site/);
  });

  it("creates real default bytes under exactly one registered owner and preserves them on repeat", () => {
    const { home, product, target } = setup();
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target, "utf8")).toBe('{\n  "primaryAgent": "hanako"\n}\n');
    const rel = "user/preferences.json";
    const owners = PERSISTENT_STORES.filter(s => s.pathPatterns.some(p => expandStorePathPattern(home, p).some(m => m.relPath === rel)));
    expect(owners.map(s => s.id)).toEqual([OWNER]);
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target, "utf8")).toBe('{\n  "primaryAgent": "hanako"\n}\n');
  });

  it.each([['custom', '{"primaryAgent":"custom", "unknown":true}\n'], ['damaged', '{broken\u0000']])("preserves %s existing bytes", (_label, contents) => {
    const { home, product, target } = setup();
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, contents);
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target)).toEqual(Buffer.from(contents));
  });

  it("does not claim to repair a partial file left by a failed direct write", () => {
    const { home, product, target } = setup();
    const write = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      if (file === target) { write(file, '{"primary'); throw new Error("simulated write failure"); }
      return write(file, data, options);
    }) as typeof fs.writeFileSync);
    expect(() => ensureFirstRun(home, product)).toThrow("simulated write failure");
    spy.mockRestore();
    ensureFirstRun(home, product);
    expect(fs.readFileSync(target, "utf8")).toBe('{"primary');
  });

  it("detects a deleted preferences write", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, "void 0")) })).toThrow(/dangling/);
  });

  it("detects a duplicated preferences write", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, `${call}; ${call}`)) }).inventory).not.toEqual(inventory);
  });

  it("detects an unknown preferences write", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, `${call}; fs.writeFileSync("unknown", "x")`)) })).toThrow(/unregistered persistence site/);
  });

  it("detects an overlapping preferences exemption", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: broadExemptions })).toThrow(/ambiguous persistence site/);
  });

  it("accepts the committed fingerprint", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toBeDefined();
  });

  it("accepts comment-only fingerprint drift", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, sourceOverrides: overrides(`// comment\n${source}`) })).resolves.toBeDefined();
  });
  it.each([
    [MODULE, source, 'path.join(hanakoHome, "user", "preferences.json")', 'path.join(hanakoHome, "user", "other.json")'],
    [MODULE, source, 'if (!fs.existsSync(prefsPath))', 'if (true)'],
    [MODULE, source, 'primaryAgent: "hanako",', 'primaryAgent: "other",'],
    ["server/index.ts", server, 'const hanakoHome = resolveHanakoHome(process.env.HANA_HOME);', 'const hanakoHome = resolveHanakoHome(undefined);'],
    ["server/index.ts", server, 'ensureFirstRun(hanakoHome, productDir)', 'ensureFirstRun(productDir, productDir)'],
  ])("fingerprints execution source mutation in %s: %s", async (module, text, before, after) => {
    expect(text.split(before)).toHaveLength(2);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides: new Map([[module, text.replace(before, after)]]) })).rejects.toThrow(/fingerprint mismatch/);
  });
});
