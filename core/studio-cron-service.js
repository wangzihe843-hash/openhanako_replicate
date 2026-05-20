import fs from "fs";
import path from "path";
import { CronStore } from "../lib/desk/cron-store.js";
import { createModuleLogger } from "../lib/debug-log.js";

const log = createModuleLogger("studio-cron");

function assertValidPathSegment(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`${label} contains invalid path characters`);
  }
  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeWorkspaceFolders(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim());
}

function normalizeExecutionContext(input, actorAgentId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("cron job requires executionContext");
  }
  return {
    kind: normalizeOptionalString(input.kind) || "session_workspace",
    cwd: normalizeOptionalString(input.cwd),
    workspaceFolders: normalizeWorkspaceFolders(input.workspaceFolders),
    sourceSessionPath: normalizeOptionalString(input.sourceSessionPath),
    createdByAgentId: normalizeOptionalString(input.createdByAgentId) || actorAgentId,
  };
}

function legacyRefKey(ref) {
  if (!ref?.agentId || !ref?.jobId) return null;
  return `${ref.agentId}\u0000${ref.jobId}`;
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export class StudioCronService {
  /**
   * @param {object} opts
   * @param {string} opts.hanakoHome
   * @param {string} opts.agentsDir
   * @param {() => string} opts.getStudioId
   */
  constructor({ hanakoHome, agentsDir, getStudioId }) {
    if (!hanakoHome) throw new Error("StudioCronService requires hanakoHome");
    if (!agentsDir) throw new Error("StudioCronService requires agentsDir");
    if (typeof getStudioId !== "function") throw new Error("StudioCronService requires getStudioId");
    this._hanakoHome = hanakoHome;
    this._agentsDir = agentsDir;
    this._getStudioId = getStudioId;
    this._store = null;
    this._storeStudioId = null;
  }

  listJobs() {
    return this._getStore().listJobs();
  }

  getJob(id) {
    return this._getStore().getJob(id);
  }

  addJob(job) {
    const actorAgentId = normalizeOptionalString(job?.actorAgentId);
    if (!actorAgentId) throw new Error("cron job requires actorAgentId");
    const executionContext = normalizeExecutionContext(job.executionContext, actorAgentId);
    return this._getStore().addJob({
      ...job,
      actorAgentId,
      executionContext,
      legacyRef: job.legacyRef || null,
    });
  }

  removeJob(id) {
    return this._getStore().removeJob(id);
  }

  updateJob(id, partial) {
    return this._getStore().updateJob(id, partial);
  }

  toggleJob(id) {
    return this._getStore().toggleJob(id);
  }

  markRun(id, opts) {
    return this._getStore().markRun(id, opts);
  }

  logRun(id, run) {
    return this._getStore().logRun(id, run);
  }

  getRunHistory(id, limit) {
    return this._getStore().getRunHistory(id, limit);
  }

  _getStore() {
    const studioId = assertValidPathSegment(this._getStudioId(), "studioId");
    if (!this._store || this._storeStudioId !== studioId) {
      const deskDir = path.join(this._hanakoHome, "studios", studioId, "desk");
      this._store = new CronStore(
        path.join(deskDir, "cron-jobs.json"),
        path.join(deskDir, "cron-runs"),
        { idPrefix: "studio_job" },
      );
      this._storeStudioId = studioId;
    }
    this._importLegacyJobs(this._store);
    return this._store;
  }

  _importLegacyJobs(store) {
    const existingLegacyRefs = new Set(
      store.listJobs()
        .map((job) => legacyRefKey(job.legacyRef))
        .filter(Boolean),
    );
    let entries;
    try {
      entries = fs.readdirSync(this._agentsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentId = entry.name;
      const jobsPath = path.join(this._agentsDir, agentId, "desk", "cron-jobs.json");
      let data;
      try {
        data = readJsonIfPresent(jobsPath);
      } catch (err) {
        log.warn(`skipped invalid legacy cron store for ${agentId}: ${err.message}`);
        continue;
      }
      if (!data || !Array.isArray(data.jobs)) continue;
      for (const legacyJob of data.jobs) {
        const ref = { agentId, jobId: legacyJob?.id };
        const refKey = legacyRefKey(ref);
        if (!refKey || existingLegacyRefs.has(refKey)) continue;
        const imported = this._toStudioJob(agentId, legacyJob, ref);
        if (!imported) continue;
        store.addImportedJob(imported);
        existingLegacyRefs.add(refKey);
      }
    }
  }

  _toStudioJob(agentId, legacyJob, legacyRef) {
    if (!legacyJob || typeof legacyJob !== "object") return null;
    if (typeof legacyJob.prompt !== "string" || !legacyJob.prompt.trim()) return null;
    if (!["at", "every", "cron"].includes(legacyJob.type)) return null;
    if (legacyJob.schedule === undefined || legacyJob.schedule === null) return null;
    return {
      ...legacyJob,
      actorAgentId: agentId,
      executionContext: {
        kind: "legacy_agent_home",
        cwd: null,
        workspaceFolders: [],
        sourceSessionPath: null,
        createdByAgentId: agentId,
      },
      legacyRef,
    };
  }
}
