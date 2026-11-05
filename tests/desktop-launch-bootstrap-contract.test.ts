import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const bootstrapPath = path.join(root, "desktop", "bootstrap.cjs");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

const tmpHomesToCleanup = [];

afterEach(() => {
  while (tmpHomesToCleanup.length > 0) {
    const dir = tmpHomesToCleanup.pop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function bootstrapHomeSeenByMain(packaged: boolean, configured: boolean, redirect = false, useCwdAlias = false) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bootstrap-home-"));
  tmpHomesToCleanup.push(tmpHome);
  const input = ["nested", "..", "selected-home"].join(path.sep);
  const cwd = useCwdAlias ? path.join(tmpHome, "cwd-alias") : tmpHome;
  if (useCwdAlias) fs.symlinkSync(tmpHome, cwd, process.platform === "win32" ? "junction" : "dir");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
  delete env.HANA_HOME;
  if (configured) env.HANA_HOME = input;

  // Compile the repository's actual bootstrap source in a child process.
  // Electron and the desktop main are the boundaries, so this observes the
  // environment at the instant the selected main would be loaded.
  const driver = `
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const initialCwd = process.cwd();
const filename = ${JSON.stringify(bootstrapPath)};
let source = fs.readFileSync(filename, "utf8");
if (${JSON.stringify(redirect)}) {
  const target = "process.env.HANA_HOME = hanakoHome;";
  if (source.split(target).length !== 2) throw new Error("home forwarding target changed");
  source = source.replace(target, 'process.env.HANA_HOME = path.join(hanakoHome, "redirected");');
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === filename) {
    if (request === "electron") return { app: { isPackaged: ${JSON.stringify(packaged)}, exit() {} }, dialog: { showErrorBox() {} } };
    if (request === "./src/shared/windows-system-ca.cjs") return { enableWindowsSystemCaForCurrentProcess() {} };
    if (request === "./src/shared/launch-integrity.cjs") return {
      appendLaunchLog() {}, writeLaunchDiagnostic() {}, checkWindowsInstallSurface() { return { ok: true }; },
    };
    if (request === "./src/office-pdf-helper.cjs") return { isOfficePdfHelperInvocation() { return false; } };
    if (request === "./main.cjs" || request === "./main.bundle.cjs") {
      process.stdout.write(JSON.stringify({ request, home: process.env.HANA_HOME, initialCwd }));
      return {};
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const bootstrap = new Module(filename, module);
bootstrap.filename = filename;
bootstrap.paths = Module._nodeModulePaths(path.dirname(filename));
bootstrap._compile(source, filename);
`;
  const result = spawnSync(process.execPath, ["-e", driver], {
    cwd, env, windowsHide: true, encoding: "utf-8", timeout: 15000,
  });
  expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
  const { initialCwd, ...observed } = JSON.parse(result.stdout);
  // A child may report the physical spelling of cwd rather than its symlink.
  // Verify it is the requested directory before using it to resolve relative input.
  expect(fs.realpathSync(initialCwd)).toBe(fs.realpathSync(tmpHome));
  const expectedHome = configured ? path.resolve(initialCwd, input) : path.join(tmpHome, ".hanako");
  return { expectedHome, observed };
}

function expectForwardedHome(observed: unknown, packaged: boolean, home: string) {
  expect(observed).toEqual({ request: packaged ? "./main.bundle.cjs" : "./main.cjs", home });
}

describe("desktop launch bootstrap contract", () => {
  it("routes dev and packaged Electron through the pre-main bootstrap", () => {
    expect(packageJson.main).toBe("desktop/bootstrap.cjs");
    expect(packageJson.build?.extraMetadata?.main).toBe("desktop/bootstrap.cjs");
    expect(packageJson.build?.files).toContain("desktop/bootstrap.cjs");
    expect(packageJson.build?.files).toContain("desktop/src/shared/launch-integrity.cjs");
    expect(packageJson.build?.files).toContain("desktop/src/shared/windows-system-ca.cjs");
    expect(packageJson.build?.files).toContain("shared/hana-runtime-paths.cjs");
    expect(packageJson.build?.files).toContain("desktop/main.bundle.cjs");
  });

  it.each([false, true])("passes the resolved configured or default home to desktop main (packaged=%s)", packaged => {
    for (const configured of [false, true]) {
      const { expectedHome, observed } = bootstrapHomeSeenByMain(packaged, configured);
      expectForwardedHome(observed, packaged, expectedHome);
    }
  });

  it.each([false, true])("resolves a relative home from a directory link (packaged=%s)", packaged => {
    const { expectedHome, observed } = bootstrapHomeSeenByMain(packaged, true, false, true);
    expectForwardedHome(observed, packaged, expectedHome);
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "rejects a redirected home (packaged=%s, configured=%s)", (packaged, configured) => {
      const { expectedHome, observed } = bootstrapHomeSeenByMain(packaged, configured, true, true);
      expectForwardedHome(observed, packaged, path.join(expectedHome, "redirected"));
      expect(() => expectForwardedHome(observed, packaged, expectedHome)).toThrow();
    },
  );

  it("bootstrap.cjs registers process diagnostics before loading the main bundle (subprocess behavior test)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bootstrap-behavior-"));
    tmpHomesToCleanup.push(tmpHome);
    const driverPath = path.join(tmpHome, "driver.cjs");

    const driverSource = `
const path = require("node:path");
const Module = require("node:module");
const REPO_ROOT = ${JSON.stringify(root)};

const fakeApp = {
  isPackaged: false,
  exit: () => {},
};
const fakeDialog = {
  showErrorBox: () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: fakeApp, dialog: fakeDialog };
  if (request === "./main.cjs" || request === "./main.bundle.cjs") return {};
  return originalLoad.call(this, request, parent, isMain);
};

require(path.join(REPO_ROOT, "desktop", "bootstrap.cjs"));

// Verify the uncaughtException listener was registered as a side effect.
process.emit("uncaughtException", new Error("driver-injected"));

// Give synchronous writes a brief buffer (writes are sync, but be defensive).
setTimeout(() => process.exit(0), 100);
`;

    fs.writeFileSync(driverPath, driverSource, "utf-8");

    const result = spawnSync(process.execPath, [driverPath], {
      env: { ...process.env, HANA_HOME: tmpHome },
      windowsHide: true,
      encoding: "utf-8",
      timeout: 15000,
    });

    expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

    const diagnosticsDir = path.join(tmpHome, "diagnostics", "desktop-launch");
    const markerPath = path.join(diagnosticsDir, "launch-marker.json");
    expect(
      fs.existsSync(markerPath),
      `marker not written; stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    ).toBe(true);

    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    expect(marker.event).toBe("launch-marker");
    // The marker file is overwritten on each writeLaunchMarker call as bootstrap
    // progresses through stages (bootstrap-started -> main-load-started -> main-loaded);
    // the final status proves the whole pre-main sequence executed without crashing.
    const knownStatuses = new Set([
      "bootstrap-started",
      "main-load-started",
      "main-loaded",
      "desktop-main-load-failed",
      "install-surface-check-failed",
    ]);
    expect(knownStatuses.has(String(marker.payload?.status))).toBe(true);

    // launch.log is append-only; its presence + bootstrap-loaded entry proves that
    // writeLaunchMarker("bootstrap-started") fired earlier in the same module load
    // (loadDesktopMain only runs after the bootstrap-started marker is written).
    const launchLogPath = path.join(diagnosticsDir, "launch.log");
    expect(
      fs.existsSync(launchLogPath),
      `launch.log not written; stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    ).toBe(true);
    const launchLogEntries = fs
      .readFileSync(launchLogPath, "utf-8")
      .split("\n")
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
    const events = launchLogEntries.map(entry => entry.event);
    expect(events).toContain("bootstrap-loaded");

    // Verify the uncaughtException listener was registered as a side effect of
    // requiring bootstrap.cjs — the driver emits a synthetic error after require
    // and we expect bootstrap's handler to have written the diagnostic to disk.
    const uncaughtPath = path.join(diagnosticsDir, "uncaughtException.json");
    expect(
      fs.existsSync(uncaughtPath),
      `uncaughtException diagnostic not written; stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    ).toBe(true);
    const uncaught = JSON.parse(fs.readFileSync(uncaughtPath, "utf-8"));
    expect(uncaught.payload?.error?.message).toBe("driver-injected");
    expect(events).toContain("uncaughtException");
  });

  it("enables Windows system CAs before loading Electron or the full desktop main", () => {
    const source = fs.readFileSync(bootstrapPath, "utf-8");
    const enableIndex = source.indexOf("enableWindowsSystemCaForCurrentProcess();");
    const electronIndex = source.indexOf('require("electron")');
    const mainIndex = source.indexOf("loadDesktopMain();");

    expect(enableIndex).toBeGreaterThan(-1);
    expect(electronIndex).toBeGreaterThan(enableIndex);
    expect(mainIndex).toBeGreaterThan(enableIndex);
  });

  it.each([false, true])("reports profile refusal and stops without GUI or later work (stderr unavailable=%s)", brokenStderr => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-profile-refusal-"));
    tmpHomesToCleanup.push(tmpHome);
    const driverPath = path.join(tmpHome, "driver.cjs");
    fs.writeFileSync(driverPath, `
const Module = require('node:module');
const fs = require('node:fs');
if (${JSON.stringify(brokenStderr)}) {
  const originalWrite = fs.writeSync;
  fs.writeSync = (fd, ...args) => {
    if (fd === 2) throw Object.assign(new Error('synthetic broken stderr'), { code: 'EPIPE' });
    return originalWrite(fd, ...args);
  };
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: false, exit: () => {} }, dialog: {
    showErrorBox: () => { process.stdout.write('UNEXPECTED_GUI'); }
  } };
  if (request === './main.cjs') throw Object.assign(new Error('Synthetic desktop profile stopped. Use --hana-new-isolated-desktop-profile; browser logins are not inherited.'), { code: 'HANA_DESKTOP_PROFILE_STARTUP' });
  return originalLoad.call(this, request, parent, isMain);
};
require(${JSON.stringify(bootstrapPath)});
process.stdout.write('UNEXPECTED_CONTINUE');
`);
    const result = spawnSync(process.execPath, [driverPath], {
      env: { ...process.env, HANA_HOME: tmpHome }, encoding: "utf8", timeout: 15000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    if (!brokenStderr) {
      expect(result.stderr).toContain("--hana-new-isolated-desktop-profile");
      expect(result.stderr).toContain("browser logins are not inherited");
    }
    const diagnostics = path.join(tmpHome, "diagnostics", "desktop-launch");
    const failure = JSON.parse(fs.readFileSync(path.join(diagnostics, "desktop-main-load-failed.json"), "utf8"));
    expect(failure.payload.error.code).toBe("HANA_DESKTOP_PROFILE_STARTUP");
    expect(failure.payload.error.message).toContain("--hana-new-isolated-desktop-profile");
    expect(JSON.parse(fs.readFileSync(path.join(diagnostics, "launch-marker.json"), "utf8")).payload.status).toBe("desktop-main-load-failed");
  });
});
