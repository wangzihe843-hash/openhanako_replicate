import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMigrationStatus, runMigrations } from "../core/migrations.ts";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cron-publication-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

function context(id: number) {
  const latest = getMigrationStatus({}).registryLatestId;
  let preferences = {
    _dataVersion: id - 1,
    _migrationState: { completedIds: Array.from({ length: latest - id }, (_, index) => id + index + 1), lastFailedIds: [] as number[] },
  };
  const ctx = {
    hanakoHome: home, agentsDir: path.join(home, "agents"),
    prefs: {
      getPreferences: () => structuredClone(preferences),
      savePreferences: value => { preferences = structuredClone(value); },
    },
    log: vi.fn<(line: string) => void>(),
  };
  // Only the requested slot is pending, including when it precedes #37.
  expect(getMigrationStatus(ctx.prefs.getPreferences()).pendingIds).toEqual([id]);
  return ctx;
}

function writeJobs(root: "agents" | "studios", value: unknown) {
  const file = path.join(home, root, "hana", "desk", "cron-jobs.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

function legacyDocument() {
  return { nextNum: 19, custom: { retain: true }, jobs: [{
    id: "job_18", type: "cron", schedule: "0 9 * * *", prompt: "summarize",
    enabled: true, model: { id: "gpt-4o", provider: "openai" },
    actorAgentId: "hana", unknown: { retain: [1, 2] },
  }] };
}

describe.each([30, 38, 39])("Cron migration #%i publication", id => {
  it("retains the existing explicit execution context and owner contract", () => {
    const ctx = context(id);
    const executionContext = {
      kind: "legacy_agent_home", cwd: null, workspaceFolders: [],
      sourceSessionPath: null, createdByAgentId: "hana",
    };
    const document = legacyDocument();
    const file = writeJobs("studios", { ...document, jobs: document.jobs.map(job => ({ ...job, schemaVersion: 1, executionContext })) });
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ jobs: [{
      schemaVersion: 4, type: "cron", prompt: "summarize", executionContext,
      trigger: { kind: "cron", expression: "0 9 * * *" },
      createdBy: { kind: "agent", agentId: "hana" },
      executor: { kind: "agent_session", agentId: "hana", prompt: "summarize", model: { id: "gpt-4o", provider: "openai" }, executionContext },
    }] });
  });

  it.each(["agents", "studios"] as const)("preserves legacy/unknown fields in %s and retains replay convergence", root => {
    const ctx = context(id);
    const file = writeJobs(root, legacyDocument());
    const write = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(ctx.log).toHaveBeenCalledWith(`[migrations] #${id} 完成`);
    expect(ctx.log.mock.calls.filter(([line]) => /#\d+ 完成/.test(line))).toEqual([[`[migrations] #${id} 完成`]]);
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(result).toMatchObject({ nextNum: 19, custom: { retain: true }, jobs: [{
      id: "job_18", type: "cron", schedule: "0 9 * * *", prompt: "summarize", enabled: true,
      model: { id: "gpt-4o", provider: "openai" }, unknown: { retain: [1, 2] },
      trigger: { kind: "cron", expression: "0 9 * * *" }, executor: { kind: "agent_session", agentId: "hana" },
    }] });
    expect(write.mock.calls.map(args => String(args[0]))).toEqual([file + ".tmp"]);
    expect(rename.mock.calls).toEqual([[file + ".tmp", file]]);
    expect(fs.existsSync(file + ".tmp")).toBe(false);
    const bytes = fs.readFileSync(file, "utf8");
    write.mockClear(); rename.mockClear();
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    // Existing #30/#38 behavior: a second forced replay materializes the
    // top-level null context introduced inside executor on the first pass.
    // Exact-baseline comparison documents this; attribution does not fix it.
    expect(runMigrations(context(id))).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    if (id === 39) {
      expect(write).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    } else {
      expect(write.mock.calls.map(args => String(args[0]))).toEqual([file + ".tmp"]);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ...result, jobs: result.jobs.map(job => ({ ...job, executionContext: null })) });
    }
    write.mockClear(); rename.mockClear();
    const converged = fs.readFileSync(file, "utf8");
    expect(runMigrations(context(id))).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(converged);
  });

  it.each(["write", "rename"])("keeps failed %s pending, preserves the primary, and retries", stage => {
    const ctx = context(id);
    const file = writeJobs("agents", legacyDocument());
    const original = fs.readFileSync(file, "utf8");
    const error = Object.assign(new Error("injected publication failure"), { code: "EIO" });
    const write = fs.writeFileSync;
    const rename = fs.renameSync;
    const failing = stage === "write"
      ? vi.spyOn(fs, "writeFileSync").mockImplementation(new Proxy(write, { apply(target, receiver, args) {
        if (String(args[0]) === file + ".tmp") throw error;
        return Reflect.apply(target, receiver, args);
      } }))
      : vi.spyOn(fs, "renameSync").mockImplementation(new Proxy(rename, { apply(target, receiver, args) {
        if (String(args[1]) === file) throw error;
        return Reflect.apply(target, receiver, args);
      } }));
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [id], lastFailedIds: [id] });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(ctx.prefs.getPreferences()._migrationState.completedIds).not.toContain(id);
    expect(ctx.log).not.toHaveBeenCalledWith(`[migrations] #${id} 完成`);
    // A failed rename leaves valid staging bytes; no migration rollback is claimed.
    expect(fs.existsSync(file + ".tmp")).toBe(stage === "rename");
    if (stage === "rename") expect(JSON.parse(fs.readFileSync(file + ".tmp", "utf8")).jobs[0].executor.kind).toBe("agent_session");
    failing.mockRestore();
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).jobs[0].executor.kind).toBe("agent_session");
    expect(fs.existsSync(file + ".tmp")).toBe(false);
  });

  it.each(["{broken", { jobs: null }, { jobs: [] }, { unrelated: true }])("retains malformed/empty data without publishing: %j", value => {
    const ctx = context(id);
    const file = writeJobs("agents", value);
    const bytes = fs.readFileSync(file, "utf8");
    const write = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");
    expect(runMigrations(ctx)).toMatchObject({ pendingIds: [], lastFailedIds: [] });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });
});
