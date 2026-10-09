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

it.runIf(process.platform === 'win32' || process.platform === 'darwin').each([
  'plain',
  // Reproduce the literal '~' in Windows temp aliases on both native platforms.
  // Escapes also ensure the loaded document is the intended fixed file.
  'RUNNER~1',
  'escaped %25 # 空间',
])('connects a new HTTP/HTTPS server while the real isolated renderer CSP stays restrictive (%s fixture path)', async directory => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-connection-csp-'));
  const output = path.join(parent, directory);
  await fs.mkdir(output);
  await build({
    entryPoints: [path.join(root, 'desktop/src/react/services/server-connection.ts')],
    outfile: path.join(output, 'connection.js'), bundle: true, format: 'iife', globalName: 'connectionApi', platform: 'browser',
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Unit-test setup mocks require('electron'); the installer records the real
  // platform executable separately, without changing that shared mock cache.
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const executable = process.env.HANA_TEST_ELECTRON_PATH || path.join(
    electronRoot, 'dist', (await fs.readFile(path.join(electronRoot, 'path.txt'), 'utf8')).trim(),
  );
  try {
    await promisify(execFile)(executable, [path.join(root, 'tests/fixtures/server-connection-csp-electron.cjs'), output], { env, windowsHide: true, timeout: 35_000 });
  } catch (error) {
    const result = await fs.readFile(path.join(output, 'result.json'), 'utf8').catch(() => 'No renderer result');
    throw new Error(`Isolated CSP fixture failed: ${result}`, { cause: error });
  }
  const result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
  expect(result.error).toBeUndefined();
  expect(result.cases.map((item: { scheme: string }) => item.scheme)).toEqual(['http', 'https']);
  for (const check of result.senderChecks) {
    expect(check.snapshotUnavailable).toBeUndefined();
    for (const url of [check.senderURL, ...check.targets.map((target: { trustedURL: string }) => target.trustedURL)]) {
      expect(url).toMatch(/^file:\/\/\/<(provided-output|real-output)>\/(settings|untrusted)\.html$/);
    }
  }
  for (const scheme of ['http', 'https']) {
    expect(result.senderChecks).toContainEqual(expect.objectContaining({
      phase: `${scheme}:initial-handshake`, outcome: 'resolved',
      targets: expect.arrayContaining([expect.objectContaining({
        scheme, navigation: 'did-finish-load', documentURLComparison: 'equal',
        predicates: { windowAlive: true, webContentsSame: true, mainFrameSame: true, documentURLSame: true },
      })]),
    }));
    expect(result.senderChecks).toContainEqual(expect.objectContaining({
      phase: `${scheme}:untrusted-document`, outcome: 'rejected',
      targets: expect.arrayContaining([expect.objectContaining({
        scheme, documentURLComparison: 'different',
        predicates: { windowAlive: true, webContentsSame: true, mainFrameSame: true, documentURLSame: false },
      })]),
    }));
  }
  console.info(`CSP evidence: ${path.join(output, 'result.json')}`);
}, 45_000);
