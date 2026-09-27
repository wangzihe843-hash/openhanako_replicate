export interface CompanionTaskStatus {
  taskId: string;
  status: string;
  updatedAt: number;
}

export interface CompanionTaskChange extends CompanionTaskStatus {
  sequence: number;
}

export interface CompanionStatusResponse {
  sequence: number;
  serverTime: number;
  tasks: CompanionTaskStatus[];
  changes: CompanionTaskChange[];
}

export type CompanionState = 'idle' | 'busy' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'canceled' | 'unavailable';
export type CompanionTerminalState = Extract<CompanionState, 'completed' | 'failed' | 'canceled'>;

/** A short feedback is only justified by a real task terminal transition. */
export function latestCompanionTerminalChange(changes: readonly CompanionTaskChange[], now: number): CompanionTaskChange | null {
  // cancel() records an abort followed by canceled; take the last transition per task.
  const latestByTask = new Map<string, CompanionTaskChange>();
  for (const change of changes) {
    if (!Number.isSafeInteger(change.sequence) || !Number.isFinite(change.updatedAt)) continue;
    if (now - change.updatedAt > 8000 || change.updatedAt - now > 2000) continue;
    const previous = latestByTask.get(change.taskId);
    if (!previous || change.sequence > previous.sequence) latestByTask.set(change.taskId, change);
  }
  return [...latestByTask.values()]
    .filter((change) => ['completed', 'failed', 'canceled', 'aborted'].includes(change.status))
    .sort((a, b) => b.sequence - a.sequence)[0] ?? null;
}

export function terminalCompanionState(status: string): CompanionTerminalState | null {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'canceled' || status === 'aborted') return 'canceled';
  return null;
}

export function resolveCompanionState(input: {
  tasks: readonly CompanionTaskStatus[];
  streaming: boolean;
  awaitingApproval: boolean;
  inlineError: boolean;
  feedback: CompanionTerminalState | null;
  unavailable: boolean;
}): CompanionState {
  if (input.awaitingApproval) return 'waiting';
  if (input.tasks.some((task) => task.status === 'blocked')) return 'blocked';
  if (input.tasks.some((task) => task.status === 'paused' || task.status === 'recovering')) return 'waiting';
  if (input.feedback) return input.feedback;
  if (input.inlineError) return 'failed';
  if (input.tasks.some((task) => task.status === 'pending' || task.status === 'running') || input.streaming) return 'busy';
  if (input.unavailable) return 'unavailable';
  return 'idle';
}
