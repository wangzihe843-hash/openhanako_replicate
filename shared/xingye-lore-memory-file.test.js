import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getXingyeLoreMemoryFilePath,
  readXingyeLoreMemoryFile,
  writeXingyeLoreMemoryFile,
  upsertXingyeLoreMemoryBlock,
  removeXingyeLoreMemoryBlock,
  syncXingyeStableLoreMemoryFile,
  readXingyeStableLoreMemoryForPrompt,
  readXingyeStableLoreMemoryForPromptSync,
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

  it('syncs enabled canonical always lore for the current agent', async () => {
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

  it('syncs every category when it is canonical always lore', async () => {
    await syncXingyeStableLoreMemoryFile({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      entries: ['worldview', 'location', 'organization', 'rule', 'event'].map((category) =>
        baseLore({ id: category, category, summary: `${category} summary.` }),
      ),
    });

    const file = await readXingyeLoreMemoryFile({ hanakoHome: tempRoot, agentId: 'agent-a' });
    expect(file).toContain('worldview summary.');
    expect(file).toContain('location summary.');
    expect(file).toContain('organization summary.');
    expect(file).toContain('rule summary.');
    expect(file).toContain('event summary.');
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
      maxChars: 300,
    });

    const file = await readXingyeLoreMemoryFile({ hanakoHome: tempRoot, agentId: 'agent-a' });
    expect(file).toContain('...');
    expect(file).not.toContain('A'.repeat(200));
  });


  it('keeps high priority lore first and fits complete managed blocks within the default prompt budget', async () => {
    const entries = [
      baseLore({ id: 'low', title: 'Low', priority: 1, summary: 'L'.repeat(3919) }),
      baseLore({ id: 'high', title: 'High', priority: 100, summary: 'Essential high priority fact.' }),
    ];
    await syncXingyeStableLoreMemoryFile({ hanakoHome: tempRoot, agentId: 'agent-a', entries });
    const prompt = await readXingyeStableLoreMemoryForPrompt({ hanakoHome: tempRoot, agentId: 'agent-a' });
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt).toContain('Essential high priority fact.');
    expect(prompt.indexOf('id=high')).toBeLessThan(prompt.indexOf('id=low'));
    expect(prompt).toMatch(/<!-- \/xingye-lore:id=low -->$/);
    expect(prompt).toContain('...');
    const shorter = readXingyeStableLoreMemoryForPromptSync({ hanakoHome: tempRoot, agentId: 'agent-a', maxChars: 240 });
    expect(shorter.length).toBeLessThanOrEqual(240);
    expect(shorter).toMatch(/<!-- \/xingye-lore:id=high -->$/);
  });

  it('keeps later entries when an earlier title cannot fit the prompt budget', async () => {
    const options = { hanakoHome: tempRoot, agentId: 'agent-a' };
    const entries = [
      baseLore({ id: 'oversized', title: 'H'.repeat(4000), priority: 100 }),
      baseLore({ id: 'normal', title: 'Normal', priority: 1, summary: 'Keep this stable fact.' }),
    ];
    await syncXingyeStableLoreMemoryFile({ ...options, entries });
    const prompt = await readXingyeStableLoreMemoryForPrompt(options);
    expect(prompt).toContain('Keep this stable fact.');
    expect(prompt).not.toContain('id=oversized');
    expect(prompt).toMatch(/<!-- \/xingye-lore:id=normal -->$/);
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(readXingyeStableLoreMemoryForPromptSync(options)).toBe(prompt);
    const before = await readXingyeLoreMemoryFile(options);
    await syncXingyeStableLoreMemoryFile({ ...options, entries });
    expect(await readXingyeLoreMemoryFile(options)).toBe(before);
  });

  it('skips an oversized legacy block without hiding later saved text or rewriting it', async () => {
    const options = { hanakoHome: tempRoot, agentId: 'agent-a' };
    await upsertXingyeLoreMemoryBlock({
      ...options,
      lore: baseLore({ id: 'normal', title: 'Normal' }),
      content: 'Keep this saved fact.',
    });
    await upsertXingyeLoreMemoryBlock({
      ...options,
      lore: baseLore({ id: 'oversized', title: 'H'.repeat(4000) }),
      content: 'Cannot fit with this title.',
    });
    const before = await readXingyeLoreMemoryFile(options);
    expect(before.indexOf('id=oversized')).toBeLessThan(before.indexOf('id=normal'));
    const prompt = await readXingyeStableLoreMemoryForPrompt(options);
    expect(prompt).toContain('Keep this saved fact.');
    expect(prompt).not.toContain('id=oversized');
    expect(prompt).toMatch(/<!-- \/xingye-lore:id=normal -->$/);
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(readXingyeStableLoreMemoryForPromptSync(options)).toBe(prompt);
    expect(await readXingyeLoreMemoryFile(options)).toBe(before);
  });

  it('reorders retained blocks after priority-only edits and resolves ties by updatedAt', async () => {
    const options = { hanakoHome: tempRoot, agentId: 'agent-a' };
    const first = baseLore({ id: 'first', title: 'First', priority: 80, summary: 'First fact.' });
    const second = baseLore({ id: 'second', title: 'Second', priority: 30, summary: 'Second fact.' });
    await syncXingyeStableLoreMemoryFile({ ...options, entries: [first, second] });
    const result = await syncXingyeStableLoreMemoryFile({ ...options, entries: [first, { ...second, priority: 90 }] });
    expect(result).toMatchObject({ retained: 2, upserted: 0 });
    const reordered = await readXingyeLoreMemoryFile(options);
    expect(reordered.indexOf('id=second')).toBeLessThan(reordered.indexOf('id=first'));
    await syncXingyeStableLoreMemoryFile({ ...options, entries: [first, { ...second, priority: 90 }] });
    expect(await readXingyeLoreMemoryFile(options)).toBe(reordered);

    await syncXingyeStableLoreMemoryFile({
      ...options,
      entries: [{ ...first, updatedAt: '2026-03-01T00:00:00.000Z' }, { ...second, priority: 80 }],
    });
    const updated = await readXingyeLoreMemoryFile(options);
    expect(updated.indexOf('id=first')).toBeLessThan(updated.indexOf('id=second'));
  });

  it('uses canonical metadata to order old blocks without replacing their text or rewriting the file', async () => {
    const options = { hanakoHome: tempRoot, agentId: 'agent-a' };
    const high = baseLore({ id: 'high', title: 'High', priority: 100 });
    const low = baseLore({ id: 'low', title: 'Low', priority: 1 });
    await upsertXingyeLoreMemoryBlock({ ...options, lore: high, content: 'Saved high summary.' });
    await upsertXingyeLoreMemoryBlock({ ...options, lore: low, content: 'L'.repeat(3919) });
    const before = await readXingyeLoreMemoryFile(options);
    expect(before.indexOf('id=low')).toBeLessThan(before.indexOf('id=high'));
    const entriesPath = path.join(tempRoot, 'agents', 'agent-a', 'xingye', 'lore', 'entries.json');
    await fs.mkdir(path.dirname(entriesPath), { recursive: true });
    await fs.writeFile(entriesPath, JSON.stringify(Object.fromEntries([
      { ...high, summary: 'Canonical source must not replace derived text.' },
      low,
      baseLore({ id: 'only-in-source', priority: 200, summary: 'Do not add this body.' }),
    ].map(entry => [entry.id, entry]))));
    const prompt = await readXingyeStableLoreMemoryForPrompt(options);
    expect(prompt).toContain('Saved high summary.');
    expect(prompt.indexOf('id=high')).toBeLessThan(prompt.indexOf('id=low'));
    expect(prompt).not.toContain('Canonical source');
    expect(prompt).not.toContain('Do not add this body.');
    expect(readXingyeStableLoreMemoryForPromptSync(options)).toBe(prompt);
    expect(await readXingyeLoreMemoryFile(options)).toBe(before);
  });

  it('preserves handwritten notes between blocks during a complete reorder', async () => {
    const options = { hanakoHome: tempRoot, agentId: 'agent-a' };
    const entries = [baseLore({ id: 'one' }), baseLore({ id: 'two' })];
    await syncXingyeStableLoreMemoryFile({ ...options, entries });
    const content = await readXingyeLoreMemoryFile(options);
    const manual = 'Manual note with intentional spacing.\n\n\n\nKeep this paragraph.';
    await writeXingyeLoreMemoryFile({
      ...options,
      content: content.replace('<!-- /xingye-lore:id=one -->', '<!-- /xingye-lore:id=one -->\n\n' + manual),
    });
    await syncXingyeStableLoreMemoryFile({ ...options, entries: entries.map(entry => ({ ...entry, priority: entry.id === 'two' ? 100 : 1 })) });
    expect(await readXingyeLoreMemoryFile(options)).toContain(manual);
  });

  it('omits blocks when the complete marker overhead cannot fit', async () => {
    const options = { hanakoHome: tempRoot, agentId: 'agent-a' };
    await syncXingyeStableLoreMemoryFile({ ...options, entries: [baseLore()], maxChars: 80 });
    expect(await readXingyeStableLoreMemoryForPrompt(options)).toBe('');
    await upsertXingyeLoreMemoryBlock({ ...options, lore: baseLore(), content: 'Body' });
    expect(readXingyeStableLoreMemoryForPromptSync({ ...options, maxChars: 80 })).toBe('');
  });

  it('leaves the last good file intact if atomic replacement fails', async () => {
    const options = { hanakoHome: tempRoot, agentId: 'agent-a' };
    await syncXingyeStableLoreMemoryFile({ ...options, entries: [baseLore()] });
    const before = await readXingyeLoreMemoryFile(options);
    const failRename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated rename failure'));
    try {
      await expect(syncXingyeStableLoreMemoryFile({
        ...options, entries: [baseLore({ summary: 'New text' })],
      })).rejects.toThrow('simulated rename failure');
    } finally {
      failRename.mockRestore();
    }
    expect(await readXingyeLoreMemoryFile(options)).toBe(before);
    expect(await fs.readdir(path.dirname(getXingyeLoreMemoryFilePath(options)))).toEqual(['lore-memory.md']);
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
