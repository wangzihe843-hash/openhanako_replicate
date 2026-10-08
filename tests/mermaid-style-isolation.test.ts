import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');

it.runIf(process.platform === 'darwin' || process.platform === 'win32')('isolates Mermaid styles during rendering and display while retaining diagram behavior', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-mermaid-isolation-'));
  await build({
    entryPoints: [path.join(root, 'desktop/src/react/utils/mermaid-renderer.ts')],
    outfile: path.join(output, 'renderer.js'), bundle: true, format: 'iife', globalName: 'mermaidRenderer', platform: 'browser',
  });
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const executable = process.env.HANA_TEST_ELECTRON_PATH || path.join(
    electronRoot, 'dist', (await fs.readFile(path.join(electronRoot, 'path.txt'), 'utf8')).trim(),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await promisify(execFile)(executable, [path.join(root, 'tests/fixtures/mermaid-style-isolation-electron.cjs'), output], { env, windowsHide: true, timeout: 40_000 });
  } catch (error) {
    const result = await fs.readFile(path.join(output, 'result.json'), 'utf8').catch(() => 'No renderer result');
    throw new Error(`Mermaid isolation fixture failed: ${result}`, { cause: error });
  }
  const result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
  expect(result.error).toBeUndefined();
  expect(result.cases.map((item: { name: string }) => item.name)).toEqual([
    'themeCSS', 'fontFamily', 'frontmatter', 'secure-config', 'normal-animated', 'state', 'gantt', 'sequence', 'editing-and-errors',
  ]);
  console.info(`Mermaid isolation evidence: ${path.join(output, 'result.json')}`);
}, 50_000);
