import { describe, expect, it } from "vitest";
import { extractBlocks } from "../server/block-extractors.ts";
import {
  projectChannelPostOutcome,
  projectRegistryTaskOutcome,
  projectWebReadOutcome,
} from "../lib/task-outcome/task-outcome.ts";

const hash = `sha256:${"a".repeat(64)}`;
const completeRead = {
  status: "complete" as const,
  scope: "single_response_text" as const,
  sourceUrl: "https://example.org/article",
  resolvedUrl: "https://example.org/article",
  responseTextHash: hash,
  outputTextHash: hash,
  returnedCharacters: 120,
  missingReasons: [],
};

describe("TaskOutcome projections", () => {
  it("keeps workflow lifecycle completion separate from requested-goal verification", () => {
    const outcome = projectRegistryTaskOutcome({ taskId: "workflow-1", type: "workflow", status: "completed", updatedAt: 123 });
    expect(outcome).toMatchObject({ lifecycle: "completed", goalResult: "unverified", kind: "workflow" });
    expect(outcome?.evidence).toEqual([{ kind: "task_registry", reference: "workflow-1", status: "completed", timestamp: 123 }]);
    expect(projectRegistryTaskOutcome({ taskId: "workflow-2", type: "workflow", status: "failed" }))
      .toMatchObject({ lifecycle: "failed", goalResult: "failed" });
  });

  it("scopes channel verification to the local append receipt, not recipient reading", () => {
    const effectId = "b".repeat(64);
    const outcome = projectChannelPostOutcome({
      effectId, status: "committed", attempts: 1,
      receipt: { channel: "ch_team", sender: "alice", timestamp: "2026-09-27 19:00:00" },
    });
    expect(outcome).toMatchObject({
      lifecycle: "completed", goalResult: "verified", goalScope: "local_channel_append",
      evidence: [{ kind: "channel_receipt", reference: "ch_team", sender: "alice" }],
    });
    expect(projectChannelPostOutcome({ effectId, status: "unknown", attempts: 1 }))
      .toMatchObject({ lifecycle: "unknown", goalResult: "unverified", pendingDecisions: ["inspect_channel_receipt"] });
  });

  it("uses structured S9 coverage, even if assistant prose claims the full page was read", () => {
    expect(projectWebReadOutcome("read-1", completeRead)).toMatchObject({ lifecycle: "completed", goalResult: "verified" });
    const partial = projectWebReadOutcome("read-2", {
      ...completeRead, status: "partial", missingReasons: ["html_coverage_unverified", "media_not_read"],
    });
    expect(partial).toMatchObject({
      lifecycle: "completed", goalResult: "partial", goalScope: "single_response_text",
      evidence: [{ contentHash: hash, missingReasons: ["html_coverage_unverified", "media_not_read"] }],
    });
    expect(projectWebReadOutcome("read-3", { ...completeRead, outputTextHash: undefined }))
      .toMatchObject({ lifecycle: "completed", goalResult: "unverified" });
  });

  it.each(["empty_body", "timeout", "cancelled", "transport_or_read_error"])("shows a failed S9 read for %s", (reason) => {
    const outcome = projectWebReadOutcome(`read-${reason}`, {
      status: "failed", scope: "single_response_text", sourceUrl: "https://example.org/article", missingReasons: [reason],
    });
    expect(outcome).toMatchObject({ lifecycle: "failed", goalResult: "failed", evidence: [{ missingReasons: [reason] }] });
  });

  it("extracts the same result card from live and persisted tool result details", () => {
    const details = { readEvidence: { ...completeRead, status: "partial", missingReasons: ["media_not_read"] } };
    const live = extractBlocks("web_fetch", details, { content: [] }, "read-live");
    const restored = extractBlocks("web_fetch", details, { role: "toolResult", toolCallId: "read-live", content: [] });
    expect(live).toEqual(restored);
    expect(live).toMatchObject([{ type: "task_outcome", outcome: { taskId: "tool:read-live", goalResult: "partial" } }]);
  });
});
