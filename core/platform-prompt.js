import os from "node:os";

// 模型侧看到稳定的 bash 工具契约；Windows 的 Git/cmd/POSIX runtime
// 分派属于 win32-exec 的执行层细节，避免泄漏到 prompt 里干扰规划。
function getExecShellLabel() {
  return "bash";
}

export function getPlatformPromptNote({
  platform = process.platform,
  osType = os.type(),
  osRelease = os.release(),
} = {}) {
  const lines = [
    `Platform: ${platform}`,
    `Shell: ${getExecShellLabel(platform)}`,
    `OS Version: ${osType} ${osRelease}`,
  ];
  if (platform === "win32") {
    lines.push(
      "Host OS is Windows, but the bash tool accepts POSIX shell-style commands.",
      "Hanako may internally route simple git commands through bundled git.exe and explicit cmd.exe/powershell.exe commands through Windows-native runners.",
      "Prefer POSIX syntax for pipes, paths, environment variables, and redirection when writing shell-style commands.",
      "Use cmd.exe /c or powershell.exe -NoProfile -Command only when you explicitly need a Windows-native shell.",
      "Discard POSIX command output with /dev/null; use CMD's nul device only inside an explicit cmd.exe command.",
    );
  }
  return lines.join("\n");
}
