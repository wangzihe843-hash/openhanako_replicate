import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { retrySessionTurn } from "../core/session-turn-actions.ts";
import { EffectLedger, getChannelPostRetryContext, publicEffectRecord, runChannelPostEffect } from "../lib/task-outcome/effect-ledger.ts";

describe("task retry reuses original logical channel actions", () => {
  it.each(["committed", "failed", "unknown"] as const)("handles prior %s receipts with a fresh model tool call ID", async status => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-retry-effects-"));
    try {
      const ledger = new EffectLedger(root);
      const initialSend = vi.fn(async () => {
        if (status !== "committed") throw Object.assign(new Error(status), { code: status === "failed" ? "channel_write_cancelled" : "uncertain" });
        return { timestamp: "original-timestamp" };
      });
      const shared = { ledger, agentId: "hana", sessionIdentity: "session-id:sess_one", channelId: "ch_team", content: "hello", lookupReceipt: () => null };
      const original = await runChannelPostEffect({ ...shared, toolCallId: "original-call", send: initialSend });
      const manager = SessionManager.inMemory("/workspace");
      const userId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "Post hello" }] } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
      manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "original-call", name: "channel", arguments: { action: "post", channel: "ch_team", content: "hello" } }] } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
      manager.appendMessage({ role: "toolResult", toolName: "channel", toolCallId: "original-call", content: [], details: { effect: publicEffectRecord(original.record) } } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
      const assistantId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: status }] } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
      const engine = {
        getSessionManifest: () => ({ ownerAgentId: "hana", currentLocator: { path: "/session.jsonl" } }),
        getSessionIdForPath: () => "sess_one", ensureSessionLoaded: async () => ({ sessionManager: manager }),
        isSessionStreaming: () => false, setSessionBranchHead: vi.fn(),
      };
      const retrySend = vi.fn(async () => ({ timestamp: "retry-timestamp" }));
      const submit = vi.fn(async (_engine, opts) => {
        expect(getChannelPostRetryContext()?.actions).toEqual([{ toolCallId: "original-call", effectId: original.record.effectId }]);
        opts.beforeInputSideEffects();
        manager.appendMessage({ role: "user", content: opts.text, timestamp: Date.now() });
        return runChannelPostEffect({ ...shared, toolCallId: "new-model-call", send: retrySend });
      });
      const retry = await retrySessionTurn(engine, { sessionId: "sess_one", target: { role: "assistant", entryId: assistantId }, mode: "task_retry" }, { submit, invalidateDerivedState: () => {} });
      expect(retry.record.effectId).toBe(original.record.effectId);
      expect(retry.record.status).toBe(status === "failed" ? "committed" : status);
      expect(retrySend).toHaveBeenCalledTimes(status === "failed" ? 1 : 0);
      expect(getChannelPostRetryContext()).toBeNull();
      expect(manager.getEntries().some(entry => entry.id === userId)).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("cannot change the task while using retry effect authorization", async () => {
    const submit = vi.fn();
    const engine = { ensureSessionLoaded: vi.fn(), getSessionManifest: () => ({ ownerAgentId: "hana", currentLocator: { path: "/session.jsonl" } }) };
    await expect(retrySessionTurn(engine, { sessionId: "sess_one", mode: "task_retry", replacementText: "Post something else" }, { submit })).rejects.toThrow("cannot change");
    expect(submit).not.toHaveBeenCalled();
    expect(engine.ensureSessionLoaded).not.toHaveBeenCalled();
  });
});
