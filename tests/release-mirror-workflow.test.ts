import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readWorkflow(name: string) {
  return fs.readFileSync(path.join(rootDir, ".github", "workflows", name), "utf-8");
}

describe("release mirror workflows", () => {
  it("mirrors the published tag to AtomGit after the release job succeeds", () => {
    const workflow = readWorkflow("build.yml");

    expect(workflow).toContain("mirror-atomgit:");
    expect(workflow).toContain("needs: release");
    expect(workflow).toContain("ATOMGIT_REPO: OpenHanako-Releases");
    expect(workflow).toContain("node scripts/mirror-release-to-atomgit.mjs --tag \"${{ github.ref_name }}\"");
    expect(workflow).not.toContain("node scripts/mirror-release-to-atomgit.mjs --newest");
    expect(workflow).not.toContain("node scripts/mirror-release-to-atomgit.mjs --latest");
  });

  it("keeps manual mirror selection explicit for prerelease and stable releases", () => {
    const workflow = readWorkflow("mirror-release-to-atomgit.yml");

    expect(workflow).toContain("- newest");
    expect(workflow).toContain("- stable");
    expect(workflow).toContain("- tag");
    expect(workflow).toContain("ATOMGIT_REPO: OpenHanako-Releases");
    expect(workflow).toContain("ARGS+=(--stable \"${{ inputs.limit }}\")");
    expect(workflow).toContain("ARGS+=(--newest \"${{ inputs.limit }}\")");
  });
});
