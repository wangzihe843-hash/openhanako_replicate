import { describe, expect, it } from "vitest";
import { classifyExecCommand } from "../lib/exec-command/policy.ts";
import { renderCommandForExecShell, renderCommandWithWorkdir, resolveExecShell } from "../lib/exec-command/shell.ts";

describe("exec_command policy and shell rendering", () => {
  it("flags POSIX heredocs on Windows before they hit PowerShell", () => {
    const result = classifyExecCommand("python - <<'PY'\nprint('x')\nPY", { platform: "win32" });

    expect(result).toMatchObject({
      unsupportedSyntax: true,
      errorCode: "EXEC_COMMAND_POSIX_SYNTAX_ON_WINDOWS",
      reason: "posix-heredoc-on-windows",
    });
  });

  it("classifies common Windows probes as safe or probe-level commands", () => {
    expect(classifyExecCommand("Get-Command python", { platform: "win32" })).toMatchObject({
      kind: "safe",
      executable: "get-command",
    });
    expect(classifyExecCommand("python --version", { platform: "win32" })).toMatchObject({
      kind: "probe",
      executable: "python",
    });
  });

  it("keeps Windows auto shell raw and wraps explicit shell overrides", () => {
    const auto = resolveExecShell({ platform: "win32" });
    expect(auto).toMatchObject({ family: "powershell", label: "powershell", explicit: false });
    expect(renderCommandForExecShell("Get-ChildItem", auto, { platform: "win32" })).toBe("Get-ChildItem");

    const cmd = resolveExecShell({ shell: "cmd", platform: "win32" });
    expect(renderCommandForExecShell("dir", cmd, { platform: "win32" })).toBe('cmd.exe /d /s /c "dir"');

    const bash = resolveExecShell({ shell: "bash", platform: "win32" });
    expect(renderCommandForExecShell("ls -la", bash, { platform: "win32" })).toBe("bash -lc 'ls -la'");

    const powershell = resolveExecShell({ shell: "powershell", platform: "win32" });
    expect(renderCommandForExecShell('Write-Output "ok"', powershell, { platform: "win32" }))
      .toBe('powershell.exe -NoProfile -Command "Write-Output \\"ok\\""');
  });

  it("renders workdir inside the selected shell instead of ignoring it", () => {
    const powershell = resolveExecShell({ platform: "win32" });
    expect(renderCommandWithWorkdir("Get-ChildItem", powershell, {
      workdir: "C:\\work\\repo",
      defaultCwd: "C:\\work",
      platform: "win32",
    })).toBe("Set-Location -LiteralPath 'C:\\work\\repo'; Get-ChildItem");

    const posix = resolveExecShell({ platform: "linux" });
    expect(renderCommandWithWorkdir("pwd", posix, {
      workdir: "/tmp/repo",
      defaultCwd: "/tmp",
      platform: "linux",
    })).toBe("cd '/tmp/repo' && pwd");
  });
});
