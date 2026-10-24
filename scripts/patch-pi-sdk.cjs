/**
 * patch-pi-sdk.cjs — Pi SDK 只读验证
 *
 * 历史上这个脚本会在 postinstall 阶段修改
 * node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.js，
 * 为 Hana 的 session-scoped sandbox tools 打通 baseToolsOverride。
 *
 * Pi SDK 0.68+ 已把 createAgentSession({ tools }) 改成工具名 allowlist，
 * Hana 现在通过 lib/pi-sdk 适配层把本地 Tool[] 转为 customTools + names。
 * 因此这个脚本只验证版本、SDK 结构和生产 import 边界，不再写 node_modules。
 *
 * 文件名（patch-pi-sdk）保留是为了不动 package.json 的 postinstall 钩子，
 * 避免触发 npm install cache 重算。实际职责已是只读验证（log 前缀 verify-pi-sdk）。
 */

const fs = require("fs");
const path = require("path");
const { createHash } = require("node:crypto");

const root = path.join(__dirname, "..");
const sdkRoot = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piAiRoot = path.join(root, "node_modules", "@earendil-works", "pi-ai");
const verifiedVersions = new Set(["1.4.0"]);
const verifiedPiAiVersions = new Set(["1.4.0"]);
// Reject family drift, including nested copies; 1.4.0 pins its family exactly.
const piFamilyPath = /node_modules\/@earendil-works\/(chord|pi-agent-core|pi-ai|pi-coding-agent|pi-codemode|pi-mcp|pi-telemetry|pi-tui)$/;
const requiredFamily = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-codemode", "pi-mcp", "pi-telemetry", "pi-tui"];
// Official npm 1.4.0 tarball integrities and published dist entry fingerprints.
const reviewedFamily = {
  "pi-agent-core": {
    "integrity": "sha512-PoKY84SKUwnt7S5QBZaGUqfNO1kjP3KHpHUA9QpFTj4cOjaVWMYIcBPJ6FDRCdE8Zen9OSECQUd0uUfVgtSmgA==",
    "distIndexSha256": "40cb358d7f05594e9b67845a78ae50ad05e8375f0cfa8cee8a74801556c09afd"
  },
  "pi-ai": {
    "integrity": "sha512-hQM/C4+1w8rHYACzDDf+0vQMnEnpzIop1tptIERVgR3ZeT/hHSzBNG8PaWPgxWQjqSeKCyBZSyp8uTT6eKK1pQ==",
    "distIndexSha256": "7808fc618b4c816322005628af2726a53c4db678b37fb311163210c4fbab5ed0"
  },
  "pi-coding-agent": {
    "integrity": "sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg==",
    "distIndexSha256": "4569157e6038be9840fa514db4b00a27fd0be9e3622cc7b49a281de6c027d7ff"
  },
  "pi-codemode": {
    "integrity": "sha512-23CNAXpS9DuLzPMyYuvrXVVio46x4YhffCgCqaWmF7F5H8PooqjrQvX4ucF6M0BhUd+x2tV6r1J0dv8cCME4Cg==",
    "distIndexSha256": "ae755805c5022213d9a43d3b9a8da39d04ab0f4278e6053b888682675a281ce2"
  },
  "pi-mcp": {
    "integrity": "sha512-92aZmmGsUpHHknYuKXZHRINQfahntw5hU9If0I0ZM49GojOaFHpkl5/GF3/aatqpt7v7GjZbBfpfSygGKW+pnw==",
    "distIndexSha256": "e954af0d87891dab3bab10a5ca7b7ce12d9baf796bd17a7983e39f0bba404111"
  },
  "pi-telemetry": {
    "integrity": "sha512-MLIfowwUYIY65jSjMX82paZOrX/NTvLk6D08h+3Jq42a99RzUOewzuCR0zOlPul3D6UBfddat76VT6LvsHEs1w==",
    "distIndexSha256": "b34be60c5fac72aefc31e9fddd80aafb32d2a76332a49ce42887555990e15da6"
  },
  "pi-tui": {
    "integrity": "sha512-4obPOjgOD7g4mGSlngIvxyujC1UPdmyI9zdVthbr8GufacFEX+Ce0+scPgHg++k2xj5+QjESM2d5TxvIuzCVmg==",
    "distIndexSha256": "6068ae4207de753d9ec00dbe14aee199e6160d1dea0db9c8a92f65d08ffc6e80"
  }
};

function fail(message) {
  console.error(`[verify-pi-sdk] ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

if (!fs.existsSync(sdkRoot)) {
  console.log("[verify-pi-sdk] SDK not installed, skipping");
  process.exit(0);
}

const pkg = readJson(path.join(sdkRoot, "package.json"));
if (!verifiedVersions.has(pkg.version)) {
  fail(`SDK version ${pkg.version} is not verified. Verified versions: ${[...verifiedVersions].join(", ")}`);
}

if (!fs.existsSync(piAiRoot)) {
  fail("@earendil-works/pi-ai is not installed");
}
const piAiPkg = readJson(path.join(piAiRoot, "package.json"));
if (!verifiedPiAiVersions.has(piAiPkg.version)) {
  fail(`pi-ai version ${piAiPkg.version} is not verified. Verified versions: ${[...verifiedPiAiVersions].join(", ")}`);
}

const agentPkg = readJson(path.join(root, "node_modules", "@earendil-works", "pi-agent-core", "package.json"));
if (agentPkg.version !== pkg.version || piAiPkg.version !== pkg.version) {
  fail("pi-agent-core, pi-ai and pi-coding-agent must use the same verified version");
}
const lock = readJson(path.join(root, "package-lock.json"));
for (const name of requiredFamily) {
  const location = `node_modules/@earendil-works/${name}`;
  if (!lock.packages?.[location] || !fs.existsSync(path.join(root, location, "package.json"))) {
    fail(`required Pi family package missing: ${name}`);
  }
}
for (const [location, dependency] of Object.entries(lock.packages || {})) {
  if (!piFamilyPath.test(location)) continue;
  if (dependency.version !== pkg.version) {
    fail(`mixed Pi version at ${location}: ${dependency.version}`);
  }
  const familyName = location.slice(location.lastIndexOf("/") + 1);
  if (reviewedFamily[familyName] && dependency.integrity !== reviewedFamily[familyName].integrity) {
    fail(`Pi 1.4.0 official tarball integrity differs at ${location}`);
  }
  const installedManifest = path.join(root, location, "package.json");
  if (fs.existsSync(installedManifest)) {
    const installed = readJson(installedManifest);
    if (installed.version !== pkg.version) {
      fail(`mixed installed Pi version at ${location}: ${installed.version}`);
    }
  }
}
if (pkg.version === "1.4.0") {
  const requested = readJson(path.join(root, "package.json"));
  for (const name of requiredFamily) {
    if (requested.overrides?.[`@earendil-works/${name}`] !== "1.4.0") fail(`Pi override must pin ${name} to 1.4.0`);
  }
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {
    if (requested.dependencies?.[`@earendil-works/${name}`] !== "1.4.0") fail(`Pi dependency must pin ${name} to 1.4.0`);
  }
  const source = fs.readFileSync(path.join(sdkRoot, "dist/core/agent-session.js"), "utf8");
  const start = source.indexOf("    async _startRun(trigger, onStarted) {");
  const end = source.indexOf("    /**", start);
  const digest = createHash("sha256").update(source.slice(start, end)).digest("hex");
  if (start < 0 || end < 0 || digest !== "39279b7a97daff07835880131a5fdf7340ef5d7de5960639039f8ed791549afa") {
    fail("Pi 1.4.0 _startRun differs from the source-bound lifecycle adapter");
  }
  for (const [name, seal] of Object.entries(reviewedFamily)) {
    const location = `node_modules/@earendil-works/${name}`;
    if (lock.packages[location].integrity !== seal.integrity) fail(`Pi 1.4.0 official tarball integrity differs for ${name}`);
    const entrySource = fs.readFileSync(path.join(root, location, "dist/index.js"));
    if (createHash("sha256").update(entrySource).digest("hex") !== seal.distIndexSha256) {
      fail(`Pi 1.4.0 published dist entry differs for ${name}`);
    }
  }
  // Budget planning relies on the published simple-provider context clamp.
  for (const [relative, expected] of Object.entries({
  "api/simple-options.js": "ff234becff46a6c25c1e437c86d72fbe7aeb4e107266d1bf6951622d223b0ae0",
  "utils/estimate.js": "b5b606011ab0dce2a5db309dd812c9b8ddd0bbcbc9416de699fb9cd087cc84d6"
})) {
    const budgetSource = fs.readFileSync(path.join(piAiRoot, "dist", relative));
    if (createHash("sha256").update(budgetSource).digest("hex") !== expected) {
      fail(`Pi 1.4.0 output-budget helper differs: ${relative}`);
    }
  }
  const compactionSource = fs.readFileSync(path.join(sdkRoot, "dist/core/compaction/compaction.js"));
  if (createHash("sha256").update(compactionSource).digest("hex") !== "f51e78ef1da66b5803fc91e185f07b968f8f989ab9326b7744958416aad3f6f6") {
    fail("Pi 1.4.0 compaction differs from the reviewed request-shape mirror");
  }
  const authSource = fs.readFileSync(path.join(sdkRoot, "dist/core/auth-storage.js"));
  if (createHash("sha256").update(authSource).digest("hex") !== "59791d54e50bfb86f0bb9e8dcee776547ae1744fc4aeb2fe14ff6610c1f5c567") {
    fail("Pi 1.4.0 auth-storage differs from the reviewed acquisition budget");
  }
}
for (const [file, markers] of [
  ["core/auth-storage.js", ["AuthStorage", "FileAuthStorageBackend", "InMemoryAuthStorageBackend"]],
  ["core/compaction/compaction.js", ["prepareCompaction"]],
]) {
  const source = fs.readFileSync(path.join(sdkRoot, "dist", file), "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) fail(`required SDK internal ${marker} missing from ${file}`);
  }
}

const sdkIndex = fs.readFileSync(path.join(sdkRoot, "dist", "index.js"), "utf8");
const expectedExportMarkers = [
  "createAgentSession",
  "ModelRuntime",
  "createReadTool",
  "createWriteTool",
  "createEditTool",
  "createBashTool",
  "createGrepTool",
  "createFindTool",
  "createLsTool",
  "parseSessionEntries",
  "buildSessionContext",
  "buildSessionProjection",
];

for (const marker of expectedExportMarkers) {
  if (!sdkIndex.includes(marker)) {
    fail(`expected SDK export marker not found: ${marker}`);
  }
}

const scanDirs = ["core", "server", "lib", "hub"].map(d => path.join(root, d));
const adapterDir = path.join(root, "lib", "pi-sdk");
const importPattern = /(?:from\s+["']@(?:mariozechner|earendil-works)\/(?:pi-ai|pi-coding-agent|pi-agent-core)|import\s*\(\s*["']@(?:mariozechner|earendil-works)\/(?:pi-ai|pi-coding-agent|pi-agent-core)|require\s*\(\s*["']@(?:mariozechner|earendil-works)\/(?:pi-ai|pi-coding-agent|pi-agent-core))/;
const leaks = [];

function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === adapterDir || entry.name === "node_modules") continue;
      scanDir(full);
    } else if (/\.(js|mjs|cjs|ts)$/.test(entry.name)) {
      const content = fs.readFileSync(full, "utf8");
      if (importPattern.test(content)) {
        leaks.push(path.relative(root, full));
      }
    }
  }
}

for (const dir of scanDirs) scanDir(dir);

if (leaks.length > 0) {
  fail(`production files bypass lib/pi-sdk: ${leaks.join(", ")}`);
}

console.log("[verify-pi-sdk] all checks passed");
