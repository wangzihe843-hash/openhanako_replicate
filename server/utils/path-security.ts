/**
 * path-security.js — 路径安全校验共享模块
 *
 * 敏感路径检查，供 upload.js 和 desk.js 共用。
 */
import fs from "fs";
import path from "path";
import os from "os";
import { filesystemIdentityKeySync } from "../../shared/link-aware-fs.ts";

/** 解析真实路径（跟踪 symlink），失败返回 null */
export function realPath(p) {
  try { return fs.realpathSync(path.resolve(p)); }
  catch { return null; }
}

/** 敏感 dot 目录（不允许从这些目录复制文件） */
const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".config/gcloud", ".kube"];

/**
 * 检查路径是否指向敏感位置
 * @param {string} srcPath - 待检查的路径（相对路径视为敏感，fail-closed）
 * @param {string} [hanakoHome] - hanakoHome 路径（也视为敏感）
 * @returns {boolean}
 */
export function isSensitivePath(srcPath, hanakoHome) {
  if (!path.isAbsolute(srcPath)) return true; // fail-closed on relative input
  const resolved = realPath(srcPath);
  if (!resolved) return true; // fail-closed
  const candidate = filesystemIdentityKeySync(resolved);
  const home = os.homedir();
  for (const d of SENSITIVE_DIRS) {
    // Both sides must use filesystem identity: sensitive directories may be
    // links, and Windows accepts differently cased spellings of the same path.
    const sensitive = filesystemIdentityKeySync(path.join(home, d));
    if (candidate === sensitive || candidate.startsWith(sensitive + path.sep)) return true;
  }
  if (hanakoHome) {
    const realHome = realPath(hanakoHome);
    if (realHome) {
      const sensitive = filesystemIdentityKeySync(realHome);
      if (candidate === sensitive || candidate.startsWith(sensitive + path.sep)) return true;
    }
  }
  return false;
}
