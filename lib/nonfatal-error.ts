import { createModuleLogger } from "./debug-log.ts";
import { redactLogText } from "./log-redactor.ts";

const log = createModuleLogger("runtime-warning");

/** Report a recoverable failure without replacing the operation's primary result. */
export function reportNonfatalError(operation: string, error: unknown): void {
  try {
    const rawMessage: unknown = error instanceof Error ? error.message : error;
    const message = typeof rawMessage === "string" ? rawMessage : "Non-Error failure";
    log.warn(redactLogText(`${operation}: ${message}`));
  } catch {
    // A broken diagnostic sink must not interrupt teardown or mask the original failure.
  }
}
