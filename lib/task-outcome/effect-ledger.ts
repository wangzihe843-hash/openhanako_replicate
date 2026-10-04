/** Durable, conservative receipt tracking for the channel.post pilot. */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { parseChannel } from "../channels/channel-store.ts";

export type EffectStatus = "prepared" | "committed" | "failed" | "unknown";

export interface EffectRecord {
  effectId: string;
  operationKey: string;
  /** Engine-authored action identity, when present. Never accepted as a tool argument. */
  logicalActionId?: string;
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
    ...(record.logicalActionId ? { logicalActionId: record.logicalActionId } : {}),
    ...(record.receipt ? { receipt: record.receipt } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  };
}

const effectLocks = new Map<string, Promise<unknown>>();
const PRE_SEND_CODES = new Set(["channel_not_found", "channel_not_member", "channel_write_cancelled"]);

export function digestEffectInput(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function channelPostOperationKey(agentId: string, toolCallId: string, sessionIdentity?: string | null, logicalActionId?: string): string {
  if (!toolCallId?.trim()) throw new Error("channel.post requires a stable tool call ID");
  if (logicalActionId != null) {
    if (!logicalActionId.trim()) throw new Error("channel.post requires a nonempty logical action ID");
    return digestEffectInput(["channel.post", "logical", agentId, sessionIdentity?.trim() || null, logicalActionId]);
  }
  // Pi tool-call IDs are only session-local. A stable Hana session ID (or JSONL
  // locator) separates separate conversations; the two-argument form retains
  // the direct-call/old-ledger identity for callers without runtime context.
  return sessionIdentity?.trim()
    ? digestEffectInput(["channel.post", "session", agentId, sessionIdentity, toolCallId])
    : digestEffectInput(["channel.post", agentId, toolCallId]);
}

export interface ChannelPostRetryAction {
  toolCallId: string;
  effectId?: string;
  logicalActionId?: string;
  argsDigest?: string;
}

export interface ChannelPostRetryContext {
  agentId: string;
  sessionIdentity: string | null;
  /** Original channel.post calls in persisted turn order, supplied by the engine. */
  actions: readonly ChannelPostRetryAction[];
  /** Engine-only synchronous durable binding, called before a provider/effect dispatch. */
  beforeDispatch?: () => void;
}

interface ChannelPostRetryState {
  context: Readonly<ChannelPostRetryContext>;
  bindings: Map<string, Readonly<ChannelPostRetryAction>>;
  nextAction: number;
  beforeDispatch?: () => void;
  dispatchPrepared: boolean;
}

const channelPostRetryStorage = new AsyncLocalStorage<ChannelPostRetryState>();

/** Read-only trusted runtime context, also usable by the retry tool-permission gate. */
export function getChannelPostRetryContext(): Readonly<ChannelPostRetryContext> | null {
  return channelPostRetryStorage.getStore()?.context || null;
}

/** Bind the retry to the actual accepted input, never an adjacent pending prefix. */
export function prepareChannelPostRetryDispatch(agentId: string, sessionIdentity?: string | null): void {
  const retry = channelPostRetryStorage.getStore();
  if (!retry) return;
  if (retry.context.agentId !== agentId || retry.context.sessionIdentity !== (sessionIdentity?.trim() || null)) {
    throw effectError("effect_retry_scope_mismatch", "Task retry effect binding belongs to a different agent or session");
  }
  if (retry.dispatchPrepared) return;
  retry.beforeDispatch?.();
  retry.dispatchPrepared = true;
}

/**
 * Retry identity comes from persisted actions selected by the engine, not model
 * arguments or a content hash. Calls are rebound in strict original order. A
 * changed, skipped, or extra action must become an explicit new user operation.
 */
export function runWithChannelPostRetryContext<T>(context: ChannelPostRetryContext, callback: () => T): T {
  if (!context.agentId?.trim()) throw new Error("Task retry requires an agent identity");
  const seenCalls = new Set<string>();
  const actions = context.actions.map((action) => {
    if (!action.toolCallId?.trim() || seenCalls.has(action.toolCallId)) {
      throw effectError("effect_retry_binding_ambiguous", "Task retry has missing or duplicate original tool call identities");
    }
    if (action.effectId != null && !/^[a-f0-9]{64}$/.test(action.effectId)) {
      throw effectError("effect_retry_binding_ambiguous", "Task retry has an invalid original effect identity");
    }
    seenCalls.add(action.toolCallId);
    return Object.freeze({ ...action });
  });
  return channelPostRetryStorage.run({
    context: Object.freeze({
      agentId: context.agentId,
      sessionIdentity: context.sessionIdentity?.trim() || null,
      actions: Object.freeze(actions),
    }),
    bindings: new Map(),
    nextAction: 0,
    beforeDispatch: context.beforeDispatch,
    dispatchPrepared: false,
  }, callback);
}

function effectError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
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
  /** Trusted engine binding only; channel tool parameters must never supply this. */
  logicalActionId?: string;
  channelId: string;
  content: string;
  lookupReceipt: (effectId: string, receiptToken: string) => { timestamp: string; sender: string } | null;
  send: (effectId: string, receiptToken: string) => Promise<{ timestamp: string; replayed?: boolean }>;
}

function resolveChannelPostEffectIdentity(input: ChannelPostEffectInput, argsDigest: string) {
  if (!input.toolCallId?.trim()) throw new Error("channel.post requires a stable tool call ID");
  const retry = channelPostRetryStorage.getStore();
  if (!retry) {
    return {
      effectId: channelPostOperationKey(input.agentId, input.toolCallId, input.sessionIdentity, input.logicalActionId),
      sourceToolCallId: input.toolCallId,
      logicalActionId: input.logicalActionId,
      isRetry: false,
    };
  }
  if (retry.context.agentId !== input.agentId || retry.context.sessionIdentity !== (input.sessionIdentity?.trim() || null)) {
    throw effectError("effect_retry_scope_mismatch", "Task retry effect binding belongs to a different agent or session");
  }
  prepareChannelPostRetryDispatch(input.agentId, input.sessionIdentity);
  const existingBinding = retry.bindings.get(input.toolCallId);
  const action = existingBinding || retry.context.actions[retry.nextAction];
  if (!action) {
    throw effectError("effect_retry_unbound", "Task retry cannot create an additional channel post; request a new operation explicitly");
  }
  const effectId = action.effectId || channelPostOperationKey(input.agentId, action.toolCallId, input.sessionIdentity, action.logicalActionId);
  const record = input.ledger.read(effectId);
  // The original action may have been interrupted before the model received its
  // result. Consult the durable ledger even if no effect ID was in that result.
  // A missing receipt record is never evidence that repeating the send is safe.
  if (!record) {
    throw effectError("effect_retry_record_missing", "Task retry cannot establish the original channel post identity from its ledger");
  }
  if (record.argsDigest !== argsDigest || (action.argsDigest && action.argsDigest !== argsDigest)) {
    throw effectError("effect_identity_conflict", "Task retry channel post differs from the next original logical action");
  }
  if ((action.logicalActionId && action.logicalActionId !== record.logicalActionId)
    || (input.logicalActionId && input.logicalActionId !== record.logicalActionId)) {
    throw effectError("effect_identity_conflict", "Task retry logical action identity differs from its original ledger record");
  }
  if (!existingBinding) {
    retry.bindings.set(input.toolCallId, action);
    retry.nextAction += 1;
  }
  return { effectId, sourceToolCallId: action.toolCallId, logicalActionId: record.logicalActionId, isRetry: true };
}

/** One in-process runner per logical action; the channel marker is the persisted receipt. */
export async function runChannelPostEffect(input: ChannelPostEffectInput): Promise<{ record: EffectRecord; sentNow: boolean }> {
  // appendMessage persists the trimmed body. This digest checks arguments only;
  // it must not collapse separate intentional operations with identical content.
  const argsDigest = digestEffectInput([input.channelId, input.agentId, input.content.trim()]);
  const { effectId, sourceToolCallId, logicalActionId, isRetry } = resolveChannelPostEffectIdentity(input, argsDigest);
  const previous = effectLocks.get(effectId) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    let record = input.ledger.read(effectId);
    if (isRetry && !record) {
      throw effectError("effect_retry_record_missing", "Original channel post ledger record disappeared before retry execution");
    }
    if (record && record.argsDigest !== argsDigest) {
      throw Object.assign(new Error("Tool call ID reused with different channel.post arguments"), { code: "effect_identity_conflict" });
    }
    // A record written before session-scoped keys cannot be assigned safely to
    // any one of several sessions with the same tool-call ID. Preserve it and
    // block a new send instead of silently treating its absence at the new key
    // as proof that this action has never run.
    if (!record && !logicalActionId && input.sessionIdentity?.trim()) {
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
      ...(logicalActionId ? { logicalActionId } : {}),
      taskId: record?.taskId || `tool:${sourceToolCallId}`,
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
