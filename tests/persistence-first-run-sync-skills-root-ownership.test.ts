import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureFirstRun } from "../core/first-run.ts";
import { assertCommittedPersistenceSchemaFingerprint, generatePersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "core/first-run.ts";
const SERVER = "server/index.ts";
const RESOLVER = "shared/hana-runtime-paths.cjs";
const OWNER = "skill-state";
const EXEMPTION = "cross-store-first-run-bootstrap";
const call = "fs.mkdirSync(dstDir, { recursive: true })";
const reason = "Ensures the user skill root before syncing bundled skills.";
const source = fs.readFileSync(path.join(ROOT, MODULE), "utf8");
const sources = new Map([MODULE, SERVER, RESOLVER].map(module => [module, fs.readFileSync(path.join(ROOT, module), "utf8")]));
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-startup-receipt.json"), "utf8"));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf8"));
const noOwner = PERSISTENT_STORES.map(store => store.id !== OWNER ? store : {
  ...store, siteRules: store.siteRules.filter(rule => rule.reason !== reason),
});
const escapedCall = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const priorExemptions = PERSISTENCE_EXEMPTIONS.map(exemption => exemption.id !== EXEMPTION ? exemption : {
  ...exemption, linePattern: `(?:${exemption.linePattern})|(?:^${escapedCall}$)`,
});
const overrides = (text: string) => new Map([[MODULE, text]]);
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(withSource: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-sync-skills-root-"));
  tempDirs.push(root);
  const home = path.join(root, "自定义 home");
  const product = path.join(root, "product", "lib");
  const src = path.join(product, "..", "skills2set");
  const dst = path.join(home, "skills");
  // Avoid default-agent seeding so the test exercises only skill synchronization.
  fs.mkdirSync(path.join(home, "agents", "existing"), { recursive: true });
  fs.writeFileSync(path.join(home, "agents", "existing", "config.yaml"), "agent: {}\n");
  fs.mkdirSync(product, { recursive: true });
  if (withSource) fs.mkdirSync(src);
  return { home, product, src, dst };
}

describe("first-run syncSkills root ownership", () => {
  describe("metadata comparison", () => {
    let actual: ReturnType<typeof scanPersistentStores>;
    let previous: ReturnType<typeof scanPersistentStores>;

    // Keep real full scans and full schema hashing in separate bounded phases.
    beforeAll(() => {
      actual = scanPersistentStores({ rootDir: ROOT });
      previous = scanPersistentStores({ rootDir: ROOT, stores: noOwner, exemptions: priorExemptions });
    }, 10_000);

    it("moves exactly dstDir and preserves descriptors, startup receipt, expiry and skillsDst", () => {
      expect(actual.inventory).toEqual(inventory);
      expect(actual.startupReceipt).toEqual(receipt);
      expect(actual.inventory.stores).toHaveLength(65);
      expect(actual.inventory.discoveredSites).toHaveLength(905);
      expect(actual.inventory.exemptions).toHaveLength(32);
      expect(actual.inventory.discoveredSites.filter(site => site.storeId)).toHaveLength(721);
      expect(actual.inventory.discoveredSites.filter(site => site.exemptionId)).toHaveLength(184);
      const changed = previous.inventory.discoveredSites.map((before, index) => ({ before, after: actual.inventory.discoveredSites[index] }))
        .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
      expect(changed).toHaveLength(1);
      const { before, after } = changed[0];
      expect(before).toMatchObject({ sourceFile: MODULE, kind: "mkdir", excerpt: call, ordinal: 0, storeId: null, exemptionId: EXEMPTION });
      expect(after).toEqual({ ...before, reason, storeId: OWNER, exemptionId: null });
      expect(previous.inventory.stores).toEqual(actual.inventory.stores);
      expect(previous.startupReceipt).toEqual(receipt);
      expect(previous.inventory.exemptions.filter(e => e.id !== EXEMPTION)).toEqual(actual.inventory.exemptions.filter(e => e.id !== EXEMPTION));
      const oldExemption = previous.inventory.exemptions.find(e => e.id === EXEMPTION)!;
      const exemption = actual.inventory.exemptions.find(e => e.id === EXEMPTION)!;
      expect({ ...oldExemption, linePattern: exemption.linePattern }).toEqual(exemption);
      expect(exemption.expiresOn).toBe("2026-11-17");
      expect(actual.inventory.discoveredSites).toContainEqual(expect.objectContaining({
        sourceFile: MODULE, kind: "mkdir", excerpt: "fs.mkdirSync(skillsDst, { recursive: true })", storeId: null, exemptionId: EXEMPTION,
      }));
      const dated = actual.inventory.exemptions.filter(e => e.expiresOn === "2026-11-17");
      expect(dated).toHaveLength(6);
      expect(actual.inventory.discoveredSites.filter(site => dated.some(e => e.id === site.exemptionId))).toHaveLength(81);
      expect(actual.inventory.discoveredSites.filter(site => site.exemptionId === EXEMPTION)).toHaveLength(9);
    });

    it("changes only the syncSkills mapping and exemption in the full fingerprint", async () => {
      const priorFingerprint = await generatePersistenceSchemaFingerprint({ rootDir: ROOT, inventory: previous.inventory,
        review: { classification: "compatible", compatibilityReason: "Test-only reconstruction of the preceding single-site exemption." } });
      const { siteMappings, exemptions, payloadFingerprint, review, ...unchanged } = committed;
      const { siteMappings: oldMappings, exemptions: oldExemptions, payloadFingerprint: oldHash, review: _oldReview, ...oldUnchanged } = priorFingerprint;
      expect(unchanged).toEqual(oldUnchanged);
      expect(payloadFingerprint).not.toBe(oldHash);
      const changedMappings = oldMappings.map((oldMapping, index) => ({ before: oldMapping, after: siteMappings[index] }))
        .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
      expect(changedMappings).toHaveLength(1);
      expect(changedMappings[0].after).toEqual({ ...changedMappings[0].before, reason, storeId: OWNER, exemptionId: null });
      expect(exemptions.filter((e: { id: string }) => e.id !== EXEMPTION)).toEqual(oldExemptions.filter((e: { id: string }) => e.id !== EXEMPTION));
      expect(review.classification).toBe("compatible");
    });
  });

  it("proves the helper stays private and has exactly one direct caller with the user-root argument", () => {
    const parsed = ts.createSourceFile(MODULE, source, ts.ScriptTarget.Latest, true);
    const references: ts.Identifier[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === "syncSkills") references.push(node);
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(references).toHaveLength(2);
    const declaration = references[1].parent;
    expect(ts.isFunctionDeclaration(declaration)).toBe(true);
    if (!ts.isFunctionDeclaration(declaration)) throw new Error("syncSkills is no longer a private function declaration");
    expect(declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).toBeFalsy();
    expect(references[0].parent.getText(parsed)).toBe("syncSkills(skillsSrc, skillsDst)");
    expect(source).toContain('const skillsDst = path.join(hanakoHome, "skills");');
    expect(sources.get(SERVER)).toContain('const hanakoHome = resolveHanakoHome(process.env.HANA_HOME);');
    expect(sources.get(SERVER)?.match(/\bensureFirstRun\(/g)).toHaveLength(1);
  });

  it("rejects a missing owner", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, stores: noOwner })).toThrow(/unregistered persistence site/);
  });
  it("rejects duplicate ownership from the old exemption", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions: priorExemptions })).toThrow(/ambiguous persistence site/);
  });
  it("detects deletion of the exact mkdir", () => {
    expect(source.split(call)).toHaveLength(2);
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, "void 0")) })).toThrow(/dangling/);
  });
  it("detects duplication without accepting the committed inventory", () => {
    const duplicated = scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, `${call}; ${call}`)) });
    expect(duplicated.inventory).not.toEqual(inventory);
    expect(duplicated.inventory.discoveredSites.filter(site => site.sourceFile === MODULE && site.excerpt === call && site.storeId === OWNER)).toHaveLength(2);
  });
  it("rejects an unknown additional target", () => {
    expect(() => scanPersistentStores({ rootDir: ROOT, sourceOverrides: overrides(source.replace(call, `${call}; fs.mkdirSync("unknown", { recursive: true })`)) })).toThrow(/unregistered persistence site/);
  });

  it("retains the existing whole-file bindings that guard this call chain", async () => {
    const profile = PERSISTENT_STORES.find(store => store.id === "agent-profile")!;
    expect(profile.protocolModules).toEqual(expect.arrayContaining([MODULE, SERVER, RESOLVER]));
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT })).resolves.toEqual(committed);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides: overrides(`// ordinary comment\n${source}`) })).resolves.toEqual(committed);
  });
  // Existing profile/preferences whole-file bindings protect these source-level
  // changes even though this ownership-only patch adds no protocol modules.
  it.each([
    [MODULE, 'path.join(hanakoHome, "skills")', 'path.join(hanakoHome, "other")'],
    [MODULE, "syncSkills(skillsSrc, skillsDst)", "syncSkills(skillsSrc, skillsSrc)"],
    [MODULE, "function syncSkills(srcDir, dstDir)", "export function syncSkills(srcDir, dstDir)"],
    [MODULE, "syncSkills(skillsSrc, skillsDst);", "syncSkills(skillsSrc, skillsDst); const alias = syncSkills; alias(skillsSrc, skillsSrc);"],
    [SERVER, "resolveHanakoHome(process.env.HANA_HOME)", "resolveHanakoHome(undefined)"],
    [RESOLVER, 'const raw = input || path.join(homeDir, ".hanako");', 'const raw = path.join(homeDir, ".hanako");'],
  ])("rejects call-chain drift in %s: %s", async (module, before, after) => {
    const text = sources.get(module)!;
    expect(text.split(before)).toHaveLength(2);
    const sourceOverrides = new Map([[module, text.replace(before, after)]]);
    expect(scanPersistentStores({ rootDir: ROOT, sourceOverrides }).inventory).toEqual(inventory);
    await expect(assertCommittedPersistenceSchemaFingerprint({ rootDir: ROOT, inventory, sourceOverrides })).rejects.toThrow(/fingerprint mismatch/);
  });

  it.each([false, true])("uses only the requested home with bundled source present=%s", withSource => {
    const { home, product, dst } = setup(withSource);
    const mkdir = vi.spyOn(fs, "mkdirSync");
    ensureFirstRun(home, product);
    expect(fs.statSync(dst).isDirectory()).toBe(true);
    const rootCalls = () => mkdir.mock.calls.filter(([dir]) => String(dir) === dst);
    expect(rootCalls()).toHaveLength(withSource ? 2 : 1);
    for (const args of rootCalls()) expect(args).toEqual([dst, { recursive: true }]);
    fs.writeFileSync(path.join(dst, "custom"), "retained");
    ensureFirstRun(home, product);
    expect(rootCalls()).toHaveLength(withSource ? 4 : 2);
    expect(fs.readFileSync(path.join(dst, "custom"), "utf8")).toBe("retained");
    expect(fs.existsSync(path.join(product, "skills"))).toBe(false);
  });
  it("syncs a bundled skill beneath that root and preserves unrelated installed skills", () => {
    const { home, product, src, dst } = setup(true);
    fs.mkdirSync(path.join(src, "bundled", "assets"), { recursive: true });
    fs.writeFileSync(path.join(src, "bundled", "SKILL.md"), "bundled skill");
    fs.writeFileSync(path.join(src, "bundled", "assets", "asset.txt"), "asset");
    fs.mkdirSync(path.join(dst, "custom"), { recursive: true });
    fs.writeFileSync(path.join(dst, "custom", "SKILL.md"), "user skill");
    ensureFirstRun(home, product);
    expect(fs.readFileSync(path.join(dst, "bundled", "SKILL.md"), "utf8")).toBe("bundled skill");
    expect(fs.readFileSync(path.join(dst, "bundled", "assets", "asset.txt"), "utf8")).toBe("asset");
    expect(fs.readFileSync(path.join(dst, "custom", "SKILL.md"), "utf8")).toBe("user skill");
  });
  it("propagates a failure of the helper mkdir before copying any skill", () => {
    const { home, product, src, dst } = setup(true);
    fs.mkdirSync(path.join(src, "bundled"));
    fs.writeFileSync(path.join(src, "bundled", "SKILL.md"), "bundled skill");
    const mkdir = fs.mkdirSync.bind(fs);
    let rootCalls = 0;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
      if (String(args[0]) === dst && ++rootCalls === 2) throw new Error("simulated syncSkills mkdir failure");
      return mkdir(...args);
    }) as typeof fs.mkdirSync);
    const copy = vi.spyOn(fs, "copyFileSync");
    expect(() => ensureFirstRun(home, product)).toThrow("simulated syncSkills mkdir failure");
    expect(rootCalls).toBe(2);
    expect(copy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dst, "bundled"))).toBe(false);
  });
});
