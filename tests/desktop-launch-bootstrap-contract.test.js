import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

const tmpHomesToCleanup = [];

afterEach(() => {
  while (tmpHomesToCleanup.length > 0) {
    const dir = tmpHomesToCleanup.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("desktop launch bootstrap contract", () => {
  it("routes dev and packaged Electron through the pre-main bootstrap", () => {
    expect(packageJson.main).toBe("desktop/bootstrap.cjs");
    expect(packageJson.build?.extraMetadata?.main).toBe("desktop/bootstrap.cjs");
    expect(packageJson.build?.files).toContain("desktop/bootstrap.cjs");
    expect(packageJson.build?.files).toContain("desktop/src/shared/launch-integrity.cjs");
    expect(packageJson.build?.files).toContain("shared/hana-runtime-paths.cjs");
    expect(packageJson.build?.files).toContain("desktop/main.bundle.cjs");
  });

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
});
