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

  it("emits Platform/Shell/OS Version on win32", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "win32" });
    expect(out).toBe(
      "Platform: win32\n" +
      "Shell: platform-adaptive\n" +
      "OS Version: TestOS 1.2.3\n" +
      "Host OS is Windows. Simple git commands run through Hanako's bundled git.exe when available.\n" +
      "Simple Windows-native commands may run through cmd.exe; POSIX shell commands run through Hanako's bundled PortableGit Bash runtime.\n" +
      "Use POSIX syntax for pipes, paths, environment variables, and redirection when writing shell-style commands.\n" +
      "Use cmd.exe /c or powershell.exe -NoProfile -Command only when you explicitly need a Windows-native shell.\n" +
      "Discard POSIX command output with /dev/null; use CMD's nul device only inside an explicit cmd.exe command."
    );
  });

  it("keeps Shell: bash on POSIX platforms regardless of $SHELL", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "darwin" });
    expect(out).toContain("Shell: bash");
    expect(out).not.toContain("zsh");
    expect(out).not.toContain("fish");
  });
});
