/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createXingyeStorageRoute } from '../server/routes/xingye-storage.js';
import { readXingyeStableLoreMemoryForPromptSync } from '../shared/xingye-lore-memory-file.js';
import { readXingyeRuntimeLoreEntriesSync } from '../shared/xingye-runtime-lore-file.js';
import { LoreEditor } from '../desktop/src/react/xingye/LoreEditor';
import {
  flushXingyePersistenceNow, refreshXingyeAgentPersistence, resetXingyePersistenceForTests,
} from '../desktop/src/react/xingye/xingye-persistence';
import { listLoreEntries } from '../desktop/src/react/xingye/xingye-lore-store';

const harness = vi.hoisted(() => ({
  fetch: vi.fn(),
  state: {
    userName: 'Fixture user', agents: [],
    activeServerConnection: {
      serverId: 'local', spaceId: 'local', label: 'test',
      baseUrl: 'http://127.0.0.1:17333', wsUrl: 'ws://127.0.0.1:17333',
      token: null, authState: 'paired', trustState: 'local', capabilities: ['chat'],
    },
  },
}));
// Only transport and app-shell state are replaced. The editor, store,
// persistence bridge, storage API, Hono route and disk/mirror writers are real.
vi.mock('../desktop/src/react/hooks/use-hana-fetch', () => ({ hanaFetch: harness.fetch }));
vi.mock('../desktop/src/react/hooks/use-config', () => ({ useConfig: () => ({ config: {} }) }));
vi.mock('../desktop/src/react/stores', () => ({
  useStore: Object.assign((select: (state: typeof harness.state) => unknown) => select(harness.state), {
    getState: () => harness.state,
  }),
}));

const agentId = 'lore-fixture-a';
const otherAgentId = 'lore-fixture-b';
const stamp = '2026-10-01T00:00:00.000Z';
function row(id: string, metadata: Record<string, unknown> = {}) {
  return {
    id, agentId, title: id, content: `SYNTHETIC_${id}_CONTENT`, category: 'background',
    keywords: ['lighthouse'], enabled: true, priority: 50, insertionMode: 'always',
    visibility: 'canonical', createdAt: stamp, updatedAt: stamp, ...metadata,
  };
}
const story = { version: 1, agentId, realm: 'story', worldId: 'world', branchId: 'branch', knowledge: 'shared' };
const legacy = { version: 1, agentId, realm: 'legacy', knowledge: 'shared' };

let root: string;
let entriesPath: string;
let otherPath: string;
beforeEach(() => {
  resetXingyePersistenceForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-metadata-'));
  entriesPath = path.join(root, 'agents', agentId, 'xingye', 'lore', 'entries.json');
  otherPath = path.join(root, 'agents', otherAgentId, 'xingye', 'lore', 'entries.json');
  fs.mkdirSync(path.dirname(entriesPath), { recursive: true });
  fs.mkdirSync(path.dirname(otherPath), { recursive: true });
  fs.writeFileSync(otherPath, JSON.stringify({ other: row('other', { agentId: otherAgentId }) }));
  const app = new Hono();
  app.route('/api', createXingyeStorageRoute({
    agentsDir: path.join(root, 'agents'),
    getAgent: (id: string) => [agentId, otherAgentId].includes(id) ? { id } : null,
  }));
  harness.fetch.mockReset();
  harness.fetch.mockImplementation((url: string, init: RequestInit) => app.request(url, init));
});
afterEach(() => {
  cleanup();
  resetXingyePersistenceForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function assertDiagnostics() {
  fireEvent.click(screen.getByText('设定选择诊断（模拟预览）'));
  for (const name of ['共享始终设定选择器', '共享关键词选择器', '桌面通用选择器']) {
    const region = within(screen.getByRole('region', { name }));
    expect.soft(region.getByText('scoped').closest('li')).toHaveTextContent('作用范围无效或角色、世界、分支、知情范围不匹配');
    expect.soft(region.getByText('stale').closest('li')).toHaveTextContent('来源已过时');
    expect.soft(region.getByText('unconfirmed').closest('li')).toHaveTextContent('派生来源尚未确认有效');
    expect.soft(region.getByText('invalid').closest('li')).toHaveTextContent('作用范围无效或角色、世界、分支、知情范围不匹配');
  }
}

describe('desktop Lore metadata through the real file persistence path', () => {
  it.each(['map', 'legacy array'])('preserves edited and untouched guards through %s read, editor save and reload', async (format) => {
    const rows = [
      row('edited', { memoryScope: legacy, sourceStatus: 'active', origin: 'manual' }),
      row('scoped', { memoryScope: story, sourceStatus: 'active', origin: 'derived' }),
      row('stale', { sourceStatus: 'stale', origin: 'manual' }),
      row('unconfirmed', { sourceStatus: 'unknown', origin: 'derived' }),
      row('invalid', { memoryScope: { ...story, version: 2 }, origin: 'derived', sourceStatus: 'active' }),
      row('old', { category: 'memory', keywords: 'lighthouse，港口', priority: 200 }),
    ];
    fs.writeFileSync(entriesPath, JSON.stringify(format === 'map' ? Object.fromEntries(rows.map(entry => [entry.id, entry])) : rows));
    const before = fs.readFileSync(entriesPath, 'utf8');
    const otherBefore = fs.readFileSync(otherPath, 'utf8');
    await refreshXingyeAgentPersistence(agentId);
    render(<LoreEditor agentId={agentId} />);
    assertDiagnostics();
    expect(fs.readFileSync(entriesPath, 'utf8')).toBe(before);
    expect(harness.fetch.mock.calls.every(([, init]) => JSON.parse(init.body).action === 'readJson')).toBe(true);

    fireEvent.click(within(screen.getByTestId('lore-entry-card-edited')).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('条目正文（按预算引用）'), { target: { value: 'EDITED_SYNTHETIC_CONTENT' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设定条目' }));
    await act(async () => { await flushXingyePersistenceNow(); });
    const saved = JSON.parse(fs.readFileSync(entriesPath, 'utf8'));
    expect(saved.edited.content).toBe('EDITED_SYNTHETIC_CONTENT');
    for (const original of rows) {
      for (const key of ['memoryScope', 'sourceStatus', 'origin']) {
        expect.soft(saved[original.id][key], `${original.id}.${key} on disk`).toEqual(original[key as keyof typeof original]);
      }
    }
    expect(saved.old).toMatchObject({ category: 'background', keywords: ['lighthouse', '港口'], priority: 100 });
    expect(saved.old).not.toHaveProperty('memoryScope');
    expect(fs.readFileSync(otherPath, 'utf8')).toBe(otherBefore);

    // Recreate the in-memory binding and UI so this is a disk reload, not a cache read.
    cleanup();
    resetXingyePersistenceForTests();
    await refreshXingyeAgentPersistence(agentId);
    render(<LoreEditor agentId={agentId} />);
    assertDiagnostics();
    expect(listLoreEntries(otherAgentId)).toEqual([]);
    expect(listLoreEntries(agentId).find(entry => entry.id === 'edited')?.content).toBe('EDITED_SYNTHETIC_CONTENT');
    const stable = readXingyeStableLoreMemoryForPromptSync({ hanakoHome: root, agentId });
    const mirror = fs.readFileSync(path.join(root, 'agents', agentId, 'xingye', 'lore-memory.md'), 'utf8');
    const runtime = readXingyeRuntimeLoreEntriesSync({ hanakoHome: root, agentId });
    for (const id of ['scoped', 'stale', 'unconfirmed', 'invalid']) {
      expect.soft(stable).not.toContain(`SYNTHETIC_${id}_CONTENT`);
      expect.soft(mirror).not.toContain(`SYNTHETIC_${id}_CONTENT`);
      expect.soft(runtime.map((entry: { id: string }) => entry.id)).not.toContain(id);
    }
    expect(stable).toContain('EDITED_SYNTHETIC_CONTENT');
    expect(stable).toContain('SYNTHETIC_old_CONTENT');
  });
});
