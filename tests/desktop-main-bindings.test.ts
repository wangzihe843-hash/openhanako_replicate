import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import globals from 'globals';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'build/shell-surface-manifest.json'), 'utf8'));
const sourceFiles = ['desktop', 'shared', 'server']
  .flatMap((directory) => [...fs.globSync(`${directory}/**/*.cjs`, { cwd: root })])
  .map((file) => file.split(path.sep).join('/'))
  .filter((file) => !file.endsWith('.bundle.cjs'))
  .sort();
const shellCjsSources = manifest.asarFiles
  .flatMap((entry: { sourceEntry?: string; sourcePaths?: string[] }) => [
    ...(entry.sourceEntry ? [entry.sourceEntry] : []),
    ...(entry.sourcePaths ?? []),
  ])
  .filter((file: string) => file.endsWith('.cjs'));

describe('first-party desktop CJS bindings', () => {
  it('covers every CJS source named by the shell package census', () => {
    expect(sourceFiles).toContain('desktop/main.cjs');
    expect(sourceFiles).toContain('desktop/bootstrap.cjs');
    for (const file of shellCjsSources) expect(sourceFiles).toContain(file);
  });

  it('has no undeclared references or syntax errors in desktop, shared, and server CJS', () => {
    const linter = new Linter({ configType: 'flat' });
    const errors = sourceFiles.flatMap((file) => linter.verify(
      fs.readFileSync(path.join(root, file), 'utf8'),
      [{
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'commonjs',
          globals: file === 'desktop/preload.cjs'
            ? { ...globals.node, window: 'readonly', localStorage: 'readonly' }
            : globals.node,
        },
        rules: { 'no-undef': 'error' },
      }],
    ).filter((message) => message.severity === 2)
      .map((message) => `${file}:${message.line}:${message.column} ${message.message}`));
    expect(errors).toEqual([]);
  });
});
