import ts from "typescript";

const MODULE = "core/migrations.ts";
const TARGET = "migrateAgentPhoneRuntimeOutOfProjection";
const FUNCTIONS = [TARGET, "removeFrontmatterKeys", "parseAgentPhoneProjectionFrontmatter",
  "agentPhoneRuntimePatchFromMeta", "parseEncodedFrontmatterJson", "runMigrations"];
const CONSTANTS = ["AGENT_PHONE_RUNTIME_KEYS", "AGENT_PHONE_PROJECTION_RUNTIME_KEYS", "migrationIds"];
const IMPORTS = [
  ["fs", "fs", "default"], ["path", "path", "default"],
  ["atomicWriteSync", "../shared/safe-fs.ts", "named"],
  ["safeConversationStem", "../lib/conversations/agent-phone-projection.ts", "named"],
  ["readDirectoryLikeDirentsSync", "../shared/link-aware-fs.ts", "named"],
];
const CALLS = [
  "atomicWriteSync(projectionPath, nextProjection)",
  "fs.mkdirSync(runtimeDir, { recursive: true })",
  'atomicWriteSync(runtimePath, JSON.stringify(nextRuntime, null, 2) + "\\n")',
];
const printer = ts.createPrinter({ removeComments: true });
function check(value, detail) {
  if (!value) throw new Error(`agent phone migration protocol: ${detail}`);
}
function one(nodes, detail) {
  check(nodes.length === 1, `missing or duplicate ${detail}`);
  return nodes[0];
}
function parse(module, text) {
  const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  check(source.parseDiagnostics.length === 0, `invalid source ${module}`);
  return source;
}
function inside(node, ancestor) {
  for (let current = node; current; current = current.parent) if (current === ancestor) return true;
  return false;
}
function identifiers(source, name) {
  const result = [];
  const visit = node => {
    if (ts.isIdentifier(node) && node.text === name) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}
function imported(source, name, module, kind) {
  const imports = source.statements.filter(ts.isImportDeclaration);
  const declaration = one(imports.filter(node => node.importClause?.name?.text === name
    || (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some(entry => entry.name.text === name))), `import ${name}`);
  check(declaration.moduleSpecifier.text === module && !declaration.importClause.isTypeOnly, `import provenance ${name}`);
  if (kind === "default") check(declaration.importClause.name?.text === name, `default import ${name}`);
  else {
    const binding = one(declaration.importClause.namedBindings.elements.filter(entry => entry.name.text === name), `binding ${name}`);
    check(!binding.isTypeOnly && !binding.propertyName, `aliased import ${name}`);
  }
  // Reject a second top-level value declaration competing with the import.
  check(!source.statements.some(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(entry => entry.name.getText(source) === name)), `shadowed import ${name}`);
  return declaration;
}

/**
 * This finite source selector is specific to migration #32. It does not execute
 * migrations or certify the surrounding module's initialization, arbitrary
 * global mutation, the complete runner, filesystem confinement or transactions.
 * Shared publication/selection dependencies are hashed as protocolModules.
 */
export function agentPhoneMigrationProtocol({ readSource, hashSource }) {
  const source = parse(MODULE, readSource(MODULE));
  const selected = [];
  const add = node => { if (!selected.includes(node)) selected.push(node); return node; };
  for (const args of IMPORTS) add(imported(source, ...args));
  for (const name of CONSTANTS) {
    const statement = one(source.statements.filter(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(entry => entry.name.getText(source) === name)), name);
    check(statement.declarationList.flags === ts.NodeFlags.Const && statement.declarationList.declarations.length === 1, `noncanonical const ${name}`);
    add(statement);
  }
  for (const name of FUNCTIONS) {
    const declaration = one(source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name), name);
    check(declaration.body && !declaration.asteriskToken && !declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword), `nonordinary function ${name}`);
    check(!source.statements.some(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(entry => entry.name.getText(source) === name)), `shadowed function ${name}`);
    add(declaration);
  }
  const registryStatement = one(source.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(entry => entry.name.getText(source) === "migrations")), "migrations registry");
  check(registryStatement.declarationList.flags === ts.NodeFlags.Const && registryStatement.declarationList.declarations.length === 1, "noncanonical registry");
  const registry = registryStatement.declarationList.declarations[0].initializer;
  check(registry && ts.isObjectLiteralExpression(registry), "nonliteral registry");
  // A later spread, computed/string key, getter or method can override a
  // visible numeric 32 property. Prove that every actual key is canonical and
  // unique before selecting slot 32; do not infer this from the visible slot.
  const ids = new Set();
  for (const property of registry.properties) {
    check(ts.isPropertyAssignment(property) && ts.isNumericLiteral(property.name)
      && /^[1-9][0-9]*$/.test(property.name.text) && Number.isSafeInteger(Number(property.name.text))
      && ts.isIdentifier(property.initializer), "unknown registry property shape");
    check(!ids.has(property.name.text), `duplicate registry id ${property.name.text}`);
    ids.add(property.name.text);
  }
  const slot = one(registry.properties.filter(node => ts.isPropertyAssignment(node)
    && ts.isNumericLiteral(node.name) && node.name.text === "32"), "slot 32");
  check(ts.isIdentifier(slot.initializer) && slot.initializer.text === TARGET, "slot 32 target");
  const target = selected.find(node => ts.isFunctionDeclaration(node) && node.name.text === TARGET);
  for (const expression of CALLS) {
    const matches = [];
    const visit = node => {
      if (ts.isCallExpression(node) && printer.printNode(ts.EmitHint.Unspecified, node, source).trim() === expression) matches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    check(matches.length === 1 && inside(matches[0], target), `missing, duplicate or moved call ${expression}`);
  }

  // The selected bindings cannot escape through an unselected alias/caller.
  // removeFrontmatterKeys has one existing sibling call in migration #23;
  // recognizing that exact call grants no ownership to the sibling migration.
  const names = [...CONSTANTS.filter(name => name !== "migrationIds"), ...FUNCTIONS];
  for (const name of names) {
    let siblingCalls = 0;
    for (const ref of identifiers(source, name)) {
      if (selected.some(node => inside(ref, node)) || inside(ref, slot)) continue;
      let enclosing = ref.parent;
      while (enclosing && !ts.isFunctionDeclaration(enclosing)) enclosing = enclosing.parent;
      const sibling = name === "removeFrontmatterKeys" && enclosing?.name?.text === "removeAgentPhoneReplyInstructions"
        && ts.isCallExpression(ref.parent) && ref.parent.expression === ref
        && printer.printNode(ts.EmitHint.Unspecified, ref.parent, source).trim() === "removeFrontmatterKeys(raw, keys)";
      check(sibling, `unselected reference ${name}`);
      siblingCalls++;
    }
    if (name === "removeFrontmatterKeys") check(siblingCalls === 1, "sibling helper reference drift");
  }
  for (const ref of identifiers(source, "migrations")) {
    check(inside(ref, registryStatement) || selected.some(node => inside(ref, node)), "unselected registry reference");
  }

  const engineModule = "core/engine.ts";
  const engine = parse(engineModule, readSource(engineModule));
  const engineImport = imported(engine, "runMigrations", "./migrations.ts", "named");
  const refs = identifiers(engine, "runMigrations").filter(ref => !inside(ref, engineImport));
  const invocation = one(refs, "Engine.init migration invocation");
  check(ts.isCallExpression(invocation.parent) && invocation.parent.expression === invocation, "indirect engine invocation");
  let method = invocation.parent;
  while (method && !ts.isMethodDeclaration(method)) method = method.parent;
  check(method?.name?.getText(engine) === "init", "migration invocation outside Engine.init");
  const callback = invocation.parent.parent;
  check(ts.isArrowFunction(callback) && callback.body === invocation.parent
    && !callback.modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword), "indirect startup callback");
  const wrapper = callback.parent;
  check(ts.isCallExpression(wrapper) && wrapper.expression.getText(engine) === "runBestEffortStartupMigrationStep"
    && wrapper.arguments.length === 3 && wrapper.arguments[1] === callback
    && ts.isStringLiteral(wrapper.arguments[0]) && wrapper.arguments[0].text === "migration-registry", "startup wrapper drift");
  const declaration = wrapper.parent;
  check(ts.isVariableDeclaration(declaration) && declaration.name.getText(engine) === "registryStep"
    && declaration.initializer === wrapper && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const, "startup declaration drift");
  const statement = declaration.parent.parent;
  check(ts.isVariableStatement(statement) && ts.isBlock(statement.parent), "startup statement drift");
  const condition = statement.parent.parent;
  check(ts.isIfStatement(condition) && condition.thenStatement === statement.parent
    && condition.expression.getText(engine) === "legacyPrerequisitesReady"
    && condition.parent === method.body, "startup phase nesting drift");
  const readiness = one(method.body.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(entry => entry.name.getText(engine) === "legacyPrerequisitesReady")), "legacy readiness");
  const wrapperFunction = one(engine.statements.filter(node => ts.isFunctionDeclaration(node)
    && node.name?.text === "runBestEffortStartupMigrationStep"), "startup wrapper function");
  const migrationText = selected.map(node => node.getText(source)).join("\n\n")
    + `\nconst migrations = { ${slot.getText(source)} };\n`;
  const engineText = `${engineImport.getText(engine)}\n${wrapperFunction.getText(engine)}\n${readiness.getText(engine)}\n${wrapper.getText(engine)};\n`;
  return {
    migrationId: 32,
    boundary: "Named declarations and bindings, slot 32, and the direct Engine.init invocation only; no whole-module execution or transaction guarantee.",
    sources: [
      { module: MODULE, scopes: [...FUNCTIONS, ...CONSTANTS, "migrations[32]", ...IMPORTS.map(([name]) => `import ${name}`)], sourceHash: hashSource(MODULE, migrationText) },
      { module: engineModule, scopes: ["import runMigrations", "runBestEffortStartupMigrationStep", "Engine.init legacyPrerequisitesReady", "Engine.init migration-registry invocation"], sourceHash: hashSource(engineModule, engineText) },
    ],
  };
}
