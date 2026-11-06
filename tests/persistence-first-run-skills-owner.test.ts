import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import { PERSISTENCE_EXEMPTIONS, PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILE = "core/first-run.ts";
const SKILLS_ROOT_MKDIR = "fs.mkdirSync(skillsDst, { recursive: true })";

describe("first-run skill root ownership", () => {
  it("assigns only the skillsDst mkdir to skill-state and retains the sync helper exemption", () => {
    const { inventory } = scanPersistentStores({ rootDir: ROOT });
    const firstRunSites = inventory.discoveredSites.filter((site) => site.sourceFile === SOURCE_FILE);

    expect(firstRunSites.filter((site) => site.storeId === "skill-state")).toEqual([
      expect.objectContaining({
        kind: "mkdir",
        excerpt: SKILLS_ROOT_MKDIR,
        storeId: "skill-state",
        exemptionId: null,
      }),
    ]);
    expect(firstRunSites.find((site) => site.excerpt === "fs.mkdirSync(dstDir, { recursive: true })"))
      .toMatchObject({ kind: "mkdir", storeId: null, exemptionId: "cross-store-first-run-bootstrap" });
  });

  it("leaves the skillsDst mkdir unregistered if its owner rule is removed", () => {
    const stores = PERSISTENT_STORES.map((store) => store.id === "skill-state" ? {
      ...store,
      siteRules: store.siteRules.filter((rule) => rule.sourceFile !== SOURCE_FILE),
    } : store);

    expect(() => scanPersistentStores({ rootDir: ROOT, stores }))
      .toThrow(/unregistered persistence site: core\/first-run\.ts:\d+ mkdir fs\.mkdirSync\(skillsDst,/);
  });

  it.each([
    'fs.mkdirSync(skillsDst, { recursive: true, mode: 0o700 });',
    'fs.mkdirSync(path.join(skillsDst, "extra"), { recursive: true });',
    'fs.mkdirSync(skillsDst + "-extra", { recursive: true });',
    'fs.writeFileSync(skillsDst, "unexpected");',
    'fs.rmSync(skillsDst, { recursive: true });',
  ])("rejects an additional skill write: %s", (additionalWrite) => {
    const original = fs.readFileSync(path.join(ROOT, SOURCE_FILE), "utf-8");

    expect(() => scanPersistentStores({
      rootDir: ROOT,
      sourceOverrides: new Map([[SOURCE_FILE, `${original}\n${additionalWrite}\n`]]),
    })).toThrow(/unregistered persistence site: core\/first-run\.ts:/);
  });

  it("rejects a duplicate exemption for the owned skillsDst mkdir", () => {
    const exemptions = PERSISTENCE_EXEMPTIONS.map((exemption) => (
      exemption.id === "cross-store-first-run-bootstrap" ? {
        ...exemption,
        linePattern: `(?:${exemption.linePattern}|^fs\\.mkdirSync\\(skillsDst, \\{ recursive: true \\}\\)$)`,
      } : exemption
    ));

    expect(() => scanPersistentStores({ rootDir: ROOT, exemptions }))
      .toThrow(/ambiguous persistence site: core\/first-run\.ts:\d+ mkdir matches store:skill-state, exemption:cross-store-first-run-bootstrap/);
  });
});
