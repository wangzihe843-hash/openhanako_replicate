import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { isWin32PathLike } from "../shell/shell-utils.ts";

const CACHE_DIR = "win32-sandbox-runtime";
const MARKER_FILE = ".hana-sandbox-runtime.json";

function pathOpsFor(...paths) {
  return paths.some(isWin32PathLike) ? path.win32 : path;
}

function joinRuntimePath(root, ...segments) {
  const ops = pathOpsFor(root);
  return ops.join(root, ...segments);
}

function dirnameRuntimePath(filePath) {
  return pathOpsFor(filePath).dirname(filePath);
}

function normalizeForCompare(filePath) {
  const ops = pathOpsFor(filePath);
  const normalized = ops.normalize(String(filePath || ""));
  return ops === path.win32 ? normalized.toLowerCase() : normalized;
}

function isInsideRuntimeRoot(target, root) {
  if (!target || !root) return false;
  const ops = pathOpsFor(target, root);
  const targetNorm = normalizeForCompare(target);
  const rootNorm = normalizeForCompare(root);
  const rel = ops.relative(rootNorm, targetNorm);
  return rel === "" || (!!rel && !rel.startsWith("..") && !ops.isAbsolute(rel));
}

function runtimePrimaryPath(runtimeInfo) {
  return runtimeInfo?.git || runtimeInfo?.shell || runtimeInfo?.executable || null;
}

function runtimeSourceRoot(runtimeInfo, kind) {
  if (runtimeInfo?.bundledRoot) {
    const ops = pathOpsFor(runtimeInfo.bundledRoot);
    const root = ops.resolve(runtimeInfo.bundledRoot);
    if (normalizeForCompare(root) === normalizeForCompare(ops.parse(root).root)) {
      throw new Error("[win32-sandbox] A volume root cannot be a complete bundled runtime.");
    }
    return root;
  }
  if (kind !== "node") {
    throw new Error(`[win32-sandbox] An explicit bundledRoot is required for runtime kind "${kind}".`);
  }
  const primary = runtimePrimaryPath(runtimeInfo);
  return primary ? dirnameRuntimePath(primary) : null;
}

// A standalone node.exe may live next to workspaces or even at a volume root.
// Its parent is not a runtime tree. Copy only Node's executable/companions and
// the bundled package-manager closure, leaving unrelated files where they are.
function nodeRuntimeEntries(sourceRoot, primaryPath) {
  const ops = pathOpsFor(sourceRoot, primaryPath);
  const entries = new Set([ops.basename(primaryPath)]);
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if ((entry.isFile() || entry.isSymbolicLink()) && /(?:\.dll$|^icudt.*\.dat$)/i.test(entry.name)) {
      entries.add(entry.name);
    }
  }
  for (const entry of [
    "npm", "npm.cmd", "npm.ps1", "npx", "npx.cmd", "npx.ps1",
    "corepack", "corepack.cmd", "corepack.ps1",
    ops.join("node_modules", "npm"), ops.join("node_modules", "corepack"),
  ]) {
    if (fs.existsSync(ops.join(sourceRoot, entry))) entries.add(entry);
  }
  return [...entries].sort();
}

function rewriteRuntimePath(sourcePath, sourceRoot, targetRoot) {
  if (!sourcePath) return sourcePath;
  const ops = pathOpsFor(sourcePath, sourceRoot, targetRoot);
  let rel = ops.relative(sourceRoot, sourcePath);
  if (!rel || rel.startsWith("..") || ops.isAbsolute(rel)) {
    rel = ops.basename(sourcePath);
  }
  return ops.join(targetRoot, rel);
}

function statSignature(filePath) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}

function runtimeManifest({ sourceRoot, primaryPath, kind, sourceEntries }) {
  return {
    version: 2,
    kind,
    sourceRoot: normalizeForCompare(sourceRoot),
    primaryPath: normalizeForCompare(primaryPath),
    sourceRootStat: statSignature(sourceRoot),
    primaryStat: statSignature(primaryPath),
    sourceEntries: sourceEntries?.map((entry) => ({
      path: entry,
      ...statSignature(joinRuntimePath(sourceRoot, entry)),
    })) ?? null,
  };
}

function manifestMatches(markerPath, manifest) {
  try {
    const existing = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    return JSON.stringify(existing) === JSON.stringify(manifest);
  } catch {
    return false;
  }
}

function stableCacheName({ sourceRoot, primaryPath, kind, manifest }) {
  const hash = crypto
    .createHash("sha256")
    .update(`${kind}\0${normalizeForCompare(sourceRoot)}\0${normalizeForCompare(primaryPath)}`)
    .update(`\0${JSON.stringify(manifest)}`)
    .digest("hex")
    .slice(0, 16);
  return `${kind}-${hash}`;
}

function copyRuntimeTree({ sourceRoot, sourceEntries, targetRoot, markerPath, manifest }) {
  const ops = pathOpsFor(sourceRoot, targetRoot);
  const parent = ops.dirname(targetRoot);
  fs.mkdirSync(parent, { recursive: true });

  const tmpRoot = ops.join(parent, `.${ops.basename(targetRoot)}.tmp-${process.pid}-${Date.now()}`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  try {
    const copyOptions = { recursive: true, force: true, dereference: true };
    if (sourceEntries) {
      fs.mkdirSync(tmpRoot, { recursive: true });
      for (const entry of sourceEntries) {
        const destination = ops.join(tmpRoot, entry);
        fs.mkdirSync(ops.dirname(destination), { recursive: true });
        fs.cpSync(ops.join(sourceRoot, entry), destination, copyOptions);
      }
    } else {
      fs.cpSync(sourceRoot, tmpRoot, copyOptions);
    }
    fs.writeFileSync(ops.join(tmpRoot, MARKER_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.renameSync(tmpRoot, targetRoot);
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (fs.existsSync(targetRoot) && manifestMatches(markerPath, manifest)) return;
    throw err;
  }
}

function ensureCachedRuntimeRoot({ sourceRoot, primaryPath, hanakoHome, kind, bundled }) {
  if (!hanakoHome) {
    throw new Error("[win32-sandbox] HANA_HOME is required to prepare sandbox runtime cache.");
  }
  if (!sourceRoot || !fs.existsSync(sourceRoot)) {
    throw new Error(`[win32-sandbox] Runtime source root does not exist: ${sourceRoot || "(missing)"}`);
  }
  if (!primaryPath || !fs.existsSync(primaryPath)) {
    throw new Error(`[win32-sandbox] Runtime executable does not exist: ${primaryPath || "(missing)"}`);
  }

  const cacheRoot = sandboxRuntimeCacheRoot(hanakoHome);
  if (isInsideRuntimeRoot(sourceRoot, cacheRoot)) return sourceRoot;
  if (bundled && isInsideRuntimeRoot(cacheRoot, sourceRoot)) {
    throw new Error("[win32-sandbox] The runtime cache cannot be inside a complete bundled runtime.");
  }

  const sourceEntries = bundled ? null : nodeRuntimeEntries(sourceRoot, primaryPath);
  const manifest = runtimeManifest({ sourceRoot, primaryPath, kind, sourceEntries });
  const targetRoot = joinRuntimePath(cacheRoot, stableCacheName({ sourceRoot, primaryPath, kind, manifest }));
  const markerPath = joinRuntimePath(targetRoot, MARKER_FILE);

  if (fs.existsSync(targetRoot) && manifestMatches(markerPath, manifest)) return targetRoot;

  copyRuntimeTree({ sourceRoot, sourceEntries, targetRoot, markerPath, manifest });
  return targetRoot;
}

export function sandboxRuntimeCacheRoot(hanakoHome) {
  if (!hanakoHome) throw new Error("[win32-sandbox] HANA_HOME is required for sandbox runtime cache.");
  return joinRuntimePath(hanakoHome, ".ephemeral", CACHE_DIR);
}

// Per-executable, in-process cache of whether a sandboxed PowerShell startup
// probe succeeded. Keyed by resolved executable path so pwsh and Windows
// PowerShell 5.1 are probed and cached independently; populated the first
// time a sandboxed PowerShell command reaches spawnViaSandboxHelper for that
// executable, so later commands in the same process skip the probe entirely.
const sandboxPowerShellProbeCache = new Map<string, "ok" | "unsupported">();

export function getSandboxPowerShellProbeResult(executable: string) {
  return sandboxPowerShellProbeCache.get(normalizeForCompare(executable)) ?? null;
}

export function setSandboxPowerShellProbeResult(executable: string, result: "ok" | "unsupported") {
  sandboxPowerShellProbeCache.set(normalizeForCompare(executable), result);
}

// Test-only: clear cached probe verdicts between cases.
export function resetSandboxPowerShellProbeCacheForTests() {
  sandboxPowerShellProbeCache.clear();
}

export type Win32PowerShellFlavor = "pwsh" | "windows-powershell";

const POWERSHELL_FLAVOR_PROBE_TIMEOUT_MS = 3000;

function probePwshOnPath(spawn: typeof spawnSync): boolean {
  try {
    const result = spawn("where.exe", ["pwsh.exe"], {
      encoding: "utf-8",
      timeout: POWERSHELL_FLAVOR_PROBE_TIMEOUT_MS,
      windowsHide: true,
    } as any);
    return result.status === 0 && !!String(result.stdout || "").trim();
  } catch {
    return false;
  }
}

// Detects which PowerShell flavor is on this machine, to feed exec_command's
// tool description (see execCommandDescription in ../exec-command/guidance.ts).
//
// createExecCommandTools() calls this exactly once per tool-set build, and
// bakes the result directly into the `description` string literal on the
// tool object at that moment (lib/exec-command/tool.ts). Tool-set builds
// happen once per session-construction event — createSession,
// executeIsolated's temp session, the bridge owner-session setup,
// runAgentSession's temp/phone session — never once per turn and never once
// per LLM call. That description string is hashed into the LLM provider's
// cache-prefix contract (lib/llm/cache-prefix-contract.ts): once a session's
// tools are built, the description must never change again for that
// session's lifetime, or it reads as a cache-prefix drift.
//
// That's why this function deliberately does NOT memoize its verdict across
// calls, unlike the sandboxed-PowerShell-startup-probe cache below (that one
// caches on purpose, because it verifies runtime execution behavior, not a
// one-shot description bake). Memoizing here would let a pwsh install (or
// uninstall) that happens between two tool-set builds leak the *previous*
// build's stale verdict into the next one. The only thing allowed to see an
// updated pwsh install is the next tool-set build — a new session, a new
// isolated sub-session, a fresh-compact rebuild — which naturally gets a
// fresh probe because it calls this function again from scratch. The
// where.exe probe itself is cheap (tens of milliseconds) and only runs at
// tool-set build time, not on any per-turn or per-command hot path.
export function detectWin32PowerShellFlavor({
  platform = process.platform,
  spawn = spawnSync,
}: { platform?: NodeJS.Platform; spawn?: typeof spawnSync } = {}): Win32PowerShellFlavor | null {
  if (platform !== "win32") return null;
  return probePwshOnPath(spawn) ? "pwsh" : "windows-powershell";
}

export function prepareSandboxRuntime(runtimeInfo, { hanakoHome, kind }) {
  if (!runtimeInfo) return runtimeInfo;
  const sourceRoot = runtimeSourceRoot(runtimeInfo, kind);
  const primaryPath = runtimePrimaryPath(runtimeInfo);
  const targetRoot = ensureCachedRuntimeRoot({ sourceRoot, primaryPath, hanakoHome, kind, bundled: !!runtimeInfo.bundledRoot });
  if (targetRoot === sourceRoot) return runtimeInfo;

  return {
    ...runtimeInfo,
    bundledRoot: runtimeInfo.bundledRoot
      ? targetRoot
      : runtimeInfo.bundledRoot,
    git: rewriteRuntimePath(runtimeInfo.git, sourceRoot, targetRoot),
    shell: rewriteRuntimePath(runtimeInfo.shell, sourceRoot, targetRoot),
    executable: rewriteRuntimePath(runtimeInfo.executable, sourceRoot, targetRoot),
  };
}
