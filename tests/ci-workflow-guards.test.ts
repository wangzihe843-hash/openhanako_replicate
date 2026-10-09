import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * tests/ci-workflow-guards.test.ts — 静态断言"边界/构建守卫已接进 CI 工作流"
 *
 * 这不是测试守卫脚本本身（lint-open-boundary.mjs / verify-seed-kit.mjs 各自
 * 有自己的单测），而是测试"工作流 YAML 有没有把它们接上"。动机：这类接线
 * 一旦被后续改动（比如重构 job、精简步骤）无意间删掉，CI 本身不会报错——
 * 少了一个校验步骤只会让流水线更快地"通过"，不会让它变红。这份测试把"工作
 * 流必须包含这些守卫步骤"这件事，从"运维记忆"变成一个会失败的断言。
 *
 * 解析用 js-yaml（仓库已有依赖，见 package.json dependencies），不新增依赖。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_YAML_PATH = path.join(ROOT, ".github", "workflows", "ci.yml");
const BUILD_YAML_PATH = path.join(ROOT, ".github", "workflows", "build.yml");
const NATIVE_EVIDENCE_IF = "always() && runner.os == 'Windows'";
const NATIVE_UPLOAD_IF = `${NATIVE_EVIDENCE_IF} && steps.native_auth_lock.outcome != 'skipped' && steps.native_auth_lock.outcome != ''`;

interface WorkflowStep {
  name?: string;
  run?: string;
  if?: string;
  [key: string]: unknown;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
  [key: string]: unknown;
}

interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>;
  [key: string]: unknown;
}

function loadWorkflow(filePath: string): WorkflowDoc {
  const text = fs.readFileSync(filePath, "utf-8");
  // js-yaml 4 uses YAML 1.2, so the Actions `on:` key stays a string.
  return yaml.load(text) as WorkflowDoc;
}

function stepRun(step: WorkflowStep): string {
  return typeof step.run === "string" ? step.run : "";
}

describe("fork workflow safety", () => {
  const ci = loadWorkflow(CI_YAML_PATH);
  const build = loadWorkflow(BUILD_YAML_PATH);

  it("checks the exact acceptance branch and feature pushes with the existing platform coverage", () => {
    expect(ci.on).toEqual({
      push: { branches: ["main", "feature/xingye-mvp", "review/ci22-integration-20261009"] },
      pull_request: { branches: ["main"] },
    });
    expect(ci.concurrency).toEqual({
      group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    });
    expect(Object.keys(ci.jobs).sort()).toEqual(["lint-open-boundary", "open-build-smoke", "test", "windows-auth-lock-native"]);
    expect(ci.jobs.test["runs-on"]).toBe("${{ matrix.os }}");
    expect(ci.jobs.test.strategy).toEqual({
      "fail-fast": false,
      matrix: { os: ["macos-latest", "windows-2022"], "node-version": ["24.15.0"] },
    });
    for (const name of ["lint-open-boundary", "open-build-smoke"]) {
      expect(ci.jobs[name]?.["runs-on"]).toBe("ubuntu-latest");
    }
  });

  it.each([
    ["main", true],
    ["feature/xingye-mvp", true],
    ["review/ci22-integration-20261009", true],
    ["feature/unrelated", false],
    ["feature/xingye-mvp-extra", false],
    ["main-extra", false],
    ["fix/ci22-macos-electron-init-20261009", false],
    ["review/xingye-ci-publish-prep-20261009", false],
    ["review/ci-smoke-20261009", false],
    ["review/ci22-other-20261009", false],
    ["review/ci22-integration", false],
    ["review/ci22-integration-20261010", false],
    ["review/ci22-integration-20261009-extra", false],
    ["review/ci22-integration-20261009/nested", false],
    ["review/CI22-integration-20261009", false],
    ["other/review/ci22-integration-20261009", false],
  ])("matches push branch %s only when explicitly allowed (%s)", (branch, expected) => {
    const events = ci.on as { push: { branches: string[] } };
    // The trigger assertion above pins literal names, so no glob emulation is needed.
    expect(events.push.branches.includes(branch)).toBe(expected);
  });

  it("uses the triggering commit for every checkout without a ref input or secrets", () => {
    for (const [name, job] of Object.entries(ci.jobs)) {
      const checkouts = (job.steps ?? []).filter((step) => String(step.uses).startsWith("actions/checkout@"));
      expect(checkouts).toEqual([{ uses: ["test", "windows-auth-lock-native"].includes(name) ? "actions/checkout@v5" : "actions/checkout@v4" }]);
    }
    expect(JSON.stringify(ci)).not.toContain("inputs.");
    expect(JSON.stringify(ci)).not.toContain("secrets.");
  });

  it("collects all platform results and propagates every gate failure, including CSP diagnostics", () => {
    for (const job of Object.values(ci.jobs)) {
      expect(job.if).toBeUndefined();
      expect(job.needs).toBeUndefined();
      expect(job["continue-on-error"] ?? false).toBe(false);
      for (const step of job.steps ?? []) {
        expect(step["continue-on-error"] ?? false).toBe(false);
        if (step.name === "Preserve native Windows auth lock evidence") {
          expect(step.if).toBe(NATIVE_UPLOAD_IF);
          expect(step.uses).toBe("actions/upload-artifact@v4");
        } else if (step.name === "Check native Windows auth lock evidence") {
          expect(step.if).toBe(NATIVE_EVIDENCE_IF);
        } else {
          expect([undefined, "runner.os == 'macOS'", "runner.os == 'Windows'", "always()"]).toContain(step.if);
        }
      }
    }
  });

  it("runs the complete test suite and all shared gates without branch-based skips", () => {
    const requiredRuns = {
      test: ["npm run typecheck", "npm run lint:warnings", "npm run build:packages", "npm run build:client", "npm test"],
      "lint-open-boundary": ["node scripts/lint-open-boundary.mjs"],
      "open-build-smoke": ["npm run build:server:open", "npm run smoke:server:open"],
    };
    for (const [jobName, commands] of Object.entries(requiredRuns)) {
      for (const command of commands) {
        const steps = ci.jobs[jobName].steps?.filter((step) => stepRun(step) === command) ?? [];
        expect(steps, `${jobName}: ${command}`).toHaveLength(1);
        expect(steps[0].if).toBeUndefined();
      }
    }
  });

  it.each([
    ["build.yml", "release"],
    ["build.yml", "publish-train"],
    ["build.yml", "mirror-atomgit"],
    ["publish-train.yml", "publish-train"],
    ["mirror-release-to-atomgit.yml", "mirror"],
  ])("keeps publishing entry %s/%s unconditionally disabled", (file, jobName) => {
    const doc = loadWorkflow(path.join(ROOT, ".github", "workflows", file));
    expect(doc.jobs[jobName]?.if).toBe("${{ false }}");
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.jobs[jobName]?.permissions ?? doc.permissions).toEqual({ contents: "read" });
  });

  it("gives all three serial typechecks a bounded heap budget only in their CI step", () => {
    const steps = ci.jobs.test.steps ?? [];
    const typecheck = steps.filter((step) => step.name === "Typecheck");
    expect(typecheck).toHaveLength(1);
    expect(stepRun(typecheck[0])).toBe("npm run typecheck");
    expect(typecheck[0].env).toEqual({ NODE_OPTIONS: "--max-old-space-size=4096" });
    expect(typecheck[0].if).toBeUndefined();
    expect(typecheck[0]["continue-on-error"] ?? false).toBe(false);
    expect(ci.env ?? {}).not.toHaveProperty("NODE_OPTIONS");
    expect(ci.jobs.test.env ?? {}).not.toHaveProperty("NODE_OPTIONS");
    for (const step of steps.filter((step) => step.name !== "Typecheck")) {
      expect(step.env ?? {}).not.toHaveProperty("NODE_OPTIONS");
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.typecheck).toBe(
      "tsc --noEmit && tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.test.json",
    );
  });

  it("grants only contents read in every CI/build job, including dormant publishers", () => {
    for (const doc of [ci, build]) {
      expect(doc.permissions).toEqual({ contents: "read" });
      for (const job of Object.values(doc.jobs)) {
        expect(job.permissions ?? doc.permissions).toEqual({ contents: "read" });
      }
    }
  });

  it("installs the locked Electron binary before macOS renderer tests", () => {
    const steps = ci.jobs.test.steps ?? [];
    const installIndex = steps.findIndex((step) => stepRun(step) === "npm ci");
    const electronIndex = steps.findIndex((step) => step.name === "Install Electron binary for macOS renderer tests");
    const testIndex = steps.findIndex((step) => stepRun(step) === "npm test");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(electronIndex).toBeGreaterThan(installIndex);
    expect(testIndex).toBeGreaterThan(electronIndex);
    expect(steps[electronIndex]).toEqual({
      name: "Install Electron binary for macOS renderer tests",
      if: "runner.os == 'macOS'",
      run: "node node_modules/electron/install.js",
    });
  });

  it("keeps npm ci lifecycle scripts and uses the VS 2022 runner for the locked compiler fallback", () => {
    const steps = ci.jobs.test.steps ?? [];
    expect(steps.filter((step) => step.name === "Install dependencies")).toEqual([
      { name: "Install dependencies", run: "npm ci" },
    ]);
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    expect(lock.packages["node_modules/node-gyp"].version).toBe("11.5.0");
    expect(lock.packages["node_modules/better-sqlite3"].version).toBe("12.6.2");
    expect(JSON.stringify(ci.jobs.test)).not.toMatch(/ignore-scripts|continue-on-error|npm_config_build_from_source/);
  });

  it("retains every Windows native, desktop and packaged-server gate on the pinned runner", () => {
    const steps = ci.jobs.test.steps ?? [];
    for (const command of [
      "node scripts/build-windows-sandbox-helper.mjs x64",
      "node scripts/smoke-windows-sandbox-helper.mjs x64",
      "node scripts/smoke-desktop-main-pet.cjs",
      "node scripts/download-mingit.js",
      "node scripts/build-server.mjs win32 x64",
      "node scripts/smoke-full-server.mjs",
      "node scripts/build-standalone-server-artifact.mjs x64",
      "node scripts/verify-standalone-server-artifact.mjs x64 --smoke",
    ]) {
      const matches = steps.filter(step => stepRun(step) === command);
      expect(matches).toHaveLength(1);
      expect(matches[0].if).toBe("runner.os == 'Windows'");
    }
  });

  it("runs native Windows auth A/B in an independent strict job after npm ci", () => {
    const job = ci.jobs["windows-auth-lock-native"];
    expect(job["runs-on"]).toBe("windows-2022");
    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    const steps = job.steps ?? [];
    expect(steps.find(step => step.uses === "actions/setup-node@v5")?.with)
      .toEqual({ "node-version": "24.15.0", cache: "npm" });
    const installIndex = steps.findIndex((step) => stepRun(step) === "npm ci");
    const probeIndex = steps.findIndex((step) => stepRun(step) === "node scripts/probe-windows-auth-lock.mjs");
    expect(probeIndex).toBeGreaterThan(installIndex);
    expect(steps[probeIndex]).toEqual({
      name: "Probe native Windows auth lock delete-pending recovery",
      id: "native_auth_lock",
      if: "runner.os == 'Windows'",
      "timeout-minutes": 5,
      run: "node scripts/probe-windows-auth-lock.mjs",
    });
    expect(steps[probeIndex + 1]).toEqual({
      name: "Check native Windows auth lock evidence",
      if: NATIVE_EVIDENCE_IF,
      env: { NATIVE_AUTH_LOCK_OUTCOME: "${{ steps.native_auth_lock.outcome }}" },
      run: "node scripts/check-windows-auth-lock-evidence.mjs",
    });
    expect(steps[probeIndex + 2]).toEqual({
      name: "Preserve native Windows auth lock evidence",
      if: NATIVE_UPLOAD_IF,
      uses: "actions/upload-artifact@v4",
      with: {
        name: "windows-auth-lock-native-windows-2022",
        path: "output/windows-auth-lock-native/",
        "if-no-files-found": "error",
      },
    });
    expect(steps.at(-1)).toBe(steps[probeIndex + 2]);
    // No needs edge in either direction; no continue-on-error in either job.
    // The full Windows gates are unchanged and can run even if this job fails.
    expect(ci.jobs.test.needs).toBeUndefined();
    expect(JSON.stringify(ci.jobs.test)).not.toContain("native_auth_lock");
    expect(ci.jobs.test.steps?.find(step => stepRun(step) === "npm test")?.if).toBeUndefined();
  });

  it.each([
    ["Windows", "skipped", true, false], // npm ci failed: report not-run, no nonexistent upload.
    ["Windows", "", true, false],
    ["Windows", "success", true, true],
    ["Windows", "failure", true, true],
    ["Windows", "cancelled", true, true],
    ["macOS", "skipped", false, false],
    ["Linux", "skipped", false, false],
  ])("collects native evidence for %s / %s without assuming prior success", (os, outcome, check, upload) => {
    const steps = ci.jobs["windows-auth-lock-native"].steps ?? [];
    // These pinned expressions use only the shared JS/Actions boolean subset.
    const context = { always: () => true, runner: { os }, steps: { native_auth_lock: { outcome } } };
    expect(runInNewContext(steps.find(step => step.name === "Check native Windows auth lock evidence")!.if!, context)).toBe(check);
    expect(runInNewContext(steps.find(step => step.name === "Preserve native Windows auth lock evidence")!.if!, context)).toBe(upload);
  });

  it("keeps tag/manual builds and all four installer targets without enabling Release", () => {
    expect(build.on).toEqual({ push: { tags: ["v*"] }, workflow_dispatch: null });
    expect(build.concurrency).toEqual({
      group: "${{ github.workflow }}-${{ github.ref }}",
      "cancel-in-progress": false,
    });
    expect(build.jobs.build).toMatchObject({
      needs: "renderer-box",
      strategy: { matrix: { include: [
        { os: "macos-latest", target: "dmg", arch: "arm64" },
        { os: "macos-latest", target: "dmg", arch: "x64" },
        { os: "windows-latest", target: "nsis", arch: "x64" },
        { os: "ubuntu-latest", target: "AppImage", arch: "x64" },
      ] } },
    });
    expect(build.jobs.release?.if).toBe("${{ false }}");
    for (const job of [build.jobs["renderer-box"], build.jobs.build]) {
      expect(job.if).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain("secrets.");
    }
    const installers = (build.jobs.build.steps ?? []).filter((s) => stepRun(s).includes("npx electron-builder"));
    expect(installers).toHaveLength(3);
    for (const step of installers) expect(stepRun(step)).toContain("--publish never");
    expect(build.jobs.build.env).toMatchObject({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      SKIP_NOTARIZE: "true",
    });
  });

  it("generates a matching ephemeral seed keyset before bundling the desktop verifier", () => {
    const steps = build.jobs.build.steps ?? [];
    const keyIndex = steps.findIndex((s) => s.name === "Prepare ephemeral seed signing key");
    const clientIndex = steps.findIndex((s) => stepRun(s).includes("npm run build:client"));
    const serverIndex = steps.findIndex((s) => stepRun(s).includes("node scripts/build-server.mjs"));
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    expect(clientIndex).toBeGreaterThan(keyIndex);
    expect(serverIndex).toBeGreaterThan(clientIndex);
    expect(stepRun(steps[keyIndex])).toContain("node scripts/artifact-keygen.mjs");
    expect(stepRun(steps[keyIndex])).toContain("HANA_SIGN_KEY=$RUNNER_TEMP/hana-build-sign-key.pem");
    expect(stepRun(steps[keyIndex])).toContain("HANA_SIGN_KEYSET=$RUNNER_TEMP/hana-build-keyset.json");
    const cleanup = steps.find((s) => s.name === "Remove ephemeral private key");
    expect(cleanup?.if).toBe("always()");
    expect(stepRun(cleanup ?? {})).toContain('rm -f "$RUNNER_TEMP/hana-build-sign-key.pem"');
  });
});

describe("ci.yml: open composition build+smoke guard is wired", () => {
  const doc = loadWorkflow(CI_YAML_PATH);

  it("defines an open-build-smoke job", () => {
    expect(doc.jobs).toHaveProperty("open-build-smoke");
  });

  it("the open-build-smoke job builds and smoke-tests the open composition server", () => {
    const job = doc.jobs["open-build-smoke"];
    expect(job).toBeDefined();
    const steps = job.steps ?? [];
    expect(steps.some((s) => stepRun(s).includes("build:server:open"))).toBe(true);
    expect(steps.some((s) => stepRun(s).includes("smoke:server:open"))).toBe(true);
  });

  it("defines a lint-open-boundary job that runs the boundary lint script", () => {
    const job = doc.jobs["lint-open-boundary"];
    expect(job).toBeDefined();
    const steps = job?.steps ?? [];
    expect(steps.some((s) => stepRun(s).includes("scripts/lint-open-boundary.mjs"))).toBe(true);
  });
});

describe("ci.yml: Windows restricted-token helper is exercised before release builds", () => {
  const doc = loadWorkflow(CI_YAML_PATH);

  it("builds and runs the native helper smoke in the Windows test matrix", () => {
    const steps = doc.jobs.test?.steps ?? [];
    const buildIndex = steps.findIndex((step) => stepRun(step).includes("build-windows-sandbox-helper.mjs"));
    const smokeIndex = steps.findIndex((step) => stepRun(step).includes("smoke-windows-sandbox-helper.mjs"));

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(smokeIndex).toBeGreaterThan(buildIndex);
    expect(steps[buildIndex]?.if).toBe("runner.os == 'Windows'");
    expect(steps[smokeIndex]?.if).toBe("runner.os == 'Windows'");
  });

  it("builds and smoke-verifies the extracted standalone package with an ephemeral CI keyset", () => {
    const steps = doc.jobs.test?.steps ?? [];
    const rendererIndex = steps.findIndex((step) => stepRun(step).includes("build:renderer"));
    const keyIndex = steps.findIndex((step) => step.name === "Prepare ephemeral signing key for Windows standalone smoke");
    const minGitIndex = steps.findIndex((step) => stepRun(step).includes("scripts/download-mingit.js"));
    const serverIndex = steps.findIndex((step) => stepRun(step).includes("scripts/build-server.mjs win32 x64"));
    const packIndex = steps.findIndex((step) => stepRun(step).includes("scripts/build-standalone-server-artifact.mjs x64"));
    const verifyIndex = steps.findIndex((step) => stepRun(step).includes("scripts/verify-standalone-server-artifact.mjs x64 --smoke"));

    expect(keyIndex).toBeGreaterThan(rendererIndex);
    expect(minGitIndex).toBeGreaterThan(keyIndex);
    expect(serverIndex).toBeGreaterThan(minGitIndex);
    expect(packIndex).toBeGreaterThan(serverIndex);
    expect(verifyIndex).toBeGreaterThan(packIndex);
    for (const index of [keyIndex, minGitIndex, serverIndex, packIndex, verifyIndex]) {
      expect(steps[index]?.if).toBe("runner.os == 'Windows'");
    }
    expect(stepRun(steps[keyIndex])).toContain("$RUNNER_TEMP/hana-ci-sign-key.pem");
    expect(stepRun(steps[keyIndex])).toContain("HANA_SIGN_KEYSET=$RUNNER_TEMP/hana-ci-keyset.json");
    expect(stepRun(steps[keyIndex])).not.toContain("secrets.HANA_SIGN_KEY");
  });
});

describe("build.yml: seed kit verification precedes every electron-builder invocation", () => {
  const doc = loadWorkflow(BUILD_YAML_PATH);

  it("every job step that invokes electron-builder is preceded, within the same job, by a matching verify-seed-kit step", () => {
    const jobsWithElectronBuilder: string[] = [];

    for (const [jobName, job] of Object.entries(doc.jobs)) {
      const steps = job.steps ?? [];
      steps.forEach((step, index) => {
        // Match the actual invocation ("npx electron-builder"), not a bare "electron-builder"
        // substring — several steps in this file carry that word inside `run:` block-scalar
        // shell comments (e.g. the keychain setup step explaining why CSC_KEYCHAIN is exported
        // for electron-builder to reuse), which would otherwise false-positive here.
        if (!stepRun(step).includes("npx electron-builder")) return;
        jobsWithElectronBuilder.push(jobName);

        const precedingSteps = steps.slice(0, index);
        // The verify step must also gate on the same "if" condition as the electron-builder
        // step it guards — otherwise (e.g. three verify-seed-kit steps for three different
        // platforms all sitting earlier in the same steps array) an unrelated platform's
        // verify step could satisfy a naive "any preceding verify-seed-kit step exists"
        // check while this platform's build runs completely unguarded.
        const guard = precedingSteps.find(
          (s) => stepRun(s).includes("verify-seed-kit.mjs") && s.if === step.if,
        );
        expect(
          guard,
          `job "${jobName}" step "${step.name}" (if: ${step.if}) calls electron-builder ` +
            `without a preceding verify-seed-kit.mjs step gated on the same "if" condition`,
        ).toBeDefined();
      });
    }

    // Sanity: this test would be vacuously true if build.yml stopped invoking
    // electron-builder anywhere at all. Pin down that we actually found the
    // three known platform build steps, so a refactor that removes them all
    // gets caught by this assertion changing rather than by silence.
    expect(jobsWithElectronBuilder.length).toBeGreaterThanOrEqual(3);
  });
});

describe("build.yml: Windows standalone server stays outside the seed/OTA boundary", () => {
  const doc = loadWorkflow(BUILD_YAML_PATH);

  it("builds and smoke-verifies the standalone archive after both server and sandbox helper", () => {
    const steps = doc.jobs.build?.steps ?? [];
    const serverIndex = steps.findIndex((step) => stepRun(step).includes("scripts/build-server.mjs"));
    const helperIndex = steps.findIndex((step) => stepRun(step).includes("scripts/build-windows-sandbox-helper.mjs"));
    const installerIndex = steps.findIndex((step) => stepRun(step).includes("npx electron-builder --win nsis"));
    const packIndex = steps.findIndex((step) => stepRun(step).includes("scripts/build-standalone-server-artifact.mjs"));
    const verifyIndex = steps.findIndex((step) => stepRun(step).includes("scripts/verify-standalone-server-artifact.mjs"));
    const uploadIndex = steps.findIndex((step) => step.name === "Upload artifacts");

    expect(serverIndex).toBeGreaterThanOrEqual(0);
    expect(helperIndex).toBeGreaterThan(serverIndex);
    expect(packIndex).toBeGreaterThan(helperIndex);
    expect(verifyIndex).toBeGreaterThan(packIndex);
    expect(installerIndex).toBeGreaterThan(verifyIndex);
    expect(uploadIndex).toBeGreaterThan(verifyIndex);
    expect(steps[packIndex]?.if).toBe("runner.os == 'Windows'");
    expect(steps[verifyIndex]?.if).toBe("runner.os == 'Windows'");
    expect(stepRun(steps[packIndex])).not.toContain("win-unpacked");
    expect(stepRun(steps[verifyIndex])).toContain("--smoke");
  });

  it("uploads and gates the standalone archive plus SHA-256 manifest without a signing-key gate", () => {
    const buildSteps = doc.jobs.build?.steps ?? [];
    const uploadArtifact = buildSteps.find((step) => step.name === "Upload artifacts");
    const uploadArtifactText = JSON.stringify(uploadArtifact);
    expect(uploadArtifactText).toContain("dist-standalone/HanaCore-*-Windows-x64.tar.gz");
    expect(uploadArtifactText).toContain("dist-standalone/HanaCore-*-Windows-x64.manifest.json");
    expect(uploadArtifactText).not.toContain("dist-standalone/HanaCore-*-Windows-x64.manifest.json.sig");

    const releaseSteps = doc.jobs.release?.steps ?? [];
    const releaseUpload = releaseSteps.find((step) => step.name === "Upload release assets");
    const releaseGate = releaseSteps.find((step) => step.name === "Verify release assets");
    expect(stepRun(releaseUpload ?? {})).toContain("dist-standalone/HanaCore-*-Windows-x64.tar.gz");
    expect(stepRun(releaseUpload ?? {})).toContain("dist-standalone/HanaCore-*-Windows-x64.manifest.json");
    expect(stepRun(releaseUpload ?? {})).not.toContain("dist-standalone/HanaCore-*-Windows-x64*'");
    expect(stepRun(releaseGate ?? {})).toContain("HanaCore-.*-Windows-x64\\.tar\\.gz");
    expect(stepRun(releaseGate ?? {})).toContain("HanaCore-.*-Windows-x64\\.manifest\\.json");
    expect(stepRun(releaseGate ?? {})).toContain("Obsolete standalone manifest signature leaked into the release");
    expect(stepRun(releaseGate ?? {})).not.toContain(
      'MISSING+=("Windows x64 standalone server manifest signature")',
    );
  });

  it("does not expose the standalone namespace to publish-train", () => {
    const publishTrainText = JSON.stringify(doc.jobs["publish-train"]);
    expect(publishTrainText).not.toContain("dist-standalone");
    expect(publishTrainText).not.toContain("HanaCore-");
    expect(publishTrainText).toContain("publish-train.mjs");
  });
});
