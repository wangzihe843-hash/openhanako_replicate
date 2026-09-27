import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeExperienceVersion } from "../lib/tools/experience-versions.ts";

describe("agents route: experience toggle", () => {
  let tempRoot;
  let agentDir;
  let app;
  let engine;
  const agentId = "hana";

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-experience-route-"));
    agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(path.join(agentDir, "experience"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");
    fs.writeFileSync(
      path.join(agentDir, "experience", "workflow.md"),
      "<!-- experience-title: d29ya2Zsb3c -->\n1. Keep context boundaries explicit.\n",
      "utf-8",
    );

    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    engine = {
      agentsDir: tempRoot,
      getAgent: vi.fn(() => ({
        id: agentId,
        experienceEnabled: false,
        tools: [],
      })),
      providerRegistry: {
        getAllProvidersRaw: vi.fn(() => ({})),
        get: vi.fn(() => null),
      },
      updateConfig: vi.fn().mockResolvedValue(undefined),
      invalidateAgentListCache: vi.fn(),
      getLocale: vi.fn(() => ""),
      getTimezone: vi.fn(() => ""),
      getSandbox: vi.fn(() => false),
      getFileBackup: vi.fn(() => ({ enabled: false })),
      getUpdateChannel: vi.fn(() => "stable"),
      getAutoCheckUpdates: vi.fn(() => true),
      getThinkingLevel: vi.fn(() => "auto"),
      getEditor: vi.fn(() => null),
      getLearnSkills: vi.fn(() => ({})),
      getHeartbeatMaster: vi.fn(() => true),
      getChannelsEnabled: vi.fn(() => false),
      getBridgeReadOnly: vi.fn(() => false),
      getBridgeReceiptEnabled: vi.fn(() => true),
    };
    app = new Hono();
    app.route("/api", createAgentsRoute(engine));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("injects the disabled default for legacy configs without experience.enabled", async () => {
    const res = await app.request(`/api/agents/${agentId}/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.experience).toEqual({ enabled: false });
  });

  it("does not expose stored experience content while paused", async () => {
    const res = await app.request(`/api/agents/${agentId}/experience`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.content).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("Keep context boundaries explicit");
  });

  it("rejects experience writes while paused and preserves stored files", async () => {
    const res = await app.request(`/api/agents/${agentId}/experience`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# workflow\n1. overwrite\n" }),
    });
    expect(res.status).toBe(403);

    const stored = fs.readFileSync(path.join(agentDir, "experience", "workflow.md"), "utf-8");
    expect(stored).toContain("Keep context boundaries explicit");
    expect(stored).not.toContain("overwrite");
  });

  it("returns a failure when deleting an old experience category fails", async () => {
    engine.getAgent.mockReturnValue({ id: agentId, experienceEnabled: true, tools: [] });
    const unlink = fs.unlinkSync;
    const oldPath = path.join(agentDir, "experience", "workflow.md");
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (String(file) === oldPath) throw Object.assign(new Error("category deletion failed"), { code: "EACCES" });
      return unlink(file);
    });
    const res = await app.request('/api/agents/' + agentId + '/experience', {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "category deletion failed" });
    expect(engine.updateConfig).not.toHaveBeenCalled();
    expect(fs.readFileSync(oldPath, "utf8")).toContain("Keep context boundaries explicit");
  });

  it("gates version review by the experience toggle and requires explicit verification", async () => {
    const proposal = proposeExperienceVersion(agentDir, {
      category: "review", content: "Verify the output file before completion.",
      workspacePath: path.join(tempRoot, "work"), sourceReference: "task-123",
      sourceResult: "partial", verificationMethod: "Open the output and compare task criteria",
    });
    expect((await app.request(`/api/agents/${agentId}/experience-versions`)).status).toBe(403);
    engine.getAgent.mockReturnValue({ id: agentId, experienceEnabled: true, tools: [] });
    const listed = await app.request(`/api/agents/${agentId}/experience-versions`);
    expect((await listed.json()).versions[0].id).toBe(proposal.id);
    const endpoint = `/api/agents/${agentId}/experience-versions/${proposal.id}`;
    const change = (action: string, evidence?: string) => app.request(endpoint, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, evidence }),
    });
    expect((await change("activate")).status).toBe(400);
    expect((await change("verify", "")).status).toBe(400);
    expect((await change("verify", "Opened artifact and checked every criterion")).status).toBe(200);
    expect((await change("activate")).status).toBe(200);
    expect((await change("revoke")).status).toBe(200);
    expect((await (await app.request(`/api/agents/${agentId}/experience-versions`)).json()).versions[0].status).toBe("revoked");
  });

  it("rejects topic and experience reads and writes for a tombstoned agent with retained config", async () => {
    engine.getAgent.mockReturnValue({ id: agentId, experienceEnabled: true, tools: [] });
    fs.writeFileSync(path.join(agentDir, ".deleted-agent.json"), JSON.stringify({ version: 1, agentId }));
    const requests = [
      app.request(`/api/agents/${agentId}/topic-candidates`),
      app.request(`/api/agents/${agentId}/topic-candidates`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType: "reality_source", title: "Retained data", reason: "test",
          sourceUrl: "https://example.com", expiresAt: "2099-01-01T00:00:00Z" }),
      }),
      app.request(`/api/agents/${agentId}/experience-versions`),
      app.request(`/api/agents/${agentId}/experience`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# review\n1. Must not write\n" }),
      }),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map(response => response.status)).toEqual([404, 404, 404, 404]);
    expect(fs.existsSync(path.join(agentDir, "xingye", "heartbeat", "topic-candidates.json"))).toBe(false);
    expect(fs.readFileSync(path.join(agentDir, "experience", "workflow.md"), "utf8"))
      .toContain("Keep context boundaries explicit");
  });
});
