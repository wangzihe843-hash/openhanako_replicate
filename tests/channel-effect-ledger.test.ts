import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { addBookmarkEntry, appendMessage, createChannel, parseChannel } from "../lib/channels/channel-store.ts";
import { createChannelTool } from "../lib/tools/channel-tool.ts";
import { channelPostOperationKey, EffectLedger, publicEffectRecord, verifyChannelPostReceipt } from "../lib/task-outcome/effect-ledger.ts";

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
});
