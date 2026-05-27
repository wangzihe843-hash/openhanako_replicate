import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixModules = require("../scripts/fix-modules.cjs").default;

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-computer-use-packaging-"));
  tempDirs.push(dir);
  return dir;
}

function makeMacAfterPackContext(appOutDir) {
  return {
    appOutDir,
    arch: 3,
    packager: {
      platform: { name: "mac" },
      appInfo: { productFilename: "HanaAgent" },
    },
  };
}

function resourcesDir(appOutDir) {
  return path.join(appOutDir, "HanaAgent.app", "Contents", "Resources");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Computer Use packaging contract", () => {
  it("fails macOS afterPack when the helper binary is missing from app resources", async () => {
    const appOutDir = makeTempDir();
    fs.mkdirSync(resourcesDir(appOutDir), { recursive: true });

    await expect(fixModules(makeMacAfterPackContext(appOutDir))).rejects.toThrow(
      /Computer Use helper missing/,
    );
  });

  it("runs the helper build before electron-builder in the GitHub macOS release workflow", () => {
    const workflowText = fs.readFileSync(
      path.resolve(".github", "workflows", "build.yml"),
      "utf8",
    );
    const workflow = yaml.load(workflowText);

    // 找跑 macOS 打包的 job：在 jobs 里挑包含 `npx electron-builder --mac` 的那个 step 所在的 job。
    // 这样不硬编码 job 名，将来重命名也不会脆断。
    const jobs = workflow.jobs ?? {};
    const macJobEntry = Object.entries(jobs).find(([, job]) =>
      Array.isArray(job?.steps) &&
      job.steps.some((step) => typeof step?.run === "string" && step.run.includes("npx electron-builder --mac")),
    );
    expect(macJobEntry, "expected a job that runs `npx electron-builder --mac`").toBeTruthy();

    const [macJobName, macJob] = macJobEntry;
    const steps = macJob.steps;

    const helperBuildIndex = steps.findIndex(
      (step) => typeof step?.run === "string" && step.run.includes("node scripts/build-computer-use-helper.mjs"),
    );
    const macBuilderIndex = steps.findIndex(
      (step) => typeof step?.run === "string" && step.run.includes("npx electron-builder --mac"),
    );

    expect(helperBuildIndex, `helper build step not found in job ${macJobName}`).toBeGreaterThanOrEqual(0);
    expect(macBuilderIndex, `electron-builder --mac step not found in job ${macJobName}`).toBeGreaterThanOrEqual(0);
    expect(
      helperBuildIndex,
      "helper build must run before electron-builder --mac",
    ).toBeLessThan(macBuilderIndex);

    // HANA_COMPUTER_USE_HELPER_ARCH 必须绑到 matrix.arch。
    // 优先看结构化位置（step.env / job.env），都没有再回落到 helper build step 的 run 脚本里的
    // 内联 shell env（当前 workflow 用的就是 `HANA_COMPUTER_USE_HELPER_ARCH=${{ matrix.arch }} node ...`
    // 这种写法）。三个位置任一命中即可，但仍然 scoped 到 helper build 这一步，比全文 grep 严。
    const matrixArchExpr = "${{ matrix.arch }}";
    const helperStep = steps[helperBuildIndex];
    const stepEnvValue = helperStep?.env?.HANA_COMPUTER_USE_HELPER_ARCH;
    const jobEnvValue = macJob?.env?.HANA_COMPUTER_USE_HELPER_ARCH;
    // 内联值可能是 `${{ matrix.arch }}`（含空格）或者裸 token（如 arm64），所以两种都尝试匹配。
    const inlineEnvMatch =
      typeof helperStep?.run === "string"
        ? helperStep.run.match(/HANA_COMPUTER_USE_HELPER_ARCH=(\$\{\{[^}]*\}\}|\S+)/)
        : null;
    const inlineEnvValue = inlineEnvMatch ? inlineEnvMatch[1] : undefined;

    const resolvedArchSource = stepEnvValue ?? jobEnvValue ?? inlineEnvValue;
    expect(
      resolvedArchSource,
      "HANA_COMPUTER_USE_HELPER_ARCH must be bound on the helper build step (step.env, job.env, or inline shell prefix)",
    ).toBe(matrixArchExpr);
  });
});
