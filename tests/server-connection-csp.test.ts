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

it.runIf(process.platform === 'win32')('connects a new HTTP/HTTPS server while the real isolated renderer CSP stays restrictive', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-connection-csp-'));
  await build({
    entryPoints: [path.join(root, 'desktop/src/react/services/server-connection.ts')],
    outfile: path.join(output, 'connection.js'), bundle: true, format: 'iife', globalName: 'connectionApi', platform: 'browser',
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.HANA_TEST_ELECTRON_PATH || require('electron');
  try {
    await promisify(execFile)(executable, [path.join(root, 'tests/fixtures/server-connection-csp-electron.cjs'), output], { env, windowsHide: true, timeout: 35_000 });
  } catch (error) {
    const result = await fs.readFile(path.join(output, 'result.json'), 'utf8').catch(() => 'No renderer result');
    throw new Error(`Isolated CSP fixture failed: ${result}`, { cause: error });
  }
  const result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
  expect(result.error).toBeUndefined();
  expect(result.cases.map((item: { scheme: string }) => item.scheme)).toEqual(['http', 'https']);
  console.info(`CSP evidence: ${path.join(output, 'result.json')}`);
}, 45_000);
