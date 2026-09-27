import { SettingsManager } from "../lib/pi-sdk/index.ts";

/** 默认 session settings */
export function createDefaultSettings() {
  return SettingsManager.inMemory({
    steeringMode: "all",
    // Pi 0.86+ defaults to paid background cache warming during tool runs.
    // Keep Hana's existing request/billing behavior until explicitly supported.
    cacheWarming: "off",
    compaction: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20_000,
    },
  });
}
