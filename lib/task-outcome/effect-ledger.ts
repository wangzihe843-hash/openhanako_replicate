/** Durable, conservative receipt tracking for the channel.post pilot. */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { parseChannel } from "../channels/channel-store.ts";

export type EffectStatus = "prepared" | "committed" | "failed" | "unknown";

export interface EffectRecord {
  effectId: string;
  operationKey: string;
  taskId: string;
  attemptId: string;
  attempts: number;
  toolName: "channel.post";
  argsDigest: string;
  receiptToken: string;
  status: EffectStatus;
  receipt?: { channel: string; timestamp: string; sender: string };
  errorCode?: string;
  updatedAt: number;
}

/** Tool results are persisted in the model-visible session; never expose the receipt token. */
export function publicEffectRecord(record: EffectRecord) {
  return {
    effectId: record.effectId,
    status: record.status,
    attempts: record.attempts,
    ...(record.receipt ? { receipt: record.receipt } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  };
}

const effectLocks = new Map<string, Promise<unknown>>();
const PRE_SEND_CODES = new Set(["channel_not_found", "channel_not_member", "channel_write_cancelled"]);

export function digestEffectInput(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function channelPostOperationKey(agentId: string, toolCallId: string, sessionIdentity?: string | null): string {
  if (!toolCallId?.trim()) throw new Error("channel.post requires a stable tool call ID");
  // Pi tool-call IDs are only session-local. A stable Hana session ID (or JSONL
  // locator) separates separate conversations; the two-argument form retains
  // the direct-call/old-ledger identity for callers without runtime context.
  return sessionIdentity?.trim()
    ? digestEffectInput(["channel.post", "session", agentId, sessionIdentity, toolCallId])
    : digestEffectInput(["channel.post", agentId, toolCallId]);
}

export class EffectLedger {
  private directory: string;

  constructor(channelsDir: string) {
    this.directory = path.join(channelsDir, ".effects", "channel-post");
  }

  private filePath(effectId: string): string {
    if (!/^[a-f0-9]{64}$/.test(effectId)) throw new Error("Invalid effect ID");
    return path.join(this.directory, `${effectId}.json`);
  }

  read(effectId: string): EffectRecord | null {
    const filePath = this.filePath(effectId);
    if (!fs.existsSync(filePath)) return null;
    const record = JSON.parse(fs.readFileSync(filePath, "utf8")) as EffectRecord;
    if (record.effectId !== effectId || record.operationKey !== effectId) {
      throw new Error("Effect ledger identity mismatch");
    }
    return record;
  }

  write(record: EffectRecord): EffectRecord {
    const filePath = this.filePath(record.effectId);
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return record;
  }
}

/** Read-only current-artifact verification; the receipt token never leaves the server. */
export function verifyChannelPostReceipt(ledger: EffectLedger, filePath: string, channelId: string, effectId: string) {
  const record = ledger.read(effectId);
  if (!record || record.status !== "committed" || record.receipt?.channel !== channelId || !fs.existsSync(filePath)) return null;
  const message = parseChannel(fs.readFileSync(filePath, "utf8"), { includeReceiptMetadata: true })
    .messages.find((entry) => entry.effectId === effectId);
  if (!message || message.receiptToken !== record.receiptToken) return null;
  if (digestEffectInput([channelId, message.sender, message.body]) !== record.argsDigest) return null;
  if (message.sender !== record.receipt.sender || message.timestamp !== record.receipt.timestamp) return null;
  return { channel: channelId, sender: message.sender, timestamp: message.timestamp };
}

export interface ChannelPostEffectInput {
  ledger: EffectLedger;
  agentId: string;
  toolCallId: string;
  sessionIdentity?: string | null;
  channelId: string;
  content: string;
  lookupReceipt: (effectId: string, receiptToken: string) => { timestamp: string; sender: string } | null;
  send: (effectId: string, receiptToken: string) => Promise<{ timestamp: string; replayed?: boolean }>;
}

/** One in-process runner per logical action; the channel marker is the persisted receipt. */
export async function runChannelPostEffect(input: ChannelPostEffectInput): Promise<{ record: EffectRecord; sentNow: boolean }> {
  const effectId = channelPostOperationKey(input.agentId, input.toolCallId, input.sessionIdentity);
  const previous = effectLocks.get(effectId) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    // appendMessage persists the trimmed body. Digest that canonical body so a
    // later artifact check sees the same bytes for posts with outer whitespace.
    const argsDigest = digestEffectInput([input.channelId, input.agentId, input.content.trim()]);
    let record = input.ledger.read(effectId);
    if (record && record.argsDigest !== argsDigest) {
      throw Object.assign(new Error("Tool call ID reused with different channel.post arguments"), { code: "effect_identity_conflict" });
    }
    // A record written before session-scoped keys cannot be assigned safely to
    // any one of several sessions with the same tool-call ID. Preserve it and
    // block a new send instead of silently treating its absence at the new key
    // as proof that this action has never run.
    if (!record && input.sessionIdentity?.trim()) {
      const legacy = input.ledger.read(channelPostOperationKey(input.agentId, input.toolCallId));
      if (legacy) {
        record = input.ledger.write({
          effectId,
          operationKey: effectId,
          taskId: `tool:${input.toolCallId}`,
          attemptId: `${effectId}:legacy`,
          attempts: 0,
          toolName: "channel.post",
          argsDigest,
          receiptToken: crypto.randomBytes(16).toString("hex"),
          status: "unknown",
          errorCode: "effect_legacy_identity_ambiguous",
          updatedAt: Date.now(),
        });
        return { record, sentNow: false };
      }
    }
    if (record?.status === "committed") return { record, sentNow: false };

    // An interrupted prepared write is uncertain. Query the durable message
    // marker first; absence is not proof that a partially written send is safe.
    if (record && record.status !== "failed") {
      let receipt: ReturnType<ChannelPostEffectInput["lookupReceipt"]> = null;
      let receiptError: string | undefined;
      try { receipt = input.lookupReceipt(effectId, record.receiptToken); }
      catch { receiptError = "effect_receipt_conflict"; }
      record = input.ledger.write({
        ...record,
        status: receipt ? "committed" : "unknown",
        ...(receipt ? { receipt: { channel: input.channelId, ...receipt } } : {}),
        ...(receiptError ? { errorCode: receiptError } : {}),
        updatedAt: Date.now(),
      });
      return { record, sentNow: false };
    }

    const attempts = (record?.attempts || 0) + 1;
    record = input.ledger.write({
      effectId,
      operationKey: effectId,
      taskId: `tool:${input.toolCallId}`,
      attemptId: `${effectId}:${attempts}`,
      attempts,
      toolName: "channel.post",
      argsDigest,
      receiptToken: record?.receiptToken || crypto.randomBytes(16).toString("hex"),
      status: "prepared",
      updatedAt: Date.now(),
    });
    try {
      const result = await input.send(effectId, record.receiptToken);
      record = input.ledger.write({
        ...record,
        status: "committed",
        receipt: { channel: input.channelId, timestamp: result.timestamp, sender: input.agentId },
        updatedAt: Date.now(),
      });
      return { record, sentNow: !result.replayed };
    } catch (error) {
      let receipt: ReturnType<ChannelPostEffectInput["lookupReceipt"]> = null;
      try { receipt = input.lookupReceipt(effectId, record.receiptToken); } catch { /* query failure is unknown */ }
      if (receipt) {
        record = input.ledger.write({
          ...record, status: "committed",
          receipt: { channel: input.channelId, ...receipt }, updatedAt: Date.now(),
        });
        return { record, sentNow: false };
      }
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "send_error";
      record = input.ledger.write({
        ...record,
        status: PRE_SEND_CODES.has(code) ? "failed" : "unknown",
        errorCode: code,
        updatedAt: Date.now(),
      });
      return { record, sentNow: false };
    }
  });
  effectLocks.set(effectId, run);
  try { return await run; }
  finally { if (effectLocks.get(effectId) === run) effectLocks.delete(effectId); }
}
