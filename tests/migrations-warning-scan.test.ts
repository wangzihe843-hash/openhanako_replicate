import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMigrationStatus, runMigrations } from "../core/migrations.ts";

interface MigrationPreferences {
  _dataVersion: number;
  _migrationState: {
    completedIds: number[];
    lastFailedIds: number[];
  };
}

const migrationIds = [30, 38, 39] as const;
const scanRoots = ["studios", "agents"] as const;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-migration-warning-scan-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function makeContext(migrationId: number, pendingIds = [migrationId]) {
  const prefsPath = path.join(home, "preferences.json");
  const latestId = getMigrationStatus({}).registryLatestId;
  const prefs = {
    getPreferences(): MigrationPreferences {
      return JSON.parse(fs.readFileSync(prefsPath, "utf8")) as MigrationPreferences;
    },
    savePreferences(value: MigrationPreferences) {
      fs.writeFileSync(prefsPath, JSON.stringify(value));
    },
  };
  prefs.savePreferences({
    _dataVersion: migrationId - 1,
    _migrationState: {
      completedIds: Array.from({ length: latestId - migrationId }, (_, index) => migrationId + index + 1)
        .filter((id) => !pendingIds.includes(id)),
      lastFailedIds: [],
    },
  });
  return {
    hanakoHome: home,
    agentsDir: path.join(home, "agents"),
    prefs,
    log: vi.fn<(line: string) => void>(),
  };
}

function writeJob(root: typeof scanRoots[number]) {
  const jobsPath = path.join(home, root, "hana", "desk", "cron-jobs.json");
  fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
  fs.writeFileSync(jobsPath, JSON.stringify({
    jobs: [{
      id: "legacy-job",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "summarize",
      enabled: true,
      actorAgentId: "hana",
      executionContext: null,
    }],
  }));
  return jobsPath;
}

function failScan(directory: string, code: string) {
  const failure = Object.assign(new Error(`${code}: cannot scan ${directory}`), { code, path: directory });
  const readDirectory = fs.readdirSync;
  return vi.spyOn(fs, "readdirSync").mockImplementation(new Proxy(readDirectory, {
    apply(target, receiver, args) {
      if (String(args[0]) === directory) throw failure;
      return Reflect.apply(target, receiver, args);
    },
  }));
}

describe.each(migrationIds)("migration #%i optional directory scans", (migrationId) => {
  it.each(scanRoots.flatMap((root) => ["EACCES", "EPERM", "EIO", "ENOENT"].map((code) => ({ root, code }))))(
    "keeps an existing $root directory failure ($code) pending and retries from the persisted receipt",
    ({ root, code }) => {
      const ctx = makeContext(migrationId);
      const studiosJob = writeJob("studios");
      const agentsJob = writeJob("agents");
      const originals = [studiosJob, agentsJob].map((file) => fs.readFileSync(file, "utf8"));
      const scan = failScan(path.join(home, root), code);

      expect(runMigrations(ctx)).toMatchObject({ pendingIds: [migrationId], lastFailedIds: [migrationId] });
      expect(scan).toHaveBeenCalled();
      expect(ctx.prefs.getPreferences()).toMatchObject({
        _dataVersion: migrationId - 1,
        _migrationState: { lastFailedIds: [migrationId] },
      });
      expect(ctx.prefs.getPreferences()._migrationState.completedIds).not.toContain(migrationId);
      expect(ctx.log).not.toHaveBeenCalledWith(`[migrations] #${migrationId} 完成`);
      expect([studiosJob, agentsJob].map((file) => fs.readFileSync(file, "utf8"))).toEqual(originals);

      scan.mockRestore();
      const retryLog = vi.fn<(line: string) => void>();
      expect(runMigrations({ ...ctx, log: retryLog })).toMatchObject({ pendingIds: [], lastFailedIds: [] });
      expect(ctx.prefs.getPreferences()._dataVersion).toBe(getMigrationStatus({}).registryLatestId);
      expect(retryLog).toHaveBeenCalledWith(`[migrations] #${migrationId} 完成`);
      for (const file of [studiosJob, agentsJob]) {
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
          jobs: [{ executor: { kind: "agent_session", agentId: "hana" } }],
        });
      }
      const completed = [studiosJob, agentsJob].map((file) => fs.readFileSync(file, "utf8"));
      retryLog.mockClear();
      runMigrations({ ...ctx, log: retryLog });
      expect(retryLog).not.toHaveBeenCalled();
      expect([studiosJob, agentsJob].map((file) => fs.readFileSync(file, "utf8"))).toEqual(completed);
    },
  );

  it.each(["studios", "agents", "both"] as const)("allows absent %s roots and still migrates any present root", (missing) => {
    const ctx = makeContext(migrationId);
    const presentJobs = scanRoots.filter((root) => missing !== "both" && root !== missing).map(writeJob);

    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(ctx.prefs.getPreferences()._dataVersion).toBe(getMigrationStatus({}).registryLatestId);
    for (const root of scanRoots) {
      if (missing === "both" || root === missing) expect(fs.existsSync(path.join(home, root))).toBe(false);
    }
    for (const file of presentJobs) {
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
        jobs: [{ executor: { kind: "agent_session", agentId: "hana" } }],
      });
    }
  });

  it.each(scanRoots)("rejects a %s root that is a file and retries after it becomes a directory", (root) => {
    const ctx = makeContext(migrationId);
    const directory = path.join(home, root);
    fs.writeFileSync(directory, "not a directory");

    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [migrationId], lastFailedIds: [migrationId] });
    expect(fs.readFileSync(directory, "utf8")).toBe("not a directory");
    fs.unlinkSync(directory);
    fs.mkdirSync(directory);
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
  });

  it("retries a successful scan when its completion receipt could not be saved", () => {
    const ctx = makeContext(migrationId);
    const jobsPath = writeJob("agents");
    const save = vi.spyOn(ctx.prefs, "savePreferences").mockImplementation(() => {
      throw new Error("receipt disk unavailable");
    });

    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [migrationId], lastFailedIds: [] });
    const migrated = fs.readFileSync(jobsPath, "utf8");
    expect(JSON.parse(migrated)).toMatchObject({ jobs: [{ executor: { kind: "agent_session" } }] });
    save.mockRestore();
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(fs.readFileSync(jobsPath, "utf8")).toBe(migrated);
  });
});

it("keeps #39 blocked by a failed #38 scan until the next successful attempt", () => {
  const ctx = makeContext(38, [38, 39]);
  writeJob("agents");
  const scan = failScan(ctx.agentsDir, "EACCES");

  expect(runMigrations(ctx)).toMatchObject({ pendingIds: [38, 39], lastFailedIds: [38] });
  expect(ctx.log).toHaveBeenCalledWith("[migrations] #39 等待前置迁移 #38");
  scan.mockRestore();
  ctx.log.mockClear();
  expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
  expect(ctx.log).toHaveBeenCalledWith("[migrations] #38 完成");
  expect(ctx.log).toHaveBeenCalledWith("[migrations] #39 完成");
});
