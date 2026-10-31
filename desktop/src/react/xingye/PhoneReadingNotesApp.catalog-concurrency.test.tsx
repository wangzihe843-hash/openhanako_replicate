/** @vitest-environment jsdom */
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error The production server route is JavaScript without a declaration file.
import { createXingyeStorageRoute } from '../../../../server/routes/xingye-storage.js';
import { listBooksForAgent, readingBookCatalogPath } from './xingye-reading-book-catalog';

const mock = vi.hoisted(() => ({ post: vi.fn(), history: vi.fn(), saveHistory: vi.fn() }));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: mock.post }));
vi.mock('./xingye-reading-history-ai', () => ({ generateReadingHistoryWithAI: mock.history }));
vi.mock('./xingye-app-history-state', () => ({ loadHistoryState: async () => ({ version: 1 }), saveHistoryState: mock.saveHistory }));
vi.mock('./xingye-app-entry-store', () => ({ listAppEntries: async () => [], appendAppEntry: vi.fn(), deleteAppEntry: vi.fn() }));
vi.mock('./xingye-reading-notes-drafts', () => ({ listReadingNoteDrafts: async () => [], confirmReadingNoteDraft: vi.fn(), discardReadingNoteDraft: vi.fn() }));
vi.mock('./xingye-open-library-adapter', () => ({ searchOpenLibraryBooksViaProxy: vi.fn() }));
vi.mock('./xingye-reading-topics-ai', () => ({ inferReadingTopicsWithAI: vi.fn() }));
vi.mock('./xingye-wikiquote-adapter', () => ({ fetchWikiquoteSuggestions: vi.fn() }));
vi.mock('./xingye-reading-annotation-ai', () => ({ inferReadingAnnotationWithAI: vi.fn() }));
import { PhoneReadingNotesApp } from './PhoneReadingNotesApp';

const roots: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => {
  cleanup(); vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each(['bootstrap', 'manual'])('keeps both real catalog writes when %s finishes last in the mounted reading UI', async (last) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-ui-catalog-'));
  roots.push(root);
  const agent = { id: 'reading-owner', name: 'Reader', yuan: 'hanako', isPrimary: false, hasAvatar: false };
  const agentsDir = path.join(root, 'agents');
  const app = new Hono().route('/api', createXingyeStorageRoute({ agentsDir, getAgent: (id: string) => id === agent.id ? agent : null }));
  const entered = deferred(); const release = deferred(); const model = deferred();
  let pause = true;
  mock.post.mockImplementation(async (body) => {
    // Old snapshot protocol is included so this same UI test is red on the fixed base.
    if (pause && ['writeJsonl', 'mutateReadingBookCatalog'].includes(body.action)) {
      pause = false; entered.resolve(); await release.promise;
    }
    const response = await app.request('/api/xingye/storage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
  });
  mock.history.mockImplementation(async () => {
    if (last === 'manual') await model.promise;
    return [{ book: { title: 'Bootstrap book', authors: ['Synthetic'] }, annotations: [] }];
  });
  mock.saveHistory.mockResolvedValue({ version: 1 });
  render(<PhoneReadingNotesApp ownerAgent={agent} ownerProfile={null} displayName="Reader" onBack={() => {}} />);
  await waitFor(() => expect(mock.history).toHaveBeenCalledTimes(1));
  if (last === 'bootstrap') await entered.promise;
  fireEvent.click(screen.getByRole('button', { name: '新增书目' }));
  fireEvent.change(screen.getByLabelText('书名'), { target: { value: 'Manual book' } });
  fireEvent.click(screen.getByRole('button', { name: '保存书目' }));
  if (last === 'manual') {
    await entered.promise;
    await act(async () => { model.resolve(); });
    await waitFor(() => expect(mock.saveHistory).toHaveBeenCalledTimes(1));
  } else {
    await screen.findByText('Manual book');
  }
  const file = path.join(agentsDir, agent.id, 'xingye', readingBookCatalogPath());
  expect(fs.readFileSync(file, 'utf8')).toContain(last === 'manual' ? 'Bootstrap book' : 'Manual book');
  await act(async () => { release.resolve(); });
  await waitFor(async () => expect((await listBooksForAgent(agent.id)).map((row) => row.title).sort()).toEqual(['Bootstrap book', 'Manual book']));
  await screen.findByRole('heading', { name: 'Manual book' });
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await screen.findByText('Bootstrap book');
  await screen.findByText('Manual book');
  await waitFor(() => expect(mock.saveHistory).toHaveBeenCalledTimes(1));
  expect((await listBooksForAgent(agent.id)).map((row) => row.title).sort()).toEqual(['Bootstrap book', 'Manual book']);
  expect(mock.post.mock.calls.every(([body]) => body.agentId === agent.id)).toBe(true);
});
