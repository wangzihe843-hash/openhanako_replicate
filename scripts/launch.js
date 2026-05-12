#!/usr/bin/env node
/**
 * Cross-platform dev launcher
 * 瑙ｅ喅 POSIX `VAR=val cmd` 璇硶鍜?`~` 鍦?Windows 涓婁笉宸ヤ綔鐨勯棶棰?
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
process.env.HANA_HOME = process.env.HANA_HOME || join(homedir(), ".hanako-dev");
// 鏈湴 Electron 鍐嶆媺璧?server 鏃讹紝鏄惧紡鎶婂綋鍓?Node runtime 浼犱笅鍘汇€?
// 杩欐牱寮€鍙戞ā寮忕殑 server/source 杩涚▼灏变笉浼氳鐢?Electron 鑷甫 Node锛岄伩鍏?native addon ABI 婕傜Щ銆?
process.env.HANA_DEV_NODE_BIN = process.execPath;

const mode = process.argv[2];
const extra = process.argv.slice(3);

let bin, args;
switch (mode) {
  case "electron":
    bin = require("electron");
    args = [".", ...extra];
    break;
  case "electron-dev":
    bin = require("electron");
    args = [".", "--dev", ...extra];
    break;
  case "electron-vite":
    process.env.VITE_DEV_URL = "http://localhost:5173";
    bin = require("electron");
    args = [".", "--dev", ...extra];
    break;
  case "cli":
    bin = process.execPath;
    args = ["index.js", ...extra];
    break;
  case "server":
    bin = process.execPath;
    args = ["server/index.js", ...extra];
    break;
  default:
    console.error("Usage: node scripts/launch.js <electron|electron-dev|electron-vite|cli|server>");
    process.exit(1);
}

// Electron 浠ュ瓙杩涚▼杩愯鏃讹紙濡?VS Code / Claude Code 缁堢锛夛紝
// 鐖惰繘绋嬪彲鑳借浜?ELECTRON_RUN_AS_NODE=1锛屼細璁?Electron 浠ョ函 Node 妯″紡鍚姩锛?
// 瀵艰嚧 require('electron') 鎷夸笉鍒板唴缃?API銆俿pawn 鍓嶆竻鎺夈€?
delete process.env.ELECTRON_RUN_AS_NODE;

const child = spawn(bin, args, { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));

