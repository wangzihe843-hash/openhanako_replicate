import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { compareWarnings, snapshotWarnings, runWarningRatchet } from '../scripts/lint-warning-ratchet.mjs';

const rootDir = path.resolve('warning-fixture');
function snapshot(source: string, positions: Array<[number, number]>, name = 'sample.ts') {
  return snapshotWarnings([{
    filePath: path.join(rootDir, name),
    messages: positions.map(([line, column]) => ({ ruleId: '@typescript-eslint/no-explicit-any', severity: 1, message: 'Unexpected any.', line, column })),
  }], { rootDir, readSource: () => source });
}

describe('warning ratchet source identity', () => {
  it('allows line shifts and CRLF conversion without giving another source site a budget', () => {
    const before = snapshot('const oldValue: any = 1;\n', [[1, 17]]);
    const shifted = snapshot('\r\nconst oldValue: any = 1;\r\n', [[2, 17]]);
    expect(compareWarnings(before, shifted)).toMatchObject({ addedCount: 0, removedCount: 0 });
    const replaced = snapshot('const newValue: any = 1;\n', [[1, 17]]);
    expect(compareWarnings(before, replaced)).toMatchObject({ addedCount: 1, removedCount: 1 });
  });

  it('normalizes multiline destructuring and callback context across checkout line endings', () => {
    const code = 'function example({\n  first,\n  second\n}: any) {}\n';
    expect(compareWarnings(snapshot(code, [[4, 4]]), snapshot(code.replaceAll('\n', '\r\n'), [[4, 4]])))
      .toMatchObject({ addedCount: 0, removedCount: 0 });
  });

  it('does not trade a removed warning for one in a different file', () => {
    const code = 'const value: any = 1;';
    expect(compareWarnings(snapshot(code, [[1, 14]], 'one.ts'), snapshot(code, [[1, 14]], 'two.ts')))
      .toMatchObject({ addedCount: 1, removedCount: 1 });
  });

  it('distinguishes identical lines inside different declared owners', () => {
    const a = 'function first() {\n  let value: any;\n}';
    const b = 'function second() {\n  let value: any;\n}';
    expect(compareWarnings(snapshot(a, [[2, 14]]), snapshot(b, [[2, 14]])))
      .toMatchObject({ addedCount: 1, removedCount: 1 });
  });

  it('does not trade warnings between anonymous test, route, or event callbacks', () => {
    for (const callee of ['it', 'app.get', 'emitter.on']) {
      const oldSource = callee + "('old', () => {\n  const value: any = 1;\n});";
      const newSource = callee + "('new', () => {\n  const value: any = 1;\n});";
      expect(compareWarnings(snapshot(oldSource, [[2, 16]]), snapshot(newSource, [[2, 16]])))
        .toMatchObject({ addedCount: 1, removedCount: 1 });
      expect(compareWarnings(snapshot(oldSource, [[2, 16]]), snapshot('\n' + oldSource, [[3, 16]])))
        .toMatchObject({ addedCount: 0, removedCount: 0 });
    }
  });

  it('counts repeated diagnostics instead of collapsing them to a set', () => {
    const source = 'const pair: [any, any] = [1, 2];';
    expect(compareWarnings(snapshot(source, [[1, 14]]), snapshot(source, [[1, 14], [1, 19]])))
      .toMatchObject({ addedCount: 1, removedCount: 0, warningCount: 2 });
  });

  it('reports reductions without suppressing remaining diagnostics', () => {
    const source = 'const pair: [any, any] = [1, 2];';
    expect(compareWarnings(snapshot(source, [[1, 14], [1, 19]]), snapshot(source, [[1, 14]])))
      .toMatchObject({ addedCount: 0, removedCount: 1, warningCount: 1 });
  });

  it('rejects corrupt or duplicate allowances', () => {
    const baseline = snapshot('const x: any = 1;', [[1, 10]]);
    expect(() => compareWarnings({ ...baseline, version: 2 }, baseline)).toThrow('Invalid');
    expect(() => compareWarnings({ ...baseline, entries: [...baseline.entries, ...baseline.entries] }, baseline)).toThrow('Duplicate');
    expect(() => compareWarnings({ ...baseline, entries: [{ ...baseline.entries[0], count: -1 }] }, baseline)).toThrow('Invalid');
  });
});


it('never records or accepts lint errors, even with explicit baseline generation', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-warning-guard-'));
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    fs.mkdirSync(path.join(fixture, 'build'));
    fs.writeFileSync(path.join(fixture, 'eslint.config.mjs'), 'export default [{ ignores: ["output/**"] }, { rules: { "no-undef": "error" } }];');
    fs.writeFileSync(path.join(fixture, 'bad.js'), 'missingFunction();');
    expect(await runWarningRatchet({ rootDir: fixture, writeBaseline: true })).toBe(1);
    expect(fs.existsSync(path.join(fixture, 'build/eslint-warning-baseline.json'))).toBe(false);
    const report = JSON.parse(fs.readFileSync(path.join(fixture, 'output/lint-warning-ratchet/comparison.json'), 'utf8'));
    expect(report.errorCount).toBe(1);
    expect(stderr).toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
  }
});
