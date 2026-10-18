import fs from "fs";
import path from "path";
import { createRequire } from "node:module";

export const DEFERRED_BRIDGE_SDK_PACKAGES = Object.freeze([
  "@larksuiteoapi/node-sdk",
  "node-telegram-bot-api",
]);

export const PI_RUNTIME_PACKAGES = Object.freeze([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
]);

// Bundling renames createRequire bindings, which NFT cannot reliably follow.
// Trace these CJS entrypoints directly so hoisted transitive dependencies survive.
export function resolveDeferredBridgeSdkEntrypoints(rootDir, packageNames) {
  const require = createRequire(path.resolve(rootDir, "package.json"));
  return DEFERRED_BRIDGE_SDK_PACKAGES.filter((name) => packageNames.includes(name)).map((name) => {
    const entry = fs.realpathSync(require.resolve(name));
    // Resolve aliases such as macOS /var, keeping node_modules beneath the
    // real runtime root so package or node_modules links cannot escape it.
    const nodeModules = path.join(fs.realpathSync(rootDir), "node_modules");
    const relative = path.relative(nodeModules, entry);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Deferred bridge SDK ${name} resolved outside its runtime tree: ${entry}`);
    }
    return entry;
  });
}

/**
 * Read and JSON-parse a file, retrying on EMFILE/ENFILE (file handle exhaustion).
 *
 * Windows has no ulimit-equivalent, so nft trace can exhaust the OS handle quota.
 * EMFILE means "temporarily can't open" — the file exists and is valid. Treating
 * it the same as ENOENT is a contract bug: it maps an I/O resource error onto a
 * product-integrity failure, which is exactly the misdiagnosis that kills Windows builds.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {{ maxRetries?: number, baseDelayMs?: number }} [opts]
 * @returns {unknown} Parsed JSON value.
 * @throws On ENOENT, JSON parse failure, or EMFILE after all retries.
 */
export function readPackageJsonWithRetry(filePath, { maxRetries = 5, baseDelayMs = 50 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      const code = err && err.code;
      // EMFILE = too many open file descriptors (Windows/macOS kernel limit hit).
      // ENFILE = system-wide file table full (rarer but same transient nature).
      // Both are recoverable: wait and retry. Do NOT treat as "file missing".
      if (code === "EMFILE" || code === "ENFILE") {
        lastErr = err;
        if (attempt < maxRetries) {
          // Synchronous exponential backoff — this is a build script, blocking is fine.
          // Atomics.wait on a fresh SharedArrayBuffer gives a true sync sleep without
          // spinning and without requiring a running event loop.
          const delayMs = baseDelayMs * Math.pow(2, attempt);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
          continue;
        }
        // Exhausted retries: re-throw the original EMFILE so the caller knows why.
        throw lastErr;
      }
      // ENOENT = file truly absent. JSON SyntaxError = corrupt file.
      // All other errors: propagate as-is.
      throw err;
    }
  }
}

function getLockedPackageVersion(rootLock, packageName) {
  const packagePath = `node_modules/${packageName}`;
  const lockedPackage = rootLock?.packages?.[packagePath];
  if (!lockedPackage?.version) {
    throw new Error(`[build-server] package-lock.json does not contain ${packagePath}`);
  }
  return lockedPackage.version;
}

export function buildExternalPackage(
  rootPkg,
  externalDeps,
  { rootLock, pinnedTransitiveDeps = [] } = {},
) {
  const dependencies = {};

  for (const [packageName, requestedVersion] of Object.entries(externalDeps)) {
    dependencies[packageName] = rootLock
      ? getLockedPackageVersion(rootLock, packageName)
      : requestedVersion;
  }

  for (const packageName of pinnedTransitiveDeps) {
    dependencies[packageName] = getLockedPackageVersion(rootLock, packageName);
  }

  // Pi's caret-ranged family must match the reviewed root exactly, including
  // members reached transitively from an external entrypoint.
  let overrides;
  if (PI_RUNTIME_PACKAGES.some(packageName => Object.hasOwn(dependencies, packageName))) {
    overrides = Object.fromEntries(PI_RUNTIME_PACKAGES.map(packageName => [
      packageName, getLockedPackageVersion(rootLock, packageName),
    ]));
    if (new Set(Object.values(overrides)).size !== 1) {
      throw new Error("[build-server] Pi runtime family must use one root-lock version");
    }
  }

  return {
    name: "hanako-server",
    version: rootPkg.version,
    type: "module",
    dependencies,
    ...(overrides ? { overrides } : {}),
  };
}

function resolveLockedDependency(packages, parent, name) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`[build-server] invalid locked dependency name: ${name}`);
  }
  // Lock paths always use '/', including on Windows. Keep nested versions in
  // their original locations; resolving only by package name loses consumers.
  for (let current = parent; ; current = path.posix.dirname(current)) {
    const candidate = path.posix.join(current, "node_modules", name);
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!current || current === ".") return undefined;
  }
}

function filterExternalOverrides(rules, names, rootPkg) {
  const result = {};
  for (const [selector, value] of Object.entries(rules || {})) {
    const versionIndex = selector.indexOf("@", 1);
    const name = versionIndex < 0 ? selector : selector.slice(0, versionIndex);
    if (selector !== "." && !names.has(name)) continue;
    if (typeof value === "string") {
      // A $reference refers to the original root declaration, which need not
      // be a direct dependency of the smaller artifact manifest.
      const referenced = value.startsWith("$") ? value.slice(1) : undefined;
      const spec = referenced
        ? rootPkg.dependencies?.[referenced] || rootPkg.optionalDependencies?.[referenced]
          || rootPkg.devDependencies?.[referenced]
        : value;
      if (!spec) throw new Error(`[build-server] unresolved override reference: ${value}`);
      result[selector] = spec;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const children = filterExternalOverrides(value, names, rootPkg);
      if (Object.keys(children).length) result[selector] = children;
    } else {
      throw new Error(`[build-server] invalid override: ${selector}`);
    }
  }
  return result;
}

/** Project the root lock without re-resolving, hoisting or dropping platforms. */
export function buildExternalDependencyPlan(rootPkg, externalDeps, options = {}) {
  const { rootLock } = options;
  if (rootLock?.lockfileVersion !== 3 || !rootLock.packages?.[""]) {
    throw new Error("[build-server] external dependencies require a complete v3 root lock");
  }
  const externalPkg = buildExternalPackage(rootPkg, externalDeps, options);
  const selected = new Set();
  function visit(location) {
    if (selected.has(location)) return;
    const entry = rootLock.packages[location];
    if (!entry || entry.link || !entry.version || !entry.resolved || !entry.integrity) {
      throw new Error(`[build-server] incomplete or linked root-lock package: ${location}`);
    }
    if (entry.dev) {
      throw new Error(`[build-server] external closure contains dev-only package: ${location}`);
    }
    selected.add(location);
    const dependencies = { ...entry.peerDependencies, ...entry.dependencies, ...entry.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      const target = resolveLockedDependency(rootLock.packages, location, name);
      if (target) visit(target);
      else if (!Object.hasOwn(entry.dependencies || {}, name)
        && !Object.hasOwn(entry.optionalDependencies || {}, name)
        && entry.peerDependenciesMeta?.[name]?.optional) continue;
      else throw new Error(`[build-server] missing root-lock dependency: ${location} -> ${name}`);
    }
  }
  for (const name of Object.keys(externalPkg.dependencies)) {
    visit(resolveLockedDependency(rootLock.packages, "", name));
  }
  const names = new Set([...selected].map(location => location.split("node_modules/").at(-1)));
  const overrides = filterExternalOverrides(rootPkg.overrides, names, rootPkg);
  if (PI_RUNTIME_PACKAGES.some(name => names.has(name))) {
    const versions = PI_RUNTIME_PACKAGES.map(name => getLockedPackageVersion(rootLock, name));
    if (new Set(versions).size !== 1 || [...selected].some(location =>
      PI_RUNTIME_PACKAGES.includes(location.split("node_modules/").at(-1))
      && rootLock.packages[location].version !== versions[0])) {
      throw new Error("[build-server] Pi runtime family must use one root-lock version");
    }
    for (const name of PI_RUNTIME_PACKAGES) overrides[name] = versions[0];
  }
  if (Object.keys(overrides).length) externalPkg.overrides = overrides;
  // Copy every field, including optional/devOptional/peer, os/cpu/libc and
  // lifecycle metadata. The host's installed tree is never the lock source.
  const externalLock = {
    name: externalPkg.name,
    version: externalPkg.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: externalPkg.name, version: externalPkg.version, dependencies: externalPkg.dependencies },
      ...Object.fromEntries([...selected].sort().map(location => [location, rootLock.packages[location]])),
    },
  };
  return structuredClone({ externalPkg, externalLock });
}

/** Read-only validation with the SAME npm implementation used by target ci. */
export async function verifyExternalDependencyTree({ outDir, externalLock, cachedNpmCli, installed = false }) {
  const require = createRequire(path.resolve(cachedNpmCli));
  const Arborist = require("@npmcli/arborist");
  const arb = new Arborist({ path: outDir, offline: true, audit: false, fund: false });
  const tree = installed ? await arb.loadActual({ forceActual: true }) : await arb.loadVirtual();
  const installedLock = installed
    ? JSON.parse(fs.readFileSync(path.join(outDir, "node_modules", ".package-lock.json"), "utf-8"))
    : externalLock;
  for (const node of tree.inventory.values()) {
    const location = node.location;
    const expected = externalLock.packages[location];
    if (!expected || node.isLink || node.package.version !== expected.version) {
      throw new Error(`[build-server] dependency differs from derived lock: ${location}`);
    }
    if (location) {
      const metadata = installedLock.packages?.[location];
      for (const key of ["version", "resolved", "integrity"]) {
        if (metadata?.[key] !== expected[key]) {
          throw new Error(`[build-server] installed ${key} differs from derived lock: ${location}`);
        }
      }
    }
    const declarations = { ...expected.peerDependencies, ...expected.dependencies, ...expected.optionalDependencies };
    if (node.edgesOut.size !== Object.keys(declarations).length
      || Object.entries(declarations).some(([name, spec]) => node.edgesOut.get(name)?.rawSpec !== spec)) {
      throw new Error(`[build-server] dependency declarations differ from derived lock: ${location}`);
    }
    for (const edge of node.edgesOut.values()) {
      // Optional platform packages may be absent after ci, but their lock
      // entries were required before installation. Only optional peers may
      // be absent from the projected graph itself.
      if (!edge.to && (edge.type === "peerOptional" || (installed && edge.optional))) continue;
      const target = resolveLockedDependency(externalLock.packages, location, edge.name);
      if (!edge.valid || !edge.to || edge.to.location !== target) {
        throw new Error(`[build-server] invalid locked dependency edge: ${location} -> ${edge.name}`);
      }
    }
  }
}

function packageNameFromBareSpecifier(specifier) {
  if (
    typeof specifier !== "string"
    || specifier.length === 0
    || specifier.startsWith(".")
    || specifier.startsWith("/")
    || specifier.startsWith("node:")
  ) {
    return null;
  }

  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

export function collectBareImportPackageNames(source) {
  const packages = new Set();
  const importPattern = /^\s*import\s+(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["']/gm;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const packageName = packageNameFromBareSpecifier(match[1]);
    if (packageName) packages.add(packageName);
  }
  return [...packages].sort();
}

export function collectInstalledOptionalDependencyDirs(nmDir, packageNames) {
  const dirs = [];

  for (const packageName of packageNames) {
    const packageJsonPath = path.join(nmDir, packageName, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    } catch {
      continue;
    }

    for (const optionalName of Object.keys(pkg.optionalDependencies || {})) {
      const optionalDir = path.join(nmDir, optionalName);
      if (fs.existsSync(optionalDir)) {
        dirs.push(path.resolve(optionalDir));
      }
    }
  }

  return dirs;
}

export function buildJiebaRuntimeSmokeScript() {
  return [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(new URL('./package.json', import.meta.url));",
    "const { Jieba } = require('@node-rs/jieba');",
    "const { dict } = require('@node-rs/jieba/dict');",
    "const jieba = Jieba.withDict(dict);",
    "jieba.loadDict(Buffer.from('session_search 1000 nz\\nA2A通信 1000 nz\\n聊天记录 1000 nz', 'utf8'));",
    "const tokens = jieba.cutForSearch('聊天记录 A2A通信 session_search', true);",
    "for (const token of ['聊天记录', 'A2A通信', 'session_search']) {",
    "  if (!tokens.includes(token)) {",
    "    throw new Error(`@node-rs/jieba runtime smoke failed: missing ${token} from ${tokens.join('|')}`);",
    "  }",
    "}",
    "console.log('[build-server] jieba runtime smoke passed');",
    "",
  ].join("\n");
}

export function buildBetterSqliteRuntimeSmokeScript() {
  return [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(new URL('./package.json', import.meta.url));",
    "const Database = require('better-sqlite3');",
    "const db = new Database(':memory:');",
    "try {",
    "  const row = db.prepare('select 1 as ok').get();",
    "  if (row?.ok !== 1) {",
    "    throw new Error(`better-sqlite3 runtime smoke failed: ${JSON.stringify(row)}`);",
    "  }",
    "} finally {",
    "  db.close();",
    "}",
    "console.log('[build-server] better-sqlite3 runtime smoke passed');",
    "",
  ].join("\n");
}

/**
 * Unlike the two smokes above, this one goes through a dynamic `import()`
 * rather than createRequire, because that is how the packaged server reaches
 * this package: the bundle keeps it external and imports it lazily, so the
 * ESM-importing-CJS interop is part of what needs to hold. Both export shapes
 * are accepted for the same reason the runtime loader accepts both.
 *
 * The assertion deliberately stops at "a real conversion produced the source
 * values" instead of matching the exact table layout — the layout belongs to
 * the upstream Markdown serializer, and pinning it here would turn a harmless
 * upstream formatting change into a failed build.
 */
export function buildAnydocRuntimeSmokeScript() {
  return [
    "const mod = await import('@firecrawl/anydoc');",
    "const api = mod && typeof mod.toMarkdownBytes === 'function' ? mod : mod?.default;",
    "if (typeof api?.toMarkdownBytes !== 'function') {",
    "  throw new Error('@firecrawl/anydoc runtime smoke failed: toMarkdownBytes is not callable');",
    "}",
    "const markdown = await api.toMarkdownBytes(Buffer.from('a,b\\n1,2'), 'csv');",
    "if (typeof markdown !== 'string' || !markdown.includes('1') || !markdown.includes('2')) {",
    "  throw new Error(`@firecrawl/anydoc runtime smoke failed: ${JSON.stringify(markdown)}`);",
    "}",
    "console.log('[build-server] @firecrawl/anydoc runtime smoke passed');",
    "",
  ].join("\n");
}

function collectRuntimeExportTargets(exportValue, targets = []) {
  if (typeof exportValue === "string") {
    targets.push(exportValue);
    return targets;
  }

  if (!exportValue || typeof exportValue !== "object") {
    return targets;
  }

  for (const [condition, value] of Object.entries(exportValue)) {
    if (condition === "types") continue;
    collectRuntimeExportTargets(value, targets);
  }

  return targets;
}

function getRootExport(exportsField) {
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return exportsField;
  }

  if (Object.hasOwn(exportsField, ".")) {
    return exportsField["."];
  }

  const keys = Object.keys(exportsField);
  const isSubpathMap = keys.some((key) => key.startsWith("."));
  return isSubpathMap ? undefined : exportsField;
}

export function verifyExternalEntrypoints(outDir, packageNames, { readRetries, readBaseDelayMs } = {}) {
  const failures = [];
  const retryOpts = {};
  if (readRetries !== undefined) retryOpts.maxRetries = readRetries;
  if (readBaseDelayMs !== undefined) retryOpts.baseDelayMs = readBaseDelayMs;

  for (const packageName of packageNames) {
    const packageDir = path.join(outDir, "node_modules", packageName);
    const packageJsonPath = path.join(packageDir, "package.json");

    let pkg;
    try {
      // readPackageJsonWithRetry retries on EMFILE/ENFILE (transient handle exhaustion).
      // It only throws ENOENT or parse errors after retries — those are genuine failures.
      pkg = readPackageJsonWithRetry(packageJsonPath, retryOpts);
    } catch (err) {
      const code = err && err.code;
      // EMFILE/ENFILE after all retries: the file exists but we couldn't open it.
      // This is an I/O resource failure, NOT a missing package. Don't count it as
      // a missing entrypoint — doing so is the contract bug that caused #1307.
      // Re-throw so the caller (build-server.mjs) sees a hard I/O error and can
      // decide to abort with an accurate message rather than a misleading "missing" report.
      if (code === "EMFILE" || code === "ENFILE") {
        throw err;
      }
      // ENOENT: package.json truly absent — the package was not installed.
      // JSON SyntaxError: package.json is corrupt.
      // Both are genuine product-integrity failures.
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${packageName}: ${msg}`);
      continue;
    }

    const rootExport = getRootExport(pkg.exports);
    const targets = rootExport === undefined
      ? [pkg.main, pkg.module].filter(Boolean)
      : collectRuntimeExportTargets(rootExport);

    for (const target of targets) {
      if (typeof target !== "string" || !target.startsWith("./") || target.includes("*")) {
        continue;
      }

      const targetPath = path.join(packageDir, target);
      if (!fs.existsSync(targetPath)) {
        failures.push(`${packageName}: ${target} resolves to missing file ${targetPath}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error([
      "[build-server] external package entrypoint verification failed:",
      ...failures.map((failure) => `  - ${failure}`),
    ].join("\n"));
  }
}
