import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFirstRun } from "../core/first-run.ts";
import { expandStorePathPattern } from "../core/data-epoch-checkpoint-provider.ts";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { DEFAULT_HEARTBEAT_INTERVAL_MINUTES, DEFAULT_WORKSPACE_DIRNAME } from "../shared/default-workspace.ts";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import * as secretFs from "../shared/secret-fs.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/first-run.ts";
const OWNER = "agent-profile";
const EXEMPTION = "cross-store-first-run-bootstrap";
const reason = "Writes the final default agent configuration during first-run seeding or repair.";
const call = `writeSecretFileSync(cfgDest, YAML.dump(raw, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }))`;
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const noOwner = PERSISTENT_STORES.map(s => s.id !== OWNER ? s : { ...s, siteRules: s.siteRules.filter(r => r.reason !== reason) });
const escapedCall = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(e => e.id !== EXEMPTION ? e : {
  ...e, kinds: ["copy-file", "mkdir", "rename", "secret-write", "write-file"],
  linePattern: `(?:${e.linePattern})|(?:^${escapedCall}$)`,
});
const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-first-run-config-write-"));
  tempDirs.push(root);
  const home = path.join(root, "hana-home"), product = path.join(root, "product"), osHome = path.join(root, "os-home");
  const target = path.join(home, "agents", "hanako", "config.yaml");
  fs.mkdirSync(product, { recursive: true });
  fs.writeFileSync(path.join(product, "config.example.yaml"), YAML.dump({
    agent: { name: "Synthetic Hanako", yuan: "hanako" },
    desk: { home_folder: "template-placeholder", heartbeat_enabled: true, heartbeat_interval: 99, retained: "desk-value" },
    memory: { enabled: false, retained: "memory-value" },
    synthetic: { retained: "config-value" },
  }));
  vi.spyOn(os, "homedir").mockReturnValue(osHome);
  return { home, product, target, osHome };
}

describe("first-run final config write ownership", () => {
  it("moves only the final config write and preserves every other mapping, descriptor and phase", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    const previous = scanPersistentStores({ rootDir: ROOT, stores: noOwner, exemptions: priorExemptions });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
    expect(actual.inventory.stores).toHaveLength(65);
    expect(previous.inventory.discoveredSites).toHaveLength(905);
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    const changed = previous.inventory.discoveredSites.map((before, i) => ({ before, after: actual.inventory.discoveredSites[i] }))
      .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(changed).toHaveLength(1);
    const { before, after } = changed[0];
    expect(before).toMatchObject({ sourceFile: MODULE, kind: "secret-write", excerpt: call, ordinal: 0, storeId: null, exemptionId: EXEMPTION });
    expect(after).toMatchObject({ sourceFile: MODULE, kind: "secret-write", excerpt: call, ordinal: 0, storeId: OWNER, exemptionId: null, reason });
    expect({ ...before, reason: after.reason, storeId: after.storeId, exemptionId: after.exemptionId }).toEqual(after);
    expect(previous.inventory.stores).toEqual(actual.inventory.stores);
    expect(previous.startupReceipt).toEqual(actual.startupReceipt);
    expect(actual.inventory.exemptions).toHaveLength(32);
    expect(previous.inventory.exemptions.filter(e => e.id !== EXEMPTION)).toEqual(actual.inventory.exemptions.filter(e => e.id !== EXEMPTION));
    const prior = previous.inventory.exemptions.find(e => e.id === EXEMPTION)!;
    const current = actual.inventory.exemptions.find(e => e.id === EXEMPTION)!;
    expect({ ...prior, kinds: current.kinds, linePattern: current.linePattern }).toEqual(current);
    expect(current.expiresOn).toBe("2026-11-17");
    expect(current.kinds).toEqual(["copy-file", "mkdir", "rename", "write-file"]);
    const dated = actual.inventory.exemptions.filter(e => e.expiresOn === "2026-11-17");
    expect(dated).toHaveLength(6);
    expect(previous.inventory.discoveredSites.filter(s => dated.some(e => e.id === s.exemptionId))).toHaveLength(79);
    expect(actual.inventory.discoveredSites.filter(s => dated.some(e => e.id === s.exemptionId))).toHaveLength(78);
    expect(previous.inventory.discoveredSites.filter(s => s.exemptionId === EXEMPTION)).toHaveLength(10);
    expect(actual.inventory.discoveredSites.filter(s => s.exemptionId === EXEMPTION)).toHaveLength(9);
    expect(actual.inventory.discoveredSites.filter(s => s.sourceFile === MODULE && s.kind === "copy-file" && s.excerpt === "fs.copyFileSync(configSrc, cfgDest)"))
      .toEqual([expect.objectContaining({ storeId: OWNER, exemptionId: null })]);
  });

  it("rejects the write without an owner or exemption", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner })).toThrow(/unregistered persistence site/);
  });

  it("rejects simultaneous ownership and exemption", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions })).toThrow(/ambiguous persistence site/);
  });

  it("detects deletion of the exact call", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: new Map([[MODULE, source.replace(call, "void 0")]]) })).toThrow(/dangling/);
  });

  it("detects duplication of the exact call", () => {
    expect(source.split(call)).toHaveLength(2);
    const duplicated = scanPersistentStores({ rootDir: ROOT, sourceOverrides: new Map([[MODULE, source.replace(call, `${call}; ${call}`)]]) }).inventory;
    expect(duplicated).not.toEqual(inventory);
    expect(duplicated.discoveredSites.filter(s => s.sourceFile === MODULE && s.excerpt === call && s.storeId === OWNER)).toHaveLength(2);
  });

  it("rejects an additional write to an unknown target", () => {
    expect(source.split(call)).toHaveLength(2);
    const unknown = call.replace("cfgDest", "unknownDest");
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: new Map([[MODULE, source.replace(call, `${call}; ${unknown}`)]]) })).toThrow(/unregistered persistence site/);
  });

  it("changes only the fingerprint mapping, exemption and review", async () => {
    const previousInventory = scanPersistentStores({ rootDir: ROOT, stores: noOwner, exemptions: priorExemptions }).inventory;
    const previous = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previousInventory, review: { classification: "compatible", compatibilityReason: "Test-only ownership comparison." } });
    const { siteMappings: oldSites, exemptions: oldExemptions, payloadFingerprint: oldHash, review: oldReview, ...oldRest } = previous;
    const { siteMappings, exemptions, payloadFingerprint, review, ...rest } = committed;
    expect(rest).toEqual(oldRest);
    expect(rest.dataEpoch).toBe(1);
    expect(siteMappings).not.toEqual(oldSites);
    expect(exemptions).not.toEqual(oldExemptions);
    expect(payloadFingerprint).not.toBe(oldHash);
    expect(review.classification).toBe(oldReview.classification);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed })).resolves.toEqual(committed);
  });

  it.each([
    ["home_folder: ensureDefaultWorkspace(),", 'home_folder: "other-workspace",'],
    ["heartbeat_enabled: false,", "heartbeat_enabled: true,"],
    ["heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,", "heartbeat_interval: 99,"],
    ["enabled: true,", "enabled: false,"],
    ['const cfgDest = path.join(agentDir, "config.yaml");', 'const cfgDest = path.join(agentDir, "other.yaml");'],
  ])("retains the fingerprint gate for final config drift: %s", async (before, after) => {
    expect(source.split(before)).toHaveLength(2);
    const sourceOverrides = new Map([[MODULE, source.replace(before, after)]]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it("publishes the final seeded config to the same sole owner as its template copy", () => {
    const { home, product, target, osHome } = setup();
    const write = secretFs.writeSecretFileSync;
    const captured: { target: string; value: unknown }[] = [];
    const writer = vi.spyOn(secretFs, "writeSecretFileSync").mockImplementation((file, content) => {
      write(file, content);
      captured.push({ target: file, value: YAML.load(content) });
    });
    const copy = vi.spyOn(fs, "copyFileSync");
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(true);
    expect(captured).toEqual([{ target, value: {
      agent: { name: "Synthetic Hanako", yuan: "hanako" },
      desk: { home_folder: path.join(osHome, "Desktop", DEFAULT_WORKSPACE_DIRNAME), heartbeat_enabled: false, heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_MINUTES, retained: "desk-value" },
      memory: { enabled: true, retained: "memory-value" },
      synthetic: { retained: "config-value" },
    } }]);
    expect(YAML.load(fs.readFileSync(target, "utf8"))).toEqual(captured[0].value);
    expect(copy.mock.calls.filter(([, dst]) => String(dst) === target)).toHaveLength(1);
    const owners = PERSISTENT_STORES.filter(s => s.pathPatterns.some(p => expandStorePathPattern(home, p).some(m => m.relPath === "agents/hanako/config.yaml")));
    expect(owners.map(s => s.id)).toEqual([OWNER]);
    fs.writeFileSync(target, "agent:\n  name: Custom\nmemory:\n  enabled: false\n");
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("agent:\n  name: Custom\nmemory:\n  enabled: false\n");
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("writes the final repaired default config while retaining another valid profile", () => {
    const { home, product, target } = setup();
    const other = path.join(home, "agents", "other", "config.yaml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "agent:\n  name: Other\n");
    const writer = vi.spyOn(secretFs, "writeSecretFileSync");
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(true);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[0][0]).toBe(target);
    expect(YAML.load(fs.readFileSync(target, "utf8"))).toMatchObject({ memory: { enabled: true }, desk: { heartbeat_enabled: false } });
    expect(fs.readFileSync(other, "utf8")).toBe("agent:\n  name: Other\n");
  });
});
