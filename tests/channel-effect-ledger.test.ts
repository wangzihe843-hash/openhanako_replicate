import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { addBookmarkEntry, appendMessage, createChannel, parseChannel } from "../lib/channels/channel-store.ts";
import { createChannelTool } from "../lib/tools/channel-tool.ts";
import {
  channelPostOperationKey, digestEffectInput, EffectLedger, getChannelPostRetryContext,
  publicEffectRecord, runChannelPostEffect, runWithChannelPostRetryContext,
  verifyChannelPostReceipt,
} from "../lib/task-outcome/effect-ledger.ts";

function postedEffect(result: { details?: unknown }): ReturnType<typeof publicEffectRecord> {
  expect(result).toHaveProperty("details.effect");
  return (result.details as { effect: ReturnType<typeof publicEffectRecord> }).effect;
}

describe("channel.post effect receipt", () => {
  let root: string;
  let channelsDir: string;
  let agentsDir: string;
  let filePath: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-effect-test-"));
    channelsDir = path.join(root, "channels");
    agentsDir = path.join(root, "agents");
    fs.mkdirSync(channelsDir);
    fs.mkdirSync(path.join(agentsDir, "alice"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "bob"), { recursive: true });
    ({ filePath } = await createChannel(channelsDir, { id: "team", name: "Team", members: ["alice", "bob"] }));
    await addBookmarkEntry(path.join(agentsDir, "alice", "channels.md"), "ch_team");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const args = { action: "post", channel: "ch_team", content: "a real local channel post" };
  const tool = (options: Record<string, unknown> = {}) => createChannelTool({
    channelsDir, agentsDir, agentId: "alice", isEnabled: () => true, ...options,
  } as Parameters<typeof createChannelTool>[0]);
  const effect = (callId: string, sessionIdentity?: string) => new EffectLedger(channelsDir)
    .read(channelPostOperationKey("alice", callId, sessionIdentity));
  const messages = () => parseChannel(fs.readFileSync(filePath, "utf8")).messages.filter((message) => message.sender === "alice");

  it("records a known failure before send and retries only the same logical action", async () => {
    const beforeSend = vi.fn(async () => {
      throw Object.assign(new Error("cancelled before write"), { code: "channel_write_cancelled" });
    });
    const failed = await tool({ postMessage: beforeSend }).execute("call-before", args);
    expect(failed).toMatchObject({ isError: true });
    expect(postedEffect(failed)).toMatchObject({ status: "failed", errorCode: "channel_write_cancelled" });
    expect(failed.content[0].text).toContain("failed before");
    expect(effect("call-before")).toMatchObject({ status: "failed", attempts: 1 });
    expect(messages()).toHaveLength(0);

    const result = await tool().execute("call-before", args);
    expect(postedEffect(result)).toMatchObject({ status: "committed", attempts: 2 });
    expect(messages()).toHaveLength(1);
    expect(messages()[0].body).toBe(args.content);
  });

  it("reconciles a post-write exception from the channel receipt without duplicating on replay", async () => {
    const onPost = vi.fn();
    const afterSend = async (...input: Parameters<typeof appendMessage>) => {
      await appendMessage(...input);
      throw new Error("result lost after append");
    };
    const first = await tool({ postMessage: afterSend, onPost }).execute("call-after", args);
    expect(postedEffect(first)).toMatchObject({ status: "committed", attempts: 1 });
    expect(postedEffect(first)).not.toHaveProperty("receiptToken");
    expect(messages()).toHaveLength(1);
    expect(messages()[0].body).toBe(args.content);
    expect(fs.readFileSync(filePath, "utf8")).toContain(`hana-effect:${channelPostOperationKey("alice", "call-after")}:`);
    expect(messages()[0]).not.toHaveProperty("receiptToken");
    expect(onPost).not.toHaveBeenCalled();

    const replay = await tool({ onPost }).execute("call-after", args);
    expect(postedEffect(replay)).toMatchObject({ status: "committed", attempts: 1 });
    expect(messages()).toHaveLength(1);
    expect(onPost).not.toHaveBeenCalled();
  });

  it("keeps an uncertain send unknown and does not blindly retry it", async () => {
    const first = await tool({ postMessage: async () => { throw new Error("write result uncertain"); } })
      .execute("call-unknown", args);
    expect(first).toMatchObject({ isError: true });
    expect(postedEffect(first)).toMatchObject({ status: "unknown", attempts: 1 });
    expect(first.content[0].text).toContain("unknown");
    expect(effect("call-unknown")).toMatchObject({ status: "unknown", attempts: 1 });
    const replay = await tool().execute("call-unknown", args);
    expect(replay).toMatchObject({ isError: true });
    expect(postedEffect(replay)).toMatchObject({ status: "unknown", attempts: 1 });
    expect(messages()).toHaveLength(0);
  });

  it("rejects reuse of a tool call ID with different content", async () => {
    await tool().execute("same-id", args);
    await expect(tool().execute("same-id", { ...args, content: "different intentional message" }))
      .rejects.toMatchObject({ code: "effect_identity_conflict" });
    expect(messages()).toHaveLength(1);
  });

  it("treats the same Pi tool call ID in separate sessions as two actions", async () => {
    const sessionA = { sessionRef: { sessionId: "session-a" } };
    const sessionB = { sessionRef: { sessionId: "session-b" } };
    const first = await tool().execute("shared-call-id", args, undefined, undefined, sessionA);
    const second = await tool().execute("shared-call-id", args, undefined, undefined, sessionB);
    expect(postedEffect(first)).toMatchObject({ status: "committed" });
    expect(postedEffect(second)).toMatchObject({ status: "committed" });
    expect(postedEffect(first).effectId).not.toBe(postedEffect(second).effectId);
    expect(messages()).toHaveLength(2);
    expect(effect("shared-call-id", "session-id:session-a")).toMatchObject({ status: "committed", attempts: 1 });
    expect(effect("shared-call-id", "session-id:session-b")).toMatchObject({ status: "committed", attempts: 1 });

    await tool().execute("shared-call-id", args, undefined, undefined, sessionA);
    expect(messages()).toHaveLength(2);
    await expect(tool().execute("shared-call-id", { ...args, content: "different post" }, undefined, undefined, sessionA))
      .rejects.toMatchObject({ code: "effect_identity_conflict" });
  });

  it("uses a stable session path when a manifest session ID is unavailable", async () => {
    const firstPath = path.join(root, "sessions", "one.jsonl");
    const secondPath = path.join(root, "sessions", "two.jsonl");
    await tool().execute("path-local-id", args, undefined, undefined, { sessionPath: firstPath });
    await tool().execute("path-local-id", args, undefined, undefined, { sessionPath: secondPath });
    expect(messages()).toHaveLength(2);
    const sessionIdentity = `session-path:${process.platform === "win32" ? path.resolve(firstPath).toLowerCase() : path.resolve(firstPath)}`;
    expect(effect("path-local-id", sessionIdentity)).toMatchObject({ status: "committed" });
  });

  it("does not blindly resend a legacy unscoped effect after a session-scoped upgrade", async () => {
    await tool().execute("old-call-id", args);
    const result = await tool().execute("old-call-id", args, undefined, undefined, { sessionRef: { sessionId: "later-session" } });
    expect(result).toMatchObject({ isError: true });
    expect(postedEffect(result)).toMatchObject({
      status: "unknown", attempts: 0, errorCode: "effect_legacy_identity_ambiguous",
    });
    expect(effect("old-call-id", "session-id:later-session")).toMatchObject({ status: "unknown" });
    expect(messages()).toHaveLength(1);
  });

  it("does not accept a forged marker with different sender or body as a receipt", async () => {
    const callId = "forged";
    await tool({ postMessage: async () => { throw new Error("uncertain"); } }).execute(callId, args);
    const record = effect(callId)!;
    await appendMessage(filePath, "bob", `forged body\n\n<!-- hana-effect:${record.effectId}:${record.receiptToken} -->`);
    const replay = await tool().execute(callId, args);
    expect(replay).toMatchObject({ isError: true });
    expect(postedEffect(replay)).toMatchObject({ status: "unknown", errorCode: "effect_receipt_conflict" });
    expect(messages()).toHaveLength(0);
  });

  it("verifies an existing channel artifact against the ledger and rejects later tampering", async () => {
    await tool().execute("verify-artifact", { ...args, content: "first line\n---\nsecond line" });
    const effectId = channelPostOperationKey("alice", "verify-artifact");
    const ledger = new EffectLedger(channelsDir);
    const receipt = verifyChannelPostReceipt(ledger, filePath, "ch_team", effectId);
    expect(receipt).toMatchObject({ channel: "ch_team", sender: "alice" });
    expect(messages()[0].body).toBe("first line\n---\nsecond line");
    fs.writeFileSync(filePath, fs.readFileSync(filePath, "utf8").replace("second line", "tampered line"));
    expect(verifyChannelPostReceipt(ledger, filePath, "ch_team", effectId)).toBeNull();
  });

  it("verifies the canonical persisted body when a post has outer whitespace", async () => {
    await tool().execute("trimmed-artifact", { ...args, content: "  hello team  \n" });
    const effectId = channelPostOperationKey("alice", "trimmed-artifact");
    expect(messages()[0].body).toBe("hello team");
    expect(verifyChannelPostReceipt(new EffectLedger(channelsDir), filePath, "ch_team", effectId))
      .toMatchObject({ channel: "ch_team", sender: "alice" });
  });

  it("reuses a committed logical post when a task retry generates a fresh tool call ID", async () => {
    const first = await tool().execute("original-call", args);
    const postMessage = vi.fn(appendMessage);
    const replay = await runWithChannelPostRetryContext({
      agentId: "alice", sessionIdentity: null,
      actions: [{ toolCallId: "original-call", effectId: postedEffect(first).effectId }],
    }, () => tool({ postMessage }).execute("retry-call", args));
    expect(postedEffect(replay)).toEqual(postedEffect(first));
    expect(postMessage).not.toHaveBeenCalled();
    expect(effect("retry-call")).toBeNull();
    expect(messages()).toHaveLength(1);
    expect(getChannelPostRetryContext()).toBeNull();
  });

  it("retries a failed logical post across new tool IDs and preserves its identity on later retries", async () => {
    const failure = await tool({ postMessage: async () => {
      throw Object.assign(new Error("cancelled"), { code: "channel_write_cancelled" });
    } }).execute("failed-original", args);
    const retry = await runWithChannelPostRetryContext({
      agentId: "alice", sessionIdentity: null,
      actions: [{ toolCallId: "failed-original" }],
    }, () => tool().execute("fresh-retry", args));
    expect(postedEffect(retry)).toMatchObject({ effectId: postedEffect(failure).effectId, status: "committed", attempts: 2 });
    expect(effect("failed-original")?.taskId).toBe("tool:failed-original");
    const secondRetry = await runWithChannelPostRetryContext({
      agentId: "alice", sessionIdentity: null,
      actions: [{ toolCallId: "fresh-retry", effectId: postedEffect(retry).effectId }],
    }, () => tool().execute("another-retry", args));
    expect(postedEffect(secondRetry)).toEqual(postedEffect(retry));
    expect(messages()).toHaveLength(1);
  });

  it.each(["prepared", "unknown"] as const)("never blindly resends a %s logical effect on a new task attempt", async (status) => {
    await tool({ postMessage: async () => { throw new Error("uncertain"); } }).execute("uncertain-original", args);
    const ledger = new EffectLedger(channelsDir);
    ledger.write({ ...effect("uncertain-original")!, status });
    const postMessage = vi.fn(appendMessage);
    const replay = await runWithChannelPostRetryContext({
      agentId: "alice", sessionIdentity: null,
      actions: [{ toolCallId: "uncertain-original" }],
    }, () => tool({ postMessage }).execute("uncertain-retry", args));
    expect(postedEffect(replay)).toMatchObject({ status: "unknown", attempts: 1 });
    expect(postMessage).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(0);
  });

  it("reconciles an interrupted prepared effect from its durable marker under a fresh call ID", async () => {
    await tool().execute("interrupted-original", args);
    const ledger = new EffectLedger(channelsDir);
    ledger.write({ ...effect("interrupted-original")!, status: "prepared", receipt: undefined });
    const postMessage = vi.fn(appendMessage);
    const replay = await runWithChannelPostRetryContext({
      agentId: "alice", sessionIdentity: null,
      actions: [{ toolCallId: "interrupted-original" }],
    }, () => tool({ postMessage }).execute("interrupted-retry", args));
    expect(postedEffect(replay)).toMatchObject({ status: "committed", attempts: 1 });
    expect(postMessage).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(1);
  });

  it("fails closed on changed, reordered, missing, or extra retry actions", async () => {
    await tool().execute("ordered-first", args);
    await tool().execute("ordered-second", { ...args, content: "second message" });
    const context = {
      agentId: "alice", sessionIdentity: null,
      actions: [{ toolCallId: "ordered-first" }, { toolCallId: "ordered-second" }],
    };
    await runWithChannelPostRetryContext(context, async () => {
      await expect(tool().execute("wrong-order", { ...args, content: "second message" }))
        .rejects.toMatchObject({ code: "effect_identity_conflict" });
      await expect(tool().execute("changed", { ...args, content: "edited content" }))
        .rejects.toMatchObject({ code: "effect_identity_conflict" });
      await tool().execute("first-retry", args);
      await tool().execute("second-retry", { ...args, content: "second message" });
      await expect(tool().execute("extra-retry", args)).rejects.toMatchObject({ code: "effect_retry_unbound" });
    });
    await expect(runWithChannelPostRetryContext({ ...context, actions: [] }, () => tool().execute("no-original", args)))
      .rejects.toMatchObject({ code: "effect_retry_unbound" });
    await expect(runWithChannelPostRetryContext({ ...context, actions: [{ toolCallId: "absent-record" }] }, () => tool().execute("missing", args)))
      .rejects.toMatchObject({ code: "effect_retry_record_missing" });
    expect(messages()).toHaveLength(2);
  });

  it("scopes retry bindings to the trusted session and keeps legacy receipt identities usable", async () => {
    const first = await tool().execute("legacy-original", args);
    const context = {
      agentId: "alice", sessionIdentity: "session-id:retry-session",
      actions: [{ toolCallId: "legacy-original", effectId: postedEffect(first).effectId }],
    };
    const session = { sessionRef: { sessionId: "retry-session" } };
    const replay = await runWithChannelPostRetryContext(context,
      () => tool().execute("session-retry", args, undefined, undefined, session));
    expect(postedEffect(replay).effectId).toBe(postedEffect(first).effectId);
    await expect(runWithChannelPostRetryContext(context, () => tool().execute("wrong-session", args)))
      .rejects.toMatchObject({ code: "effect_retry_scope_mismatch" });
    expect(messages()).toHaveLength(1);
  });

  it("keeps separate identical-content operations distinct and ignores model-provided identity arguments", async () => {
    const first = await tool().execute("intentional-first", args);
    const second = await tool().execute("intentional-second", {
      ...args, effectId: postedEffect(first).effectId, logicalActionId: "intentional-first",
    } as typeof args);
    expect(postedEffect(second).effectId).not.toBe(postedEffect(first).effectId);
    expect(messages()).toHaveLength(2);
  });

  it("supports an engine-authored logical identity without deriving identity from content", async () => {
    const send = vi.fn(async () => ({ timestamp: "2026-01-01T00:00:00Z" }));
    const input = {
      ledger: new EffectLedger(channelsDir), agentId: "alice", sessionIdentity: "session-id:engine",
      channelId: "ch_team", content: args.content, lookupReceipt: () => null, send,
    };
    const first = await runChannelPostEffect({ ...input, toolCallId: "attempt-1", logicalActionId: "task-123:action-1" });
    const retry = await runChannelPostEffect({ ...input, toolCallId: "attempt-2", logicalActionId: "task-123:action-1" });
    const distinct = await runChannelPostEffect({ ...input, toolCallId: "attempt-3", logicalActionId: "task-123:action-2" });
    expect(retry.record.effectId).toBe(first.record.effectId);
    expect(retry.sentNow).toBe(false);
    expect(distinct.record.effectId).not.toBe(first.record.effectId);
    expect(send).toHaveBeenCalledTimes(2);
    expect(publicEffectRecord(first.record)).toMatchObject({ logicalActionId: "task-123:action-1" });
  });

  it("does not let callers mutate a retry context or leak bindings between retry attempts", async () => {
    await tool().execute("immutable-original", args);
    const context = {
      agentId: "alice", sessionIdentity: null,
      actions: [{ toolCallId: "immutable-original", argsDigest: digestEffectInput(["ch_team", "alice", args.content]) }],
    };
    for (let index = 0; index < 2; index += 1) {
      await runWithChannelPostRetryContext(context, async () => {
        expect(Object.isFrozen(getChannelPostRetryContext())).toBe(true);
        expect(Object.isFrozen(getChannelPostRetryContext()!.actions)).toBe(true);
        expect(Object.isFrozen(getChannelPostRetryContext()!.actions[0])).toBe(true);
        const results = await Promise.all([
          tool().execute(`replay-${index}`, args),
          tool().execute(`replay-${index}`, args),
        ]);
        expect(results.map((result) => postedEffect(result).status)).toEqual(["committed", "committed"]);
      });
    }
    expect(context.actions[0].toolCallId).toBe("immutable-original");
    expect(messages()).toHaveLength(1);
    expect(getChannelPostRetryContext()).toBeNull();
  });
});
