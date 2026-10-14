// Desktop-only identity. Never rewrite HANA_HOME or inspect/copy legacy storage.
const nodeFs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const NAMESPACE = "HanaAgent-userData-v2";
const MARKER = ".hana-desktop-profile.json";
const NAMESPACE_MARKER = ".hana-desktop-namespace.json";
const NEW_PROFILE_FLAG = "--hana-new-isolated-desktop-profile";
const NEW_PROFILE_ENV = "HANA_NEW_ISOLATED_DESKTOP_PROFILE";
const ERROR_CODE = "HANA_DESKTOP_PROFILE_STARTUP";

function fail(message) {
  throw Object.assign(new Error(`Desktop profile startup stopped.\n${message}`), { code: ERROR_CODE });
}

function lstatIfPresent(filePath, fs) {
  try { return fs.lstatSync(filePath); }
  catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Missing suffixes are only a read-only prediction. A persisted identity requires
// an existing HOME, rechecked below. ENOTDIR/EACCES/ELOOP and dangling links fail.
function canonicalizeDesktopHome(input, fs = nodeFs) {
  let ancestor = path.resolve(input);
  const suffix = [];
  while (!lstatIfPresent(ancestor, fs)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail(`Cannot resolve directory: ${input}`);
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const canonical = fs.realpathSync.native(ancestor);
  if (!fs.statSync(canonical).isDirectory()) fail(`Not a directory: ${ancestor}`);
  return path.join(canonical, ...suffix);
}

function resolveDesktopIdentity(hanakoHome, defaultHome, fs = nodeFs) {
  const canonicalHome = canonicalizeDesktopHome(hanakoHome, fs);
  const canonicalDefault = canonicalizeDesktopHome(defaultHome, fs);
  const devHome = path.join(path.dirname(path.resolve(defaultHome)), ".hanako-dev");
  const canonicalDev = canonicalizeDesktopHome(devHome, fs);
  const kind = canonicalHome === canonicalDefault ? "default"
    : canonicalHome === canonicalDev ? "dev" : "custom";
  const digest = createHash("sha256")
    .update(`hana-desktop-user-data-v2\0${process.platform}\0${canonicalHome}`, "utf8")
    .digest("hex");
  const appName = kind === "default" ? "Hanako" : kind === "dev" ? "Hanako-dev"
    : path.join(NAMESPACE, digest);
  return { canonicalHome, kind, digest, appName, devHome };
}

// Reproduce the *old* Windows comparison only to locate legacy candidates.
// Case folding is never used for the new identity or for directory equivalence.
function legacyAppName(home, defaultHome) {
  const resolved = path.resolve(home);
  const defaultResolved = path.resolve(defaultHome);
  if (resolved === defaultResolved || (process.platform === "win32"
    && resolved.toLowerCase() === defaultResolved.toLowerCase())) return "Hanako";
  const suffix = path.basename(resolved).replace(/^\./, "");
  return suffix ? suffix.charAt(0).toUpperCase() + suffix.slice(1) : "Hanako";
}

function readNewProfileChoice(argv = [], env = {}) {
  const raw = env[NEW_PROFILE_ENV];
  if ((raw !== undefined && !["", "0", "1"].includes(raw))
    || argv.some(arg => arg.startsWith(`${NEW_PROFILE_FLAG}=`))
    || (argv.includes(NEW_PROFILE_FLAG) && raw === "0")) {
    fail(`Invalid profile option. Use exactly ${NEW_PROFILE_FLAG} or ${NEW_PROFILE_ENV}=1 only to create a new isolated desktop profile. Remove the option to cancel.`);
  }
  return argv.includes(NEW_PROFILE_FLAG) || raw === "1";
}

function requirePlainDirectory(dir, fs) {
  const stat = lstatIfPresent(dir, fs);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    fail(`Desktop profile path must be a directory, not a file or symlink: ${dir}`);
  }
  return stat;
}

function readMarker(markerPath, fs) {
  const stat = lstatIfPresent(markerPath, fs);
  if (!stat) {
    fail(`Unmarked desktop profile directory: ${path.dirname(markerPath)}\nIt may contain an interrupted initialization or unrelated data. Inspect it and move it aside manually before retrying; even ${NEW_PROFILE_FLAG} cannot adopt or overwrite it.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) {
    fail(`Invalid desktop profile marker: ${markerPath}. Leave this directory intact and inspect it before retrying.`);
  }
  try { return JSON.parse(fs.readFileSync(markerPath, "utf8")); }
  catch (err) { fail(`Cannot read desktop profile marker: ${markerPath}\n${err.message}`); }
}

function checkMarker(userData, identity, fs) {
  const markerPath = path.join(userData, MARKER);
  const marker = readMarker(markerPath, fs);
  if (marker?.version !== 2 || marker.platform !== process.platform
    || marker.canonicalHome !== identity.canonicalHome || marker.digest !== identity.digest
    || !["no-legacy-profile", "explicit-new-profile"].includes(marker.initializedBy)) {
    fail(`Desktop profile marker does not match this canonical HOME: ${markerPath}\nHOME: ${identity.canonicalHome}. Leave the directory intact; the new-profile option cannot override this check.`);
  }
}

function checkNamespace(namespaceDir, canonicalAppData, fs) {
  requirePlainDirectory(namespaceDir, fs);
  const marker = readMarker(path.join(namespaceDir, NAMESPACE_MARKER), fs);
  if (marker?.version !== 2 || marker.appData !== canonicalAppData
    || fs.realpathSync.native(namespaceDir) !== namespaceDir) {
    fail(`Desktop profile namespace marker or path does not match: ${namespaceDir}. Leave it intact and inspect it before retrying.`);
  }
}

function writeMarker(markerPath, marker, fs) {
  const fd = fs.openSync(markerPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(marker) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function prepareDesktopUserData({ hanakoHome, defaultHome, appData, argv, env, fsImpl: fs = nodeFs }) {
  try {
    const explicitChoice = readNewProfileChoice(argv, env);
    const identity = resolveDesktopIdentity(hanakoHome, defaultHome, fs);
    const canonicalAppData = canonicalizeDesktopHome(appData, fs);
    const userData = path.join(canonicalAppData, identity.appName);
    // bootstrap creates HANA_HOME/diagnostics before main. Do not create or
    // canonicalize business storage on behalf of the desktop profile selector.
    const homeStat = fs.statSync(hanakoHome);
    if (!homeStat.isDirectory()) fail(`HANA_HOME must be an existing directory: ${hanakoHome}`);
    const assertStable = () => {
      const current = resolveDesktopIdentity(hanakoHome, defaultHome, fs);
      const stat = fs.statSync(hanakoHome);
      if (current.canonicalHome !== identity.canonicalHome || current.appName !== identity.appName
        || stat.dev !== homeStat.dev || stat.ino !== homeStat.ino
        || canonicalizeDesktopHome(appData, fs) !== canonicalAppData) {
        fail(`Directory identity changed during desktop profile initialization. Retry with a stable HANA_HOME: ${hanakoHome}`);
      }
    };
    const legacyPaths = [...new Set([hanakoHome, identity.canonicalHome]
      .map(home => path.join(canonicalAppData, legacyAppName(home, defaultHome))))];
    // Only probe directory metadata, never any legacy cookie/connection content.
    const existingLegacy = () => legacyPaths.filter(candidate => {
      const stat = lstatIfPresent(candidate, fs);
      if (!stat) return false;
      if (!fs.statSync(candidate).isDirectory()) fail(`Legacy desktop profile is not a directory: ${candidate}`);
      return true;
    });

    if (identity.kind !== "custom") {
      const conventionalHome = identity.kind === "default" ? defaultHome : identity.devHome;
      if (path.resolve(hanakoHome) !== path.resolve(conventionalHome)) {
        const otherProfiles = existingLegacy().filter(candidate => candidate !== userData);
        if (otherProfiles.length) {
          fail(`Historical HOME alias has a different desktop profile:\n${otherProfiles.join("\n")}\nThe canonical ${identity.kind} profile is: ${userData}\nTo explicitly continue that preserved profile, launch with HANA_HOME set to ${path.resolve(conventionalHome)}. The alias profile stays in place; no data is merged. ${NEW_PROFILE_FLAG} cannot create a fresh profile for this reserved identity.`);
        }
      }
      assertStable();
      // Preserve legacy sessionData behavior for the default and conventional dev.
      if (!lstatIfPresent(userData, fs)) fs.mkdirSync(userData, { recursive: true });
      if (!fs.statSync(userData).isDirectory()) fail(`Not a desktop profile directory: ${userData}`);
      assertStable();
      return { ...identity, userData, sessionData: null };
    }

    const namespaceDir = path.join(canonicalAppData, NAMESPACE);
    const namespaceExists = requirePlainDirectory(namespaceDir, fs);
    if (namespaceExists) checkNamespace(namespaceDir, canonicalAppData, fs);
    if (requirePlainDirectory(userData, fs)) {
      checkMarker(userData, identity, fs);
    } else {
      const oldPaths = existingLegacy();
      if (oldPaths.length && !explicitChoice) {
        fail(`An earlier desktop profile exists:\n${oldPaths.join("\n")}\nNew isolated profile:\n${userData}\nCanonical HOME: ${identity.canonicalHome}\nTo create this new, empty desktop profile and leave the old profile in place, relaunch the same HOME with ${NEW_PROFILE_FLAG} or ${NEW_PROFILE_ENV}=1. Remove the option after this one successful initialization. To cancel, leave the option unset.\nThe new profile does not inherit browser logins, remote connections, or some UI settings. Chats, model credentials and databases in HANA_HOME are unchanged. No profile was opened or migrated.`);
      }
      assertStable();
      if (!namespaceExists) {
        fs.mkdirSync(canonicalAppData, { recursive: true });
        let created = false;
        try { fs.mkdirSync(namespaceDir); created = true; }
        catch (err) { if (err.code !== "EEXIST") throw err; }
        if (created) {
          requirePlainDirectory(namespaceDir, fs);
          if (fs.realpathSync.native(namespaceDir) !== namespaceDir) fail(`Desktop profile parent changed: ${namespaceDir}`);
          writeMarker(path.join(namespaceDir, NAMESPACE_MARKER), { version: 2, appData: canonicalAppData }, fs);
        }
      }
      checkNamespace(namespaceDir, canonicalAppData, fs);
      try {
        // Exclusive directory creation: a concurrent/aborted creator is never
        // treated as consent. Retry only once its valid marker is present.
        fs.mkdirSync(userData);
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        requirePlainDirectory(userData, fs);
        checkMarker(userData, identity, fs);
        checkNamespace(namespaceDir, canonicalAppData, fs);
        if (fs.realpathSync.native(userData) !== userData) fail(`Desktop profile path changed: ${userData}`);
        assertStable();
        return { ...identity, userData, sessionData: userData };
      }
      assertStable();
      requirePlainDirectory(userData, fs);
      if (fs.realpathSync.native(userData) !== userData) fail(`Desktop profile path changed: ${userData}`);
      writeMarker(path.join(userData, MARKER), { version: 2, platform: process.platform,
        canonicalHome: identity.canonicalHome, digest: identity.digest,
        initializedBy: explicitChoice ? "explicit-new-profile" : "no-legacy-profile" }, fs);
      checkMarker(userData, identity, fs);
    }
    assertStable();
    checkNamespace(namespaceDir, canonicalAppData, fs);
    requirePlainDirectory(userData, fs);
    if (fs.realpathSync.native(userData) !== userData) fail(`Desktop profile path changed: ${userData}`);
    return { ...identity, userData, sessionData: userData };
  } catch (err) {
    if (err.code === ERROR_CODE) throw err;
    fail(`${err.code || "Filesystem error"}: ${err.message}\nCheck the HOME and desktop profile paths and their access permissions before retrying. No fallback profile or automatic migration is used.`);
  }
}

module.exports = { canonicalizeDesktopHome, resolveDesktopIdentity, prepareDesktopUserData };
