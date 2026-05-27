import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postXingyeStorage } from './xingye-storage-api';
import { hanaFetch } from '../hooks/use-hana-fetch';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

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
  beforeEach(() => {
    (hanaFetch as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('client rejects /api/xingye/storage calls without agentId before fetch', async () => {
    await expect(postXingyeStorage({ action: 'readJson', relativePath: 'profile.json' }))
      .rejects
      .toThrow('agentId is required');
  });

  it('happy-path forwards agentId + action + relativePath to /api/xingye/storage via hanaFetch', async () => {
    const mockFetch = hanaFetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: 'ok' }),
    });

    const result = await postXingyeStorage({
      agentId: 'agent-xyz',
      action: 'readJson',
      relativePath: 'profile.json',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/xingye/storage');
    expect(init.method).toBe('POST');
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody.agentId).toBe('agent-xyz');
    expect(parsedBody.action).toBe('readJson');
    expect(parsedBody.relativePath).toBe('profile.json');
    expect(result).toEqual({ result: 'ok' });
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
