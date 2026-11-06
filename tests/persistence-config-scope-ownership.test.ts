import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import { migrateConfigScope } from "../shared/migrate-config-scope.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "shared/migrate-config-scope.ts";
const OWNER = "agent-profile";
const EXEMPTION = "config-scope-migration-helper";
const reason = "Writes the cleaned agent config after preserving its scope-migration backup.";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const oldExemption = { id: EXEMPTION, ownerModule: MODULE, sourceFile: MODULE, reason: "Compatibility helper mutates a caller-supplied config file; concrete agent config ownership is registered at callers.", expiresOn: "2026-11-17", kinds: ["database-open", "write-file", "append-file", "rename", "copy-file", "mkdir", "remove-path", "truncate-file", "atomic-write", "secret-write", "persistent-store-constructor"] };
const oldStores = PERSISTENT_STORES.map((s) => s.id !== OWNER ? s : { ...s, siteRules: s.siteRules.filter((r) => r.reason !== reason), protocolModules: s.protocolModules.filter((p) => ![MODULE, "shared/config-schema.ts", "core/engine.ts"].includes(p)) });
const oldExemptions = PERSISTENCE_EXEMPTIONS.map((e) => e.id === EXEMPTION ? oldExemption : e);
const overrides = (s: string) => new Map([[MODULE, s]]);
const CALLER_PARTITIONS = 8;
const callerPartition = (file: string) => createHash("sha256").update(file).digest().readUInt32BE(0) % CALLER_PARTITIONS;
function usesMigration(file: string, text: string): boolean {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found = false;
  const walk = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "migrateConfigScope") found = true;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.includes("migrate-config-scope")) {
      if (node.importClause?.name || (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings))) found = true;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "migrateConfigScope") found = true;
      if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments.some((arg) => ts.isStringLiteral(arg) && arg.text.includes("migrate-config-scope"))) found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  return found;
}
describe("config scope migration ownership", () => {
  it("moves only the formal config write and preserves every other site, store path and receipt", () => {
    const actual = scanPersistentStores({ rootDir: ROOT });
    const previous = scanPersistentStores({ rootDir: ROOT, stores: oldStores, exemptions: oldExemptions });
    expect(actual.inventory).toEqual(inventory);
    expect(actual.inventory.stores).toHaveLength(65);
    expect(actual.inventory.discoveredSites).toHaveLength(905);
    expect(actual.inventory.exemptions).toHaveLength(32);
    const differences = previous.inventory.discoveredSites.map((before, i) => ({ before, after: actual.inventory.discoveredSites[i] })).filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
    expect(differences).toHaveLength(2);
    const owned = differences.find(({ after }) => after.storeId === OWNER && after.sourceFile === MODULE)!;
    expect(owned.before).toMatchObject({ exemptionId: EXEMPTION, storeId: null, kind: "secret-write", excerpt: "writeSecretFileSync(ac.path, YAML.dump(ac.config, { lineWidth: -1 }))" });
    expect({ ...owned.before, storeId: OWNER, exemptionId: null, reason }).toEqual(owned.after);
    const backup = differences.find(({ after }) => after.exemptionId === EXEMPTION)!;
    expect(backup.before).toMatchObject({ sourceFile: MODULE, kind: "secret-write", excerpt: "writeSecretFileSync(backupPath, ac.content)" });
    expect({ ...backup.before, reason: backup.after.reason }).toEqual(backup.after);
    expect(actual.inventory.stores.filter((s) => s.id !== OWNER)).toEqual(previous.inventory.stores.filter((s) => s.id !== OWNER));
    const oldOwner = previous.inventory.stores.find((s) => s.id === OWNER)!;
    const newOwner = actual.inventory.stores.find((s) => s.id === OWNER)!;
    expect({ ...oldOwner, protocolModules: newOwner.protocolModules }).toEqual(newOwner);
    expect(newOwner.protocolModules).toEqual([...oldOwner.protocolModules, "core/engine.ts", "shared/config-schema.ts", MODULE]);
    expect(actual.startupReceipt).toEqual(previous.startupReceipt);
    expect(actual.startupReceipt).toEqual(JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8")));
    const remaining = actual.inventory.exemptions.filter((e) => e.expiresOn === "2026-11-17");
    const ids = new Set(remaining.map((e) => e.id));
    expect(remaining).toHaveLength(6);
    expect(actual.inventory.discoveredSites.filter((s) => ids.has(s.exemptionId))).toHaveLength(88);
    expect(actual.inventory.discoveredSites.filter((s) => s.exemptionId === EXEMPTION)).toHaveLength(1);
  });

  it("rejects a config write without its owner", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: oldStores })).toThrow(/unregistered persistence site/);
  });

  it("rejects a config write with overlapping ownership", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: oldExemptions })).toThrow(/ambiguous persistence site/);
  });

  it("locks the agent root and recognizes migration callers", () => {
    const engine = fs.readFileSync(path.join(ROOT, "core/engine.ts"), "utf8");
    expect(engine.match(/migrateConfigScope\s*\(/g)).toHaveLength(1);
    expect(engine).toContain('this.agentsDir = path.join(hanakoHome, "agents")');
    expect(engine).toContain('agentsDir: this.agentsDir');
    expect(source).toContain('path.join(agentsDir, entry.name, "config.yaml")');
    expect(usesMigration("other.ts", 'import { migrateConfigScope as alias } from "./migrate-config-scope.ts"; alias({});')).toBe(true);
    expect(usesMigration("other.ts", 'import * as scope from "./migrate-config-scope.ts"; scope.migrateConfigScope({});')).toBe(true);
    expect(usesMigration("other.ts", 'const scope = require("./migrate-config-scope.ts");')).toBe(true);
    expect(usesMigration("other.ts", 'import { CONFIG_SCOPE_BACKUP_SUFFIX } from "./migrate-config-scope.ts";')).toBe(false);
  });

  // Re-enumerate the same roots in each partition; every path maps to exactly one test.
  it.each(Array.from({ length: CALLER_PARTITIONS }, (_, i) => i))("locks the unique production caller in partition %i", (partition) => {
    const files: string[] = [];
    function visit(dir: string) {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) { if (!["node_modules", "tests", "__tests__", "dist", "native"].includes(entry.name)) visit(rel); }
        else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) files.push(rel);
      }
    }
    for (const dir of ["server", "core", "hub", "lib", "shared", "plugins", "desktop", "cli"]) visit(dir);
    const callers = files.filter((f) => f !== MODULE && callerPartition(f) === partition && usesMigration(f, fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(callers).toEqual(callerPartition("core/engine.ts") === partition ? ["core/engine.ts"] : []);
  });

  it.each([
    [MODULE, 'entry.name, "config.yaml"', 'entry.name, "other.yaml"'],
    [MODULE, 'writeSecretFileSync(ac.path, YAML.dump', 'writeSecretFileSync(backupPath, YAML.dump'],
    [MODULE, '".pre-scope-migration"', '".other-backup"'],
    ["core/engine.ts", 'path.join(hanakoHome, "agents")', 'path.join(hanakoHome, "others")'],
    ["core/engine.ts", '      migrateConfigScope({', '      const alias = migrateConfigScope;\n      alias({'],
    ["shared/config-schema.ts", "scope: 'global'", "scope: 'agent'"],
  ])("rejects protocol drift in %s", async (module, before, after) => {
    const text = fs.readFileSync(path.join(ROOT, module), "utf8");
    expect(text).toContain(before);
    const sourceOverrides = new Map([[module, text.replace(before, after)]]);
    const mutation = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides, review: { classification: "compatible", compatibilityReason: "Test-only protocol mutation." } });
    expect(mutation.schemas.find((s) => s.storeId === OWNER)).not.toEqual(committed.schemas.find((s) => s.storeId === OWNER));
    expect(mutation.schemas.filter((s) => s.storeId !== OWNER)).toEqual(committed.schemas.filter((s) => s.storeId !== OWNER));
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });
  it("accepts comments and line movement", async () => {
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, committedFingerprint: committed, sourceOverrides: overrides(`// comment\n\n${source}`) })).resolves.toEqual(committed);
  });
  it.each(["missing formal", "ordinary formal", "missing backup", "unknown"])("rejects %s write", (kind) => {
    const formal = 'writeSecretFileSync(ac.path, YAML.dump(ac.config, { lineWidth: -1 }))';
    const backup = 'writeSecretFileSync(backupPath, ac.content)';
    const mutations = {
      "missing formal": source.replace(formal, 'void ac.path'),
      "ordinary formal": source.replace(formal, 'fs.writeFileSync(ac.path, YAML.dump(ac.config))'),
      "missing backup": source.replace(backup, 'void backupPath'),
      "unknown": source.replace(formal, `${formal};\n      fs.writeFileSync("unknown", "x")`),
    };
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(mutations[kind]) })).toThrow();
  });
  it("detects a duplicate formal write", () => {
    const formal = 'writeSecretFileSync(ac.path, YAML.dump(ac.config, { lineWidth: -1 }))';
    const duplicate = scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(formal, `${formal};\n      ${formal}`)) }).inventory;
    expect(duplicate.discoveredSites).not.toEqual(inventory.discoveredSites);
    expect(duplicate.discoveredSites.filter((s) => s.sourceFile === MODULE && s.storeId === OWNER)).toHaveLength(2);
  });
});

describe("config scope migration failure receipts", () => {
  it.each(["backup", "formal"])("keeps the receipt pending if the %s publication fails", (failure) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scope-owner-"));
    try {
      const agentsDir = path.join(tmp, "agents");
      const config = path.join(agentsDir, "one", "config.yaml");
      const backup = `${config}.pre-scope-migration`;
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, "locale: zh-CN\nname: Alice\n");
      let saved: Record<string, unknown> = {};
      const prefs = { getPreferences: () => ({ ...saved }), savePreferences: (p) => { saved = { ...p }; } };
      const original = fs.renameSync;
      const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === (failure === "backup" ? backup : config)) throw new Error("injected publication failure");
        return original(from, to);
      });
      try { expect(() => migrateConfigScope({ agentsDir, prefs, primaryAgentId: "one" })).toThrow("injected publication failure"); } finally { spy.mockRestore(); }
      expect(saved._configScopeMigrated).toBeUndefined();
      expect(fs.readFileSync(config, "utf8")).toContain("locale: zh-CN");
      if (failure === "formal") expect(fs.readFileSync(backup, "utf8")).toContain("locale: zh-CN");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  it("preserves an existing backup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scope-owner-"));
    try {
      const agentsDir = path.join(tmp, "agents");
      const config = path.join(agentsDir, "one", "config.yaml");
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, "locale: zh-CN\nname: Alice\n");
      fs.writeFileSync(`${config}.pre-scope-migration`, "previous backup\n");
      let saved: Record<string, unknown> = {};
      const prefs = { getPreferences: () => ({ ...saved }), savePreferences: (p) => { saved = { ...p }; } };
      migrateConfigScope({ agentsDir, prefs, primaryAgentId: "one" });
      expect(fs.readFileSync(`${config}.pre-scope-migration`, "utf8")).toBe("previous backup\n");
      expect(saved._configScopeMigrated).toBe(true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
