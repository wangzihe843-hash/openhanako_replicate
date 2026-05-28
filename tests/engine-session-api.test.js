import { describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../core/engine.js";
import { autoProjectIdForCwd, UNCATEGORIZED_PROJECT_ID } from "../shared/session-projects.js";

describe("HanaEngine session API", () => {
  it("exposes session model switch state without leaking coordinator internals", () => {
    const engine = Object.create(HanaEngine.prototype);
    engine._sessionCoord = {
      isSessionSwitching: vi.fn(() => true),
    };

    expect(engine.isSessionSwitching("/tmp/session.jsonl")).toBe(true);
    expect(engine._sessionCoord.isSessionSwitching).toHaveBeenCalledWith("/tmp/session.jsonl");
  });

  it("deletes a project by moving explicit and cwd-derived sessions to uncategorized", async () => {
    const engine = Object.create(HanaEngine.prototype);
    const cwdProjectId = autoProjectIdForCwd("/tmp/project-hana");
    engine._sessionProjects = {
      deleteProject: vi.fn(() => ({ folders: [], projects: [] })),
    };
    engine._sessionCoord = {
      listSessions: vi.fn(async () => [
        { path: "/tmp/agents/hana/sessions/explicit.jsonl", cwd: "/elsewhere", projectId: cwdProjectId },
        { path: "/tmp/agents/hana/sessions/implicit.jsonl", cwd: "/tmp/project-hana", projectId: null },
        { path: "/tmp/agents/hana/sessions/other.jsonl", cwd: "/tmp/other", projectId: null },
      ]),
      writeSessionMeta: vi.fn(async () => undefined),
    };

    const result = await engine.deleteSessionProject(cwdProjectId);

    expect(engine._sessionProjects.deleteProject).toHaveBeenCalledWith(cwdProjectId);
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledTimes(2);
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledWith(
      "/tmp/agents/hana/sessions/explicit.jsonl",
      { projectId: UNCATEGORIZED_PROJECT_ID },
    );
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledWith(
      "/tmp/agents/hana/sessions/implicit.jsonl",
      { projectId: UNCATEGORIZED_PROJECT_ID },
    );
    expect(result).toEqual({
      catalog: { folders: [], projects: [] },
      assignment: {
        projectId: UNCATEGORIZED_PROJECT_ID,
        sessionPaths: [
          "/tmp/agents/hana/sessions/explicit.jsonl",
          "/tmp/agents/hana/sessions/implicit.jsonl",
        ],
      },
    });
  });
});
