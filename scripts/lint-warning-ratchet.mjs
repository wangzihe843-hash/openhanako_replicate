import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ESLint } from 'eslint';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = 'build/eslint-warning-baseline.json';

// Count concrete source sites, not just totals: deleting one warning must not
// pay for a different warning elsewhere in the same file. Line numbers remain
// in the full report but are omitted from identity so unrelated insertions pass.
export function snapshotWarnings(results, { rootDir = ROOT, readSource = file => fs.readFileSync(file, 'utf8') } = {}) {
  const entries = new Map();
  for (const result of results) {
    const warnings = result.messages.filter(message => message.severity === 1);
    if (!warnings.length) continue;
    const file = path.relative(rootDir, result.filePath).split(path.sep).join('/');
    if (file.startsWith('../') || path.isAbsolute(file)) throw new Error(`Lint path outside repository: ${file}`);
    // Git checkouts may use LF or CRLF; normalize before deriving any AST context.
    const source = readSource(result.filePath).replace(/\r\n?/g, "\n");
    const parsed = ts.createSourceFile(result.filePath, source, ts.ScriptTarget.Latest, true);
    const lines = source.split(/\r?\n/);
    for (const message of warnings) {
      const line = Math.max(0, (message.line || 1) - 1);
      const offset = parsed.getPositionOfLineAndCharacter(line, Math.max(0, (message.column || 1) - 1));
      const owners = [];
      function visit(node) {
        if (offset < node.getFullStart() || offset >= node.end) return;
        if (node.name && (ts.isDeclarationStatement(node) || ts.isVariableDeclaration(node)
          || ts.isParameter(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)
          || ts.isPropertyAssignment(node) || ts.isPropertySignature(node))) {
          owners.push(node.name.getText(parsed));
        }
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          let argument = node;
          while (ts.isParenthesizedExpression(argument.parent)) argument = argument.parent;
          const call = argument.parent;
          if (ts.isCallExpression(call)) {
            const labels = call.arguments.filter(arg => ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg))
              .map(arg => arg.getText(parsed));
            owners.push(JSON.stringify(['callback', call.expression.getText(parsed), labels, call.arguments.indexOf(argument)]));
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(parsed);
      const context = JSON.stringify([owners, (lines[line] || '').trim()]);
      const anchor = crypto.createHash('sha256').update(context).digest('hex');
      const entry = { file, rule: message.ruleId || 'unused-eslint-disable', message: message.message, anchor, count: 1 };
      const key = JSON.stringify([file, entry.rule, entry.message, anchor]);
      const previous = entries.get(key);
      if (previous) previous.count += 1;
      else entries.set(key, entry);
    }
  }
  return { version: 1, generatedBy: 'scripts/lint-warning-ratchet.mjs', entries: [...entries.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => entry) };
}

export function compareWarnings(baseline, current) {
  if (baseline.version !== 1 || !Array.isArray(baseline.entries)) throw new Error('Invalid warning baseline');
  const keyOf = entry => JSON.stringify([entry.file, entry.rule, entry.message, entry.anchor]);
  const prior = new Map();
  for (const entry of baseline.entries) {
    if (!Number.isSafeInteger(entry.count) || entry.count < 1 || typeof entry.file !== 'string'
      || typeof entry.rule !== 'string' || typeof entry.message !== 'string' || !/^[a-f0-9]{64}$/.test(entry.anchor)) {
      throw new Error('Invalid warning baseline entry');
    }
    const key = keyOf(entry);
    if (prior.has(key)) throw new Error('Duplicate warning baseline entry');
    prior.set(key, entry);
  }
  const actual = new Map(current.entries.map(entry => [keyOf(entry), entry]));
  const added = [], removed = [];
  for (const key of new Set([...prior.keys(), ...actual.keys()])) {
    const delta = (actual.get(key)?.count || 0) - (prior.get(key)?.count || 0);
    if (delta > 0) added.push({ ...actual.get(key), count: delta });
    if (delta < 0) removed.push({ ...prior.get(key), count: -delta });
  }
  const count = entries => entries.reduce((total, entry) => total + entry.count, 0);
  return { added, removed, addedCount: count(added), removedCount: count(removed), warningCount: count(current.entries) };
}

export async function runWarningRatchet({ rootDir = ROOT, writeBaseline = false } = {}) {
  const eslint = new ESLint({ cwd: rootDir });
  const results = await eslint.lintFiles(['.']);
  const errorCount = results.reduce((total, result) => total + result.errorCount, 0);
  const output = path.join(rootDir, 'output', 'lint-warning-ratchet');
  fs.mkdirSync(output, { recursive: true });
  // Keep every diagnostic, including errors and locations, available for review.
  fs.writeFileSync(path.join(output, 'eslint.json'), JSON.stringify(results, null, 2) + '\n');
  const current = snapshotWarnings(results, { rootDir });
  const baselinePath = path.join(rootDir, BASELINE);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  if (!baseline && !writeBaseline) throw new Error(`Missing ${BASELINE}; baseline creation requires explicit --write-baseline review`);
  const comparison = compareWarnings(baseline || { version: 1, entries: [] }, current);
  fs.writeFileSync(path.join(output, 'comparison.json'), JSON.stringify({ errorCount, ...comparison }, null, 2) + '\n');
  if (errorCount) {
    console.error(await (await eslint.loadFormatter('stylish')).format(results));
    return 1;
  }
  if (writeBaseline) {
    fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n');
    console.log(`Recorded ${comparison.warningCount} warnings in ${BASELINE}; review the baseline diff with the source changes.`);
  } else if (comparison.addedCount) {
    for (const entry of comparison.added) console.error(`${entry.file}: ${entry.rule}: ${entry.message} (${entry.count} new)`);
  }
  console.log(`Warnings: ${comparison.warningCount}; added: ${comparison.addedCount}; removed: ${comparison.removedCount}; errors: ${errorCount}. Full diagnostics: output/lint-warning-ratchet/eslint.json`);
  return !writeBaseline && comparison.addedCount ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--write-baseline') || args.length > 1) {
    console.error('Usage: node scripts/lint-warning-ratchet.mjs [--write-baseline]');
    process.exitCode = 1;
  } else {
    try { process.exitCode = await runWarningRatchet({ writeBaseline: args.includes('--write-baseline') }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
