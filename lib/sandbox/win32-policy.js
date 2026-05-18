import fs from "fs";
import os from "os";
import path from "path";

const EXTERNAL_READ_STORAGE_KINDS = new Set(["external", "install_source"]);

function normalizeExistingOrResolved(p) {
  if (!p) return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function normalizeExisting(p) {
  if (!p) return null;
  try {
    return fs.realpathSync(p);
  } catch (err) {
    return err?.code === "ENOENT" ? null : path.resolve(p);
  }
}

function uniqueNormalized(paths) {
  const out = [];
  const seen = new Set();
  for (const raw of paths || []) {
    const normalized = normalizeExistingOrResolved(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function uniqueExistingNormalized(paths) {
  const out = [];
  const seen = new Set();
  for (const raw of paths || []) {
    const normalized = normalizeExisting(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function discoverWin32SystemReadRoots({ env = process.env, platform = process.platform } = {}) {
  if (platform !== "win32") return [];
  const roots = [];
  const push = (p) => {
    if (!p) return;
    roots.push(p);
  };

  push(os.homedir());
  push(env.USERPROFILE);
  const driveRoot = (value) => {
    const match = String(value || "").match(/^[A-Za-z]:/);
    return match ? `${match[0]}\\` : null;
  };
  push(driveRoot(env.HOMEDRIVE));
  push(driveRoot(env.SystemDrive));
  for (let code = 65; code <= 90; code += 1) {
    push(`${String.fromCharCode(code)}:\\`);
  }
  return uniqueExistingNormalized(roots);
}

function isInside(target, root) {
  if (!target || !root) return false;
  const rel = path.relative(root, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isInsideAny(target, roots) {
  return roots.some((root) => isInside(target, root));
}

export function externalReadPathsFromSessionFiles(files = [], { workspaceRoots = [], hanakoHome } = {}) {
  const normalizedWorkspaceRoots = uniqueNormalized(workspaceRoots);
  const normalizedHome = hanakoHome ? normalizeExistingOrResolved(hanakoHome) : null;
  const out = [];

  for (const file of files || []) {
    if (!file || file.status === "missing" || file.status === "expired") continue;
    if (!EXTERNAL_READ_STORAGE_KINDS.has(file.storageKind || "external")) continue;
    const target = normalizeExistingOrResolved(file.realPath || file.filePath);
    if (!target) continue;
    if (normalizedHome && isInside(target, normalizedHome)) continue;
    if (isInsideAny(target, normalizedWorkspaceRoots)) continue;
    out.push(target);
  }

  return uniqueNormalized(out);
}

export function buildWin32SandboxGrants({
  policy,
  cwd,
  externalReadPaths = [],
  runtimeReadPaths = [],
  systemReadRoots,
} = {}) {
  if (!policy || policy.mode === "full-access") {
    return { readPaths: [], optionalReadPaths: [], writePaths: [], optionalWritePaths: [], denyReadPaths: [], denyWritePaths: [] };
  }

  const denyReadPaths = uniqueExistingNormalized(policy.denyReadPaths || []);
  const isDeniedRead = (target) => isInsideAny(target, denyReadPaths);
  const withoutDeniedReads = (paths) => uniqueNormalized(paths).filter((p) => !isDeniedRead(p));
  const withoutDeniedExistingReads = (paths) => uniqueExistingNormalized(paths).filter((p) => !isDeniedRead(p));
  const readableSystemRoots = Array.isArray(systemReadRoots)
    ? systemReadRoots
    : (policy.allowExternalReads === true ? discoverWin32SystemReadRoots() : []);

  const writePaths = withoutDeniedReads([
    cwd,
  ]);
  const optionalWritePaths = withoutDeniedExistingReads(policy.writablePaths || [])
    .filter((p) => !isInsideAny(p, writePaths));
  const readPaths = withoutDeniedReads([
    ...writePaths,
    ...externalReadPaths,
    ...runtimeReadPaths,
  ]);
  const optionalReadPaths = withoutDeniedExistingReads([
    ...(policy.readablePaths || []),
    ...readableSystemRoots,
  ]);
  const writeGrantRoots = [...writePaths, ...optionalWritePaths];
  const denyWritePaths = withoutDeniedExistingReads(policy.protectedPaths || [])
    .filter((p) => isInsideAny(p, writeGrantRoots));

  return { readPaths, optionalReadPaths, writePaths, optionalWritePaths, denyReadPaths, denyWritePaths };
}

export const __testing = {
  discoverWin32SystemReadRoots,
};
