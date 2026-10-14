import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { configureClientSingleInstance, getUserDataAppName } from "../desktop/src/shared/single-instance-lock.cjs";
import { resolveDesktopIdentity } from "../desktop/src/shared/user-data-identity.cjs";

const FLAG = "--hana-new-isolated-desktop-profile";
const ENV = "HANA_NEW_ISOLATED_DESKTOP_PROFILE";
const MARKER = ".hana-desktop-profile.json";
let root: string;
let defaultHome: string;
let devHome: string;
let appData: string;
let canonicalAppData: string;
function mkdir(p: string) { fs.mkdirSync(p, { recursive: true }); return p; }
function entity(p: string) {
  const { dev, ino } = fs.statSync(p, { bigint: true });
  return { dev, ino };
}
function expectedIdentity(home: string) {
  const canonicalHome = fs.realpathSync.native(home);
  const digest = createHash("sha256")
    .update(`hana-desktop-user-data-v2\0${process.platform}\0${canonicalHome}`, "utf8").digest("hex");
  return { canonicalHome, digest };
}
function tree(p: string): unknown {
  if (!fs.existsSync(p)) return null;
  if (!fs.statSync(p).isDirectory()) return fs.readFileSync(p).toString("hex");
  return Object.fromEntries(fs.readdirSync(p).sort().map(n => [n, tree(path.join(p, n))]));
}
function launch(home: string, options: Record<string, unknown> = {}, appDataPath = appData) {
  const selected: Record<string, string> = {};
  const events: string[] = [];
  const app = {
    isReady: () => false,
    getPath: (name: string) => name === "appData" ? appDataPath : selected[name],
    setPath: vi.fn((name: string, value: string) => { selected[name] = value; events.push(name); }),
    requestSingleInstanceLock: vi.fn(() => { events.push("lock"); return true; }),
    on: vi.fn(), exit: vi.fn(), quit: vi.fn(),
  };
  const run = () => configureClientSingleInstance(app, { hanakoHome: home, defaultHome, ...options });
  return { run, app, selected, events };
}
function target(home: string) { return path.join(canonicalAppData, getUserDataAppName(home, defaultHome)); }
function legacy(name: string) {
  const dir = mkdir(path.join(appData, name));
  fs.writeFileSync(path.join(dir, "synthetic-login.json"), '{"token":"SYNTHETIC-OLD-TOKEN","cookie":"SYNTHETIC"}');
  return dir;
}
function expectBlocked(home: string, options = {}, pattern: RegExp = /desktop profile/i) {
  const before = tree(root);
  const candidate = launch(home, options);
  expect(candidate.run).toThrow(pattern);
  expect(candidate.app.setPath).not.toHaveBeenCalled();
  expect(candidate.app.requestSingleInstanceLock).not.toHaveBeenCalled();
  expect(tree(root)).toEqual(before);
}
beforeEach(() => {
  // Exercise raw temp aliases; derive expectations separately via native realpath.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-profile-contract-"));
  defaultHome = mkdir(path.join(root, "os-home", ".hanako"));
  devHome = mkdir(path.join(root, "os-home", ".hanako-dev"));
  appData = mkdir(path.join(root, "appdata"));
  canonicalAppData = fs.realpathSync.native(appData);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("pre-ready desktop profile identity and initialization", () => {
  it.each([".hanako", ".hanako-dev", "same"])("isolates different full HOMEs named %s", name => {
    const a = mkdir(path.join(root, "a", name));
    const b = mkdir(path.join(root, "b", name));
    const first = launch(a); const second = launch(b);
    first.run(); second.run();
    expect(entity(a)).not.toEqual(entity(b));
    for (const [home, candidate] of [[a, first], [b, second]] as const) {
      expect(candidate.selected.userData).toBe(path.join(canonicalAppData, "HanaAgent-userData-v2", expectedIdentity(home).digest));
      expect(candidate.selected.sessionData).toBe(candidate.selected.userData);
    }
    expect(first.selected.userData).not.toBe(second.selected.userData);
    expect(entity(first.selected.userData)).not.toEqual(entity(second.selected.userData));
    fs.writeFileSync(path.join(first.selected.userData, "isolation-sentinel"), "SYNTHETIC-A");
    expect(fs.existsSync(path.join(second.selected.userData, "isolation-sentinel"))).toBe(false);
    expect(first.selected.userData).toMatch(/HanaAgent-userData-v2[/\\][a-f0-9]{64}$/);
    expect(first.selected.userData).not.toBe(path.join(canonicalAppData, name === ".hanako" ? "Hanako" : "Hanako-dev"));
  });
  it("separates dot stripping and capitalization collisions", () => {
    const paths = ["a/foo", "a/.foo", "b/Foo"].map(n => mkdir(path.join(root, n)));
    expect(new Set(paths.map(target)).size).toBe(3);
  });
  it.each(["default", "dev"])("preserves ordinary %s without a marker or new sessionData override", which => {
    const home = which === "default" ? defaultHome : devHome;
    const name = which === "default" ? "Hanako" : "Hanako-dev";
    const old = legacy(name); const oldEntity = entity(old);
    const before = tree(root);
    const candidate = launch(home); candidate.run();
    expect(candidate.selected.userData).toBe(path.join(canonicalAppData, name));
    expect(entity(candidate.selected.userData)).toEqual(oldEntity);
    expect(candidate.selected.sessionData).toBeUndefined();
    expect(candidate.events).toEqual(["userData", "lock"]);
    expect(fs.existsSync(path.join(old, MARKER))).toBe(false);
    expect(tree(root)).toEqual(before);
  });
  it("sets both new paths before acquiring the lock without changing business HOME", () => {
    const home = mkdir(path.join(root, "custom"));
    fs.writeFileSync(path.join(home, "auth.json"), "SYNTHETIC-MODEL-CREDENTIAL");
    const before = tree(home); const env = { HANA_HOME: home };
    const candidate = launch(home, { env }); candidate.run();
    expect(candidate.events).toEqual(["userData", "sessionData", "lock"]);
    expect(candidate.selected.sessionData).toBe(candidate.selected.userData);
    expect(tree(home)).toEqual(before);
    expect(env.HANA_HOME).toBe(home);
  });
  it.each([{}, { argv: [] }, { env: { [ENV]: "0" } }])("stops without a choice with zero profile writes: %j", options => {
    const home = mkdir(path.join(root, "existing")); legacy("Existing");
    expectBlocked(home, options, /--hana-new-isolated-desktop-profile/);
  });
  it.each([{ argv: [FLAG] }, { env: { [ENV]: "1" } }])("creates once with explicit choice, preserves old bytes and copies no token: %j", options => {
    const home = mkdir(path.join(root, "existing")); const old = legacy("Existing");
    const oldBytes = tree(old); const homeBytes = tree(home);
    const first = launch(home, options); first.run();
    const marker = path.join(first.selected.userData, MARKER);
    const identity = expectedIdentity(home);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({
      version: 2, platform: process.platform, ...identity, initializedBy: "explicit-new-profile",
    });
    expect(first.selected.userData).toBe(path.join(canonicalAppData, "HanaAgent-userData-v2", identity.digest));
    expect(first.selected.sessionData).toBe(first.selected.userData);
    expect(fs.readdirSync(first.selected.userData)).toEqual([MARKER]);
    expect(tree(first.selected.userData)).not.toEqual(tree(old));
    const beforeRestart = tree(root); const second = launch(home); second.run();
    expect(second.selected).toEqual(first.selected);
    expect(tree(root)).toEqual(beforeRestart);
    expect(tree(old)).toEqual(oldBytes); expect(tree(home)).toEqual(homeBytes);
  });
  it("marks automatic initialization when no old profile exists, then reuses it even if one appears", () => {
    const home = mkdir(path.join(root, "fresh")); const first = launch(home); first.run();
    expect(fs.existsSync(path.join(first.selected.userData, MARKER))).toBe(true);
    legacy("Fresh"); const second = launch(home); second.run();
    expect(second.selected).toEqual(first.selected);
  });
  it.each([false, true])("rejects an unmarked target even when empty (choice=%s)", choice => {
    launch(mkdir(path.join(root, "namespace-initializer"))).run();
    const home = mkdir(path.join(root, "custom")); mkdir(target(home));
    expectBlocked(home, { argv: choice ? [FLAG] : [] }, /unmarked/i);
  });
  it("preserves a nonempty unmarked target even with explicit choice", () => {
    launch(mkdir(path.join(root, "namespace-initializer"))).run();
    const home = mkdir(path.join(root, "custom")); const dir = mkdir(target(home));
    fs.writeFileSync(path.join(dir, "synthetic-token"), "DO-NOT-ADOPT");
    expectBlocked(home, { argv: [FLAG] }, /unmarked/i);
  });
  it("does not accept a valid marker copied from a different canonical identity", () => {
    const a = mkdir(path.join(root, "a")); const b = mkdir(path.join(root, "b"));
    const first = launch(a); first.run(); mkdir(target(b));
    fs.copyFileSync(path.join(first.selected.userData, MARKER), path.join(target(b), MARKER));
    expectBlocked(b, { argv: [FLAG] }, /marker/i);
  });
  it.each(["corrupt", "symlink", "wrong-version"])("rejects a %s initialization marker", kind => {
    const home = mkdir(path.join(root, "custom")); const first = launch(home); first.run();
    const marker = path.join(first.selected.userData, MARKER);
    if (kind === "symlink") {
      const copy = path.join(root, "marker-copy"); fs.renameSync(marker, copy);
      fs.symlinkSync(mkdir(path.join(root, "marker-link-target")), marker, "junction");
    } else if (kind === "wrong-version") {
      const data = JSON.parse(fs.readFileSync(marker, "utf8")); data.version = 1;
      fs.writeFileSync(marker, JSON.stringify(data));
    } else fs.writeFileSync(marker, "{");
    expectBlocked(home, { argv: [FLAG] }, /marker/i);
  });
  it("unifies symlink aliases and checks both lexical and canonical legacy names", () => {
    const home = mkdir(path.join(root, "physical")); const alias = path.join(root, "alias");
    fs.symlinkSync(home, alias, "junction");
    expect(target(alias)).toBe(target(home));
    legacy("Physical"); expectBlocked(alias);
    const first = launch(alias, { argv: [FLAG] }); first.run();
    legacy("Alias"); const second = launch(home); second.run();
    expect(second.selected).toEqual(first.selected);
  });
  it("shares one identity and profile across raw, native and junction HOME/appData paths", () => {
    const home = mkdir(path.join(root, "physical"));
    const alias = path.join(root, "home-alias"); fs.symlinkSync(home, alias, "junction");
    const appDataAlias = path.join(root, "appdata-alias"); fs.symlinkSync(appData, appDataAlias, "junction");
    const identity = expectedIdentity(home);
    const appName = path.join("HanaAgent-userData-v2", identity.digest);
    const expected = path.join(canonicalAppData, appName);
    const expectedMarker = { version: 2, platform: process.platform, ...identity, initializedBy: "no-legacy-profile" };
    fs.writeFileSync(path.join(home, "business-sentinel"), "SYNTHETIC-BUSINESS");
    const first = launch(home); expect(first.run()).toBe(true);
    expect(first.selected).toEqual({ userData: expected, sessionData: expected });
    fs.writeFileSync(path.join(expected, "profile-sentinel"), "SYNTHETIC-PROFILE");
    const before = tree(root); const profileEntity = entity(expected);
    for (const homePath of [home, identity.canonicalHome, alias]) {
      expect(entity(homePath)).toEqual(entity(home));
      const { kind, canonicalHome, digest, appName: actualAppName } = resolveDesktopIdentity(homePath, defaultHome);
      expect({ kind, canonicalHome, digest, appName: actualAppName }).toEqual({ kind: "custom", ...identity, appName });
      for (const appDataPath of [appData, canonicalAppData, appDataAlias]) {
        expect(entity(appDataPath)).toEqual(entity(appData));
        const candidate = launch(homePath, {}, appDataPath); expect(candidate.run()).toBe(true);
        expect(candidate.selected).toEqual(first.selected);
        expect(candidate.events).toEqual(["userData", "sessionData", "lock"]);
        expect(entity(candidate.selected.userData)).toEqual(profileEntity);
        expect(JSON.parse(fs.readFileSync(path.join(candidate.selected.userData, MARKER), "utf8"))).toEqual(expectedMarker);
        expect(fs.readFileSync(path.join(candidate.selected.userData, "profile-sentinel"), "utf8")).toBe("SYNTHETIC-PROFILE");
      }
    }
    expect(tree(root)).toEqual(before);
    if (process.platform === "win32") {
      // CI must show whether this run actually exercised short/native divergence.
      console.info("desktop-profile-path-evidence", JSON.stringify({
        platform: process.platform, rawHome: home, jsHome: fs.realpathSync(home), nativeHome: identity.canonicalHome,
        rawAppData: appData, nativeAppData: canonicalAppData,
        shortPathDifference: fs.realpathSync(home) !== identity.canonicalHome,
      }));
    }
  });
  it.each(["default", "dev"])("blocks historical %s alias ambiguity even with the new-profile option", which => {
    const home = which === "default" ? defaultHome : devHome;
    const alias = path.join(root, "old-alias"); fs.symlinkSync(home, alias, "junction");
    legacy("Old-alias");
    expect(target(alias)).toBe(target(home));
    expectBlocked(alias, { argv: [FLAG] }, /alias/i);
    expect(launch(home).run()).toBe(true);
  });
  it("allows a default alias when its old algorithm path does not exist", () => {
    const alias = path.join(root, "new-alias"); fs.symlinkSync(defaultHome, alias, "junction");
    const candidate = launch(alias); candidate.run();
    expect(candidate.selected.userData).toBe(path.join(canonicalAppData, "Hanako"));
    expect(entity(candidate.selected.userData)).toEqual(entity(path.join(appData, "Hanako")));
    expect(candidate.selected.sessionData).toBeUndefined();
  });
  it("normalizes relative paths, missing ancestors and native /var aliases without creating HOME", () => {
    const home = mkdir(path.join(root, "physical")); const alias = path.join(root, "alias");
    fs.symlinkSync(home, alias, "junction");
    const missing = path.join(home, "not-yet", "leaf"); const before = tree(root);
    expect(target(path.relative(process.cwd(), home))).toBe(target(home));
    expect(target(path.join(alias, "not-yet", "leaf"))).toBe(target(missing));
    expect(tree(root)).toEqual(before);
    if (process.platform === "darwin" && home.startsWith("/private/var/")) {
      expect(target(home.slice("/private".length))).toBe(target(home));
    }
  });
  it("waits for an existing HOME before persisting its predicted identity", () => {
    const missing = path.join(root, "not-yet", "home"); const predicted = target(missing);
    expectBlocked(missing, {}, /ENOENT/);
    mkdir(missing);
    expect(target(missing)).toBe(predicted);
    const candidate = launch(missing); candidate.run();
    expect(candidate.selected.userData).toBe(predicted);
  });
  it("uses filesystem case equivalence, preserving distinct case-sensitive entities", () => {
    const upper = mkdir(path.join(root, "MixedCase")); const lower = path.join(root, "mixedcase");
    if (fs.existsSync(lower)) expect(target(lower)).toBe(target(upper));
    else { mkdir(lower); expect(target(lower)).not.toBe(target(upper)); }
  });
  it.each(["file", "dangling", "loop", "file-parent"])("rejects invalid HOME %s without fallback", kind => {
    let home = path.join(root, "invalid");
    if (kind === "file" || kind === "file-parent") fs.writeFileSync(home, "synthetic");
    if (kind === "dangling") fs.symlinkSync(path.join(root, "missing"), home, "junction");
    if (kind === "loop") fs.symlinkSync(home, home, "junction");
    if (kind === "file-parent") home = path.join(home, "child");
    const candidate = launch(home);
    expect(candidate.run).toThrow();
    expect(candidate.app.setPath).not.toHaveBeenCalled();
    expect(candidate.app.requestSingleInstanceLock).not.toHaveBeenCalled();
  });
  it.each([{ env: { [ENV]: "true" } }, { argv: [FLAG + "=false"] }])("does not interpret malformed options as agreement: %j", options => {
    const home = mkdir(path.join(root, "existing")); legacy("Existing");
    expectBlocked(home, options, /option|HANA_NEW_ISOLATED_DESKTOP_PROFILE/i);
  });
  it("does not place a new namespace inside a same-named legacy profile", () => {
    const home = mkdir(path.join(root, "custom"));
    legacy("HanaAgent-userData-v2");
    expectBlocked(home, { argv: [FLAG] }, /namespace|unmarked/i);
  });
  it("rejects a symlinked namespace or target rather than sharing physical storage", () => {
    const home = mkdir(path.join(root, "custom"));
    const outside = mkdir(path.join(root, "outside"));
    fs.symlinkSync(outside, path.join(appData, "HanaAgent-userData-v2"), "junction");
    expectBlocked(home, { argv: [FLAG] }, /symlink/i);
  });
  it.each([{}, { argv: [FLAG] }, { env: { [ENV]: "1" } }])("reports EACCES instead of interpreting an inaccessible legacy profile as absent: %j", options => {
    const home = mkdir(path.join(root, "custom")); legacy("Custom");
    const deniedPath = path.join(canonicalAppData, "Custom");
    const denied = Object.assign(new Error("synthetic access denied"), { code: "EACCES" });
    let hits = 0;
    const lstatSync = vi.fn((p: string) => {
      if (p === deniedPath) { hits++; throw denied; }
      return fs.lstatSync(p);
    });
    expectBlocked(home, { ...options, fsImpl: { ...fs, lstatSync } }, /EACCES: synthetic access denied/);
    expect(hits).toBe(1);
    expect(lstatSync.mock.calls.filter(([p]) => p === deniedPath)).toEqual([[deniedPath]]);
    const injectedCall = lstatSync.mock.calls.findIndex(([p]) => p === deniedPath);
    expect(lstatSync.mock.results[injectedCall]).toEqual({ type: "throw", value: denied });
  });
  it("rejects a retargeted HOME before creating any profile", () => {
    const physical = mkdir(path.join(root, "physical"));
    const elsewhere = mkdir(path.join(root, "elsewhere"));
    const alias = path.join(root, "alias"); fs.symlinkSync(physical, alias, "junction");
    let calls = 0;
    const fsImpl = { ...fs, statSync: (p: string) => {
      if (p === alias && ++calls === 1) { fs.unlinkSync(alias); fs.symlinkSync(elsewhere, alias, "junction"); }
      return fs.statSync(p);
    } };
    const candidate = launch(alias, { fsImpl });
    expect(candidate.run).toThrow(/identity changed/i);
    expect(tree(appData)).toEqual({});
    expect(candidate.events).toEqual([]);
  });
  it("leaves failed initialization unmarked and refuses it on the next launch", () => {
    const home = mkdir(path.join(root, "custom"));
    const fsImpl = { ...fs, writeFileSync: () => { throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" }); } };
    const candidate = launch(home, { fsImpl });
    expect(candidate.run).toThrow(/ENOSPC/);
    expect(candidate.events).toEqual([]);
    expectBlocked(home, { argv: [FLAG] }, /marker|unmarked/i);
  });
  it("fails closed if already ready", () => {
    const home = mkdir(path.join(root, "custom")); const before = tree(root);
    const candidate = launch(home); candidate.app.isReady = () => true;
    expect(candidate.run).toThrow(/before Electron is ready/);
    expect(candidate.events).toEqual([]); expect(tree(root)).toEqual(before);
  });
});
