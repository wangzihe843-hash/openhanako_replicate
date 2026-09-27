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

const root = path.join(__dirname, "..");
const sdkRoot = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piAiRoot = path.join(root, "node_modules", "@earendil-works", "pi-ai");
const verifiedVersions = new Set(["0.87.1"]);
const verifiedPiAiVersions = new Set(["0.87.1"]);

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
for (const [location, dependency] of Object.entries(lock.packages || {})) {
  if (/node_modules\/@earendil-works\/(pi-agent-core|pi-ai|pi-coding-agent)$/.test(location)
    && dependency.version !== pkg.version) {
    fail(`mixed Pi version at ${location}: ${dependency.version}`);
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
