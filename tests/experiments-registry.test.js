import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";
import {
  CACHE_SNAPSHOT_EXPERIMENT_ID,
  getExperimentDefinitions,
  getResolvedExperimentValue,
  setExperimentValue,
} from "../lib/experiments/registry.js";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-experiments-"));
  const userDir = path.join(root, "user");
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "preferences.json"), "{}\n");
  return { root, prefs: new PreferencesManager({ userDir, agentsDir }) };
}

describe("experiment registry", () => {
  it("defines cache snapshot as a paired-toggle enum defaulting to off", () => {
    const defs = getExperimentDefinitions();
    const entry = defs.find((def) => def.id === CACHE_SNAPSHOT_EXPERIMENT_ID);

    expect(entry).toMatchObject({
      id: CACHE_SNAPSHOT_EXPERIMENT_ID,
      owner: "memory",
      scope: "global",
      defaultValue: "off",
      valueSchema: {
        type: "enum",
        presentation: { type: "paired_toggles" },
      },
    });
    expect(entry.valueSchema.options.map((opt) => opt.value)).toEqual(["off", "shadow", "write"]);
  });

  it("rejects unknown experiment ids without writing preferences", () => {
    const { prefs } = makePrefs();

    expect(() => setExperimentValue(prefs, "unknown.flag", true)).toThrow("unknown experiment id");
    expect(prefs.getPreferences().experiments).toBeUndefined();
  });

  it("persists and resolves valid global enum values", () => {
    const { prefs } = makePrefs();

    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
    expect(setExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID, "shadow")).toBe("shadow");
    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("shadow");
    expect(prefs.getPreferences().experiments[CACHE_SNAPSHOT_EXPERIMENT_ID]).toBe("shadow");
  });

  it("rejects invalid enum values", () => {
    const { prefs } = makePrefs();

    expect(() => setExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID, "maybe")).toThrow("invalid experiment value");
    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
  });
});
