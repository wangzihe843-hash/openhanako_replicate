export const COMPACTION_MODE_EXPERIMENT_ID = "session.compaction_mode";

export const COMPACTION_MODES = Object.freeze({
  AUTO: "auto",
  CACHE_PRESERVING: "cache_preserving",
  PI_COMPATIBLE: "pi_compatible",
});

const KNOWN_COMPACTION_MODES = new Set(Object.values(COMPACTION_MODES));

export function normalizeCompactionMode(value) {
  const mode = typeof value === "string" ? value : "";
  return KNOWN_COMPACTION_MODES.has(mode) ? mode : COMPACTION_MODES.AUTO;
}

export function getResolvedCompactionMode(preferencesManager) {
  return normalizeCompactionMode(
    preferencesManager?.getExperimentValue?.(COMPACTION_MODE_EXPERIMENT_ID),
  );
}
