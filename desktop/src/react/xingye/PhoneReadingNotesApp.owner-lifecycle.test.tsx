/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import type { AppEntry, AppEntryInput } from './xingye-app-entry-store';
import type { XingyeAppHistoryState } from './xingye-app-history-state';
import type {
  AgentBookTagContext,
  BookSearchResult,
  XingyeBookCatalogEntry,
} from './xingye-reading-book-catalog';
import type { ReadingHistoryBookWithAnnotations } from './xingye-reading-history-ai';

const catalog = vi.hoisted(() => ({
  listBooksForAgent: vi.fn(),
  importBooksForAgent: vi.fn(),
  deleteBookForAgent: vi.fn(),
}));
const entries = vi.hoisted(() => ({
  listAppEntries: vi.fn(), appendAppEntry: vi.fn(), deleteAppEntry: vi.fn(),
}));
const drafts = vi.hoisted(() => ({
  listReadingNoteDrafts: vi.fn(), confirmReadingNoteDraft: vi.fn(), discardReadingNoteDraft: vi.fn(),
}));
const history = vi.hoisted(() => ({ loadHistoryState: vi.fn(), saveHistoryState: vi.fn() }));
const ai = vi.hoisted(() => ({ generateReadingHistoryWithAI: vi.fn() }));
vi.mock('./xingye-reading-book-catalog', () => catalog);
vi.mock('./xingye-app-entry-store', () => entries);
vi.mock('./xingye-reading-notes-drafts', () => drafts);
vi.mock('./xingye-app-history-state', () => history);
vi.mock('./xingye-reading-history-ai', () => ai);
vi.mock('./xingye-open-library-adapter', () => ({ searchOpenLibraryBooksViaProxy: vi.fn() }));
vi.mock('./xingye-reading-topics-ai', () => ({ inferReadingTopicsWithAI: vi.fn() }));
vi.mock('./xingye-wikiquote-adapter', () => ({ fetchWikiquoteSuggestions: vi.fn() }));
vi.mock('./xingye-reading-annotation-ai', () => ({ inferReadingAnnotationWithAI: vi.fn() }));

import { PhoneReadingNotesApp } from './PhoneReadingNotesApp';

const A: Agent = { id: 'reader-a', name: 'Role A', yuan: 'hanako', isPrimary: false, hasAvatar: false };
const B: Agent = { ...A, id: 'reader-b', name: 'Role B' };
const NOW = '2026-10-31T00:00:00.000Z';
const shelves = new Map<string, XingyeBookCatalogEntry[]>();
const notes = new Map<string, AppEntry[]>();
const states = new Map<string, XingyeAppHistoryState>();
let nextId = 0;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function book(agentId: string, title: string): XingyeBookCatalogEntry {
  return {
    key: `synthetic:${agentId}:${title}`, id: `${agentId}:${title}`, dedupeKey: `${agentId}:${title}`,
    title, authors: ['Synthetic Author'], subjects: ['offline'], description: `${title} details`,
    agentTags: [{ agentId, reason: 'fixture', interests: [], createdAt: NOW }],
    createdAt: NOW, updatedAt: NOW,
  };
}

function generated(title: string): ReadingHistoryBookWithAnnotations[] {
  return [{
    book: { title, authors: ['Synthetic Author'], subjects: ['offline'], description: `${title} details` },
    annotations: [{ title: `${title} note`, annotation: `${title} private annotation`, occurredAt: NOW }],
  }];
}

function readBooks(agentId: string): XingyeBookCatalogEntry[] {
  return [...(shelves.get(agentId) ?? [])];
}

async function importBooks(agentId: string, rows: BookSearchResult[], tags: AgentBookTagContext) {
  const imported = rows.map((row) => ({
    ...row, id: `synthetic-book-${++nextId}`, dedupeKey: row.key || row.title,
    agentTags: [{ agentId, reason: tags.reason, interests: tags.interests, createdAt: NOW }],
    createdAt: NOW, updatedAt: NOW,
  }));
  shelves.set(agentId, [...readBooks(agentId), ...imported]);
  return imported;
}

async function saveState(agentId: string, _appId: string, patch: Partial<XingyeAppHistoryState>) {
  const state: XingyeAppHistoryState = { ...states.get(agentId), ...patch, version: 1 };
  states.set(agentId, state);
  return state;
}

function view(agent: Agent | null) {
  return <PhoneReadingNotesApp ownerAgent={agent} ownerProfile={null} displayName={agent?.name ?? 'TA'} onBack={() => {}} />;
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

async function completeModel(gate: ReturnType<typeof deferred<ReadingHistoryBookWithAnnotations[]>>, title: string) {
  await act(async () => { gate.resolve(generated(title)); });
}

async function expectShelf(title: string) {
  await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(title) })).toBeInTheDocument());
}

function expectNoAUi() {
  expect(screen.queryByText(/A private/)).not.toBeInTheDocument();
  expect(screen.queryByText(/已为 TA 铺好/)).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.resetAllMocks();
  shelves.clear(); notes.clear(); states.clear(); nextId = 0;
  catalog.listBooksForAgent.mockImplementation(async (agentId: string) => readBooks(agentId));
  catalog.importBooksForAgent.mockImplementation(importBooks);
  catalog.deleteBookForAgent.mockResolvedValue(true);
  entries.listAppEntries.mockImplementation(async (agentId: string) => [...(notes.get(agentId) ?? [])]);
  entries.appendAppEntry.mockImplementation(async (agentId: string, appId: AppEntry['appId'], input: AppEntryInput) => {
    const row: AppEntry = {
      id: `synthetic-note-${++nextId}`, agentId, appId, title: input.title, content: input.content,
      metadata: input.metadata ?? {}, source: input.source ?? 'manual',
      createdAt: input.createdAt ?? NOW, updatedAt: NOW,
    };
    notes.set(agentId, [...(notes.get(agentId) ?? []), row]);
    return row;
  });
  drafts.listReadingNoteDrafts.mockResolvedValue([]);
  history.loadHistoryState.mockImplementation(async (agentId: string) => states.get(agentId) ?? { version: 1 });
  history.saveHistoryState.mockImplementation(saveState);
  ai.generateReadingHistoryWithAI.mockResolvedValue(generated('normal history'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access in offline lifecycle test'));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('reading initialization owner lifetime', () => {
  it('discards A model output after switching to an existing B shelf', async () => {
    const oldModel = deferred<ReadingHistoryBookWithAnnotations[]>();
    ai.generateReadingHistoryWithAI.mockReturnValue(oldModel.promise);
    shelves.set(B.id, [book(B.id, 'B safe bookshelf')]);
    const app = render(view(A));
    await waitFor(() => expect(ai.generateReadingHistoryWithAI).toHaveBeenCalledTimes(1));
    app.rerender(view(B));
    await expectShelf('B safe bookshelf');
    await completeModel(oldModel, 'A private history book');
    await flush();
    expectNoAUi();
    await expectShelf('B safe bookshelf');
    expect(catalog.importBooksForAgent).not.toHaveBeenCalled();
    expect(shelves.get(A.id)).toBeUndefined();
    expect(readBooks(B.id).map((row) => row.title)).toEqual(['B safe bookshelf']);
    expect(history.saveHistoryState.mock.calls.every(([owner]) => owner !== A.id)).toBe(true);
  });

  it('finishes an admitted A import under A and cannot replace B selected book', async () => {
    const importGate = deferred<void>();
    catalog.importBooksForAgent.mockImplementation(async (agentId: string, rows: BookSearchResult[], tags: AgentBookTagContext) => {
      if (agentId === A.id) await importGate.promise;
      return importBooks(agentId, rows, tags);
    });
    ai.generateReadingHistoryWithAI.mockResolvedValue(generated('A private history book'));
    shelves.set(B.id, [book(B.id, 'B safe bookshelf')]);
    const app = render(view(A));
    await waitFor(() => expect(catalog.importBooksForAgent).toHaveBeenCalledTimes(1));
    app.rerender(view(B));
    await expectShelf('B safe bookshelf');
    fireEvent.click(screen.getByRole('button', { name: /B safe bookshelf/ }));
    await act(async () => { importGate.resolve(); });
    await waitFor(() => expect(states.get(A.id)?.initializedAt).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'B safe bookshelf' })).toBeInTheDocument();
    expectNoAUi();
    expect(readBooks(A.id).map((row) => row.title)).toEqual(['A private history book']);
    expect(notes.get(A.id)?.[0]).toMatchObject({ agentId: A.id, content: 'A private history book private annotation' });
    expect(notes.get(B.id)).toBeUndefined();
    expect(readBooks(B.id).map((row) => row.title)).toEqual(['B safe bookshelf']);
    expect(catalog.listBooksForAgent.mock.calls.filter(([owner]) => owner === A.id)).toHaveLength(2);
  });

  it('does not let an A marker completion overwrite a B manual import or selection', async () => {
    const markerGate = deferred<void>();
    history.saveHistoryState.mockImplementation(async (agentId: string, appId: string, patch: Partial<XingyeAppHistoryState>) => {
      if (agentId === A.id) await markerGate.promise;
      return saveState(agentId, appId, patch);
    });
    ai.generateReadingHistoryWithAI.mockResolvedValue(generated('A private history book'));
    shelves.set(B.id, [book(B.id, 'B safe bookshelf')]);
    const app = render(view(A));
    await waitFor(() => expect(history.saveHistoryState).toHaveBeenCalledWith(A.id, 'reading_notes', expect.any(Object)));
    app.rerender(view(B));
    await expectShelf('B safe bookshelf');
    fireEvent.click(screen.getByRole('button', { name: '新增书目' }));
    fireEvent.change(screen.getByLabelText('书名'), { target: { value: 'B newly imported book' } });
    fireEvent.click(screen.getByRole('button', { name: '保存书目' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'B newly imported book' })).toBeInTheDocument());
    await act(async () => { markerGate.resolve(); });
    await waitFor(() => expect(states.get(A.id)?.initializedAt).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'B newly imported book' })).toBeInTheDocument();
    expectNoAUi();
    expect(readBooks(B.id).map((row) => row.title)).toEqual(['B safe bookshelf', 'B newly imported book']);
    expect(readBooks(A.id).map((row) => row.title)).toEqual(['A private history book']);
  });

  it('keeps a B manual form and its edits intact when an A import completes', async () => {
    const importGate = deferred<void>();
    catalog.importBooksForAgent.mockImplementation(async (agentId: string, rows: BookSearchResult[], tags: AgentBookTagContext) => {
      if (agentId === A.id) await importGate.promise;
      return importBooks(agentId, rows, tags);
    });
    shelves.set(B.id, [book(B.id, 'B safe bookshelf')]);
    const app = render(view(A));
    await waitFor(() => expect(catalog.importBooksForAgent).toHaveBeenCalledTimes(1));
    app.rerender(view(B));
    await expectShelf('B safe bookshelf');
    fireEvent.click(screen.getByRole('button', { name: '新增书目' }));
    fireEvent.change(screen.getByLabelText('书名'), { target: { value: 'B unsaved title' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: 'B unsaved description' } });
    await act(async () => { importGate.resolve(); });
    await waitFor(() => expect(states.get(A.id)?.initializedAt).toBeTruthy());
    expect(screen.getByLabelText('书名')).toHaveValue('B unsaved title');
    expect(screen.getByLabelText('备注')).toHaveValue('B unsaved description');
    expectNoAUi();
  });

  it('rejects an already running A reload after changing owner', async () => {
    const reloadGate = deferred<XingyeBookCatalogEntry[]>();
    let aReadCount = 0;
    catalog.listBooksForAgent.mockImplementation(async (agentId: string) => {
      if (agentId === A.id && ++aReadCount === 3) return reloadGate.promise;
      return readBooks(agentId);
    });
    shelves.set(B.id, [book(B.id, 'B safe bookshelf')]);
    const app = render(view(A));
    await waitFor(() => expect(aReadCount).toBe(3));
    app.rerender(view(B));
    await expectShelf('B safe bookshelf');
    await act(async () => { reloadGate.resolve(readBooks(A.id)); });
    await expectShelf('B safe bookshelf');
    expectNoAUi();
  });

  it('distinguishes A first lifetime from a later A lifetime after A to B to A', async () => {
    const first = deferred<ReadingHistoryBookWithAnnotations[]>();
    const second = deferred<ReadingHistoryBookWithAnnotations[]>();
    ai.generateReadingHistoryWithAI.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    shelves.set(B.id, [book(B.id, 'B safe bookshelf')]);
    const app = render(view(A));
    await waitFor(() => expect(ai.generateReadingHistoryWithAI).toHaveBeenCalledTimes(1));
    app.rerender(view(B));
    await expectShelf('B safe bookshelf');
    app.rerender(view(A));
    await waitFor(() => expect(ai.generateReadingHistoryWithAI).toHaveBeenCalledTimes(2));
    await completeModel(first, 'A private old lifetime');
    expect(catalog.importBooksForAgent).not.toHaveBeenCalled();
    expect(screen.getByTestId('phone-reading-init-busy')).toBeInTheDocument();
    await completeModel(second, 'A current lifetime book');
    await expectShelf('A current lifetime book');
    expect(screen.queryByText(/A private old lifetime/)).not.toBeInTheDocument();
    expect(readBooks(A.id).map((row) => row.title)).toEqual(['A current lifetime book']);
  });

  it.each(['success', 'failure'] as const)('old A %s and finally cannot release B initialization busy', async (outcome) => {
    const oldModel = deferred<ReadingHistoryBookWithAnnotations[]>();
    const newModel = deferred<ReadingHistoryBookWithAnnotations[]>();
    ai.generateReadingHistoryWithAI.mockImplementation(({ agent }: { agent: Agent }) => (
      agent.id === A.id ? oldModel.promise : newModel.promise
    ));
    const app = render(view(A));
    await waitFor(() => expect(ai.generateReadingHistoryWithAI).toHaveBeenCalledTimes(1));
    app.rerender(view(B));
    await waitFor(() => expect(ai.generateReadingHistoryWithAI).toHaveBeenCalledTimes(2));
    await act(async () => {
      if (outcome === 'failure') oldModel.reject(new Error('A private failure'));
      else oldModel.resolve(generated('A private old history'));
    });
    expect(screen.getByTestId('phone-reading-init-busy')).toBeInTheDocument();
    expectNoAUi();
    expect(screen.queryByText(/A private failure/)).not.toBeInTheDocument();
    await completeModel(newModel, 'B fresh history');
    await expectShelf('B fresh history');
    expect(screen.queryByTestId('phone-reading-init-busy')).not.toBeInTheDocument();
    expect(readBooks(A.id)).toEqual([]);
  });

  it.each(['load history', 'fresh list'] as const)('does not start stale A generation after delayed preflight %s', async (phase) => {
    const gate = deferred<void>();
    let aReadCount = 0;
    if (phase === 'load history') {
      history.loadHistoryState.mockImplementation(async (agentId: string) => {
        if (agentId === A.id) await gate.promise;
        return states.get(agentId) ?? { version: 1 };
      });
    } else {
      catalog.listBooksForAgent.mockImplementation(async (agentId: string) => {
        if (agentId === A.id && ++aReadCount === 2) await gate.promise;
        return readBooks(agentId);
      });
    }
    shelves.set(B.id, [book(B.id, 'B safe bookshelf')]);
    const app = render(view(A));
    await waitFor(() => {
      if (phase === 'load history') expect(history.loadHistoryState).toHaveBeenCalledWith(A.id, 'reading_notes');
      else expect(aReadCount).toBe(2);
    });
    app.rerender(view(B));
    await expectShelf('B safe bookshelf');
    await act(async () => { gate.resolve(); });
    await flush();
    expect(ai.generateReadingHistoryWithAI).not.toHaveBeenCalled();
    expect(catalog.importBooksForAgent).not.toHaveBeenCalled();
    expectNoAUi();
    await expectShelf('B safe bookshelf');
  });

  it('does not expose A shelf while the new B initial reload is still pending', async () => {
    const bRead = deferred<XingyeBookCatalogEntry[]>();
    shelves.set(A.id, [book(A.id, 'A private bookshelf')]);
    shelves.set(B.id, [book(B.id, 'B safe bookshelf')]);
    catalog.listBooksForAgent.mockImplementation(async (agentId: string) => (
      agentId === B.id ? bRead.promise : readBooks(agentId)
    ));
    const app = render(view(A));
    await expectShelf('A private bookshelf');
    app.rerender(view(B));
    await flush();
    expect(screen.queryByRole('button', { name: /A private bookshelf/ })).not.toBeInTheDocument();
    await act(async () => { bRead.resolve(readBooks(B.id)); });
    await expectShelf('B safe bookshelf');
    expectNoAUi();
  });

  it('waits for B initial reload before checking B history or starting B generation', async () => {
    const bRead = deferred<XingyeBookCatalogEntry[]>();
    states.set(A.id, { version: 1, initializedAt: NOW });
    let bReadCount = 0;
    catalog.listBooksForAgent.mockImplementation(async (agentId: string) => {
      if (agentId === B.id && ++bReadCount === 1) return bRead.promise;
      return readBooks(agentId);
    });
    const app = render(view(A));
    await waitFor(() => expect(history.loadHistoryState).toHaveBeenCalledWith(A.id, 'reading_notes'));
    app.rerender(view(B));
    await flush();
    expect(history.loadHistoryState.mock.calls.some(([owner]) => owner === B.id)).toBe(false);
    expect(ai.generateReadingHistoryWithAI).not.toHaveBeenCalled();
    await act(async () => { bRead.resolve([]); });
    await waitFor(() => expect(ai.generateReadingHistoryWithAI).toHaveBeenCalledWith(expect.objectContaining({ agent: B })));
    await expectShelf('normal history');
    expect(states.get(B.id)?.initializedAt).toBeTruthy();
  });

  it.each(['load history', 'fresh list', 'model'] as const)('unmount invalidates delayed %s before starting further initialization work', async (phase) => {
    const preflightGate = deferred<void>();
    const modelGate = deferred<ReadingHistoryBookWithAnnotations[]>();
    let aReadCount = 0;
    if (phase === 'load history') {
      history.loadHistoryState.mockImplementation(async () => { await preflightGate.promise; return { version: 1 }; });
    } else if (phase === 'fresh list') {
      catalog.listBooksForAgent.mockImplementation(async (agentId: string) => {
        if (++aReadCount === 2) await preflightGate.promise;
        return readBooks(agentId);
      });
    } else ai.generateReadingHistoryWithAI.mockReturnValue(modelGate.promise);
    const app = render(view(A));
    await waitFor(() => {
      if (phase === 'load history') expect(history.loadHistoryState).toHaveBeenCalledTimes(1);
      else if (phase === 'fresh list') expect(aReadCount).toBe(2);
      else expect(ai.generateReadingHistoryWithAI).toHaveBeenCalledTimes(1);
    });
    app.unmount();
    await act(async () => {
      preflightGate.resolve();
      modelGate.resolve(generated('A private after unmount'));
    });
    await flush();
    if (phase !== 'model') expect(ai.generateReadingHistoryWithAI).not.toHaveBeenCalled();
    expect(catalog.importBooksForAgent).not.toHaveBeenCalled();
    expect(entries.appendAppEntry).not.toHaveBeenCalled();
    expect(history.saveHistoryState).not.toHaveBeenCalled();
    expect(readBooks(A.id)).toEqual([]);
  });

  it('continues normal first initialization with original owner, annotations and success marker', async () => {
    render(view(A));
    await expectShelf('normal history');
    expect(readBooks(A.id).map((row) => row.title)).toEqual(['normal history']);
    expect(notes.get(A.id)?.[0]).toMatchObject({ agentId: A.id, source: 'ai_reading_init', content: 'normal history private annotation' });
    expect(states.get(A.id)?.initializedAt).toBeTruthy();
    expect(readBooks(B.id)).toEqual([]);
    expect(history.saveHistoryState).toHaveBeenCalledTimes(1);
    expect(screen.getByText('已为 TA 铺好 1 本书、1 条批注')).toBeInTheDocument();
  });

  it.each(['existing shelf', 'success marker'] as const)('skips initialization for an %s', async (fixture) => {
    if (fixture === 'existing shelf') shelves.set(A.id, [book(A.id, 'existing safe shelf')]);
    else states.set(A.id, { version: 1, initializedAt: NOW });
    render(view(A));
    if (fixture === 'existing shelf') await expectShelf('existing safe shelf');
    else await waitFor(() => expect(history.loadHistoryState).toHaveBeenCalledWith(A.id, 'reading_notes'));
    await flush();
    expect(ai.generateReadingHistoryWithAI).not.toHaveBeenCalled();
    expect(catalog.importBooksForAgent).not.toHaveBeenCalled();
  });

  it('reports a current failure once, leaves no marker, and retries on a new mount', async () => {
    ai.generateReadingHistoryWithAI.mockRejectedValueOnce(new Error('current synthetic failure'))
      .mockResolvedValueOnce(generated('retry history'));
    const app = render(view(A));
    await waitFor(() => expect(screen.getByText(/初始化阅读笔记失败：current synthetic failure/)).toBeInTheDocument());
    await flush();
    expect(ai.generateReadingHistoryWithAI).toHaveBeenCalledTimes(1);
    expect(states.get(A.id)?.initializedAt).toBeUndefined();
    app.unmount();
    render(view(A));
    await expectShelf('retry history');
    expect(ai.generateReadingHistoryWithAI).toHaveBeenCalledTimes(2);
    expect(states.get(A.id)?.initializedAt).toBeTruthy();
  });
});
