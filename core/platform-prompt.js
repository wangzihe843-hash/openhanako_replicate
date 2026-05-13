import os from "node:os";

// Hana 在 macOS/Linux 上执行 AI 命令时，真实使用 bash。
// Windows 由 win32-exec 在 Git/cmd/POSIX compatibility 三条 runtime 之间显式分派。
function getExecShellLabel(platform) {
  return platform === "win32" ? "platform-adaptive" : "bash";
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
      "Host OS is Windows. Simple git commands run through Hanako's bundled git.exe when available.",
      "Simple Windows-native commands may run through cmd.exe; POSIX shell commands run through Hanako's bundled POSIX compatibility layer in sandbox mode.",
      "Use POSIX syntax for pipes, paths, environment variables, and redirection when writing shell-style commands.",
      "Use cmd.exe /c or powershell.exe -NoProfile -Command only when you explicitly need a Windows-native shell.",
      "Discard POSIX command output with /dev/null; use CMD's nul device only inside an explicit cmd.exe command.",
    );
  }
  return lines.join("\n");
}
