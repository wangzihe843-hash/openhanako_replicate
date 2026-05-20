import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);

const {
  applyGpuStartupPolicy,
  markGpuStartupFailed,
  markGpuStartupPending,
  markGpuStartupReady,
  recordGpuChildProcessGone,
  resolveGpuStartupPolicy,
} = require("../desktop/src/shared/gpu-startup-policy.cjs");

let root;

function makeHome() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-gpu-policy-"));
  return root;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writePrefs(hanakoHome, prefs) {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
}

function readPrefs(hanakoHome) {
  try {
    return readJson(path.join(hanakoHome, "user", "preferences.json"));
  } catch {
    return {};
  }
}

describe("desktop GPU startup policy", () => {
  beforeEach(() => {
    root = null;
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps hardware acceleration enabled by default", () => {
    const hanakoHome = makeHome();

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldDisableHardwareAcceleration).toBe(false);
    expect(policy.reason).toBe("default");
  });

  it("honors the user hardware acceleration preference", () => {
    const hanakoHome = makeHome();
    writePrefs(hanakoHome, { hardware_acceleration: false });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(false);
    expect(policy.shouldDisableHardwareAcceleration).toBe(true);
    expect(policy.reason).toBe("preference");
  });

  it("turns on safe mode on Windows after an incomplete early startup", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "launching-splash",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    expect(policy.hardwareAccelerationEnabled).toBe(false);
    expect(policy.reason).toBe("previous-startup-incomplete");
    expect(readPrefs(hanakoHome).hardware_acceleration).toBeUndefined();
    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.autoGpuMode).toMatchObject({
      mode: "software-safe",
      reason: "previous-startup-incomplete",
    });
  });

  it("does not auto-disable hardware acceleration for non-Windows stale startup markers", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "darwin",
      phase: "launching-splash",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "darwin",
      argv: ["Hanako"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldDisableHardwareAcceleration).toBe(false);
  });

  it("records GPU child process crashes as next-launch safe mode", () => {
    const hanakoHome = makeHome();

    recordGpuChildProcessGone({
      hanakoHome,
      platform: "win32",
      details: { type: "GPU", reason: "crashed", exitCode: -2147483645 },
      now: "2026-05-19T01:02:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(false);
    expect(policy.reason).toBe("gpu-child-process-gone");
    expect(policy.mode).toBe("software-safe");
    expect(readPrefs(hanakoHome).hardware_acceleration).toBeUndefined();
  });

  it("escalates a software-safe GPU crash to deep compatibility without changing the user preference", () => {
    const hanakoHome = makeHome();
    writePrefs(hanakoHome, { hardware_acceleration: false });
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    recordGpuChildProcessGone({
      hanakoHome,
      platform: "win32",
      policy,
      details: { type: "GPU", reason: "crashed", exitCode: -2147483645 },
      now: "2026-05-19T01:02:00.000Z",
    });

    const nextPolicy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(nextPolicy.hardwareAccelerationEnabled).toBe(false);
    expect(nextPolicy.mode).toBe("deep-compat");
    expect(nextPolicy.shouldApplyDeepCompatSwitches).toBe(true);
    expect(readPrefs(hanakoHome).hardware_acceleration).toBe(false);
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode: "deep-compat",
      reason: "gpu-child-process-gone",
      previousMode: "software-safe",
    });
  });

  it("clears the pending marker when startup reaches app-ready", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "launching-splash",
      startupId: "launch-1",
    });

    markGpuStartupReady({
      hanakoHome,
      platform: "win32",
      startupId: "launch-1",
      phase: "app-ready",
    });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.startup.status).toBe("ready");
    expect(state.startup.phase).toBe("app-ready");
  });

  it("marks startup failures without converting them into GPU safe mode", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "server-starting",
      startupId: "launch-1",
    });
    markGpuStartupFailed({
      hanakoHome,
      platform: "win32",
      startupId: "launch-1",
      reason: "server-start-failed",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.reason).toBe("default");
  });

  it("uses Electron's hardware acceleration API without unsafe GPU fallback switches", () => {
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    };

    applyGpuStartupPolicy(app, {
      shouldDisableHardwareAcceleration: true,
      reason: "preference",
    });

    expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(1);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-software-rasterizer", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-gpu-sandbox", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox", expect.anything());
  });

  it("applies deep compatibility switches without disabling software rasterizer or sandbox", () => {
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    };

    applyGpuStartupPolicy(app, {
      shouldDisableHardwareAcceleration: true,
      shouldApplyDeepCompatSwitches: true,
      mode: "deep-compat",
      reason: "gpu-child-process-gone",
    });

    expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(1);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-compositing");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-rasterization");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-software-rasterizer", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-gpu-sandbox", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox", expect.anything());
  });
});
