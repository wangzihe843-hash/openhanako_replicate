import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");

const {
  applyGpuStartupPolicy,
  markGpuStartupPending,
  markGpuStartupPhase,
  resolveGpuStartupPolicy,
} = require("../desktop/src/shared/gpu-startup-policy.cjs");

function makeFakeApp() {
  const switches = [];
  let hwAccelDisabled = false;
  return {
    commandLine: {
      appendSwitch: (name, value) => switches.push([name, value]),
      hasSwitch: () => false,
      getSwitchValue: () => "",
    },
    disableHardwareAcceleration: () => {
      hwAccelDisabled = true;
    },
    isHardwareAccelerationEnabled: () => !hwAccelDisabled,
    getGPUFeatureStatus: () => ({}),
    _switches: switches,
    _isHwAccelDisabled: () => hwAccelDisabled,
  };
}

let tmpHome = null;

function makeTmpHome() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-gpu-policy-"));
  fs.mkdirSync(path.join(tmpHome, "user"), { recursive: true });
  return tmpHome;
}

function readStartupState(hanakoHome) {
  return JSON.parse(
    fs.readFileSync(path.join(hanakoHome, "user", "gpu-startup.json"), "utf-8"),
  );
}

describe("desktop main GPU startup contract", () => {
  afterEach(() => {
    if (tmpHome) {
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {}
      tmpHome = null;
    }
  });

  it("applies GPU startup policy before Electron ready", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    const applyIndex = source.indexOf("applyGpuStartupPolicy(app, gpuStartupPolicy");
    const pendingIndex = source.indexOf("markGpuStartupPending({");
    const readyIndex = source.indexOf("app.whenReady()");

    expect(applyIndex).toBeGreaterThan(-1);
    expect(pendingIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeLessThan(readyIndex);
    expect(pendingIndex).toBeLessThan(readyIndex);
  });

  it("records the active GPU policy in the pending startup marker", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const pendingIndex = source.indexOf("markGpuStartupPending({");
    const pendingCall = source.slice(pendingIndex, source.indexOf("});", pendingIndex) + 3);

    expect(pendingIndex).toBeGreaterThan(-1);
    expect(pendingCall).toContain("policy: gpuStartupPolicy");
  });

  it("records splash phases before server phases through the shared startup marker", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const splashReadyIndex = source.indexOf('phase: "splash-ready"');
    const serverStartingIndex = source.indexOf('phase: "server-starting"');
    const serverReadyIndex = source.indexOf('phase: "server-ready"');

    expect(splashReadyIndex).toBeGreaterThan(-1);
    expect(serverStartingIndex).toBeGreaterThan(-1);
    expect(serverReadyIndex).toBeGreaterThan(-1);
    expect(splashReadyIndex).toBeLessThan(serverStartingIndex);
    expect(serverStartingIndex).toBeLessThan(serverReadyIndex);

    for (const phaseIndex of [splashReadyIndex, serverStartingIndex, serverReadyIndex]) {
      const callStart = source.lastIndexOf("markGpuStartupPhase({", phaseIndex);
      const phaseCall = source.slice(callStart, source.indexOf("});", phaseIndex) + 3);

      expect(callStart).toBeGreaterThan(-1);
      expect(phaseCall).toContain("startupId: desktopStartupId");
    }
  });

  it("records Windows window-starting phases before BrowserWindow creation can fail", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const mainStartingIndex = source.indexOf('phase: "main-window-starting"');
    const mainCreateIndex = source.indexOf("createMainWindow();");
    const mainCreatedIndex = source.indexOf('phase: "main-window-created"');
    const onboardingStartingIndex = source.indexOf('phase: "onboarding-window-starting"');
    const onboardingCreateIndex = source.indexOf('createOnboardingWindow({ skipToTutorial: "1" });');
    const onboardingCreatedIndex = source.indexOf('phase: "onboarding-window-created"');

    expect(mainStartingIndex).toBeGreaterThan(-1);
    expect(mainCreateIndex).toBeGreaterThan(-1);
    expect(mainCreatedIndex).toBeGreaterThan(-1);
    expect(mainStartingIndex).toBeLessThan(mainCreateIndex);
    expect(mainCreateIndex).toBeLessThan(mainCreatedIndex);
    expect(onboardingStartingIndex).toBeGreaterThan(-1);
    expect(onboardingCreateIndex).toBeGreaterThan(-1);
    expect(onboardingCreatedIndex).toBeGreaterThan(-1);
    expect(onboardingStartingIndex).toBeLessThan(onboardingCreateIndex);
    expect(onboardingCreateIndex).toBeLessThan(onboardingCreatedIndex);
  });

  it("creates the main BrowserWindow through the Windows diagnostic wrapper", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const helperIndex = source.indexOf("function createBrowserWindowWithDiagnostics");
    const mainCreateIndex = source.indexOf('createBrowserWindowWithDiagnostics("main", opts, { windowsMinimalRetry: true })');
    const directCreateIndex = source.indexOf("mainWindow = new BrowserWindow(opts)");

    expect(helperIndex).toBeGreaterThan(-1);
    expect(mainCreateIndex).toBeGreaterThan(helperIndex);
    expect(directCreateIndex).toBe(-1);
  });

  it("listens for GPU child process exits instead of deprecated GPU crash hooks", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain('app.on("child-process-gone"');
    expect(source).not.toContain("gpu-process-crashed");
  });

  it("does not bake unsafe GPU recovery switches into startup", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).not.toContain("disable-software-rasterizer");
    expect(source).not.toContain("disable-gpu-sandbox");
    expect(source).not.toContain("no-sandbox");
  });

  it("default GPU policy does not request unsafe Chrome switches", () => {
    const hanakoHome = makeTmpHome();
    const fakeApp = makeFakeApp();

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: [],
      env: {},
    });
    applyGpuStartupPolicy(fakeApp, policy);

    const switchNames = fakeApp._switches.map(([name]) => name);
    const forbidden = [
      "no-sandbox",
      "disable-software-rasterizer",
      "disable-gpu",
      "disable-gpu-compositing",
      "disable-gpu-rasterization",
    ];
    for (const forbiddenSwitch of forbidden) {
      expect(switchNames).not.toContain(forbiddenSwitch);
    }
    expect(fakeApp._isHwAccelDisabled()).toBe(false);
  });

  it("only appends --no-sandbox when policy explicitly opts in via shouldApplyUnsafeNoSandboxSwitch", () => {
    const fakeApp = makeFakeApp();

    // Equivalent to policyForMode(GPU_MODE_GPU_SANDBOX_COMPAT, "explicit-unsafe-no-sandbox",
    //   { shouldApplyUnsafeNoSandboxSwitch: true }) produced by resolveGpuStartupPolicy
    // when HANA_GPU_UNSAFE_NO_SANDBOX is set.
    const unsafePolicy = {
      mode: "gpu-sandbox-compat",
      reason: "explicit-unsafe-no-sandbox",
      hardwareAccelerationEnabled: true,
      shouldDisableHardwareAcceleration: false,
      shouldApplyGpuSandboxCompatSwitches: true,
      shouldApplyGpuBackendCompatSwitches: false,
      shouldApplyDeepCompatSwitches: false,
      shouldApplyUnsafeNoSandboxSwitch: true,
    };

    const result = applyGpuStartupPolicy(fakeApp, unsafePolicy);

    expect(result.unsafeNoSandbox).toBe(true);
    expect(fakeApp._switches).toContainEqual(["no-sandbox", undefined]);
  });

  it("markGpuStartupPhase appends startup phases in order to the GPU startup state file", () => {
    const hanakoHome = makeTmpHome();
    const startupId = "s1";

    markGpuStartupPending({
      hanakoHome,
      phase: "electron-starting",
      startupId,
      policy: {},
    });
    expect(readStartupState(hanakoHome).startup.phase).toBe("electron-starting");

    markGpuStartupPhase({ hanakoHome, phase: "splash-ready", startupId });
    expect(readStartupState(hanakoHome).startup.phase).toBe("splash-ready");

    markGpuStartupPhase({ hanakoHome, phase: "server-starting", startupId });
    expect(readStartupState(hanakoHome).startup.phase).toBe("server-starting");

    markGpuStartupPhase({ hanakoHome, phase: "server-ready", startupId });
    const finalState = readStartupState(hanakoHome).startup;
    expect(finalState.phase).toBe("server-ready");
    expect(finalState.status).toBe("pending");
    expect(finalState.startupId).toBe(startupId);
  });
});
