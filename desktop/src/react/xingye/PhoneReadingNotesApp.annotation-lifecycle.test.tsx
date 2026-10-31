/** @vitest-environment jsdom */
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error The production storage route is JavaScript without a declaration file.
import { createXingyeStorageRoute } from '../../../../server/routes/xingye-storage.js';
import { useStore } from '../stores';
import type { Agent } from '../types';
import type { ServerConnection } from '../services/server-connection';
import { importBooksForAgent, type XingyeBookCatalogEntry } from './xingye-reading-book-catalog';
import type { AppEntry } from './xingye-app-entry-store';
import type { XingyeReadingAnnotation } from './xingye-reading-annotation-ai';
import type { XingyeReadingTopicSuggestion } from './xingye-reading-topics-ai';
import type { WikiquoteSuggestion } from './xingye-wikiquote-adapter';

const mock = vi.hoisted(() => ({ annotation: vi.fn(), topics: vi.fn(), suggestions: vi.fn(), search: vi.fn(), history: vi.fn(), model: vi.fn() }));
vi.mock('./xingye-reading-annotation-ai', () => ({ inferReadingAnnotationWithAI: mock.annotation }));
vi.mock('./xingye-reading-topics-ai', () => ({ inferReadingTopicsWithAI: mock.topics }));
vi.mock('./xingye-wikiquote-adapter', () => ({ fetchWikiquoteSuggestions: mock.suggestions }));
vi.mock('./xingye-open-library-adapter', () => ({ searchOpenLibraryBooksViaProxy: mock.search }));
vi.mock('./xingye-reading-history-ai', () => ({ generateReadingHistoryWithAI: mock.history }));
// Keep Shell → AgentPhonePanel → reading navigation real; unrelated panels and
// the phone-home tile are inert so this test only drives the reading surface.
vi.mock('./ChatEntryPanel', () => ({ ChatEntryPanel: () => null }));
vi.mock('./GroupChatPanel', () => ({ GroupChatPanel: () => null }));
vi.mock('./MomentsPanel', () => ({ MomentsPanel: () => null }));
vi.mock('./SecretSpacePanel', () => ({ SecretSpacePanel: () => null }));
vi.mock('./GiftPanel', () => ({ GiftPanel: () => null }));
vi.mock('./RoleDetailPanel', () => ({ RoleDetailPanel: () => null }));
vi.mock('./RoleListPanel', () => ({ RoleListPanel: () => null }));
vi.mock('./PhoneHome', () => ({ PhoneHome: ({ onOpenReadingNotes }: { onOpenReadingNotes: () => void }) => <button onClick={onOpenReadingNotes}>Open reading tile</button> }));
vi.mock('./xingye-profile-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('./xingye-profile-store')>(),
  useXingyeRoleProfile: () => null,
  useXingyeRoleProfiles: () => ({}),
}));
vi.mock('./xingye-persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('./xingye-persistence')>(),
  refreshXingyeAgentPersistence: async () => {},
}));
import { PhoneReadingNotesApp } from './PhoneReadingNotesApp';
import { XingyeShell } from './XingyeShell';

const A: Agent = { id: 'reader-a', name: 'Reader A', yuan: 'hanako', isPrimary: false, hasAvatar: false };
const B: Agent = { ...A, id: 'reader-b', name: 'Reader B' };
const PASSAGE = 'Original passage for the first request.';
const NEXT_PASSAGE = 'Different passage selected after the first request.';
const oldDraft = { title: 'Old A title', annotation: 'Old A private annotation' };
const newDraft = { title: 'Current title', annotation: 'Current annotation to keep' };
let root: string;
let books: Record<string, XingyeBookCatalogEntry[]>;
let afterAppend: (() => Promise<void>) | undefined;
let afterList: (() => Promise<void>) | undefined;
let requests: { server: string; action: string; agentId: string; data?: AppEntry; event?: { type: string } }[];

function connection(server: string): ServerConnection {
  return { connectionId: server, serverId: server, studioId: server, label: server, baseUrl: `https://${server}.test`, wsUrl: `wss://${server}.test`, token: 'synthetic-only', kind: 'custom_remote', authState: 'paired', trustState: 'tunnel', credentialKind: 'device_credential', capabilities: [] };
}
function switchServer(server: string) { useStore.getState().setActiveServerConnection(connection(server)); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
function view(agent: Agent | null = A) {
  return <PhoneReadingNotesApp ownerAgent={agent} displayName={agent?.name ?? 'Reader'} onBack={() => {}} />;
}
async function finish<T>(gate: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => { gate.resolve(value); });
}
async function enterAnnotation(title = 'A first book') {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
  fireEvent.click(screen.getByRole('button', { name: '让 TA 批注' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: PASSAGE } });
}
function generate() { fireEvent.click(screen.getByRole('button', { name: '让 TA 批注' })); }
async function previewCurrent() {
  mock.annotation.mockResolvedValueOnce(newDraft);
  generate();
  await screen.findByDisplayValue(newDraft.annotation);
}
function notes(server: string, agent: Agent): AppEntry[] {
  const file = path.join(root, server, agent.id, 'xingye/apps/reading_notes/entries.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)) : [];
}
function events(server: string, agent: Agent): { type: string }[] {
  const file = path.join(root, server, agent.id, 'xingye/events/log.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).events : [];
}
function leaveForm() { fireEvent.click(screen.getByRole('button', { name: '取消' })); }
function leaveBook() { fireEvent.click(screen.getByRole('button', { name: '返回列表' })); }
async function saved() {
  fireEvent.click(screen.getByRole('button', { name: '保存批注' }));
  await screen.findByRole('button', { name: '返回列表' });
}

beforeEach(async () => {
  vi.resetAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd01-annotation-'));
  requests = []; afterAppend = undefined; afterList = undefined; books = {};
  const apps = new Map(['one', 'two'].map((server) => [server, new Hono().route('/api', createXingyeStorageRoute({ agentsDir: path.join(root, server), getAgent: (id: string) => [A, B].find((a) => a.id === id) ?? null }))]));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    const server = url.hostname.split('.')[0];
    const app = apps.get(server);
    if (app && url.pathname === '/api/xingye/phone-generate') {
      mock.model(server, JSON.parse(String(options?.body)));
      return Response.json({ ok: true, result: newDraft });
    }
    if (!app || url.pathname !== '/api/xingye/storage') throw new Error(`Unexpected transport: ${url}`);
    const body = JSON.parse(String(options?.body));
    requests.push({ server, ...body });
    const response = await app.request(url.pathname, options);
    if (body.action === 'listJsonl' && body.relativePath === 'apps/reading_notes/entries.jsonl' && afterList) await afterList();
    if (body.action === 'appendJsonl' && body.relativePath === 'apps/reading_notes/entries.jsonl' && afterAppend) await afterAppend();
    return response;
  });
  mock.suggestions.mockResolvedValue([]);
  mock.topics.mockResolvedValue([{ label: 'Current topic', subject: 'current' }]);
  mock.search.mockResolvedValue([]);
  for (const server of ['one', 'two']) {
    switchServer(server);
    for (const agent of [A, B]) {
      books[`${server}:${agent.id}`] = await importBooksForAgent(agent.id, [
        { key: `${agent.id}-first`, title: `${agent === A ? 'A' : 'B'} first book`, authors: ['Synthetic'] },
        { key: `${agent.id}-second`, title: `${agent === A ? 'A' : 'B'} second book`, authors: ['Synthetic'] },
      ], { reason: 'synthetic test', interests: [] });
    }
  }
  switchServer('one'); requests = [];
  useStore.setState({ agents: [A, B], currentAgentId: A.id });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it.each(['B', 'A again'])('keeps the new preview when A resolves after switching to %s', async (target) => {
  const pending = deferred<XingyeReadingAnnotation>();
  mock.annotation.mockReturnValueOnce(pending.promise);
  const app = render(view()); await enterAnnotation(); generate();
  app.rerender(view(B));
  if (target === 'A again') { await screen.findByText('B first book'); app.rerender(view(A)); }
  await enterAnnotation(target === 'B' ? 'B first book' : 'A first book');
  await previewCurrent(); await finish(pending, oldDraft);
  expect(screen.getByLabelText('TA 的批注（中文，可改）')).toHaveValue(newDraft.annotation);
  expect(notes('one', A)).toEqual([]); expect(notes('one', B)).toEqual([]);
});

it('saves only B text and B book after the late A response and an explicit save click', async () => {
  const pending = deferred<XingyeReadingAnnotation>();
  mock.annotation.mockReturnValueOnce(pending.promise);
  const app = render(view()); await enterAnnotation(); generate();
  app.rerender(view(B)); await enterAnnotation('B first book'); await previewCurrent();
  await finish(pending, oldDraft);
  expect(notes('one', A)).toEqual([]); expect(notes('one', B)).toEqual([]);
  await saved();
  expect(notes('one', B)).toMatchObject([{ agentId: B.id, content: newDraft.annotation, metadata: { bookId: books[`one:${B.id}`][0].id, quote: { text: PASSAGE } } }]);
  expect(notes('one', A)).toEqual([]);
});

it.each(['book', 'reopened form'])('drops old annotation after choosing a new %s', async (selection) => {
  const pending = deferred<XingyeReadingAnnotation>(); mock.annotation.mockReturnValueOnce(pending.promise);
  render(view()); await enterAnnotation(); generate(); leaveForm(); leaveBook();
  await enterAnnotation(selection === 'book' ? 'A second book' : 'A first book');
  await previewCurrent(); await finish(pending, oldDraft); await saved();
  expect(notes('one', A)).toMatchObject([{ content: newDraft.annotation, metadata: { bookId: books[`one:${A.id}`][selection === 'book' ? 1 : 0].id } }]);
});

it.each(['changed', 'changed back'])('invalidates the pending annotation when passage is %s', async (change) => {
  const pending = deferred<XingyeReadingAnnotation>(); mock.annotation.mockReturnValueOnce(pending.promise);
  render(view()); await enterAnnotation(); generate();
  fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: NEXT_PASSAGE } });
  if (change === 'changed back') fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: PASSAGE } });
  await finish(pending, oldDraft);
  expect(screen.queryByTestId('phone-reading-annotation-preview')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '让 TA 批注' })).toBeEnabled();
});

it('allows a new passage request immediately and ignores an older rejection', async () => {
  const pending = deferred<XingyeReadingAnnotation>(); mock.annotation.mockReturnValueOnce(pending.promise);
  render(view()); await enterAnnotation(); generate();
  fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: NEXT_PASSAGE } });
  await previewCurrent();
  await act(async () => { pending.reject(new Error('Old A failure')); });
  expect(screen.getByLabelText('TA 的批注（中文，可改）')).toHaveValue(newDraft.annotation);
  expect(screen.queryByText(/Old A failure/)).not.toBeInTheDocument();
});

it.each(['switch', 'round trip'])('invalidates the same-owner preview on connection %s', async (change) => {
  const pending = deferred<XingyeReadingAnnotation>(); mock.annotation.mockReturnValueOnce(pending.promise);
  render(view()); await enterAnnotation(); generate();
  act(() => { switchServer('two'); if (change === 'round trip') switchServer('one'); });
  await finish(pending, oldDraft);
  expect(screen.queryByDisplayValue(oldDraft.annotation)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '保存批注' })).not.toBeInTheDocument();
  expect(notes('one', A)).toEqual([]); expect(notes('two', A)).toEqual([]);
});

it('does not reuse a completed preview after a connection changes', async () => {
  render(view()); await enterAnnotation(); await previewCurrent();
  act(() => { switchServer('two'); });
  expect(screen.queryByRole('button', { name: '保存批注' })).not.toBeInTheDocument();
  expect(notes('two', A)).toEqual([]);
});

it('ignores a response after unmount and preserves a remounted draft', async () => {
  const pending = deferred<XingyeReadingAnnotation>(); mock.annotation.mockReturnValueOnce(pending.promise);
  const app = render(view()); await enterAnnotation(); generate(); app.unmount();
  render(view()); await enterAnnotation(); await previewCurrent(); await finish(pending, oldDraft);
  expect(screen.getByLabelText('TA 的批注（中文，可改）')).toHaveValue(newDraft.annotation);
  expect(notes('one', A)).toEqual([]);
});

it('lets an admitted save and its event finish on the original server without clearing a new form', async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  afterAppend = async () => { afterAppend = undefined; entered.resolve(); await release.promise; };
  render(view()); await enterAnnotation(); await previewCurrent();
  fireEvent.click(screen.getByRole('button', { name: '保存批注' }));
  await act(async () => { await entered.promise; });
  act(() => { switchServer('two'); });
  // Selecting again works even if the old UI erroneously stayed mounted in annotation mode.
  if (screen.queryByRole('button', { name: '取消' })) leaveForm();
  if (screen.queryByRole('button', { name: '返回列表' })) leaveBook();
  await enterAnnotation('A second book');
  fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: NEXT_PASSAGE } });
  await previewCurrent(); await finish(release, undefined);
  await waitFor(() => expect(events('one', A).length + events('two', A).length).toBe(1));
  expect(screen.getByLabelText('原文（用户提供）')).toHaveValue(NEXT_PASSAGE);
  expect(screen.getByLabelText('TA 的批注（中文，可改）')).toHaveValue(newDraft.annotation);
  expect(notes('one', A)).toMatchObject([{ content: newDraft.annotation, metadata: { bookId: books[`one:${A.id}`][0].id } }]);
  expect(notes('two', A)).toEqual([]);
  expect(events('one', A).filter((e) => e.type === 'reading_notes.entry_appended')).toHaveLength(1);
  expect(events('two', A).filter((e) => e.type === 'reading_notes.entry_appended')).toHaveLength(0);
});

it('does not close a newer passage form when an earlier save completes', async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  afterAppend = async () => { afterAppend = undefined; entered.resolve(); await release.promise; };
  render(view()); await enterAnnotation(); await previewCurrent();
  fireEvent.click(screen.getByRole('button', { name: '保存批注' })); await act(async () => { await entered.promise; });
  fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: NEXT_PASSAGE } });
  await previewCurrent(); await finish(release, undefined);
  await waitFor(() => expect(events('one', A).length + events('two', A).length).toBe(1));
  expect(screen.getByLabelText('原文（用户提供）')).toHaveValue(NEXT_PASSAGE);
  expect(screen.getByRole('button', { name: '保存批注' })).toBeEnabled();
  expect(notes('one', A)).toHaveLength(1);
});

it('keeps edits made to the same preview while its earlier snapshot is saving', async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  afterAppend = async () => { afterAppend = undefined; entered.resolve(); await release.promise; };
  render(view()); await enterAnnotation(); await previewCurrent();
  fireEvent.click(screen.getByRole('button', { name: '保存批注' })); await act(async () => { await entered.promise; });
  fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: 'Edited after save began' } });
  fireEvent.change(screen.getByLabelText('TA 的批注（中文，可改）'), { target: { value: 'Unsubmitted later edit' } });
  await finish(release, undefined);
  await waitFor(() => expect(events('one', A)).toHaveLength(1));
  expect(screen.getByLabelText('笔记标题')).toHaveValue('Edited after save began');
  expect(screen.getByLabelText('TA 的批注（中文，可改）')).toHaveValue('Unsubmitted later edit');
  expect(screen.getByRole('button', { name: '保存批注' })).toBeEnabled();
  expect(notes('one', A)).toMatchObject([{ title: newDraft.title, content: newDraft.annotation }]);
});

it.each(['success', 'failure'])('drops stale topic %s after cancel and reopening discovery', async (outcome) => {
  const pending = deferred<XingyeReadingTopicSuggestion[]>(); mock.topics.mockReturnValueOnce(pending.promise);
  render(view()); fireEvent.click(await screen.findByRole('button', { name: '帮 TA 找书' }));
  leaveForm(); fireEvent.click(screen.getByRole('button', { name: '帮 TA 找书' }));
  await screen.findByRole('button', { name: 'Current topic' });
  await act(async () => { if (outcome === 'success') pending.resolve([{ label: 'Stale topic', subject: 'stale' }]); else pending.reject(new Error('Stale topic failure')); });
  expect(screen.getByRole('button', { name: 'Current topic' })).toBeInTheDocument();
  expect(screen.queryByText(/Stale topic/)).not.toBeInTheDocument();
});

it('keeps the latest discovery search when results complete out of order', async () => {
  const pending = deferred<{ key: string; title: string; authors: string[] }[]>(); mock.search.mockReturnValueOnce(pending.promise);
  mock.topics.mockResolvedValue([{ label: 'Old category', subject: 'old' }, { label: 'Current category', subject: 'new' }]);
  render(view()); fireEvent.click(await screen.findByRole('button', { name: '帮 TA 找书' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Old category' }));
  mock.search.mockResolvedValueOnce([{ key: 'new', title: 'Current search book', authors: [] }]);
  fireEvent.click(screen.getByRole('button', { name: 'Current category' }));
  await screen.findByText('Current search book');
  await finish(pending, [{ key: 'old', title: 'Stale search book', authors: [] }]);
  expect(screen.getByText('Current search book')).toBeInTheDocument();
  expect(screen.queryByText('Stale search book')).not.toBeInTheDocument();
});

it('does not place old-book quote suggestions into the next book form', async () => {
  const pending = deferred<WikiquoteSuggestion[]>(); mock.suggestions.mockReturnValueOnce(pending.promise);
  render(view()); await enterAnnotation(); leaveForm(); leaveBook(); await enterAnnotation('A second book');
  await finish(pending, [{ text: 'Old book quotation', sourceCitation: { provider: 'wikiquote', lang: 'en', pageTitle: 'Old book', pageUrl: 'https://example.test/old' } }]);
  expect(screen.queryByText('Old book quotation')).not.toBeInTheDocument();
  expect(screen.getByLabelText('原文（用户提供）')).toHaveValue(PASSAGE);
});

it.each(['owner', 'connection', 'passage'])('does not start the model after the anchor read if the %s changed', async (change) => {
  const actual = await vi.importActual<typeof import('./xingye-reading-annotation-ai')>('./xingye-reading-annotation-ai');
  mock.annotation.mockImplementation(actual.inferReadingAnnotationWithAI);
  const entered = deferred<void>(); const release = deferred<void>();
  const app = render(view()); await enterAnnotation();
  afterList = async () => { afterList = undefined; entered.resolve(); await release.promise; };
  generate(); await act(async () => { await entered.promise; });
  if (change === 'owner') app.rerender(view(B));
  if (change === 'connection') act(() => { switchServer('two'); switchServer('one'); });
  if (change === 'passage') fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: NEXT_PASSAGE } });
  await finish(release, undefined);
  expect(mock.model).not.toHaveBeenCalled();
  expect(notes('one', A)).toEqual([]); expect(notes('two', A)).toEqual([]);
});

it('lets a current request use the real AI helper and save the generated result', async () => {
  const actual = await vi.importActual<typeof import('./xingye-reading-annotation-ai')>('./xingye-reading-annotation-ai');
  mock.annotation.mockImplementation(actual.inferReadingAnnotationWithAI);
  render(view()); await enterAnnotation(); generate();
  await screen.findByDisplayValue(newDraft.annotation); await saved();
  expect(mock.model).toHaveBeenCalledWith('one', expect.objectContaining({ ownerAgentId: A.id, kind: 'reading_annotation', prompt: expect.stringContaining(PASSAGE) }));
  expect(notes('one', A)).toMatchObject([{ content: newDraft.annotation, metadata: { quote: { text: PASSAGE } } }]);
});

it('invalidates generated text when choosing a different quotation suggestion', async () => {
  const suggestion: WikiquoteSuggestion = { text: NEXT_PASSAGE, sourceCitation: { provider: 'wikiquote', lang: 'en', pageTitle: 'Synthetic source', pageUrl: 'https://example.test/quote' } };
  mock.suggestions.mockResolvedValue([suggestion]);
  const pending = deferred<XingyeReadingAnnotation>(); mock.annotation.mockReturnValueOnce(pending.promise);
  render(view()); await enterAnnotation(); generate();
  fireEvent.click(screen.getByRole('button', { name: /Different passage selected/ }));
  await previewCurrent(); await finish(pending, oldDraft); await saved();
  expect(notes('one', A)).toMatchObject([{ content: newDraft.annotation, metadata: { quote: { text: NEXT_PASSAGE, sourceCitation: suggestion.sourceCitation } } }]);
});

it.each(['success', 'failure'])('keeps B draft intact when an admitted A save returns %s', async (outcome) => {
  const entered = deferred<void>(); const release = deferred<void>();
  afterAppend = async () => { afterAppend = undefined; entered.resolve(); await release.promise; };
  const app = render(view()); await enterAnnotation(); await previewCurrent();
  fireEvent.click(screen.getByRole('button', { name: '保存批注' })); await act(async () => { await entered.promise; });
  app.rerender(view(B)); await enterAnnotation('B first book'); await previewCurrent();
  await act(async () => { if (outcome === 'success') release.resolve(); else release.reject(new Error('Old save acknowledgement failed')); });
  if (outcome === 'success') await waitFor(() => expect(events('one', A)).toHaveLength(1));
  expect(screen.getByLabelText('TA 的批注（中文，可改）')).toHaveValue(newDraft.annotation);
  expect(screen.queryByText(/Old save acknowledgement failed/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存批注' })).toBeEnabled();
  // The failed acknowledgement was after the actual write: never undo committed data.
  expect(notes('one', A)).toHaveLength(1); expect(notes('one', B)).toEqual([]);
});

it.each(['owner', 'connection'])('drops stale topic inference on %s switch', async (change) => {
  const pending = deferred<XingyeReadingTopicSuggestion[]>(); mock.topics.mockReturnValueOnce(pending.promise);
  const app = render(view()); fireEvent.click(await screen.findByRole('button', { name: '帮 TA 找书' }));
  if (change === 'owner') app.rerender(view(B)); else act(() => { switchServer('two'); });
  if (screen.queryByRole('button', { name: '取消' })) leaveForm();
  fireEvent.click(await screen.findByRole('button', { name: '帮 TA 找书' }));
  await screen.findByRole('button', { name: 'Current topic' });
  await finish(pending, [{ label: 'Stale topic', subject: 'stale' }]);
  expect(screen.getByRole('button', { name: 'Current topic' })).toBeInTheDocument();
  expect(screen.queryByText('Stale topic')).not.toBeInTheDocument();
});

it('reaches the owner-change race through the real shell fallback without unmounting the reading page', async () => {
  const pending = deferred<XingyeReadingAnnotation>(); mock.annotation.mockReturnValueOnce(pending.promise);
  render(<XingyeShell onExit={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '小手机' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open reading tile' }));
  await enterAnnotation(); generate();
  const readingPage = screen.getByLabelText('阅读笔记');
  act(() => { useStore.setState({ agents: [B], currentAgentId: B.id }); });
  await enterAnnotation('B first book'); await previewCurrent();
  expect(screen.getByLabelText('阅读笔记')).toBe(readingPage);
  await finish(pending, oldDraft); await saved();
  expect(notes('one', A)).toEqual([]);
  expect(notes('one', B)).toMatchObject([{ content: newDraft.annotation, metadata: { bookId: books[`one:${B.id}`][0].id } }]);
});
