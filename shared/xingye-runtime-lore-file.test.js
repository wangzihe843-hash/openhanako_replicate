import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readXingyeRuntimeLoreEntriesSync } from './xingye-runtime-lore-file.js';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xingye-runtime-lore-file-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function entry(overrides = {}) {
  return {
    id: overrides.id ?? 'lore-1',
    agentId: overrides.agentId ?? 'agent-a',
    title: overrides.title ?? 'Moon Observatory',
    content: overrides.content ?? 'The moon observatory opens during silver rain.',
    category: overrides.category ?? 'location',
    keywords: overrides.keywords ?? ['observatory'],
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 50,
    insertionMode: overrides.insertionMode ?? 'keyword',
    visibility: overrides.visibility ?? 'canonical',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-02T00:00:00.000Z',
  };
}

describe('readXingyeRuntimeLoreEntriesSync', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) {
      fs.rmSync(roots.pop(), { recursive: true, force: true });
    }
  });

  it('prefers hanakoHome agents/.../xingye/lore/entries.json over workspace v2 lore.json', () => {
    const workspaceRoot = makeRoot();
    roots.push(workspaceRoot);
    const hanakoHome = makeRoot();
    roots.push(hanakoHome);
    writeJson(path.join(workspaceRoot, '.xingye', 'agents', 'agent-a', 'lore.json'), [
      entry({ id: 'workspace' }),
    ]);
    writeJson(path.join(hanakoHome, 'agents', 'agent-a', 'xingye', 'lore', 'entries.json'), {
      home: entry({ id: 'hana-lore' }),
    });

    const entries = readXingyeRuntimeLoreEntriesSync({
      workspaceRoot,
      hanakoHome,
      agentId: 'agent-a',
    });

    expect(entries.map((item) => item.id)).toEqual(['hana-lore']);
  });

  it('reads workspace v2 agent lore when hanakoHome has no entries file', () => {
    const root = makeRoot();
    roots.push(root);
    writeJson(path.join(root, '.xingye', 'agents', 'agent-a', 'lore.json'), [
      entry({ id: 'v2' }),
    ]);
    writeJson(path.join(root, '.xingye', 'v1', 'data', 'lore-entries.json'), {
      legacy: entry({ id: 'v1' }),
    });

    const entries = readXingyeRuntimeLoreEntriesSync({
      workspaceRoot: root,
      agentId: 'agent-a',
    });

    expect(entries.map((item) => item.id)).toEqual(['v2']);
  });

  it('falls back to workspace v1 lore entries', () => {
    const root = makeRoot();
    roots.push(root);
    writeJson(path.join(root, '.xingye', 'v1', 'data', 'lore-entries.json'), {
      own: entry({ id: 'own' }),
      other: entry({ id: 'other', agentId: 'agent-b' }),
    });

    const entries = readXingyeRuntimeLoreEntriesSync({
      workspaceRoot: root,
      agentId: 'agent-a',
    });

    expect(entries.map((item) => item.id)).toEqual(['own']);
  });

  it('uses hanakoHome and agentDir mirror lore when workspaceRoot is missing', () => {
    const hanakoHome = makeRoot();
    roots.push(hanakoHome);
    const agentDir = path.join(hanakoHome, 'agents', 'agent-a');
    writeJson(path.join(agentDir, 'xingye', 'lore.json'), [
      entry({ id: 'mirror' }),
    ]);

    const entries = readXingyeRuntimeLoreEntriesSync({
      hanakoHome,
      agentDir,
      agentId: 'agent-a',
    });

    expect(entries.map((item) => item.id)).toEqual(['mirror']);
  });

  it('returns an empty list when all sources are missing', () => {
    const root = makeRoot();
    roots.push(root);

    const entries = readXingyeRuntimeLoreEntriesSync({
      workspaceRoot: root,
      agentId: 'agent-a',
    });

    expect(entries).toEqual([]);
  });

  it('fails closed when reading a source fails', () => {
    const root = makeRoot();
    roots.push(root);
    fs.mkdirSync(path.join(root, '.xingye', 'agents', 'agent-a', 'lore.json'), {
      recursive: true,
    });

    expect(() =>
      readXingyeRuntimeLoreEntriesSync({
        workspaceRoot: root,
        agentId: 'agent-a',
      }),
    ).not.toThrow();
    expect(
      readXingyeRuntimeLoreEntriesSync({
        workspaceRoot: root,
        agentId: 'agent-a',
      }),
    ).toEqual([]);
  });
});
