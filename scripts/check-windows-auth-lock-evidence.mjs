import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNativeReport } from './probe-windows-auth-lock.mjs';

export const REQUIRED_EVIDENCE = [
  'summary.json',
  ...['baseline', 'candidate'].flatMap(name =>
    [`${name}.json`, `${name}.exit.json`, `${name}.stdout.txt`, `${name}.stderr.txt`]),
];

// This checks collection, not the native behavior. A failed/cancelled probe
// remains failed/cancelled even when its diagnostics were collected correctly.
export function checkNativeAuthLockEvidence({ outcome, outputDir }) {
  if (outcome === 'skipped' || outcome === '') {
    // Do not create placeholder probe artifacts or accept stale evidence.
    return { status: 'not-run', passed: false, errors: [] };
  }
  const result = { status: outcome, passed: false, errors: [] };
  try {
    assert.ok(['success', 'failure', 'cancelled'].includes(outcome), 'Unknown native probe outcome');
    const json = {};
    for (const file of REQUIRED_EVIDENCE) {
      const fullPath = path.join(outputDir, file);
      assert.ok(fs.statSync(fullPath).isFile(), `Missing evidence file: ${file}`);
      if (file.endsWith('.json')) json[file] = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    }
    if (outcome === 'success') {
      assert.equal(json['summary.json'].passed, true, 'Successful probe must have a passing summary');
      for (const name of ['baseline', 'candidate']) {
        const evidence = json[`${name}.json`];
        assert.equal(evidence.passed, true);
        assert.deepEqual(json['summary.json'].cases[name], evidence);
        const exit = json[`${name}.exit.json`];
        assert.equal(exit.code, 0);
        assert.equal(exit.signal, null);
        assert.equal(exit.error, null);
        validateNativeReport(evidence.report, name === 'baseline');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, `${name}.stdout.txt`), 'utf8')),
          evidence.report);
      }
      result.passed = true;
    }
  } catch (error) {
    result.status = 'evidence-error';
    result.errors.push(String(error.message || error));
  }
  return result;
}

export function reportNativeAuthLockEvidence({
  outcome = process.env.NATIVE_AUTH_LOCK_OUTCOME,
  outputDir = path.resolve('output/windows-auth-lock-native'),
  stepSummary = process.env.GITHUB_STEP_SUMMARY,
} = {}) {
  const result = checkNativeAuthLockEvidence({ outcome, outputDir });
  const message = result.status === 'not-run'
    ? 'not-run: the native Windows auth lock probe did not execute. No native passing result is available.'
    : `${result.status}: native probe passed=${result.passed}.`;
  if (stepSummary) fs.appendFileSync(stepSummary,
    `\n### Native Windows auth lock evidence\n\n${message}\n${result.errors.map(error => `\n- ${error}\n`).join('')}`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = reportNativeAuthLockEvidence();
  process.exitCode = result.errors.length ? 1 : 0;
}
