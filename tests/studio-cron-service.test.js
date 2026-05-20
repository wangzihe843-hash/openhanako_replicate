import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { StudioCronService } from "../core/studio-cron-service.js";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-studio-cron-"));
}

function writeLegacyJobs(root, agentId, jobs) {
  const deskDir = path.join(root, "agents", agentId, "desk");
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(
    path.join(deskDir, "cron-jobs.json"),
    JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
    "utf-8",
  );
}

describe("StudioCronService", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports legacy per-agent jobs into the studio store with explicit actor and legacyRef", () => {
    const root = makeRoot();
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    writeLegacyJobs(root, "agent-a", [
      {
        id: "job_1",
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "daily a",
        label: "Daily A",
        model: "",
        enabled: true,
        consecutiveErrors: 0,
        createdAt: "2026-05-01T00:00:00.000Z",
        lastRunAt: null,
        nextRunAt: "2026-05-21T01:00:00.000Z",
      },
    ]);
    writeLegacyJobs(root, "agent-b", [
      {
        id: "job_1",
        type: "every",
        schedule: 3_600_000,
        prompt: "hourly b",
        label: "Hourly B",
        model: { id: "gpt-test", provider: "openai" },
        enabled: false,
        consecutiveErrors: 2,
        createdAt: "2026-05-02T00:00:00.000Z",
        lastRunAt: "2026-05-03T00:00:00.000Z",
        nextRunAt: "2026-05-21T02:00:00.000Z",
      },
    ]);

    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir,
      getStudioId: () => "studio-main",
    });

    const jobs = service.listJobs().sort((a, b) => a.actorAgentId.localeCompare(b.actorAgentId));

    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
    expect(jobs.every((job) => job.id.startsWith("studio_job_"))).toBe(true);
    expect(jobs[0]).toEqual(expect.objectContaining({
      actorAgentId: "agent-a",
      legacyRef: { agentId: "agent-a", jobId: "job_1" },
      executionContext: {
        kind: "legacy_agent_home",
        cwd: null,
        workspaceFolders: [],
        sourceSessionPath: null,
        createdByAgentId: "agent-a",
      },
    }));
    expect(jobs[1]).toEqual(expect.objectContaining({
      actorAgentId: "agent-b",
      legacyRef: { agentId: "agent-b", jobId: "job_1" },
      enabled: false,
      consecutiveErrors: 2,
      lastRunAt: "2026-05-03T00:00:00.000Z",
    }));
  });

  it("does not duplicate imported legacy jobs on later reads or service instances", () => {
    const root = makeRoot();
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    writeLegacyJobs(root, "agent-a", [
      {
        id: "job_1",
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "daily a",
        label: "Daily A",
        enabled: true,
        nextRunAt: "2026-05-21T01:00:00.000Z",
      },
    ]);

    const opts = { hanakoHome: root, agentsDir, getStudioId: () => "studio-main" };
    const first = new StudioCronService(opts);
    expect(first.listJobs()).toHaveLength(1);
    expect(first.listJobs()).toHaveLength(1);

    const second = new StudioCronService(opts);
    expect(second.listJobs()).toHaveLength(1);
  });

  it("requires new jobs to carry actorAgentId and executionContext", () => {
    const root = makeRoot();
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });

    expect(() => service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "missing actor",
      executionContext: { kind: "api_request", cwd: null, workspaceFolders: [] },
    })).toThrow("cron job requires actorAgentId");

    expect(() => service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "missing context",
      actorAgentId: "agent-a",
    })).toThrow("cron job requires executionContext");
  });
});
