import {
  cloneExperiment,
  normalizeExperimentDefinition,
  normalizeExperimentValue,
} from "../../shared/experiments-schema.js";

export const CACHE_SNAPSHOT_EXPERIMENT_ID = "memory.cache_snapshot_reflection";

const DEFINITIONS = [
  normalizeExperimentDefinition({
    id: CACHE_SNAPSHOT_EXPERIMENT_ID,
    titleKey: "settings.experiments.cacheSnapshot.title",
    descriptionKey: "settings.experiments.cacheSnapshot.description",
    owner: "memory",
    scope: "global",
    defaultValue: "off",
    valueSchema: {
      type: "enum",
      presentation: {
        type: "paired_toggles",
        mapping: {
          mainOff: "off",
          mainOnObserveOn: "shadow",
          mainOnObserveOff: "write",
        },
      },
      options: [
        { value: "off", labelKey: "settings.experiments.cacheSnapshot.off" },
        { value: "shadow", labelKey: "settings.experiments.cacheSnapshot.shadow" },
        { value: "write", labelKey: "settings.experiments.cacheSnapshot.write" },
      ],
    },
    status: "beta",
    risk: "medium",
    restartPolicy: "new_session",
    targetHome: {
      tab: "agent",
      section: "memory",
      whenStable: "Move to Agent / Memory after cache hit and summary quality stabilize.",
    },
    exitCriteria: [
      "Shadow previews match legacy memory quality for normal sessions.",
      "Write mode records cache hit telemetry without hurting normal chat cache.",
      "Fallbacks are visible in health and usage logs.",
    ],
    sunsetPolicy: {
      removeWhenRetired: true,
      migration: "Read old experiment value for one release after moving to Agent / Memory.",
    },
  }),
];

const DEFINITIONS_BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

export function getExperimentDefinitions() {
  return DEFINITIONS.map(cloneExperiment);
}

export function getExperimentDefinition(id) {
  const definition = DEFINITIONS_BY_ID.get(id);
  return definition ? cloneExperiment(definition) : null;
}

function requireDefinition(id) {
  const definition = DEFINITIONS_BY_ID.get(id);
  if (!definition) throw new Error(`unknown experiment id: ${id}`);
  return definition;
}

export function getResolvedExperimentValue(preferencesManager, id) {
  const definition = requireDefinition(id);
  const stored = preferencesManager?.getExperimentValue?.(id);
  if (stored === undefined) return definition.defaultValue;
  try {
    return normalizeExperimentValue(definition, stored);
  } catch {
    return definition.defaultValue;
  }
}

export function setExperimentValue(preferencesManager, id, value) {
  const definition = requireDefinition(id);
  if (definition.scope !== "global") {
    throw new Error(`experiment ${id} requires ${definition.scope} scope`);
  }
  if (!preferencesManager || typeof preferencesManager.setExperimentValue !== "function") {
    throw new Error("preferences manager is required");
  }
  const normalized = normalizeExperimentValue(definition, value);
  preferencesManager.setExperimentValue(id, normalized);
  return normalized;
}

export function listResolvedExperiments(preferencesManager) {
  return DEFINITIONS.map((definition) => ({
    ...cloneExperiment(definition),
    value: getResolvedExperimentValue(preferencesManager, definition.id),
  }));
}
