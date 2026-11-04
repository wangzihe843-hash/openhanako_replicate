import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { PERSISTENCE_EXEMPTIONS } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/server-identity.ts";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const overrides = (text: string) => new Map([[MODULE, text]]);
vi.setConfig({ testTimeout: 30_000 });

describe("identity persistence ownership", () => {
  it("registers the six fixed-target sites and keeps the real-date inventory and receipt", () => {
    const result = scanPersistentStores({ rootDir: ROOT });
    expect(result.inventory).toEqual(inventory);
    expect(result.startupReceipt).toEqual(JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8")));
    expect(result.inventory.discoveredSites).toHaveLength(903);
    expect(result.inventory.discoveredSites.filter((site: {sourceFile: string}) => site.sourceFile !== MODULE)).toHaveLength(897);
    const sites = result.inventory.discoveredSites.filter((site: {sourceFile: string}) => site.sourceFile === MODULE);
    expect(sites.map((site: {kind: string; storeId: string; exemptionId: string | null; excerpt: string}) => [site.kind, site.storeId, site.exemptionId, site.excerpt])).toEqual([
      ["atomic-write", "server-node-identity", null, 'atomicWriteSync(path.join(hanakoHome, SERVER_NODE_FILE), JSON.stringify(data, null, 2) + "\\n")'],
      ["atomic-write", "user-studio-registries", null, 'atomicWriteSync(path.join(hanakoHome, STUDIOS_FILE), JSON.stringify(data, null, 2) + "\\n")'],
      ["atomic-write", "user-studio-registries", null, 'atomicWriteSync(path.join(hanakoHome, USERS_FILE), JSON.stringify(data, null, 2) + "\\n")'],
      ["mkdir", "server-node-identity", null, "fs.mkdirSync(path.dirname(path.join(hanakoHome, SERVER_NODE_FILE)), { recursive: true })"],
      ["mkdir", "user-studio-registries", null, "fs.mkdirSync(path.dirname(path.join(hanakoHome, STUDIOS_FILE)), { recursive: true })"],
      ["mkdir", "user-studio-registries", null, "fs.mkdirSync(path.dirname(path.join(hanakoHome, USERS_FILE)), { recursive: true })"],
    ]);
    expect(result.inventory.exemptions.some((e: {id: string}) => e.id === "server-identity-atomic-helper")).toBe(false);
    for (const id of ["server-node-identity", "user-studio-registries"]) {
      expect(committed.schemas.find((s: {storeId: string}) => s.storeId === id).protocolModules.map((p: {module: string}) => p.module)).toContain("shared/safe-fs.ts");
    }
  });

  it("pins all five calls and private fixed-target writers", () => {
    for (const statement of [
      "if (!existingServerNode) writeServerNode(hanakoHome, serverNode);",
      "if (!existingUsers) writeIdentityUsers(hanakoHome, users);",
      "else if (repairedIdentityLinks.users) writeIdentityUsers(hanakoHome, users);",
      "if (!existingStudios) writeIdentityStudios(hanakoHome, studios);",
      "else if (repairedIdentityLinks.studios) writeIdentityStudios(hanakoHome, studios);",
    ]) expect(source.split(statement)).toHaveLength(2);
    for (const name of ["writeServerNode", "writeIdentityUsers", "writeIdentityStudios"]) {
      expect(source).toContain(`function ${name}(hanakoHome, data)`);
      expect(source).not.toContain(`export function ${name}`);
    }
    expect(source).not.toContain("writeJsonAtomic");
  });

  it("keeps startup and both migration callers tied to the home argument", () => {
    const server = fs.readFileSync(path.join(ROOT, "server/index.ts"), "utf8");
    const migrations = fs.readFileSync(path.join(ROOT, "core/migrations.ts"), "utf8");
    expect(server.match(/ensureLocalIdentityRegistries\(hanakoHome\)/g)).toHaveLength(1);
    expect(migrations.match(/ensureLocalIdentityRegistries\(hanakoHome\)/g)).toHaveLength(2);
  });

  it.each([
    ["basename", 'const SERVER_NODE_FILE = "server-node.json"', 'const SERVER_NODE_FILE = "other.json"'],
    ["swapped call", 'writeServerNode(hanakoHome, serverNode);', 'writeIdentityUsers(hanakoHome, serverNode);'],
    ["alias", 'writeServerNode(hanakoHome, serverNode);', 'const alias = writeServerNode; alias(hanakoHome, serverNode);'],
    ["export", 'function writeServerNode(', 'export function writeServerNode('],
    ["wrong root", 'path.join(hanakoHome, SERVER_NODE_FILE)', 'path.join("other", SERVER_NODE_FILE)'],
    ["serialization", 'JSON.stringify(data, null, 2)', 'JSON.stringify(data)'],
  ])("rejects %s protocol drift", async (_label, before, after) => {
    expect(source).toContain(before);
    const sourceOverrides = overrides(source.replace(before, after));
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it("pins the shared atomic writer and accepts comments", async () => {
    const module = "shared/safe-fs.ts";
    const safe = fs.readFileSync(path.join(ROOT, module), "utf8");
    expect(safe).toContain('filePath + ".tmp"');
    const sourceOverrides = new Map([[module, safe.replace('filePath + ".tmp"', 'filePath + ".other"')]]);
    const changed = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only atomic protocol mutation." } });
    expect(changed.payloadFingerprint).not.toBe(committed.payloadFingerprint);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
    expect(safe).toContain("fs.renameSync(tmp, filePath)");
    const changedRename = new Map([[module, safe.replace("fs.renameSync(tmp, filePath)", "fs.copyFileSync(tmp, filePath)")]]);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides: changedRename })).rejects.toThrow(/fingerprint mismatch/);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides: overrides(`// comment\n${source}`) })).resolves.toEqual(committed);
  });

  it("detects deleted, unknown, ordinary and duplicate writes and a dangling exemption", () => {
    const write = 'atomicWriteSync(path.join(hanakoHome, SERVER_NODE_FILE), JSON.stringify(data, null, 2) + "\\n")';
    expect(source.split(write)).toHaveLength(2);
    for (const change of ["void hanakoHome", 'fs.writeFileSync("unknown", "x")', `${write}; fs.writeFileSync("unknown", "x")`]) {
      expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(write, change)) })).toThrow();
    }
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(write, `${write}; ${write}`)) }).inventory).not.toEqual(inventory);
    const retired = { id: "server-identity-atomic-helper", ownerModule: MODULE, sourceFile: MODULE, reason: "Old generic identity writer.", expiresOn: "2026-11-17", kinds: ["mkdir", "atomic-write"], linePattern: "(?:path[.]dirname\\(filePath\\)|atomicWriteSync\\(filePath)" };
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: [...PERSISTENCE_EXEMPTIONS, retired] })).toThrow(/dangling/);
  });
});
