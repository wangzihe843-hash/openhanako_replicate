import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  formatWorkspaceScopePrompt,
  normalizeWorkspaceScope,
} from "../shared/workspace-scope.js";

const PROJECT_DIR = path.join(os.tmpdir(), "hana-workspace-scope", "project");
const REFERENCE_DIR = path.join(os.tmpdir(), "hana-workspace-scope", "reference");

describe("workspace scope", () => {
  it("dedupes extra folders and excludes the primary cwd", () => {
    const scope = normalizeWorkspaceScope({
      primaryCwd: PROJECT_DIR,
      workspaceFolders: [
        REFERENCE_DIR,
        PROJECT_DIR,
        "",
        null,
        REFERENCE_DIR,
      ],
    });

    expect(scope).toEqual({
      primaryCwd: PROJECT_DIR,
      workspaceFolders: [REFERENCE_DIR],
    });
  });

  it("formats extra folders into the assistant workspace prompt", () => {
    const prompt = formatWorkspaceScopePrompt({
      primaryCwd: PROJECT_DIR,
      workspaceFolders: [REFERENCE_DIR],
      locale: "zh-CN",
    });

    expect(prompt).toContain("当前工作目录");
    expect(prompt).toContain(PROJECT_DIR);
    expect(prompt).toContain("额外文件夹");
    expect(prompt).toContain(REFERENCE_DIR);
  });
});
