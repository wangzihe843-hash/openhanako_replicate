import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function resolveShell(command) {
  if (process.platform === "win32") {
    const shell = process.env.COMSPEC || "cmd.exe";
    return command
      ? { file: shell, args: ["/d", "/s", "/c", command] }
      : { file: shell, args: [] };
  }
  const shell = process.env.SHELL || "/bin/bash";
  return command
    ? { file: shell, args: ["-lc", command] }
    : { file: shell, args: ["-i"] };
}

export async function createAsyncNodePtyBackend() {
  const pty = await import("node-pty");
  ensureUnixSpawnHelperExecutable();
  return {
    spawn({ command = "", cwd, cols = 80, rows = 24, env, onData, onExit }) {
      const { file, args } = resolveShell(command);
      const proc = pty.spawn(file, args, {
        cwd,
        cols,
        rows,
        env: env || process.env,
        name: "xterm-256color",
      });
      proc.onData((data) => onData?.(data));
      proc.onExit((event) => onExit?.({ exitCode: event.exitCode, signal: event.signal }));
      return {
        write: (data) => proc.write(data),
        kill: () => proc.kill(),
        resize: (nextCols, nextRows) => proc.resize(nextCols, nextRows),
      };
    },
  };
}

function ensureUnixSpawnHelperExecutable() {
  if (process.platform === "win32") return;
  let packageRoot;
  try {
    packageRoot = path.dirname(fileURLToPath(import.meta.resolve("node-pty/package.json")));
  } catch {
    return;
  }
  for (const helperPath of [
    path.join(packageRoot, "build", "Release", "spawn-helper"),
    path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ]) {
    try {
      if (!fs.existsSync(helperPath)) continue;
      const mode = fs.statSync(helperPath).mode;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helperPath, mode | 0o755);
      }
    } catch {}
  }
}
