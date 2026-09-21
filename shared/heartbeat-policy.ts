/** Quiet hours use the server's local clock, just like heartbeat scheduling. */
export type HeartbeatQuietHours = { enabled: boolean; start: string; end: string };

export function isHeartbeatTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function heartbeatQuietReason(value: unknown, now = new Date()): string | null {
  if (!value || typeof value !== "object") return null;
  const quiet = value as Partial<HeartbeatQuietHours>;
  if (quiet.enabled !== true) return null;
  // Invalid enabled settings must not accidentally enable unsolicited activity.
  if (!isHeartbeatTime(quiet.start) || !isHeartbeatTime(quiet.end) || quiet.start === quiet.end) {
    return "invalid-quiet-hours";
  }
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  const current = now.getHours() * 60 + now.getMinutes();
  return (start < end ? current >= start && current < end : current >= start || current < end)
    ? "quiet-hours" : null;
}
