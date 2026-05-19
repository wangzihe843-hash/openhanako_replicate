const fs = require("fs");
const path = require("path");

const STATE_VERSION = 1;
const STATE_FILE = path.join("user", "gpu-startup.json");
const PREFERENCES_FILE = path.join("user", "preferences.json");
const EARLY_STARTUP_PHASES = new Set([
  "electron-starting",
  "launching-splash",
]);
const GPU_FAILURE_REASONS = new Set([
  "abnormal-exit",
  "crashed",
  "integrity-failure",
  "launch-failed",
  "oom",
]);

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}

function readJson(filePath, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function getGpuStartupStatePath(hanakoHome) {
  return path.join(hanakoHome, STATE_FILE);
}

function getPreferencesPath(hanakoHome) {
  return path.join(hanakoHome, PREFERENCES_FILE);
}

function readState(hanakoHome) {
  return readJson(getGpuStartupStatePath(hanakoHome), { version: STATE_VERSION });
}

function writeState(hanakoHome, state) {
  writeJson(getGpuStartupStatePath(hanakoHome), {
    ...state,
    version: STATE_VERSION,
  });
}

function readPreferences(hanakoHome) {
  return readJson(getPreferencesPath(hanakoHome), {});
}

function writePreferences(hanakoHome, prefs) {
  writeJson(getPreferencesPath(hanakoHome), prefs);
}

function boolFromSetting(value, defaultValue) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
    if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
  }
  return defaultValue;
}

function hasArg(argv, name) {
  const prefix = `--${name}`;
  return (argv || []).some((arg) => arg === prefix || String(arg).startsWith(`${prefix}=`));
}

function isExplicitSafeMode(argv, env) {
  if (boolFromSetting(env?.HANA_GPU_SAFE_MODE, false)) return true;
  if (boolFromSetting(env?.HANA_DISABLE_HARDWARE_ACCELERATION, false)) return true;
  return hasArg(argv, "hana-gpu-safe-mode") || hasArg(argv, "hana-disable-hardware-acceleration");
}

function persistHardwareAccelerationPreference(hanakoHome, enabled) {
  const prefs = readPreferences(hanakoHome);
  prefs.hardware_acceleration = !!enabled;
  writePreferences(hanakoHome, prefs);
}

function isEarlyIncompleteStartup(state) {
  const startup = state?.startup;
  if (!startup || startup.status !== "pending") return false;
  return EARLY_STARTUP_PHASES.has(startup.phase || "electron-starting");
}

function resolveGpuStartupPolicy({
  hanakoHome,
  platform = process.platform,
  argv = process.argv,
  env = process.env,
  now,
} = {}) {
  if (!hanakoHome) throw new Error("resolveGpuStartupPolicy requires hanakoHome");

  const prefs = readPreferences(hanakoHome);
  const explicitSafeMode = isExplicitSafeMode(argv, env);
  if (explicitSafeMode) {
    return {
      hardwareAccelerationEnabled: false,
      shouldDisableHardwareAcceleration: true,
      reason: "explicit",
    };
  }

  const preferenceEnabled = boolFromSetting(prefs.hardware_acceleration, true);
  if (!preferenceEnabled) {
    return {
      hardwareAccelerationEnabled: false,
      shouldDisableHardwareAcceleration: true,
      reason: "preference",
    };
  }

  const state = readState(hanakoHome);
  if (platform === "win32" && isEarlyIncompleteStartup(state)) {
    const timestamp = nowIso(now);
    persistHardwareAccelerationPreference(hanakoHome, false);
    writeState(hanakoHome, {
      ...state,
      safeMode: {
        enabled: true,
        reason: "previous-startup-incomplete",
        previousStartup: state.startup,
        updatedAt: timestamp,
      },
    });
    return {
      hardwareAccelerationEnabled: false,
      shouldDisableHardwareAcceleration: true,
      reason: "previous-startup-incomplete",
    };
  }

  return {
    hardwareAccelerationEnabled: true,
    shouldDisableHardwareAcceleration: false,
    reason: "default",
  };
}

function applyGpuStartupPolicy(app, policy) {
  if (policy?.shouldDisableHardwareAcceleration && typeof app?.disableHardwareAcceleration === "function") {
    app.disableHardwareAcceleration();
    return { applied: true };
  }
  return { applied: false };
}

function markGpuStartupPending({
  hanakoHome,
  platform = process.platform,
  phase = "electron-starting",
  startupId = `${Date.now()}-${process.pid}`,
  now,
} = {}) {
  if (!hanakoHome) throw new Error("markGpuStartupPending requires hanakoHome");
  const timestamp = nowIso(now);
  const state = readState(hanakoHome);
  const next = {
    ...state,
    startup: {
      status: "pending",
      startupId,
      phase,
      platform,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
  writeState(hanakoHome, next);
  return next.startup;
}

function markGpuStartupPhase({
  hanakoHome,
  platform = process.platform,
  phase,
  startupId,
  now,
} = {}) {
  if (!hanakoHome || !phase) return null;
  const state = readState(hanakoHome);
  if (!state.startup || state.startup.status !== "pending") return null;
  if (startupId && state.startup.startupId && state.startup.startupId !== startupId) return null;
  const timestamp = nowIso(now);
  state.startup = {
    ...state.startup,
    startupId: startupId || state.startup.startupId,
    platform,
    phase,
    updatedAt: timestamp,
  };
  writeState(hanakoHome, state);
  return state.startup;
}

function markGpuStartupReady({
  hanakoHome,
  platform = process.platform,
  phase = "app-ready",
  startupId,
  now,
} = {}) {
  if (!hanakoHome) throw new Error("markGpuStartupReady requires hanakoHome");
  const state = readState(hanakoHome);
  const timestamp = nowIso(now);
  state.startup = {
    ...(state.startup || {}),
    status: "ready",
    startupId: startupId || state.startup?.startupId,
    phase,
    platform,
    readyAt: timestamp,
    updatedAt: timestamp,
  };
  writeState(hanakoHome, state);
  return state.startup;
}

function markGpuStartupFailed({
  hanakoHome,
  platform = process.platform,
  reason,
  startupId,
  now,
} = {}) {
  if (!hanakoHome) throw new Error("markGpuStartupFailed requires hanakoHome");
  const state = readState(hanakoHome);
  const timestamp = nowIso(now);
  state.startup = {
    ...(state.startup || {}),
    status: "failed",
    startupId: startupId || state.startup?.startupId,
    platform,
    reason: reason || "startup-failed",
    failedAt: timestamp,
    updatedAt: timestamp,
  };
  writeState(hanakoHome, state);
  return state.startup;
}

function sanitizeGpuDetails(details = {}) {
  return {
    type: details.type || "Unknown",
    reason: details.reason || "unknown",
    exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
    serviceName: details.serviceName || "",
    name: details.name || "",
  };
}

function isGpuChildProcessFailure(details = {}) {
  return details.type === "GPU" && GPU_FAILURE_REASONS.has(details.reason || "unknown");
}

function recordGpuChildProcessGone({
  hanakoHome,
  platform = process.platform,
  details,
  now,
} = {}) {
  if (!hanakoHome || !isGpuChildProcessFailure(details)) return false;
  const timestamp = nowIso(now);
  const crash = {
    ...sanitizeGpuDetails(details),
    platform,
    at: timestamp,
  };
  const state = readState(hanakoHome);
  writeState(hanakoHome, {
    ...state,
    safeMode: {
      enabled: true,
      reason: "gpu-child-process-gone",
      updatedAt: timestamp,
    },
    lastGpuCrash: crash,
  });
  persistHardwareAccelerationPreference(hanakoHome, false);
  return true;
}

function recordGpuInfoUpdate({
  hanakoHome,
  platform = process.platform,
  featureStatus,
  now,
} = {}) {
  if (!hanakoHome || !featureStatus || typeof featureStatus !== "object") return false;
  const state = readState(hanakoHome);
  writeState(hanakoHome, {
    ...state,
    lastGpuFeatureStatus: {
      platform,
      at: nowIso(now),
      featureStatus,
    },
  });
  return true;
}

function buildGpuStartupDiagnostics({ hanakoHome, policy, app } = {}) {
  const items = [
    ``,
    `--- GPU Startup ---`,
    `Hardware acceleration preference: ${readPreferences(hanakoHome).hardware_acceleration ?? "default"}`,
    `Startup policy: ${policy?.reason || "unknown"}`,
    `Hardware acceleration enabled by policy: ${policy?.hardwareAccelerationEnabled !== false}`,
  ];
  try {
    if (app && typeof app.isHardwareAccelerationEnabled === "function") {
      items.push(`Electron hardware acceleration enabled: ${app.isHardwareAccelerationEnabled()}`);
    }
  } catch {}
  try {
    if (app && typeof app.getGPUFeatureStatus === "function") {
      items.push(`GPU feature status: ${JSON.stringify(app.getGPUFeatureStatus())}`);
    }
  } catch {}
  const state = readState(hanakoHome);
  if (state.startup) items.push(`GPU startup marker: ${JSON.stringify(state.startup)}`);
  if (state.safeMode) items.push(`GPU safe mode: ${JSON.stringify(state.safeMode)}`);
  if (state.lastGpuCrash) items.push(`Last GPU crash: ${JSON.stringify(state.lastGpuCrash)}`);
  if (state.lastGpuFeatureStatus) {
    items.push(`Last GPU feature status: ${JSON.stringify(state.lastGpuFeatureStatus)}`);
  }
  return items.join("\n");
}

module.exports = {
  applyGpuStartupPolicy,
  buildGpuStartupDiagnostics,
  getGpuStartupStatePath,
  getPreferencesPath,
  markGpuStartupFailed,
  markGpuStartupPending,
  markGpuStartupPhase,
  markGpuStartupReady,
  recordGpuChildProcessGone,
  recordGpuInfoUpdate,
  resolveGpuStartupPolicy,
};
