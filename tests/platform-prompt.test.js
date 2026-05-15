import { describe, expect, it } from "vitest";
import { getPlatformPromptNote } from "../core/platform-prompt.js";

const baseOpts = { osType: "TestOS", osRelease: "1.2.3" };

describe("getPlatformPromptNote", () => {
  it("emits Platform/Shell/OS Version on darwin", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "darwin" });
    expect(out).toBe("Platform: darwin\nShell: bash\nOS Version: TestOS 1.2.3");
  });

  it("emits Platform/Shell/OS Version on linux", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "linux" });
    expect(out).toBe("Platform: linux\nShell: bash\nOS Version: TestOS 1.2.3");
  });

  it("keeps the model-facing bash shell contract on win32", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "win32" });
    expect(out).toBe(
      "Platform: win32\n" +
      "Shell: bash\n" +
      "OS Version: TestOS 1.2.3\n" +
      "Host OS is Windows, but the bash tool accepts POSIX shell-style commands.\n" +
      "Hanako may internally route simple git commands through bundled git.exe and explicit cmd.exe/powershell.exe commands through Windows-native runners.\n" +
      "Prefer POSIX syntax for pipes, paths, environment variables, and redirection when writing shell-style commands.\n" +
      "Use cmd.exe /c or powershell.exe -NoProfile -Command only when you explicitly need a Windows-native shell.\n" +
      "Discard POSIX command output with /dev/null; use CMD's nul device only inside an explicit cmd.exe command."
    );
    expect(out).not.toContain("platform-adaptive");
  });

  it("keeps Shell: bash on POSIX platforms regardless of $SHELL", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "darwin" });
    expect(out).toContain("Shell: bash");
    expect(out).not.toContain("zsh");
    expect(out).not.toContain("fish");
  });
});
