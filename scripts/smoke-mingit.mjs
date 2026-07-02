#!/usr/bin/env node
/**
 * smoke-mingit.mjs — Windows 上验证 MinGit runtime 能跑非交互 git 全流程 +
 * sh-compatible POSIX shell。runtime 的"真实二进制"验证（JS 单测覆盖不到）。
 *
 * 用法（Windows）：node scripts/smoke-mingit.mjs [runtimeRoot]
 *   默认 runtimeRoot = vendor/mingit
 * 退出码：全过 0，任一失败 1。
 *
 * 注意：在 macOS/Linux 上跑会 FAIL（没有 .exe），这是预期的，不要加进 npm test。
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const root = process.argv[2] || path.join(process.cwd(), "vendor", "mingit");
const git = path.join(root, "cmd", "git.exe");
// MinGit 不打包 bash.exe；POSIX 契约是 usr/bin/sh.exe（bash 以 sh 模式运行），参数 -c
const sh = path.join(root, "usr", "bin", "sh.exe");

const runtimeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
);
runtimeEnv.PATH = [
  path.join(root, "bin"),
  path.join(root, "usr", "bin"),
  path.join(root, "mingw64", "bin"),
  path.join(root, "cmd"),
  process.env.PATH || process.env.Path || "",
].filter(Boolean).join(path.delimiter);

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mingit-smoke-"));
const repoDir = path.join(workRoot, "repo");
const cloneDir = path.join(workRoot, "repo-copy");

function run(label, exe, args, opts = {}) {
  try {
    const out = execFileSync(exe, args, {
      encoding: "utf-8",
      timeout: 30000,
      env: runtimeEnv,
      ...opts,
    });
    console.log(`PASS  ${label}: ${(out || "").trim().split(/\r?\n/)[0] || "(no output)"}`);
    return true;
  } catch (err) {
    console.error(`FAIL  ${label}: ${err.message}`);
    return false;
  }
}

// 提交身份内联传入，不依赖 CI 机器的全局 git config
const IDENT = [
  "-c", "user.email=smoke@hana.invalid",
  "-c", "user.name=hana-smoke",
];

const COREUTILS = "cat ls cp mv rm mkdir grep sed awk find sort uniq head tail wc cut tr xargs echo touch";

const results = [
  run("git --version", git, ["--version"]),
  run("git init", git, ["init", repoDir]),
  run("git status", git, ["-C", repoDir, "status", "--short", "--branch"]),
  run("git config write", git, ["-C", repoDir, "config", "hana.smoke", "1"]),
  run("git config read", git, ["-C", repoDir, "config", "hana.smoke"]),
  run("git commit", git, ["-C", repoDir, ...IDENT, "commit", "--allow-empty", "-m", "smoke"]),
  run("git rev-parse HEAD", git, ["-C", repoDir, "rev-parse", "HEAD"]),
  run("git local clone", git, ["-c", "protocol.file.allow=always", "clone", repoDir, cloneDir]),
  run("git clone status", git, ["-C", cloneDir, "status", "--short", "--branch"]),
  run("sh starts", sh, ["-c", "echo sh=ok"]),
  run("coreutils present", sh, [
    "-c",
    `missing=""; for t in ${COREUTILS}; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done; ` +
      `if [ -n "$missing" ]; then echo "MISSING:$missing"; exit 1; fi; echo "coreutils ok"`,
  ]),
  run("sh pipeline", sh, [
    "-c",
    "printf 'a\\nb\\nc\\n' | grep b | sed 's/b/B/' | awk '{print $1}'",
  ]),
];

fs.rmSync(workRoot, { recursive: true, force: true });

process.exit(results.every(Boolean) ? 0 : 1);
