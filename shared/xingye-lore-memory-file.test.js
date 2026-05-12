import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getXingyeLoreMemoryFilePath,
  readXingyeLoreMemoryFile,
  writeXingyeLoreMemoryFile,
  upsertXingyeLoreMemoryBlock,
  removeXingyeLoreMemoryBlock,
  syncXingyeStableLoreMemoryFile,
  readXingyeStableLoreMemoryForPrompt,
} from './xingye-lore-memory-file.js';

let tempRoot;

const baseLore = (overrides = {}) => ({
  id: overrides.id ?? 'lore-1',
  agentId: overrides.agentId ?? 'agent-a',
  title: overrides.title ?? 'Childhood',
  summary: overrides.summary,
  content: overrides.content ?? 'Raised beside the old observatory.',
  category: overrides.category ?? 'background',
  enabled: overrides.enabled ?? true,
  visibility: overrides.visibility ?? 'canonical',
  insertionMode: overrides.insertionMode ?? 'always',
  priority: overrides.priority ?? 50,
  updatedAt: overrides.updatedAt ?? '2026-01-02T00:00:00.000Z',
});

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xingye-lore-memory-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('xingye lore memory file helper', () => {
  it('builds an agent-isolated memory file path', () => {
    expect(getXingyeLoreMemoryFilePath({ hanakoHome: tempRoot, agentId: 'agent-a' })).toBe(
      path.join(tempRoot, 'agents', 'agent-a', 'xingye', 'lore-memory.md'),
    );
    expect(getXingyeLoreMemoryFilePath({ hanakoHome: tempRoot, agentId: 'agent-b' })).toBe(
      path.join(tempRoot, 'agents', 'agent-b', 'xingye', 'lore-memory.md'),
    );
  });

  it('returns an empty string when the file does not exist', async () => {
    await expect(readXingyeLoreMemoryFile({ hanakoHome: tempRoot, agentId: 'agent-a' })).resolves.toBe('');
  });

  it('fails closed without writing when agentId is empty', async () => {
    await expect(
      writeXingyeLoreMemoryFile({ hanakoHome: tempRoot, agentId: '', content: 'Should not write.' }),
    ).rejects.toThrow('agentId is required');

    await expect(readXingyeLoreMemoryFile({ hanakoHome: tempRoot, agentId: '' })).resolves.toBe('');
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });

  it('upserts a new managed block', async () => {
    const result = await upsertXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      lore: baseLore(),
      content: 'Stable memory summary.',
    });

    expect(result).toContain('# Xingye Lore Memory');
    expect(result).toContain('<!-- xingye-lore-memory:managed=true agentId=agent-a -->');
    expect(result).toContain('<!-- xingye-lore:id=lore-1 agentId=agent-a category=background updatedAt=2026-01-02T00:00:00.000Z -->');
    expect(result).toContain('### Childhood');
    expect(result).toContain('Stable memory summary.');
  });

  it('updates an existing id without duplicating its block', async () => {
    await upsertXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      lore: baseLore(),
      content: 'Old summary.',
    });

    const result = await upsertXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      lore: baseLore({ title: 'Updated Title', updatedAt: '2026-01-03T00:00:00.000Z' }),
      content: 'New summary.',
    });

    expect(result.match(/xingye-lore:id=lore-1/g)).toHaveLength(2);
    expect(result).toContain('### Updated Title');
    expect(result).toContain('New summary.');
    expect(result).not.toContain('Old summary.');
  });

  it('removes a managed block by lore id', async () => {
    await upsertXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      lore: baseLore(),
      content: 'Stable memory summary.',
    });

    const result = await removeXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      loreId: 'lore-1',
    });

    expect(result).not.toContain('xingye-lore:id=lore-1');
    expect(result).not.toContain('Stable memory summary.');
  });

  it('removes only the requested lore block', async () => {
    await upsertXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      lore: baseLore({ id: 'keep', title: 'Keep' }),
      content: 'Keep summary.',
    });
    await upsertXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      lore: baseLore({ id: 'remove', title: 'Remove' }),
      content: 'Remove summary.',
    });

    const result = await removeXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      loreId: 'remove',
    });

    expect(result).toContain('xingye-lore:id=keep');
    expect(result).toContain('Keep summary.');
    expect(result).not.toContain('xingye-lore:id=remove');
  });

  it('syncs only enabled canonical always stable categories for the current agent', async () => {
    const result = await syncXingyeStableLoreMemoryFile({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      entries: [
        baseLore({ id: 'background', category: 'background', summary: 'Background summary.' }),
        baseLore({ id: 'relationship', category: 'relationship', summary: 'Relationship summary.' }),
        baseLore({ id: 'character', category: 'character', summary: 'Character summary.' }),
        baseLore({ id: 'disabled', enabled: false, summary: 'Disabled summary.' }),
        baseLore({ id: 'draft', visibility: 'draft', summary: 'Draft summary.' }),
        baseLore({ id: 'manual', insertionMode: 'manual', summary: 'Manual summary.' }),
        baseLore({ id: 'other-agent', agentId: 'agent-b', summary: 'Other agent summary.' }),
      ],
    });

    const file = await readXingyeLoreMemoryFile({ hanakoHome: tempRoot, agentId: 'agent-a' });
    expect(result).toMatchObject({ upserted: 3, removed: 0, retained: 0 });
    expect(file).toContain('Background summary.');
    expect(file).toContain('Relationship summary.');
    expect(file).toContain('Character summary.');
    expect(file).not.toContain('Disabled summary.');
    expect(file).not.toContain('Draft summary.');
    expect(file).not.toContain('Manual summary.');
    expect(file).not.toContain('Other agent summary.');
  });

  it('does not sync non-stable lore categories', async () => {
    await syncXingyeStableLoreMemoryFile({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      entries: ['worldview', 'location', 'organization', 'rule', 'event'].map((category) =>
        baseLore({ id: category, category, summary: `${category} summary.` }),
      ),
    });

    const file = await readXingyeLoreMemoryFile({ hanakoHome: tempRoot, agentId: 'agent-a' });
    expect(file).not.toContain('worldview summary.');
    expect(file).not.toContain('location summary.');
    expect(file).not.toContain('organization summary.');
    expect(file).not.toContain('rule summary.');
    expect(file).not.toContain('event summary.');
  });

  it('removes previously managed blocks that no longer qualify during sync', async () => {
    await syncXingyeStableLoreMemoryFile({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      entries: [
        baseLore({ id: 'keep', summary: 'Keep summary.' }),
        baseLore({ id: 'disabled', summary: 'Old disabled summary.' }),
      ],
    });

    const result = await syncXingyeStableLoreMemoryFile({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      entries: [
        baseLore({ id: 'keep', summary: 'Keep summary.' }),
        baseLore({ id: 'disabled', enabled: false, summary: 'New disabled summary.' }),
      ],
    });

    const file = await readXingyeLoreMemoryFile({ hanakoHome: tempRoot, agentId: 'agent-a' });
    expect(result).toMatchObject({ upserted: 0, removed: 1, retained: 1 });
    expect(file).toContain('Keep summary.');
    expect(file).not.toContain('Old disabled summary.');
    expect(file).not.toContain('New disabled summary.');
  });

  it('preserves non-managed hand-written content', async () => {
    await writeXingyeLoreMemoryFile({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      content: '# Xingye Lore Memory\n\nManual note outside managed section.\n',
    });

    await upsertXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      lore: baseLore(),
      content: 'Stable memory summary.',
    });
    const result = await removeXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      loreId: 'lore-1',
    });

    expect(result).toContain('Manual note outside managed section.');
  });

  it('honors maxChars when syncing summaries', async () => {
    await syncXingyeStableLoreMemoryFile({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      entries: [
        baseLore({ id: 'long', title: 'Long', summary: 'A'.repeat(200), content: 'B'.repeat(200) }),
      ],
      maxChars: 120,
    });

    const file = await readXingyeLoreMemoryFile({ hanakoHome: tempRoot, agentId: 'agent-a' });
    expect(file).toContain('...');
    expect(file).not.toContain('A'.repeat(200));
  });

  it('does not emit undefined, null, or object fragments', async () => {
    const file = await upsertXingyeLoreMemoryBlock({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      lore: baseLore({ title: undefined, content: { unexpected: true } }),
      content: null,
    });

    expect(file).not.toContain('undefined');
    expect(file).not.toContain('null');
    expect(file).not.toContain('[object Object]');
  });

  it('returns an empty prompt context when the file does not exist', async () => {
    await expect(readXingyeStableLoreMemoryForPrompt({ hanakoHome: tempRoot, agentId: 'agent-a' })).resolves.toBe('');
  });
});
