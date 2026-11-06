import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { PERSISTENCE_EXEMPTIONS } from "../shared/persistence/store-registry.ts";

// Reduced from the accepted legacy R04 reference: retain its exact publisher,
// peer-scope ordering and complete added-models publication/staging target set.
// Whole-module printer pins close aliases, registry mutation and imported helper
// changes without importing the old six-site resolver or adding a general solver.
// An executable edit to one of these modules requires another scoped review.
const SOURCE = "core/migrations.ts";
const EXEMPTION = "cross-store-legacy-migrations";
// Snapshot the trusted registry reason, never the supplied receipt's copy.
const LEGACY_REASON = PERSISTENCE_EXEMPTIONS.find(exemption => exemption.id === EXEMPTION).reason;
const SCOPE = "migrateMiniMaxTokenPlanAnthropicEndpoint";
const EXPRESSION = "writeSecretFileSync(ymlPath, yamlStr)";
const EXCLUDED = { kind: "secret-write", expression: EXPRESSION, occurrence: 0 };
const PEERS = [SCOPE, "migrateVisionToImage", "migrateGeminiOpenAICompatToNative"];
const PINS = {
  "core/migrations.ts": "055b526e9cfec4ba486d386fb1de9307ce2b4acb69436c57587ec00af6cdf653",
  "shared/safe-fs.ts": "f1586fb7255121b1955aa1531c9048e519edfb83ba3cb0c8fd9bc73f40353a78",
  "shared/secret-fs.ts": "f0fc162fab34fe56cbd37aa5162795d36094274a687562d4f699d58b676bf09d",
};
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function proof(condition, message) {
  if (!condition) throw new Error(`MiniMax #35 ownership: ${message}`);
}

function parsePinned(rootDir, relativePath, sourceOverrides) {
  const override = sourceOverrides instanceof Map ? sourceOverrides.get(relativePath)
    : Object.prototype.hasOwnProperty.call(sourceOverrides, relativePath) ? sourceOverrides[relativePath] : undefined;
  const text = override === undefined ? fs.readFileSync(path.join(rootDir, relativePath), "utf8") : String(override);
  const source = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true);
  proof(source.parseDiagnostics.length === 0, `invalid source ${relativePath}`);
  const digest = createHash("sha256").update(printer.printFile(source)).digest("hex");
  proof(digest === PINS[relativePath], `unreviewed executable source ${relativePath}`);
  return source;
}

export function resolveMiniMaxEndpoint({ rootDir, sites, stores, exemptions, sourceOverrides }) {
  const requested = exemptions.filter(e => e.excludedSites !== undefined);
  if (!requested.length) return new Map();
  proof(requested.length === 1 && requested[0].id === EXEMPTION
    && requested[0].sourceFile === SOURCE, "unknown occurrence exclusion");
  const excluded = requested[0].excludedSites;
  proof(Array.isArray(excluded) && excluded.length === 1
    && Object.keys(excluded[0]).length === 3
    && excluded[0].kind === EXCLUDED.kind && excluded[0].expression === EXCLUDED.expression
    && excluded[0].occurrence === EXCLUDED.occurrence, "unknown occurrence exclusion");

  const sources = new Map(Object.keys(PINS).map(file => [file, parsePinned(rootDir, file, sourceOverrides)]));
  const source = sources.get(SOURCE);
  const matchingCalls = [];
  function visit(node, scope = null) {
    if (ts.isFunctionDeclaration(node)) scope = node.name?.text;
    if (ts.isCallExpression(node) && node.getText(source) === EXPRESSION) matchingCalls.push({ node, scope });
    ts.forEachChild(node, child => visit(child, scope));
  }
  visit(source);
  proof(JSON.stringify(matchingCalls.map(call => call.scope)) === JSON.stringify(PEERS), "publisher peer scopes changed");

  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === SCOPE);
  proof(functions.length === 1 && matchingCalls[0].node.parent.parent.parent === functions[0], "publisher is not the exact #35 body statement");
  const registry = source.statements.filter(ts.isVariableStatement)
    .flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(source) === "migrations")?.initializer;
  proof(registry && ts.isObjectLiteralExpression(registry)
    && registry.properties.filter(node => node.name?.getText(source) === "35"
      && ts.isPropertyAssignment(node) && node.initializer.getText(source) === SCOPE).length === 1, "#35 registration changed");

  const matches = sites.filter(site => site.sourceFile === SOURCE && site.kind === "secret-write" && site.excerpt === EXPRESSION);
  proof(matches.length === 3 && matches.every((site, index) => site.ordinal === index), "scanner occurrence set changed");
  const line = source.getLineAndCharacterOfPosition(matchingCalls[0].node.getStart(source)).line + 1;
  proof(matches[0].line === undefined || matches[0].line === line, "scanner occurrence does not identify #35");
  const owners = stores.filter(store => store.id === "provider-state");
  proof(owners.length === 1 && owners[0].ownerModule === "core/provider-catalog.ts"
    && owners[0].pathPatterns.includes("added-models.yaml"), "missing exact provider-state owner/target");
  const modules = owners[0].protocolModules;
  proof(Object.keys(PINS).every(file => modules.includes(file)), "missing publication protocol source");
  return new Map([[matches[0], {
    storeId: "provider-state",
    reason: "Migrates only the legacy MiniMax Token Plan endpoint in migration #35; exact caller-root YAML and secret staging publication.",
    binding: {
      scope: SCOPE,
      root: "ctx.hanakoHome",
      targets: ["added-models.yaml.tmp", "added-models.yaml"],
    },
  }]]);
}

// Supplied inventories must pass the same source/owner proof as scanner output.
// In particular, a caller cannot omit one of the two targets and reseal a receipt.
export function assertMiniMaxEndpointReceipt({ rootDir, inventory, sourceOverrides = new Map() }) {
  const bindings = resolveMiniMaxEndpoint({ rootDir, sites: inventory.discoveredSites,
    stores: inventory.stores, exemptions: inventory.exemptions, sourceOverrides });
  // The real source registry is the entry anchor, including when a supplied
  // receipt coordinates removal of both the exclusion and the owned row.
  const registryPath = path.join(rootDir, "shared/persistence/store-registry.ts");
  if (fs.existsSync(registryPath)) {
    const registry = ts.createSourceFile(registryPath, fs.readFileSync(registryPath, "utf8"), ts.ScriptTarget.Latest, true);
    let registered = false;
    function visit(node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(registry) === "excludedSites"
        && ts.isArrayLiteralExpression(node.initializer)) {
        for (const entry of node.initializer.elements) {
          if (ts.isObjectLiteralExpression(entry) && entry.properties.some(property => ts.isPropertyAssignment(property)
            && property.name.getText(registry) === "expression" && ts.isStringLiteral(property.initializer)
            && property.initializer.text === EXPRESSION)) registered = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(registry);
    proof(!registered || bindings.size === 1, "receipt omitted the registered #35 binding");
  }
  for (const site of inventory.discoveredSites) {
    const expected = bindings.get(site);
    if (bindings.size && site.sourceFile === SOURCE && site.kind === "secret-write" && site.excerpt === EXPRESSION
      && (site.ordinal === 1 || site.ordinal === 2)) {
      proof(site.storeId === null && site.exemptionId === EXEMPTION && site.reason === LEGACY_REASON
        && site.minimaxEndpointBinding === undefined, `peer occurrence ${site.ordinal} lost its legacy ownership`);
    }
    const claimsOwnership = site.minimaxEndpointBinding !== undefined
      || (site.sourceFile === SOURCE && site.kind === "secret-write" && site.excerpt === EXPRESSION
        && site.ordinal === 0 && site.storeId === "provider-state");
    if (!expected) { proof(!claimsOwnership, "receipt claims an unbound publisher"); continue; }
    const binding = site.minimaxEndpointBinding;
    proof(site.storeId === expected.storeId && site.exemptionId === null
      && site.reason === expected.reason
      && binding && Object.keys(binding).length === 3 && binding.scope === expected.binding.scope
      && binding.root === expected.binding.root
      && JSON.stringify(binding.targets) === JSON.stringify(expected.binding.targets), "receipt target/owner binding changed");
  }
}
