import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const mainPath = path.join(root, "desktop/main.cjs");
const mainSource = fs.readFileSync(mainPath, "utf8");
const require = createRequire(import.meta.url);
const proxy = require("../shared/network-proxy.cjs");
const ca = require("../desktop/src/shared/windows-system-ca.cjs");
const windowsEnv = require("../desktop/src/shared/server-process-env.cjs");

type Mode = "direct" | "manual" | "system-proxy" | "system-direct";
type Scenario = {
  platform: "darwin" | "linux" | "win32"; packaged: boolean; mode: Mode;
  parentHome: boolean; staleInheritedHome?: boolean;
};
type Modules = { proxy: typeof proxy; ca: typeof ca; windowsEnv: typeof windowsEnv };
const modules: Modules = { proxy, ca, windowsEnv };

function visit(node: ts.Node, fn: (node: ts.Node) => void) {
  fn(node);
  ts.forEachChild(node, child => visit(child, fn));
}

// Extract the current functions, rather than reimplementing their environment
// composition. These checks locate the known route; they do not rule out other
// branches or prove the behavior of the complete Electron startup.
function extractMain(source: string) {
  const ast = ts.createSourceFile(mainPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const diagnostics = (ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error("desktop main did not parse");
  function declaration(name: string) {
    const matches = ast.statements.filter((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name && !!node.body);
    if (matches.length !== 1) throw new Error(`expected one top-level ${name} function, found ${matches.length}`);
    return matches[0];
  }
  function calls(node: ts.Node, name: string) {
    const result: ts.CallExpression[] = [];
    visit(node, child => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name) result.push(child);
    });
    return result;
  }
  function requireBindings(modulePath: string, names: string[]) {
    const matches: ts.VariableDeclaration[] = [];
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const item of statement.declarationList.declarations) {
        if (ts.isObjectBindingPattern(item.name) && item.initializer && ts.isCallExpression(item.initializer)
          && ts.isIdentifier(item.initializer.expression) && item.initializer.expression.text === "require"
          && item.initializer.arguments.length === 1 && ts.isStringLiteral(item.initializer.arguments[0])
          && item.initializer.arguments[0].text === modulePath) matches.push(item);
      }
    }
    if (matches.length !== 1 || !ts.isObjectBindingPattern(matches[0].name)) {
      throw new Error(`expected one destructured require of ${modulePath}`);
    }
    const bindings = matches[0].name.elements.map(element =>
      ts.isIdentifier(element.name) && !element.propertyName ? element.name.text : "");
    if (names.some(name => bindings.filter(binding => binding === name).length !== 1)) {
      throw new Error(`expected bindings from ${modulePath}: ${names.join(", ")}`);
    }
  }
  requireBindings("child_process", ["spawn"]);
  requireBindings("../shared/network-proxy.cjs", ["normalizeNetworkProxyConfig", "proxyConfigToEnvironment", "systemProxyConfigToEnvironment"]);
  requireBindings("./src/shared/windows-system-ca.cjs", ["withWindowsSystemCaEnv"]);
  requireBindings("./src/shared/server-process-env.cjs", ["buildWin32ServerEnv"]);

  const names = ["safeReadJSON", "readNetworkProxyPreference", "parseElectronProxyList", "resolveElectronProxyUrl",
    "serverEnvironmentForNetworkProxy", "startServer", "_spawnServerOnce"];
  const functions = names.map(declaration);
  const start = functions[functions.length - 2];
  const once = functions[functions.length - 1];
  const starts = calls(start, "_spawnServerOnce");
  if (starts.length !== 1 || starts[0].arguments.length !== 2
    || !ts.isIdentifier(starts[0].arguments[0]) || starts[0].arguments[0].text !== "serverInfoPath"
    || !ts.isIdentifier(starts[0].arguments[1]) || starts[0].arguments[1].text !== "artifactBootContext") {
    throw new Error("startServer no longer calls the known spawn function with the expected inputs");
  }
  const spawn = calls(once, "spawn");
  const options = spawn[0]?.arguments[2];
  if (spawn.length !== 1 || !options || !ts.isObjectLiteralExpression(options)
    || !options.properties.some(property => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)
      && property.name.text === "env" && ts.isIdentifier(property.initializer) && property.initializer.text === "serverEnv")) {
    throw new Error("known spawn call no longer receives serverEnv directly");
  }
  return functions.map(fn => fn.getText(ast));
}

function replaceOnce(source: string, before: string, after: string) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) throw new Error(`expected one mutation anchor: ${before}`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

// Only mutation tests compile an altered copy of the current CJS source. The
// ordinary cases above use Node's actual require() of the repository modules.
function mutatedModule(relativePath: string, before: string, after: string) {
  const filename = path.join(root, relativePath);
  const source = replaceOnce(fs.readFileSync(filename, "utf8"), before, after);
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, require: createRequire(filename), process, URL, ArrayBuffer,
  }, { filename });
  return module.exports;
}

async function observeSpawn(scenario: Scenario, source = mainSource, implementations: Modules = modules) {
  const functions = extractMain(source);
  const paths = scenario.platform === "win32" ? path.win32 : path.posix;
  const home = scenario.platform === "win32" ? "C:\\Selected Home\\花子" : "/selected home/花子";
  const osHome = scenario.platform === "win32" ? "C:\\Users\\Synthetic" :
    scenario.platform === "darwin" ? "/Users/synthetic" : "/home/synthetic";
  const staleHome = scenario.platform === "win32" ? "C:\\Wrong Home" : "/wrong-home";
  const desktopDir = scenario.platform === "win32" ? "C:\\app\\desktop" : "/app/desktop";
  const resources = scenario.platform === "win32" ? "C:\\app\\resources" : "/app/resources";
  const artifactRoot = paths.join(home, "artifacts", "server");
  const preference = scenario.mode === "manual"
    ? { mode: "manual", httpProxy: "http://manual.example.test:8080" }
    : { mode: scenario.mode.startsWith("system") ? "system" : "direct" };
  // Explicit synthetic variables only; no user environment or secrets are copied.
  const parentEnv: NodeJS.ProcessEnv = {
    HANA_HOME: scenario.staleInheritedHome ? staleHome : home,
    ...(scenario.parentHome ? { HOME: osHome } : {}),
    TEST_SENTINEL: "preserve-me", PI_CODING_AGENT_DIR: "unrelated-pi-home",
    HTTP_PROXY: "http://stale.example.test:8080", NODE_USE_SYSTEM_CA: "0",
    ...(scenario.platform === "win32" ? {
      USERPROFILE: osHome, HOMEDRIVE: "C:", HOMEPATH: "\\Users\\Synthetic",
      SystemRoot: "C:\\Windows", Path: "C:\\Windows\\System32",
    } : { PATH: "/usr/bin:/bin" }),
  };
  const trace: string[] = [];
  const resolvedUrls: string[] = [];
  let observed: { command: string; env: NodeJS.ProcessEnv } | undefined;
  const stop = new Error("spawn intercepted by test");
  const context = {
    __dirname: desktopDir, path: paths, hanakoHome: home,
    process: { platform: scenario.platform, env: parentEnv, pid: 421, execPath: paths.join(desktopDir, "electron"), resourcesPath: resources },
    app: { isPackaged: scenario.packaged, getAppPath: () => paths.join(desktopDir, "..") },
    fs: {
      readFileSync(file: string) {
        if (file === paths.join(home, "server-info.json")) throw new Error("no synthetic server-info");
        if (file !== paths.join(home, "user", "preferences.json")) throw new Error(`unexpected read: ${file}`);
        return JSON.stringify({ network_proxy: preference });
      },
      existsSync: () => true,
      unlinkSync: () => {},
    },
    session: { defaultSession: { resolveProxy: async (url: string) => {
      resolvedUrls.push(url);
      return scenario.mode === "system-proxy" ? "PROXY system.example.test:8888; DIRECT" : "DIRECT";
    } } },
    normalizeNetworkProxyConfig: implementations.proxy.normalizeNetworkProxyConfig,
    proxyConfigToEnvironment: (...args: unknown[]) => {
      trace.push("proxy");
      return implementations.proxy.proxyConfigToEnvironment(...args);
    },
    systemProxyConfigToEnvironment: (...args: unknown[]) => {
      trace.push("system-proxy");
      return implementations.proxy.systemProxyConfigToEnvironment(...args);
    },
    withWindowsSystemCaEnv: (env: NodeJS.ProcessEnv) => {
      trace.push("ca");
      // Use the true default on the host; pass the function's platform option
      // for the other representative platforms. No TLS settings are changed.
      return scenario.platform === process.platform
        ? implementations.ca.withWindowsSystemCaEnv(env)
        : implementations.ca.withWindowsSystemCaEnv(env, { platform: scenario.platform });
    },
    buildWin32ServerEnv: async (env: NodeJS.ProcessEnv, options: object) => {
      trace.push("windows-env");
      return implementations.windowsEnv.buildWin32ServerEnv(env, {
        ...options, readRegistryPathEntries: async () => ["C:\\Registry\\bin"],
      });
    },
    resolvePackagedArtifactBoot: async () => scenario.packaged ? { serverRoot: artifactRoot, channel: "stable", train: 1 } : null,
    ensureServerFilesReady: async () => ({ ok: true }),
    artifactBoot: { writeBootSentinel: async () => {} },
    parsePortInUseStartupError: () => null, isModuleResolutionError: () => null,
    resolveWindowsServerGuardian: () => paths.join(resources, "guardian.exe"),
    buildWindowsServerGuardianArgs: () => ["guardian-args"],
    spawn(command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) {
      trace.push("spawn");
      observed = { command, env: options.env };
      throw stop; // Do not create a process or execute server code.
    },
    redactLogText: (value: unknown) => String(value),
    // Logging receives synthetic values only; this stub has no side effects
    // and leaves its input unchanged so it cannot mask environment changes.
    redactMainLogText: (value: unknown) => value,
    console: { error: () => {}, log: () => {}, warn: () => {} },
    _serverLogs: [], _lastServerProgressAtMs: null, reusedServerPid: null, reusedServerOwned: false,
    _distRenderer: paths.join(artifactRoot, "renderer"), _lastServerSpawn: null, isQuitting: false,
  };
  // Run the actual startServer and _spawnServerOnce bodies for a fresh launch.
  // Electron proxy resolution, filesystem, registry, boot sentinel and spawn are
  // explicit stubs; this does not run bootstrap or verify packaged artifacts.
  try {
    await vm.runInNewContext(`(async () => {\n${functions.join("\n")}\nawait startServer();\n})()`, context, { filename: mainPath });
    throw new Error("known launch path returned without reaching spawn");
  } catch (error) {
    if (error !== stop) throw error;
  }
  if (!observed) throw new Error("spawn did not capture an environment");
  return { observed, home, osHome, staleHome, parentEnv, trace, resolvedUrls, paths, resources };
}

function expectSelectedHome(actual: NodeJS.ProcessEnv, expected: string) {
  expect(actual.HANA_HOME).toBe(expected);
}

const cases: Scenario[] = [
  { platform: "darwin", packaged: false, mode: "direct", parentHome: true },
  { platform: "darwin", packaged: true, mode: "manual", parentHome: false },
  { platform: "linux", packaged: false, mode: "system-proxy", parentHome: true },
  { platform: "linux", packaged: true, mode: "system-direct", parentHome: false },
  { platform: "win32", packaged: false, mode: "direct", parentHome: true, staleInheritedHome: true },
  { platform: "win32", packaged: true, mode: "manual", parentHome: false },
  { platform: "win32", packaged: true, mode: "system-proxy", parentHome: true },
  { platform: "win32", packaged: false, mode: "system-direct", parentHome: false },
];

describe("desktop server spawn home: known fresh-launch scenarios", () => {
  it.each(cases)("preserves the selected home on $platform, packaged=$packaged, proxy=$mode, parent HOME=$parentHome", async scenario => {
    const { observed, home, osHome, staleHome, parentEnv, trace, resolvedUrls, paths, resources } = await observeSpawn(scenario);
    expectSelectedHome(observed.env, home);
    expect(observed.env.HANA_HOME).not.toBe(staleHome);
    expect(observed.env.HOME).toBe(scenario.parentHome ? osHome : undefined);
    expect(parentEnv.HANA_HOME).toBe(scenario.staleInheritedHome ? staleHome : home);
    expect(observed.env.TEST_SENTINEL).toBe("preserve-me");
    expect(observed.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(observed.env.HANA_DESKTOP_IS_PACKAGED).toBe(scenario.packaged ? "1" : "0");
    expect(trace).toEqual([
      scenario.mode.startsWith("system") ? "system-proxy" : "proxy", "ca",
      ...(scenario.platform === "win32" ? ["windows-env"] : []), "spawn",
    ]);
    expect(resolvedUrls).toEqual(scenario.mode.startsWith("system")
      ? ["http://example.com", "https://example.com", "ws://example.com", "wss://example.com"] : []);
    if (scenario.mode === "manual") expect(observed.env.HTTP_PROXY).toBe("http://manual.example.test:8080");
    else if (scenario.mode === "system-proxy") expect(observed.env.HTTP_PROXY).toBe("http://system.example.test:8888");
    else expect(observed.env.HTTP_PROXY).toBeUndefined();
    if (scenario.platform === "win32") {
      expect(observed.env.USERPROFILE).toBe(osHome);
      expect(observed.env.NODE_USE_SYSTEM_CA).toBe("1");
      expect(observed.env.PATH).toContain("C:\\Registry\\bin");
      expect(observed.command).toBe(paths.join(resources, "guardian.exe"));
    } else expect(observed.env.NODE_USE_SYSTEM_CA).toBe("0");
  });

  it.each([
    ["startServer ordinary log", "async function startServer() {", 'console.log("synthetic log");'],
    ["startServer redacted log", "async function startServer() {", "console.log(redactMainLogText(hanakoHome));"],
    ["spawn ordinary log", "async function _spawnServerOnce(serverInfoPath, artifactBootContext) {", 'console.log("synthetic log");'],
    ["spawn redacted log", "async function _spawnServerOnce(serverInfoPath, artifactBootContext) {", "console.log(redactMainLogText(hanakoHome));"],
  ])("preserves the selected home with %s", async (_label, anchor, statement) => {
    const changed = replaceOnce(mainSource, anchor, `${anchor}\n  ${statement}`);
    for (const scenario of [cases[0], cases[1]]) {
      const result = await observeSpawn(scenario, changed);
      expectSelectedHome(result.observed.env, result.home);
      expect(result.observed.env.HOME).toBe(scenario.parentHome ? result.osHome : undefined);
    }
  });

  it("still detects the HOME overwrite when redacted logging is present", async () => {
    const anchor = "async function startServer() {";
    const logged = replaceOnce(mainSource, anchor, `${anchor}\n  console.log(redactMainLogText(hanakoHome));`);
    const changed = replaceOnce(logged, "    HANA_HOME: hanakoHome,\n",
      "    HANA_HOME: hanakoHome,\n    ...(process.env.HOME ? { HANA_HOME: process.env.HOME } : {}),\n");
    const result = await observeSpawn(cases[0], changed);
    expect(result.observed.env.HANA_HOME).toBe(result.osHome);
    expect(() => expectSelectedHome(result.observed.env, result.home)).toThrow();
  });

  it("detects the reported HOME overwrite when HOME is present, and observes the no-HOME case", async () => {
    const mutated = replaceOnce(mainSource, "    HANA_HOME: hanakoHome,\n",
      "    HANA_HOME: hanakoHome,\n    ...(process.env.HOME ? { HANA_HOME: process.env.HOME } : {}),\n");
    const withHome = await observeSpawn(cases[0], mutated);
    expect(withHome.observed.env.HANA_HOME).toBe(withHome.osHome);
    expect(() => expectSelectedHome(withHome.observed.env, withHome.home)).toThrow();
    const withoutHome = await observeSpawn({ ...cases[0], parentHome: false }, mutated);
    expectSelectedHome(withoutHome.observed.env, withoutHome.home);
  });

  it.each([
    ["wrong", 'HANA_HOME: "/redirected",', "/redirected"],
    ["missing", "HANA_HOME: undefined,", undefined],
  ])("rejects a %s home at spawn", async (_label, replacement, received) => {
    const mutated = replaceOnce(mainSource, "HANA_HOME: hanakoHome,", replacement);
    const result = await observeSpawn(cases[0], mutated);
    expect(result.observed.env.HANA_HOME).toBe(received);
    expect(() => expectSelectedHome(result.observed.env, result.home)).toThrow();
  });

  it.each([
    ["proxy", "shared/network-proxy.cjs", "const env = { ...(baseEnv || {}) };", "const env = {};"],
    ["ca", "desktop/src/shared/windows-system-ca.cjs", "const next = { ...(env || {}) };", "const next = {};"],
    ["windowsEnv", "desktop/src/shared/server-process-env.cjs", "const next = { ...source };", "const next = {};"],
  ] as const)("detects loss of environment inheritance in %s CJS", async (key, file, before, after) => {
    const changed = { ...modules, [key]: mutatedModule(file, before, after) };
    const result = await observeSpawn(cases[5], mainSource, changed);
    expect(result.observed.env.HANA_HOME).toBeUndefined();
    expect(() => expectSelectedHome(result.observed.env, result.home)).toThrow();
  });

  it("fails explicitly when the known source function cannot be located", () => {
    const renamed = replaceOnce(mainSource, "async function _spawnServerOnce(", "async function renamedSpawn(");
    expect(() => extractMain(renamed)).toThrow(/expected one top-level _spawnServerOnce/);
  });
});
