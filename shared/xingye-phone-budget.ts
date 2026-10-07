export const PHONE_AI_MAX_ATTEMPTS = 3;
export const PHONE_AI_TRANSPORT_MARGIN_MS = 5_000;

export function normalizePhoneAiTimeout(value: unknown): number {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0
    ? Math.min(Math.max(Math.floor(timeout), 30_000), 120_000)
    : 60_000;
}

/** Legacy callers only promise to wait for one attempt's budget. */
export function normalizePhoneAiTotalTimeout(attemptTimeoutMs: number, value: unknown): number {
  const total = Number(value);
  return Number.isFinite(total) && total > 0
    ? Math.min(Math.max(Math.floor(total), 1), attemptTimeoutMs * PHONE_AI_MAX_ATTEMPTS)
    : attemptTimeoutMs;
}
