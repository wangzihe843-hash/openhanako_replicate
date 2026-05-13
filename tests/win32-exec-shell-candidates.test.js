import { describe, expect, it } from "vitest";
import path from "path";
import { __testing } from "../lib/sandbox/win32-exec.js";

describe("win32 bundled shell candidates", () => {
  it("discovers MinGit ash.exe and busybox.exe when bash/sh.exe are absent", () => {
    const gitRoot = "C:\\Program Files\\Hanako\\resources\\git";
    const existing = new Set([
      path.win32.join(gitRoot, "mingw64", "bin", "ash.exe"),
      path.win32.join(gitRoot, "mingw64", "bin", "busybox.exe"),
    ]);

    const candidates = __testing.getBundledShellCandidates(
      { HANA_ROOT: "C:\\Program Files\\Hanako\\resources\\server" },
      {
        resourcesPath: "C:\\Program Files\\Hanako\\resources",
        resourceSiblingDir: () => null,
        exists: (filePath) => existing.has(filePath),
      },
    );

    expect(candidates.map((candidate) => path.win32.basename(candidate.shell))).toEqual([
      "ash.exe",
      "busybox.exe",
    ]);
    expect(candidates.find((candidate) => candidate.shell.endsWith("ash.exe"))?.args).toEqual(["-c"]);
    expect(candidates.find((candidate) => candidate.shell.endsWith("busybox.exe"))?.args).toEqual(["sh", "-c"]);
  });

  it("prepends bundled MinGit runtime directories to the shell PATH", () => {
    const gitRoot = "C:\\Program Files\\Hanako\\resources\\git";
    const shell = path.win32.join(gitRoot, "mingw64", "bin", "ash.exe");
    const env = __testing.getShellEnvForCandidate(
      { Path: "C:\\Windows\\System32" },
      { shell, args: ["-c"], bundledRoot: gitRoot },
    );

    const segments = env.Path.split(";");
    expect(segments.slice(0, 2)).toEqual([
      path.win32.join(gitRoot, "mingw64", "bin"),
      path.win32.join(gitRoot, "cmd"),
    ]);
    expect(segments).toContain("C:\\Windows\\System32");
  });
});
