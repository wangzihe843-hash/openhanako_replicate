import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { PERSISTENCE_EXEMPTIONS } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/local-user-account.ts";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const committedFingerprint = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const overrides = (text: string) => new Map([[MODULE, text]]);
vi.setConfig({ testTimeout: 30_000 });

describe("local account persistence ownership", () => {
  it("owns the four fixed-target sites and retains the reviewed inventory and receipt", () => {
    const result = scanPersistentStores({ rootDir: ROOT });
    expect(result.inventory).toEqual(inventory);
    expect(result.inventory.discoveredSites).toHaveLength(905);
    expect(result.inventory.exemptions).toHaveLength(32);
    expect(result.inventory.discoveredSites.filter((site: {sourceFile: string}) => site.sourceFile !== MODULE)).toHaveLength(901);
    expect(result.inventory.discoveredSites.filter((site: {sourceFile: string}) => site.sourceFile === MODULE).map((s: {kind: string; storeId: string; exemptionId: string | null; excerpt: string}) => [s.kind, s.storeId, s.exemptionId, s.excerpt])).toEqual([
      ["mkdir", "local-user-auth", null, "fs.mkdirSync(path.dirname(path.join(hanakoHome, LOCAL_USER_AUTH_FILE)), { recursive: true })"],
      ["mkdir", "user-studio-registries", null, "fs.mkdirSync(path.dirname(path.join(hanakoHome, USERS_FILE)), { recursive: true })"],
      ["secret-write", "local-user-auth", null, 'writeSecretFileSync(path.join(hanakoHome, LOCAL_USER_AUTH_FILE), JSON.stringify(data, null, 2) + "\\n")'],
      ["secret-write", "user-studio-registries", null, 'writeSecretFileSync(path.join(hanakoHome, USERS_FILE), JSON.stringify(data, null, 2) + "\\n")'],
    ]);
    expect(result.inventory.exemptions.some((e: {id: string}) => e.id === "local-user-account-atomic-helper")).toBe(false);
    expect(result.startupReceipt).toEqual(JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8")));
  });

  it.each([
    ["basename", 'const USERS_FILE = "users.json"', 'const USERS_FILE = "other.json"'],
    ["swapped helper", "writeLocalUsers(hanakoHome, users);", "writeLocalAuth(hanakoHome, users);"],
    ["duplicate helper", "writeLocalUsers(hanakoHome, users);", "writeLocalUsers(hanakoHome, users);\n  writeLocalUsers(hanakoHome, users);"],
    ["exported helper", "function writeLocalUsers(", "export function writeLocalUsers("],
    ["aliased helper", "writeLocalUsers(hanakoHome, users);", "const alias = writeLocalUsers;\n  alias(hanakoHome, users);"],
  ])("rejects %s protocol drift", async (_label, before, after) => {
    expect(source.split(before)).toHaveLength(2);
    const sourceOverrides = overrides(source.replace(before, after));
    const changed = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only protocol mutation." } });
    expect(changed.payloadFingerprint).not.toBe(committedFingerprint.payloadFingerprint);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it("detects removed, ordinary, unknown and duplicate writes", () => {
    const write = 'writeSecretFileSync(path.join(hanakoHome, USERS_FILE), JSON.stringify(data, null, 2) + "\\n")';
    expect(source.split(write)).toHaveLength(2);
    for (const changed of ["void hanakoHome", 'fs.writeFileSync(path.join(hanakoHome, USERS_FILE), "x")', `${write}; fs.writeFileSync("unknown", "x")`]) {
      expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(write, changed)) })).toThrow();
    }
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(write, `${write}; ${write}`)) }).inventory).not.toEqual(inventory);
    const mkdir = "fs.mkdirSync(path.dirname(path.join(hanakoHome, USERS_FILE)), { recursive: true })";
    expect(source.split(mkdir)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(mkdir, 'fs.mkdirSync("unknown", { recursive: true })')) })).toThrow();
    const retired = {
      id: "local-user-account-atomic-helper", ownerModule: MODULE, sourceFile: MODULE,
      reason: "The file-local atomic helper receives paths only from the separately registered users.json and local-user-auth.json call sites.",
      expiresOn: "2026-11-17", kinds: ["mkdir", "secret-write"],
      linePattern: "(?:path[.]dirname\\(filePath\\)|writeSecretFileSync\\(filePath)",
    };
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: [...PERSISTENCE_EXEMPTIONS, retired] })).toThrow(/dangling/);
  });

  it("pins the shared writer, both store protocols and all real account entry points", () => {
    const stores = inventory.stores.filter((s: {id: string}) => ["local-user-auth", "user-studio-registries"].includes(s.id));
    const actual = ["getLocalAccountSummary", "updateLocalAccountProfile", "setLocalAccountPassword", "clearLocalAccountPassword", "verifyLocalAccountPassword"];
    for (const store of stores) expect(store.openEntry).toEqual(expect.arrayContaining(actual));
    expect(stores.find((s: {id: string}) => s.id === "local-user-auth").openEntry).toContain("loadLocalUserAuth");
    for (const id of ["local-user-auth", "user-studio-registries"]) {
      const schema = committedFingerprint.schemas.find((s: {storeId: string}) => s.storeId === id);
      expect(schema.protocolModules.map((p: {module: string}) => p.module)).toContain("shared/secret-fs.ts");
    }
    expect(committedFingerprint.schemas.find((s: {storeId: string}) => s.storeId === "user-studio-registries").protocolModules.map((p: {module: string}) => p.module)).toContain(MODULE);
  });

  it("keeps each modifying route behind the local-owner check and uses the engine home", () => {
    const route = fs.readFileSync(path.join(ROOT, "server/routes/access.ts"), "utf8");
    for (const [verb, endpoint, call] of [["put", "/access/account/profile", "updateLocalAccountProfile"], ["put", "/access/account/password", "setLocalAccountPassword"], ["delete", "/access/account/password", "clearLocalAccountPassword"]]) {
      const start = route.indexOf(`route.${verb}("${endpoint}"`);
      expect(start).toBeGreaterThan(-1);
      const block = route.slice(start, route.indexOf("\n  });", start));
      expect(block).toContain("const denied = requireLocalOwner(c);");
      expect(block).toContain("if (denied) return denied;");
      expect(block).toContain(`${call}(engine.hanakoHome,`);
      expect(block.indexOf("if (denied) return denied;")).toBeLessThan(block.indexOf(`${call}(engine.hanakoHome,`));
    }
  });
});
