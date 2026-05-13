import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { postXingyeStorage } from './xingye-storage-api';

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('xingye storage contract', () => {
  it('client rejects /api/xingye/storage calls without agentId before fetch', async () => {
    await expect(postXingyeStorage({ action: 'readJson', relativePath: 'profile.json' }))
      .rejects
      .toThrow('agentId is required');
  });

  it('UI business code does not import the legacy workspace v2 storage entry', () => {
    const root = path.join(process.cwd(), 'desktop', 'src', 'react');
    const offenders = collectSourceFiles(root)
      .filter(file => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter(file => path.basename(file) !== 'xingye-workspace-v2.ts')
      .filter(file => fs.readFileSync(file, 'utf8').includes('xingye-workspace-v2'));

    expect(offenders.map(file => path.relative(process.cwd(), file))).toEqual([]);
  });

  it('direct postXingyeStorage object calls in production source include agentId', () => {
    const roots = [
      path.join(process.cwd(), 'desktop', 'src', 'react', 'xingye'),
      path.join(process.cwd(), 'server'),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of collectSourceFiles(root)) {
        if (/\.test\.(ts|tsx|js|jsx)$/.test(file)) continue;
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
          if (!line.includes('postXingyeStorage({')) return;
          const window = lines.slice(index, index + 8).join('\n');
          if (!/\bagentId\b/.test(window)) {
            offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
