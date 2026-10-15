import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createDataEpochCheckpointProvider, expandStorePathPattern } from "../core/data-epoch-checkpoint-provider.ts";
import { migrateLegacyWeekToLongterm } from "../lib/memory/compile.ts";
import { clearCompiledMemoryArtifacts, writeCompiledResetMarker } from "../lib/memory/compiled-memory-state.ts";
import { recoverPendingDreamApply } from "../lib/memory/dream/revision-store.ts";
import { assertCommittedPersistenceSchemaFingerprint } from "../scripts/generate-persistence-schema-fingerprint.mjs";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEMORY = "agents/agent-a/memory";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reset-inventory-"));
  tempDirs.push(home);
  const memoryDir = path.join(home, MEMORY);
  fs.mkdirSync(memoryDir, { recursive: true });
  return { home, memoryDir };
}

function write(memoryDir: string, relativePath: string, body: string) {
  const filePath = path.join(memoryDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? filesUnder(path.join(dir, entry.name)).map((name) => `${entry.name}/${name}`)
      : [entry.name]
  )).sort();
}

function owners(home: string, relativePath: string) {
  const matches = (pattern: string, tree: boolean) => expandStorePathPattern(home, pattern)
    .some((match) => match.relPath === relativePath || (tree && relativePath.startsWith(`${match.relPath}/`)));
  return PERSISTENT_STORES.filter((store) => (
    store.pathPatterns.some((pattern) => matches(pattern, store.pathKind === "tree"))
    && !store.pathExclusions.some((pattern) => matches(pattern, true))
  )).map((store) => store.id);
}

async function assertCaptured(home: string, relativePaths: string[]) {
  const before = new Map(relativePaths.map((name) => [name, fs.readFileSync(path.join(home, name))]));
  for (const name of relativePaths) expect(owners(home, name)).toEqual(["agent-memory"]);
  const provider = createDataEpochCheckpointProvider();
  const receipt = await provider.create({
    homeDir: home, fromEpoch: 1, toEpoch: 2,
    transitionId: "reset-registration-test", affectedStoreIds: ["agent-memory"],
  });
  const metadata = JSON.parse(fs.readFileSync(path.join(receipt.dir, "metadata.json"), "utf-8"));
  for (const [name, bytes] of before) {
    expect(metadata.items.filter((item: { relPath: string }) => item.relPath === name)).toHaveLength(1);
    expect(fs.readFileSync(path.join(receipt.dir, "stores", "agent-memory", name))).toEqual(bytes);
    expect(fs.readFileSync(path.join(home, name))).toEqual(bytes);
  }
  await expect(provider.verify(receipt)).resolves.toBeUndefined();
}

describe("reset persistence registration", () => {
  it.each(["compiled", "full"] as const)("captures the real %s reset archive and identity without claiming arbitrary archive files", async (kind) => {
    const { home, memoryDir } = fixture();
    const retired = {
      "daily/2026-10-14.md": "# Authored day\r\nKeep these exact bytes.\r\n",
      "daily/2026-10-14.md.fingerprint": "original-fingerprint\n",
      "editable-facts.md": "legacy source\n",
      "dream/pending-apply.json": '{"schemaVersion":1,"revisionId":"before-reset"}\n',
    };
    for (const [name, body] of Object.entries(retired)) write(memoryDir, name, body);
    const retained = {
      "week.md.migrated.bak": "previous backup\n",
      "dream/revisions/before-reset.json": '{"schemaVersion":1,"revisionId":"before-reset","before":{"facts":"old","today":"","weekDays":[],"longterm":""}}\n',
      "daily-state.json": '{"schemaVersion":4,"logicalDate":"2026-10-14","resetAt":null,"completedSteps":{}}\n',
      "reset-archive/retired-previous/daily/2026-10-13.md": "previous archive\n",
    };
    for (const [name, body] of Object.entries(retained)) write(memoryDir, name, body);
    // The still-active legacy upgrade source is registered before it is moved.
    expect(owners(home, `${MEMORY}/editable-facts.md`)).toEqual(["agent-memory"]);
    writeCompiledResetMarker(memoryDir, "2026-10-15T00:00:00.000Z", { kind });
    clearCompiledMemoryArtifacts(memoryDir);

    const archiveRoot = path.join(memoryDir, "reset-archive");
    const newArchives = fs.readdirSync(archiveRoot).filter((name) => name !== "retired-previous");
    expect(newArchives).toHaveLength(1);
    expect(newArchives[0]).toMatch(/^retired-.+$/);
    const archive = `reset-archive/${newArchives[0]}`;
    expect(filesUnder(path.join(memoryDir, archive))).toEqual(Object.keys(retired).sort());
    for (const [name, body] of Object.entries(retired)) {
      expect(fs.existsSync(path.join(memoryDir, name))).toBe(false);
      expect(fs.readFileSync(path.join(memoryDir, archive, name))).toEqual(Buffer.from(body));
    }
    for (const [name, body] of Object.entries(retained)) {
      expect(fs.readFileSync(path.join(memoryDir, name))).toEqual(Buffer.from(body));
    }
    // A second reset must retain the first archive, even for the same source name.
    write(memoryDir, "daily/2026-10-14.md", "second generation\n");
    writeCompiledResetMarker(memoryDir, "2026-10-15T00:00:00.000Z", { kind });
    clearCompiledMemoryArtifacts(memoryDir);
    const second = fs.readdirSync(archiveRoot).filter((name) => name !== "retired-previous" && name !== newArchives[0]);
    expect(second).toHaveLength(1);
    expect(fs.readFileSync(path.join(memoryDir, archive, "daily/2026-10-14.md"))).toEqual(Buffer.from(retired["daily/2026-10-14.md"]));
    await assertCaptured(home, [
      `${MEMORY}/reset.json`,
      ...Object.keys(retained).map((name) => `${MEMORY}/${name}`),
      ...Object.keys(retired).map((name) => `${MEMORY}/${archive}/${name}`),
      `${MEMORY}/reset-archive/${second[0]}/daily/2026-10-14.md`,
    ]);
    write(memoryDir, `${archive}/unrelated.json`, "{}");
    expect(owners(home, `${MEMORY}/${archive}/unrelated.json`)).toEqual([]);
  });

  it("captures the real week migration backup collision without overwriting the existing backup", async () => {
    const { home, memoryDir } = fixture();
    write(memoryDir, "week.md", "");
    write(memoryDir, "week.md.migrated.bak", "keep original backup\n");
    await expect(migrateLegacyWeekToLongterm(memoryDir, path.join(memoryDir, "longterm.md"), null))
      .resolves.toEqual({ migrated: true });
    expect(fs.existsSync(path.join(memoryDir, "week.md"))).toBe(false);
    const archives = fs.readdirSync(path.join(memoryDir, "reset-archive"));
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(memoryDir, "week.md.migrated.bak"), "utf-8")).toBe("keep original backup\n");
    const archivedWeek = `${MEMORY}/reset-archive/${archives[0]}/week.md`;
    expect(fs.readFileSync(path.join(home, archivedWeek))).toEqual(Buffer.alloc(0));
    await assertCaptured(home, [`${MEMORY}/week.md.migrated.bak`, archivedWeek]);
  });

  it("captures a legacy Dream journal retired by the real recovery reader after reset", async () => {
    const { home, memoryDir } = fixture();
    writeCompiledResetMarker(memoryDir, "2026-10-15T00:00:00.000Z");
    const journal = '{"schemaVersion":1,"revisionId":"historical","operation":"dream"}\n';
    write(memoryDir, "dream/pending-apply.json", journal);
    expect(recoverPendingDreamApply(memoryDir)).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, "dream/pending-apply.json"))).toBe(false);
    const archives = fs.readdirSync(path.join(memoryDir, "reset-archive"));
    expect(archives).toHaveLength(1);
    const retiredJournal = `${MEMORY}/reset-archive/${archives[0]}/dream/pending-apply.json`;
    expect(fs.readFileSync(path.join(home, retiredJournal), "utf-8")).toBe(journal);
    await assertCaptured(home, [`${MEMORY}/reset.json`, retiredJournal]);
  });

  it.each([
    "lib/memory/compiled-memory-state.ts",
    "lib/memory/compile.ts",
    "lib/memory/memory-ticker.ts",
    "lib/memory/dream/revision-store.ts",
    "lib/memory/dream/runner.ts",
    "core/agent.ts",
    "lib/channels/channel-store.ts",
    "lib/channels/channel-ticker.ts",
    "hub/channel-router.ts",
    "server/routes/config.ts",
  ])("keeps the reset protocol in %s guarded by the agent-memory schema", async (module) => {
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-schema-fingerprint.json"), "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "build/persistence-store-inventory.json"), "utf-8"));
    const memory = inventory.stores.find((store: { id: string }) => store.id === "agent-memory");
    expect([memory.schemaSource.module, ...memory.protocolModules]).toContain(module);
    const source = fs.readFileSync(path.join(ROOT, module), "utf-8");
    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT, committedFingerprint: committed, inventory,
      sourceOverrides: new Map([[module, `${source}\nexport const resetProtocolDriftProbe = 1;\n`]]),
    })).rejects.toThrow(/persistence schema fingerprint mismatch/);
  });
});
