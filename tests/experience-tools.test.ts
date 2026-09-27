import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExperienceTools,
  listExperienceDocuments,
  recordEntry,
  rebuildIndex,
} from "../lib/tools/experience.ts";
import { listExperienceVersions, normalizeWorkspacePath, reviewExperienceVersion } from "../lib/tools/experience-versions.ts";
import { loadLocale } from "../lib/i18n.ts";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-experience-"));
}

type ProposalDetails = { proposalId: string; status: string; scope: { path: string } };

function proposalDetails(result: unknown): ProposalDetails {
  const details = (result as { details?: Partial<ProposalDetails> } | null)?.details;
  if (typeof details?.proposalId !== "string" || typeof details.status !== "string"
    || typeof details.scope?.path !== "string") {
    throw new Error("expected a proposed experience version");
  }
  return details as ProposalDetails;
}

describe("experience tools", () => {
  let tmpDir;

  loadLocale("en");

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      tmpDir = null;
    }
  });

  it("recordEntry rejects path-like categories", () => {
    tmpDir = mktemp();
    const experienceDir = path.join(tmpDir, "experience");
    const indexPath = path.join(tmpDir, "experience.md");

    expect(() => recordEntry(experienceDir, indexPath, "../identity", "bad")).toThrow("invalid experience category");
    expect(fs.existsSync(path.join(tmpDir, "identity.md"))).toBe(false);
  });

  it("keeps legacy category Markdown readable while new work lessons require verification and workspace match", async () => {
    tmpDir = mktemp();
    const workspace = path.join(tmpDir, "workspace-a");
    const tools = createExperienceTools(tmpDir, { isEnabled: () => true, getWorkspacePath: () => workspace });
    const recordTool = tools.find((tool) => tool.name === "record_experience");
    const recallTool = tools.find((tool) => tool.name === "recall_experience");

    recordEntry(path.join(tmpDir, "experience"), path.join(tmpDir, "experience.md"),
      "Design Notes", "Legacy manually authored note.");

    const recorded = proposalDetails(await recordTool.execute("call-1", {
      category: "Design Notes",
      content: "Remember to preserve owner session identity.",
      sourceReference: "task-123 result artifact", sourceResult: "success",
      verificationMethod: "Reopen the artifact and compare its owner ID",
    }));

    expect(recorded.status).toBe("proposed");
    expect(recorded.scope.path).toBe(normalizeWorkspacePath(workspace));

    const docs = listExperienceDocuments(path.join(tmpDir, "experience"));
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Design Notes");
    expect(docs[0].file).not.toBe("Design Notes.md");
    expect(docs[0].body).not.toContain("preserve owner session");

    rebuildIndex(path.join(tmpDir, "experience"), path.join(tmpDir, "experience.md"));
    const indexText = fs.readFileSync(path.join(tmpDir, "experience.md"), "utf-8");
    expect(indexText).toContain("# Design Notes");

    const proposedRecall = await recallTool.execute("call-2", { category: "Design Notes" });
    expect(proposedRecall.content[0].text).toContain("Legacy manually authored note.");
    expect(proposedRecall.content[0].text).not.toContain("preserve owner session");

    const id = recorded.proposalId;
    reviewExperienceVersion(tmpDir, id, "verify", "Checked artifact owner ID against session ID");
    expect((await recallTool.execute("call-3", { category: "Design Notes" })).content[0].text).not.toContain("preserve owner session");
    reviewExperienceVersion(tmpDir, id, "activate");
    expect((await recallTool.execute("call-4", { category: "Design Notes" })).content[0].text).toContain("preserve owner session");
    const otherWorkspace = createExperienceTools(tmpDir, { isEnabled: () => true,
      getWorkspacePath: () => path.join(tmpDir, "workspace-b") }).find(tool => tool.name === "recall_experience");
    expect((await otherWorkspace.execute("call-5", { category: "Design Notes" })).content[0].text).not.toContain("preserve owner session");
    reviewExperienceVersion(tmpDir, id, "revoke");
    expect((await recallTool.execute("call-6", { category: "Design Notes" })).content[0].text).not.toContain("preserve owner session");
  });

  it("uses each invocation's session workspace even when another session has focus", async () => {
    tmpDir = mktemp();
    const workspaceA = path.join(tmpDir, "workspace-a");
    const workspaceB = path.join(tmpDir, "workspace-b");
    const sessionA = path.join(tmpDir, "session-a.jsonl");
    const sessionB = path.join(tmpDir, "session-b.jsonl");
    const tools = createExperienceTools(tmpDir, {
      isEnabled: () => true,
      getWorkspacePath: () => workspaceA, // Legacy fallback simulates focused session A.
      getSessionCwd: (sessionPath) => sessionPath === sessionB ? workspaceB : null,
    });
    const recordTool = tools.find((tool) => tool.name === "record_experience");
    const recallTool = tools.find((tool) => tool.name === "recall_experience");
    const params = {
      category: "session routing", content: "Use the invoking session workspace.",
      sourceReference: "background-session-result", sourceResult: "success" as const,
      verificationMethod: "Compare the stored workspace path with the invoking session",
    };
    const runtimeB = {
      sessionPath: sessionB,
      sessionManager: { getSessionFile: () => sessionB, getCwd: () => workspaceB },
    };
    const runtimeA = {
      sessionPath: sessionA,
      sessionManager: { getSessionFile: () => sessionA, getCwd: () => workspaceA },
    };

    const proposed = proposalDetails(await recordTool.execute("background-record", params, undefined, undefined, runtimeB));
    expect(proposed.scope.path).toBe(normalizeWorkspacePath(workspaceB));
    reviewExperienceVersion(tmpDir, proposed.proposalId, "verify", "Workspace path checked");
    reviewExperienceVersion(tmpDir, proposed.proposalId, "activate");
    const focusedContent = "Keep focused session A's lesson separate.";
    const focused = proposalDetails(await recordTool.execute("focused-record", { ...params, content: focusedContent },
      undefined, undefined, runtimeA));
    expect(focused.scope.path).toBe(normalizeWorkspacePath(workspaceA));
    reviewExperienceVersion(tmpDir, focused.proposalId, "verify", "Focused workspace path checked");
    reviewExperienceVersion(tmpDir, focused.proposalId, "activate");
    expect((await recallTool.execute("background-recall", { category: params.category }, undefined, undefined, runtimeB))
      .content[0].text).toContain(params.content);
    expect((await recallTool.execute("background-recall-2", { category: params.category }, undefined, undefined, runtimeB))
      .content[0].text).not.toContain(focusedContent);
    expect((await recallTool.execute("focused-recall", { category: params.category }, undefined, undefined, runtimeA))
      .content[0].text).not.toContain(params.content);
    expect((await recallTool.execute("focused-recall-2", { category: params.category }, undefined, undefined, runtimeA))
      .content[0].text).toContain(focusedContent);
    expect((await recallTool.execute("path-only-recall", { category: params.category }, { sessionPath: sessionB }))
      .content[0].text).toContain(params.content);

    // The explicit session locator also works when the runtime has no CWD.
    const pathOnly = proposalDetails(await recordTool.execute("path-only-record", {
      ...params, content: "Resolve workspace from the invoking session path.",
    }, { sessionPath: sessionB }));
    expect(pathOnly.scope.path).toBe(normalizeWorkspacePath(workspaceB));

    const countBefore = listExperienceVersions(tmpDir).length;
    const unresolved = await recordTool.execute("unresolved-record", params,
      { sessionPath: path.join(tmpDir, "unknown-session.jsonl") });
    expect(unresolved.details).not.toHaveProperty("proposalId");
    expect(listExperienceVersions(tmpDir)).toHaveLength(countBefore);
    const unresolvedRecall = await recallTool.execute("unresolved-recall", { category: params.category },
      { sessionPath: path.join(tmpDir, "unknown-session.jsonl") });
    expect(unresolvedRecall.content[0].text).not.toContain(focusedContent);
    expect(unresolvedRecall.content[0].text).not.toContain(params.content);
    const idOnly = await recordTool.execute("id-only-record", params, { sessionId: "unknown-session" });
    expect(idOnly.details).not.toHaveProperty("proposalId");
    expect(listExperienceVersions(tmpDir)).toHaveLength(countBefore);
  });

  it("restores a prior active version after replacement is revoked, including after restart", async () => {
    tmpDir = mktemp();
    const workspace = path.join(tmpDir, "workspace");
    const makeTools = () => createExperienceTools(tmpDir, { isEnabled: () => true, getWorkspacePath: () => workspace });
    const old = proposalDetails(await makeTools()[1].execute("old", { category: "review", content: "Check task artifacts.",
      sourceReference: "task-1", sourceResult: "success", verificationMethod: "Inspect artifact" }));
    reviewExperienceVersion(tmpDir, old.proposalId, "verify", "Artifact inspected");
    reviewExperienceVersion(tmpDir, old.proposalId, "activate");
    const next = proposalDetails(await makeTools()[1].execute("next", { category: "review", content: "Check task artifacts and output status.",
      sourceReference: "task-2", sourceResult: "partial", verificationMethod: "Inspect status and artifact",
      replacesId: old.proposalId }));
    reviewExperienceVersion(tmpDir, next.proposalId, "verify", "Compared result and artifact");
    const stale = proposalDetails(await makeTools()[1].execute("stale", { category: "review", content: "Check status before delivery.",
      sourceReference: "task-3", sourceResult: "success", verificationMethod: "Inspect status",
      replacesId: old.proposalId }));
    reviewExperienceVersion(tmpDir, stale.proposalId, "verify", "Status inspected");
    reviewExperienceVersion(tmpDir, next.proposalId, "activate");
    expect(listExperienceVersions(tmpDir).find(row => row.id === old.proposalId)?.status).toBe("superseded");
    expect(() => reviewExperienceVersion(tmpDir, stale.proposalId, "activate")).toThrow("no longer active");
    const retried = proposalDetails(await makeTools()[1].execute("retry", { category: "review", content: "Check status before delivery.",
      sourceReference: "task-3", sourceResult: "success", verificationMethod: "Inspect status",
      replacesId: next.proposalId }));
    expect(retried.proposalId).not.toBe(stale.proposalId);
    reviewExperienceVersion(tmpDir, next.proposalId, "revoke");
    const recalled = await makeTools()[0].execute("recall-after-restart", { category: "review" });
    expect(recalled.content[0].text).toContain("Check task artifacts.");
    expect(recalled.content[0].text).not.toContain("Check task artifacts and output status.");
  });

  it("keeps stored content but blocks recall and record while paused", async () => {
    tmpDir = mktemp();
    let enabled = true;
    const tools = createExperienceTools(tmpDir, { isEnabled: () => enabled,
      getWorkspacePath: () => path.join(tmpDir, "workspace") });
    const recordTool = tools.find((tool) => tool.name === "record_experience");
    const recallTool = tools.find((tool) => tool.name === "recall_experience");

    await recordTool.execute("call-1", {
      category: "writing workflow",
      content: "Keep the source of truth explicit.",
      sourceReference: "task-1", sourceResult: "success", verificationMethod: "Check source file",
    });
    const stored = listExperienceVersions(tmpDir);
    expect(stored).toHaveLength(1);

    enabled = false;
    const pausedRecall = await recallTool.execute("call-2", {});
    expect(pausedRecall.content[0].text).toContain("Experience is paused");

    const pausedRecord = await recordTool.execute("call-3", {
      category: "writing workflow",
      content: "This should not be added while paused.",
      sourceReference: "task-2", sourceResult: "success", verificationMethod: "Check source file",
    });
    expect(pausedRecord.content[0].text).toContain("Experience is paused");
    expect(listExperienceVersions(tmpDir)).toHaveLength(1);

    enabled = true;
    reviewExperienceVersion(tmpDir, stored[0].id, "verify", "Source checked");
    reviewExperienceVersion(tmpDir, stored[0].id, "activate");
    const resumedRecall = await recallTool.execute("call-4", { category: "writing workflow" });
    expect(resumedRecall.content[0].text).toContain("Keep the source of truth explicit.");
  });
});
