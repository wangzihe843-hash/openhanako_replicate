/**
 * seatbelt.js — macOS Seatbelt (sandbox-exec) 沙盒
 *
 * 生成 SBPL profile，用 sandbox-exec -f 执行。
 * 返回符合 Pi SDK BashOperations.exec 接口的函数。
 */

import fs from "fs";
import { spawnAndStream } from "./exec-helper.ts";
import { writeScript, writeProfile, cleanup } from "./script.ts";

/**
 * 创建 macOS 沙盒化的 exec 函数
 * @param {object} policy  从 deriveSandboxPolicy() 得到
 * @param {object} [options]
 * @param {() => boolean} [options.getSandboxNetworkEnabled]
 * @returns {(command, cwd, opts) => Promise<{exitCode}>}
 */
export function createSeatbeltExec(policy, { getSandboxNetworkEnabled }: { getSandboxNetworkEnabled?: () => boolean } = {}) {
  return async (command: string, cwd: string, { onData, signal, timeout, env }: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  }) => {
    const profile = generateProfile(policy, {
      allowNetwork: typeof getSandboxNetworkEnabled === "function"
        ? getSandboxNetworkEnabled()
        : true,
    });
    const { scriptPath } = writeScript(command, cwd);
    let profilePath: string | undefined;
    try {
      ({ profilePath } = writeProfile(profile));
      return await spawnAndStream(
        "sandbox-exec",
        ["-f", profilePath, "/bin/bash", scriptPath],
        { cwd, env, onData, signal, timeout },
      );
    } finally {
      cleanup(scriptPath, ...(profilePath ? [profilePath] : []));
    }
  };
}

/**
 * 解析真实路径（符号链接 + macOS /var → /private/var）
 */
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** SBPL string literals use escaped backslashes/quotes, not shell quoting. */
function sbplPath(p: string): string {
  const resolved = realpath(p);
  // Reject unvalidated control escapes rather than changing the policy grammar.
  for (const character of resolved) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new Error("Sandbox path contains a control character");
    }
  }
  return `"${resolved.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 生成 Seatbelt SBPL profile
 */
function generateProfile(policy, { allowNetwork = true } = {}) {
  const lines = [
    "(version 1)",
    "(deny default)",
    "",
    ";; 进程",
    "(allow process-exec* process-fork signal)",
    "(allow sysctl-read)",
    "(allow mach*)",
    "(allow ipc-posix*)",
    "",
    ";; 全局可读",
    "(allow file-read*)",
    "",
    ";; 可写路径",
  ];

  for (const p of policy.writablePaths) {
    lines.push(`(allow file-write* (subpath ${sbplPath(p)}))`);
  }

  // /tmp（macOS 上是 /private/tmp 和 /private/var/folders/...）
  lines.push(
    `(allow file-write* (subpath "/private/tmp"))`,
    `(allow file-write* (subpath ${sbplPath(process.env.TMPDIR || "/tmp")}))`
  );

  lines.push("");

  // 受保护路径（deny 覆盖 allow，SBPL last-match-wins）
  if (policy.protectedPaths.length) {
    lines.push(";; 写保护");
    for (const p of policy.protectedPaths) {
      lines.push(`(deny file-write* (subpath ${sbplPath(p)}))`);
    }
    lines.push("");
  }

  // 读取拒绝（subpath 覆盖文件和目录及其内容）
  if (policy.denyReadPaths.length) {
    lines.push(";; 读取拒绝");
    for (const p of policy.denyReadPaths) {
      const rp = sbplPath(p);
      lines.push(`(deny file-read* (subpath ${rp}))`);
      lines.push(`(deny file-write* (subpath ${rp}))`);
    }
    lines.push("");
  }

  lines.push(
    ";; 终端 + PTY",
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (regex #"^/dev/ttys[0-9]+$"))',
    '(allow file-write* (literal "/dev/ptmx"))',
    "(allow pseudo-tty)",
    "",
  );
  if (allowNetwork) {
    lines.push(
      ";; 网络（允许沙盒内命令出站联网）",
      "(allow network-outbound)",
    );
  } else {
    lines.push(
      ";; 网络（封死，联网走 Engine 工具层）",
      "(deny network*)",
    );
  }

  return lines.join("\n");
}

export const __testing = {
  generateProfile,
};
