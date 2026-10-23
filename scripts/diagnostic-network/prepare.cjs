// Static source overlay only. Does not import or run any test or production module.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = process.cwd();
const target = 'tests/dependency-network-security.test.ts';
const expected = '4357162b20417dab20e65a27dda1002a96467d0a';
const tree = 'cefa2d2636954006272e1e0801db27fb35bcf996';
const blob = '8e23b13e968f36eca053d2c896cac81d869d66ec';
function git(...args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
function assert(value, label) { if (!value) throw new Error(`Diagnostic identity/shape mismatch: ${label}`); }
assert(git('rev-parse', 'HEAD') === expected, 'commit');
assert(git('rev-parse', 'HEAD^{tree}') === tree, 'tree');
assert(git('rev-parse', `HEAD:${target}`) === blob, 'test blob');
assert(git('status', '--porcelain=v1', '--untracked-files=no') === '', 'clean tracked source before overlay');
const original = fs.readFileSync(target, 'utf8');
const hashBlob = bytes => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
assert(hashBlob(original) === blob, 'test bytes');
const lock = fs.readFileSync('package-lock.json');
assert(Buffer.compare(lock, execFileSync('git', ['show', 'HEAD:package-lock.json'])) === 0, 'lock bytes');
// Resolve TypeScript only from the tested source's existing npm-ci install.
const ts = require(path.join(root, 'node_modules/typescript'));
const sf = ts.createSourceFile(target, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert(sf.parseDiagnostics.length === 0, 'source parse');
const insertions = [];
function insert(pos, text) { insertions.push({ pos, text }); }
const calls = [];
function visit(n) {
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['it', 'afterEach'].includes(n.expression.text)) calls.push(n);
  ts.forEachChild(n, visit);
}
visit(sf);
const tests = calls.filter(n => n.expression.text === 'it');
const hooks = calls.filter(n => n.expression.text === 'afterEach');
assert(tests.length === 6 && hooks.length === 1 && new Set(tests.map(n => n.arguments[0].text)).size === 6, 'six unique cases and one cleanup');
const eventsPath = path.join(__dirname, 'events.cjs');
const moduleStart = sf.statements.find(n => !ts.isImportDeclaration(n)).getStart(sf);
insert(moduleStart, `const __diagModule = createRequire(import.meta.url)(${JSON.stringify(eventsPath)});\nconst __diag = __diagModule.mark;\nconst __diagNames = ${JSON.stringify(tests.map(n => n.arguments[0].text))};\n__diag('module-body:start');\n`);
function wrap(n, start, end, id) {
  const callback = n.arguments.find(a => ts.isArrowFunction(a));
  assert(callback && ts.isBlock(callback.body) && callback.parameters.length === 0, 'zero-argument block callback');
  const b = callback.body;
  assert(original.slice(callback.getStart(sf), callback.getStart(sf) + 7) === 'async (', 'async callback anchor');
  // Context is Vitest's actual task, including when beforeEach fails. Capture once per callback.
  insert(callback.getStart(sf) + 'async ('.length, '__diagContext');
  const caseExpression = id ? String(id) : 'null';
  insert(b.getStart(sf) + 1, `\nconst __diagTask = __diagModule.captureTask(${caseExpression}, __diagContext, __diagNames);\n__diag('${start}', __diagTask); try {\n`);
  insert(b.end - 1, `\n} finally { __diag('${end}', __diagTask); }\n`);
}
tests.forEach((n, i) => wrap(n, 'test-body:start', 'test-body:end', i + 1));
wrap(hooks[0], 'afterEach:start', 'afterEach:end');
function bracket(needle, before, after, detail = '__diagTask') {
  const pos = original.indexOf(needle);
  assert(pos >= 0 && original.indexOf(needle, pos + 1) < 0, `unique anchor ${before}`);
  insert(pos, `__diag('${before}', ${detail});\n`);
  insert(pos + needle.length, `\n__diag('${after}', ${detail});`);
}
bracket('const request = require("@cypress/request");', 'request-require:start', 'request-require:end', '{}');
bracket('runtime.reset();', 'reset:start', 'reset:returned');
bracket('for (const socket of sockets) socket.destroy();', 'sockets-destroy:start', 'sockets-destroy:end');
bracket('await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));', 'servers-close:start', 'servers-close:end');
bracket('ws.terminate();', 'ws-terminate:start', 'ws-terminate:returned');
insert(original.length, "\n__diag('module-registration:end');\n");
let observed = original;
insertions.sort((a, b) => b.pos - a.pos).forEach(({pos, text}) => { observed = observed.slice(0, pos) + text + observed.slice(pos); });
assert(ts.createSourceFile(target, observed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length === 0, 'overlay parse');
const out = process.env.NETWORK_DIAG_OUT;
assert(out && path.isAbsolute(out), 'absolute output');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'identity.json'), JSON.stringify({
  sourceCommit: expected, sourceTree: tree, sourceTestBlob: blob,
  lockSha256: crypto.createHash('sha256').update(lock).digest('hex'),
  observedTestBlob: hashBlob(observed), diagnosticVersion: 2, observation: 'test-source-insertions; not an unchanged-tree execution',
  cases: tests.map((n, i) => ({ case: i + 1, name: n.arguments[0].text })),
}, null, 2) + '\n');
fs.writeFileSync(target, observed);
const setupPath = path.join(__dirname, 'setup.mjs');
fs.writeFileSync('.network-diagnostic.config.mjs', `import base from './vitest.config.js';\nimport { createRequire } from 'node:module';\nconst { mark, taskKey } = createRequire(import.meta.url)(${JSON.stringify(eventsPath)});\nconst names = ${JSON.stringify(tests.map(n => n.arguments[0].text))};\nclass PhaseReporter {\n  onTestModuleQueued() { mark('module:queued'); }\n  onTestModuleCollected() { mark('module:collected'); }\n  onTestCaseReady(t) { mark('test-case:ready', { case: names.indexOf(t.name) + 1, taskId: taskKey(t.id) }); }\n  onTestCaseResult(t) { mark('test-case:result', { case: names.indexOf(t.name) + 1, taskId: taskKey(t.id), result: t.result().state }); }\n}\nexport default { ...base, test: { ...base.test, reporters: ['verbose', new PhaseReporter()], include: [${JSON.stringify(target)}], pool: 'forks', maxWorkers: 1, fileParallelism: false, execArgv: [...(base.test.execArgv || []), '--require', ${JSON.stringify(path.join(__dirname, 'parent.cjs'))}], sequence: { ...base.test.sequence, setupFiles: 'list' }, setupFiles: [...base.test.setupFiles, ${JSON.stringify(setupPath)}] } };\n`);
console.log('Prepared fixed-source observation overlay: six cases; assertions and original cleanup statements retained.');
