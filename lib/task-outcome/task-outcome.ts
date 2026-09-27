/** Evidence-based presentation projection. This module does not schedule work. */

export type GoalResult = "verified" | "partial" | "failed" | "unverified";
export type TaskLifecycle = "pending" | "running" | "paused" | "blocked" | "recovering" | "completed" | "failed" | "canceled" | "aborted" | "unknown";

export interface TaskOutcome {
  taskId: string;
  revision: 1;
  kind: "channel_post" | "web_read" | "workflow" | "task";
  lifecycle: TaskLifecycle;
  goalResult: GoalResult;
  goalScope: string;
  actions: Array<{ id: string; label: string; status: string }>;
  evidence: Array<{
    kind: string;
    reference: string;
    status: string;
    sourceUrl?: string;
    sender?: string;
    contentHash?: string;
    returnedCharacters?: number;
    missingReasons?: string[];
    timestamp?: string | number;
  }>;
  pendingDecisions: string[];
  updatedAt?: number;
}

export interface PublicChannelEffect {
  effectId: string;
  status: "prepared" | "committed" | "failed" | "unknown";
  attempts: number;
  receipt?: { channel: string; timestamp: string; sender: string };
  errorCode?: string;
}

export function projectChannelPostOutcome(effect: PublicChannelEffect): TaskOutcome | null {
  if (!effect || !/^[a-f0-9]{64}$/.test(effect.effectId)) return null;
  const hasReceipt = effect.status === "committed"
    && !!effect.receipt?.channel && !!effect.receipt?.timestamp && !!effect.receipt?.sender;
  const lifecycle: TaskLifecycle = effect.status === "committed" ? "completed"
    : effect.status === "failed" ? "failed"
    : effect.status === "prepared" ? "running" : "unknown";
  const goalResult: GoalResult = hasReceipt ? "verified"
    : effect.status === "failed" ? "failed" : "unverified";
  return {
    taskId: `effect:${effect.effectId}`,
    revision: 1,
    kind: "channel_post",
    lifecycle,
    goalResult,
    goalScope: "local_channel_append",
    actions: [{ id: effect.effectId, label: "channel.post", status: effect.status }],
    evidence: hasReceipt ? [{
      kind: "channel_receipt",
      reference: effect.receipt!.channel,
      status: "confirmed",
      sender: effect.receipt!.sender,
      timestamp: effect.receipt!.timestamp,
    }] : [],
    pendingDecisions: effect.status === "unknown" || (effect.status === "committed" && !hasReceipt)
      ? ["inspect_channel_receipt"] : [],
  };
}

export interface WebReadEvidence {
  status: "complete" | "partial" | "failed";
  scope: "single_response_text";
  sourceUrl: string;
  resolvedUrl?: string;
  responseTextHash?: string;
  outputTextHash?: string;
  returnedCharacters?: number;
  missingReasons: string[];
}

export function projectWebReadOutcome(toolCallId: string, read: WebReadEvidence): TaskOutcome | null {
  if (!toolCallId?.trim() || !read || read.scope !== "single_response_text" || typeof read.sourceUrl !== "string") return null;
  const missingReasons = Array.isArray(read.missingReasons)
    ? read.missingReasons.filter((reason): reason is string => typeof reason === "string").slice(0, 20) : [];
  const hasTextReceipt = /^sha256:[a-f0-9]{64}$/.test(read.outputTextHash || "")
    && /^sha256:[a-f0-9]{64}$/.test(read.responseTextHash || "")
    && Number.isSafeInteger(read.returnedCharacters) && (read.returnedCharacters || 0) > 0;
  const goalResult: GoalResult = read.status === "failed" ? "failed"
    : read.status === "partial" ? "partial"
    : read.status === "complete" && hasTextReceipt && missingReasons.length === 0 ? "verified" : "unverified";
  const lifecycle: TaskLifecycle = read.status === "failed" ? "failed" : "completed";
  return {
    taskId: `tool:${toolCallId}`,
    revision: 1,
    kind: "web_read",
    lifecycle,
    goalResult,
    goalScope: "single_response_text",
    actions: [{ id: toolCallId, label: "web_fetch", status: read.status }],
    evidence: [{
      kind: "read_coverage",
      reference: read.resolvedUrl || read.sourceUrl,
      sourceUrl: read.sourceUrl,
      status: read.status,
      ...(read.outputTextHash ? { contentHash: read.outputTextHash } : {}),
      ...(Number.isSafeInteger(read.returnedCharacters) ? { returnedCharacters: read.returnedCharacters } : {}),
      missingReasons,
    }],
    pendingDecisions: read.status === "partial" ? ["review_missing_coverage"]
      : goalResult === "unverified" ? ["inspect_read_evidence"] : [],
  };
}

export interface RegistryTaskRecord {
  taskId: string;
  type?: string;
  status: string;
  updatedAt?: number;
}

/** TaskRegistry completion is execution lifecycle only; model result text is not proof of the user's goal. */
export function projectRegistryTaskOutcome(task: RegistryTaskRecord): TaskOutcome | null {
  if (!task?.taskId || !task.status) return null;
  const statuses = new Set<TaskLifecycle>(["pending", "running", "paused", "blocked", "recovering", "completed", "failed", "canceled", "aborted"]);
  const lifecycle = statuses.has(task.status as TaskLifecycle) ? task.status as TaskLifecycle : "unknown";
  return {
    taskId: task.taskId,
    revision: 1,
    kind: task.type === "workflow" ? "workflow" : "task",
    lifecycle,
    goalResult: lifecycle === "failed" ? "failed" : "unverified",
    goalScope: "requested_goal",
    actions: [{ id: task.taskId, label: task.type || "task", status: lifecycle }],
    evidence: [{ kind: "task_registry", reference: task.taskId, status: lifecycle, ...(task.updatedAt ? { timestamp: task.updatedAt } : {}) }],
    pendingDecisions: lifecycle === "completed" ? ["verify_goal_artifacts"] : [],
    ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
  };
}
