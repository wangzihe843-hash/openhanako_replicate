import type { createAgentSession } from "../lib/pi-sdk/index.ts";

/** SDK types stay behind the Pi adapter, including extension-owned result details. */
type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
export type RuntimeCompactionResult = Awaited<ReturnType<PiSession["compact"]>>;

export interface RuntimeAgentIdentity {
  readonly id: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly runtimeInitialized: boolean;
}

/** Returning true means cancellation was requested/released, not provider exit proof. */
export type SessionAbortRequest = string | { reason?: string };
export interface SessionCancellation {
  abort(options?: SessionAbortRequest): Promise<boolean>;
  abortSession(sessionPath: string, options?: SessionAbortRequest): Promise<boolean>;
  abortSessionByPath(sessionPath: string, options?: SessionAbortRequest): Promise<boolean>;
  abortAllStreaming(): Promise<number>;
}

export interface CompactionRuntime<Result = RuntimeCompactionResult> {
  compact(customInstructions?: string): Promise<Result>;
  extensionRunner?: {
    hasHandlers?(event: "session_before_compact"): boolean;
  } | null;
  readonly isCompacting?: boolean;
  getContextUsage?(): { tokens: number | null; contextWindow: number } | undefined;
}

export interface CompactionRecoveryDependencies<Result> {
  session: CompactionRuntime<Result>;
  sessionPath: string;
  customInstructions?: string;
  reloadSessionRuntime?: (sessionPath: string) => Promise<CompactionRuntime<Result> | null | undefined>;
  onRuntimeReload?: (event: { error: unknown; session: CompactionRuntime<Result> }) => void | Promise<void>;
}

export interface CompactionRecoveryOutcome<Result> {
  result: Result;
  session: CompactionRuntime<Result>;
  recovered: boolean;
}
