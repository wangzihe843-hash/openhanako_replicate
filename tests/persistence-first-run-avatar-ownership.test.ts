import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFirstRun } from "../core/first-run.ts";
import { createDataEpochCheckpointProvider, expandStorePathPattern } from "../core/data-epoch-checkpoint-provider.ts";
import { restoreDataEpochCheckpoint } from "../core/data-epoch-restore.ts";
import { writeAvatar } from "../server/utils/avatar-files.ts";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/first-run.ts";
const OWNER = "agent-profile";
const EXEMPTION = "cross-store-first-run-bootstrap";
const REASON = "Creates the default agent avatar file parent directory during first-run seeding or repair.";
const CALL = 'fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true })';
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const noOwner = PERSISTENT_STORES.map(s => s.id !== OWNER ? s : { ...s, siteRules: s.siteRules.filter(r => r.reason !== REASON) });
const escapedCall = CALL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(e => e.id !== EXEMPTION ? e : { ...e, linePattern: `(?:${e.linePattern})|(?:^${escapedCall}$)` });
const sourceOverride = (text: string) => new Map([[MODULE, text]]);
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-first-run-avatar-"));
  tempDirs.push(root);
  const home = path.join(root, "hana-home");
  const osHome = path.join(root, "os-home");
  const product = path.join(root, "product");
  fs.mkdirSync(product, { recursive: true });
  fs.mkdirSync(osHome, { recursive: true });
  fs.writeFileSync(path.join(product, "config.example.yaml"), "agent:\n  name: Hanako\n  yuan: hanako\n");
  vi.stubEnv("HOME", osHome);
  vi.stubEnv("USERPROFILE", osHome);
  vi.stubEnv("HANA_HOME", home);
  vi.spyOn(os, "homedir").mockReturnValue(osHome);
  expect(os.homedir()).toBe(osHome);
  return { home, osHome, product, agentDir: path.join(home, "agents", "hanako") };
}

function fileOwners(home: string, relativePath: string) {
  return PERSISTENT_STORES.filter(store => store.pathPatterns.some(pattern =>
    expandStorePathPattern(home, pattern).some(match => match.relPath === relativePath && !match.isDirectory),
  )).map(store => store.id);
}

describe("first-run avatar parent ownership", () => {
  it("moves exactly the avatar mkdir and retains all other sites, paths, receipt and expiries", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    const previous = scanPersistentStores({ rootDir: ROOT, stores: noOwner, exemptions: priorExemptions });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.startupReceipt).toEqual(receipt);
    expect(actual.inventory.stores).toHaveLength(65);
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    expect(previous.inventory.stores).toEqual(actual.inventory.stores);
    expect(previous.startupReceipt).toEqual(actual.startupReceipt);
    const changed = previous.inventory.discoveredSites.map((before, i) => ({ before, after: actual.inventory.discoveredSites[i] }))
      .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(changed).toHaveLength(1);
    const { before, after } = changed[0];
    expect(before).toMatchObject({ sourceFile: MODULE, kind: "mkdir", excerpt: CALL, ordinal: 0, storeId: null, exemptionId: EXEMPTION });
    expect(after).toMatchObject({ sourceFile: MODULE, kind: "mkdir", excerpt: CALL, ordinal: 0, storeId: OWNER, exemptionId: null, reason: REASON });
    expect({ ...before, storeId: OWNER, exemptionId: null, reason: REASON }).toEqual(after);
    expect(previous.inventory.exemptions.filter(e => e.id !== EXEMPTION)).toEqual(actual.inventory.exemptions.filter(e => e.id !== EXEMPTION));
    const dated = actual.inventory.exemptions.filter(e => e.expiresOn === "2026-11-17");
    expect(dated).toHaveLength(6);
    expect(actual.inventory.discoveredSites.filter(s => dated.some(e => e.id === s.exemptionId))).toHaveLength(85);
    expect(actual.inventory.discoveredSites.filter(s => s.exemptionId === EXEMPTION)).toHaveLength(10);
    expect(previous.inventory.discoveredSites.filter(s => dated.some(e => e.id === s.exemptionId))).toHaveLength(86);
    expect(committed.dataEpoch).toBe(1);
  });

  it("rejects an unowned site and both an overlapping exemption and another store", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner })).toThrow(/unregistered persistence site/);
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions })).toThrow(/ambiguous persistence site/);
    const rule = PERSISTENT_STORES.find(s => s.id === OWNER)!.siteRules.find(r => r.reason === REASON)!;
    const twoOwners = PERSISTENT_STORES.map(s => s.id === "user-preferences" ? { ...s, siteRules: [...s.siteRules, rule] } : s);
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: twoOwners })).toThrow(/ambiguous persistence site/);
  });

  it("rejects a removed or wrong avatar target", () => {
    expect(source.split(CALL)).toHaveLength(2);
    for (const replacement of ["void 0", CALL.replace('"avatars"', '"wrong-avatars"')]) {
      expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: sourceOverride(source.replace(CALL, replacement)) })).toThrow(/dangling|unregistered persistence site/);
    }
  });

  it("records a duplicate site and rejects its changed fingerprint", async () => {
    expect(source.split(CALL)).toHaveLength(2);
    const sourceOverrides = sourceOverride(source.replace(CALL, `${CALL}; ${CALL}`));
    const mutatedInventory = scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory;
    expect(mutatedInventory.discoveredSites).toHaveLength(906);
    expect(mutatedInventory.discoveredSites.filter(s => s.sourceFile === MODULE && s.excerpt === CALL && s.storeId === OWNER)).toHaveLength(2);
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: mutatedInventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only duplicate call." } });
    expect(mutation.payloadFingerprint).not.toBe(committed.payloadFingerprint);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: mutatedInventory, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it("preserves ordinary comments while binding the agent directory expression", async () => {
    const ordinary = sourceOverride(`// ordinary comment\n${source}`);
    const commentedInventory = scanPersistentStores({ rootDir: ROOT, sourceOverrides: ordinary }).inventory;
    expect(commentedInventory).toEqual(inventory);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: commentedInventory, sourceOverrides: ordinary })).resolves.toEqual(committed);
    const before = "path.join(agentsDir, agentId)";
    expect(source.split(before)).toHaveLength(2);
    const changed = sourceOverride(source.replace(before, 'path.join(agentsDir, "other")'));
    const changedInventory = scanPersistentStores({ rootDir: ROOT, sourceOverrides: changed }).inventory;
    expect(changedInventory).toEqual(inventory);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: changedInventory, sourceOverrides: changed })).rejects.toThrow(/fingerprint mismatch/);
  });

  it.each([
    ["PURE", CALL, `/* @__PURE__ */ ${CALL}`],
    ["NO_SIDE_EFFECTS", "function seedDefaultAgent(", "/* #__NO_SIDE_EFFECTS__ */ function seedDefaultAgent("],
  ])("rejects an effective %s build annotation", async (_name, before, after) => {
    expect(source.split(before)).toHaveLength(2);
    const sourceOverrides = sourceOverride(source.replace(before, after));
    const changedInventory = scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory;
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory: changedInventory, sourceOverrides })).rejects.toThrow(/effective PURE or NO_SIDE_EFFECTS build annotation/);
  });

  it("seeds an avatar directory in the supplied home and preserves avatar bytes on repeat", async () => {
    const { home, osHome, product, agentDir } = setup();
    const report = ensureFirstRun(home, product);
    const avatars = path.join(agentDir, "avatars");
    expect(report.repairedDefaultAgent).toBe(true);
    expect(fs.statSync(avatars).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(osHome, "Desktop", "OH-WorkSpace"))).toBe(true);
    await writeAvatar(avatars, "face", "png", Buffer.from("existing avatar"));
    expect(fileOwners(home, "agents/hanako/avatars/face.png")).toEqual([OWNER]);
    const temp = path.join(avatars, "face.png.test-id.tmp");
    fs.writeFileSync(temp, "temporary avatar");
    expect(fileOwners(home, "agents/hanako/avatars/face.png.test-id.tmp")).toEqual([OWNER]);
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(false);
    expect(fs.readFileSync(path.join(avatars, "face.png"), "utf8")).toBe("existing avatar");
    expect(fs.readFileSync(temp, "utf8")).toBe("temporary avatar");
  });

  it("repairs a missing default config while preserving existing avatars and other agents", () => {
    const { home, product, agentDir } = setup();
    const avatars = path.join(agentDir, "avatars");
    const other = path.join(home, "agents", "other");
    fs.mkdirSync(avatars, { recursive: true });
    fs.writeFileSync(path.join(avatars, "face.png"), "original default avatar");
    fs.mkdirSync(path.join(other, "avatars"), { recursive: true });
    fs.writeFileSync(path.join(other, "config.yaml"), "agent: {}\n");
    fs.writeFileSync(path.join(other, "avatars", "face.png"), "other avatar");
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(true);
    expect(fs.readFileSync(path.join(avatars, "face.png"), "utf8")).toBe("original default avatar");
    expect(fs.readFileSync(path.join(other, "config.yaml"), "utf8")).toBe("agent: {}\n");
    expect(fs.readFileSync(path.join(other, "avatars", "face.png"), "utf8")).toBe("other avatar");
  });

  it("does not create a missing avatar directory for an already valid default agent", () => {
    const { home, product, agentDir } = setup();
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent: {}\n");
    expect(ensureFirstRun(home, product).repairedDefaultAgent).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "avatars"))).toBe(false);
  });

  it("backs up damaged config before a real mkdir failure and leaves earlier side effects", () => {
    const { home, product, agentDir } = setup();
    fs.mkdirSync(agentDir, { recursive: true });
    const damaged = "agent: [unclosed\n";
    fs.writeFileSync(path.join(agentDir, "config.yaml"), damaged);
    fs.writeFileSync(path.join(agentDir, "avatars"), "blocking file");
    expect(() => ensureFirstRun(home, product)).toThrow();
    const backups = fs.readdirSync(agentDir).filter(name => name.startsWith("config.yaml.broken-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(agentDir, backups[0]), "utf8")).toBe(damaged);
    expect(fs.readFileSync(path.join(agentDir, "avatars"), "utf8")).toBe("blocking file");
    expect(fs.statSync(path.join(home, "user")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(agentDir, "memory")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(agentDir, "sessions")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "desk"))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "config.yaml"))).toBe(false);
  });

  it("creates the avatar directory before reporting a missing template", () => {
    const { home, product, agentDir } = setup();
    fs.unlinkSync(path.join(product, "config.example.yaml"));
    expect(() => ensureFirstRun(home, product)).toThrow(/first-run template missing/);
    expect(fs.statSync(path.join(agentDir, "avatars")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(agentDir, "desk")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "config.yaml"))).toBe(false);
  });

  it("checkpoints avatar files, restores their parents, and does not restore empty avatar directories", async () => {
    const { home } = setup();
    const avatar = path.join(home, "agents", "hanako", "avatars", "face.png");
    const empty = path.join(home, "agents", "other", "avatars");
    fs.mkdirSync(path.dirname(avatar), { recursive: true });
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(avatar, "snapshot avatar");
    const store = PERSISTENT_STORES.find(s => s.id === OWNER)!;
    expect(store.pathKind).toBe("file");
    const provider = createDataEpochCheckpointProvider({ stores: [store] });
    const captured = await provider.create({ homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "avatar-parent", affectedStoreIds: [OWNER] });
    expect(captured.itemCount).toBe(1);
    fs.rmSync(path.dirname(avatar), { recursive: true });
    fs.rmSync(empty, { recursive: true });
    await restoreDataEpochCheckpoint({ homeDir: home, transitionId: "avatar-parent", confirmToken: "restore avatar-parent", stores: [store], log: { warn: () => {} } });
    expect(fs.readFileSync(avatar, "utf8")).toBe("snapshot avatar");
    expect(fs.existsSync(empty)).toBe(false);
    fs.rmSync(path.dirname(avatar), { recursive: true });
    await writeAvatar(path.dirname(avatar), "face", "png", Buffer.from("new avatar"));
    expect(fs.readFileSync(avatar, "utf8")).toBe("new avatar");
  });
});
