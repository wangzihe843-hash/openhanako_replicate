export declare const COMPACTION_MODE_EXPERIMENT_ID: "session.compaction_mode";

export declare const COMPACTION_MODES: Readonly<{
  AUTO: "auto";
  CACHE_PRESERVING: "cache_preserving";
  PI_COMPATIBLE: "pi_compatible";
}>;

export type CompactionMode =
  | typeof COMPACTION_MODES.AUTO
  | typeof COMPACTION_MODES.CACHE_PRESERVING
  | typeof COMPACTION_MODES.PI_COMPATIBLE;

export declare function normalizeCompactionMode(value: unknown): CompactionMode;

export declare function getResolvedCompactionMode(preferencesManager: unknown): CompactionMode;
