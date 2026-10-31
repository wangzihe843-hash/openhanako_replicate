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
import { PhoneReadingNotesApp } from './PhoneReadingNotesApp';
import { importBooksForAgent, type XingyeBookCatalogEntry } from './xingye-reading-book-catalog';
import { generateSmsHistoryWithAI } from './xingye-phone-ai';
import {
  flushXingyePersistenceNow, getXingyePersistenceStorage,
  refreshXingyeAgentPersistence, resetXingyePersistenceForTests,
} from './xingye-persistence';
import { getSmsHistoryGenerationState, getSmsThread, type XingyePhoneContactView } from './xingye-phone-store';
import type { AppEntry } from './xingye-app-entry-store';
import { postXingyeStorage } from './xingye-storage-api';

// The tested SMS/annotation helpers, stores, connection subscription, event log,
// hanaFetch and Hono storage route are real. Only unrelated discovery adapters
// and the final model/network transport return synthetic data.
vi.mock('./xingye-reading-topics-ai', () => ({ inferReadingTopicsWithAI: async () => [] }));
vi.mock('./xingye-wikiquote-adapter', () => ({ fetchWikiquoteSuggestions: async () => [] }));
vi.mock('./xingye-open-library-adapter', () => ({ searchOpenLibraryBooksViaProxy: async () => [] }));
vi.mock('./xingye-reading-history-ai', () => ({ generateReadingHistoryWithAI: async () => ({ addedCount: 0 }) }));
vi.mock('./xingye-speaker-context', async original => ({
  ...await original<typeof import('./xingye-speaker-context')>(),
  resolveXingyeSpeakerUserName: async () => 'Synthetic user',
}));

const owner: Agent = { id: 'combined-owner', name: 'Combined reader', yuan: 'hanako', isPrimary: false };
const contact = {
  ownerAgentId: owner.id, targetType: 'agent', targetId: 'peer', displayName: 'Peer',
  originalName: 'Peer', remark: '', impression: '', tags: [], status: 'active',
} as XingyePhoneContactView;
const PASSAGE = 'The original passage chosen by the reader.';
const NEXT_PASSAGE = 'The next passage belongs to the new draft.';
const smsPath = 'phone/sms-threads.json';
type Call = { server: string; route: string; body: Record<string, unknown>; auth: string | null; marker?: string };
let root: string;
let calls: Call[];
let books: Record<string, XingyeBookCatalogEntry[]>;
let beforeModel: ((call: Call) => Promise<void>) | undefined;
let afterWrite: ((call: Call) => Promise<void>) | undefined;

function connection(server: string): ServerConnection {
  return {
    connectionId: server, serverId: server, studioId: 'synthetic', label: server,
    baseUrl: `https://${server}.invalid`, wsUrl: `wss://${server}.invalid`,
    token: `synthetic-${server}`, kind: 'custom_remote', authState: 'paired',
    trustState: 'tunnel', credentialKind: 'device_credential', capabilities: ['chat'],
  };
}
function select(server: string) { useStore.getState().setActiveServerConnection(connection(server)); }
async function switchTo(server: string) {
  await act(async () => { select(server); await refreshXingyeAgentPersistence(owner.id); });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function sms() {
  return generateSmsHistoryWithAI({ ownerAgent: owner, ownerProfile: null, contacts: [contact], profileFingerprint: 'combined' });
}
function modelCalls(kind: string, server?: string) {
  return calls.filter(c => c.route === '/api/xingye/phone-generate' && c.body.kind === kind && (!server || c.server === server));
}
function disk(server: string, relative: string): string {
  const file = path.join(root, server, owner.id, 'xingye', relative);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
function notes(server: string): AppEntry[] {
  return disk(server, 'apps/reading_notes/entries.jsonl').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function readingEvents(server: string): unknown[] {
  return (JSON.parse(disk(server, 'events/log.json') || '{"events":[]}').events as { type: string }[])
    .filter(e => e.type === 'reading_notes.entry_appended');
}
function view() { return render(<PhoneReadingNotesApp ownerAgent={owner} displayName={owner.name} onBack={() => {}} />); }
async function enter(book = 'First book', passage = PASSAGE) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(book) }));
  fireEvent.click(screen.getByRole('button', { name: '让 TA 批注' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: passage } });
}
function annotate() { fireEvent.click(screen.getByRole('button', { name: '让 TA 批注' })); }
async function preview(marker: string) { annotate(); await screen.findByDisplayValue(marker); }
async function save() {
  fireEvent.click(screen.getByRole('button', { name: '保存批注' }));
  await screen.findByRole('button', { name: '返回列表' });
}

beforeEach(async () => {
  resetXingyePersistenceForTests();
  calls = []; books = {}; beforeModel = undefined; afterWrite = undefined;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-reading-combination-'));
  const apps = new Map(['one', 'two'].map(server => [server, new Hono().route('/api', createXingyeStorageRoute({
    agentsDir: path.join(root, server), getAgent: (id: string) => id === owner.id ? owner : null,
  }))]));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    const server = url.hostname.split('.')[0];
    const app = apps.get(server);
    if (!app) throw new Error(`Unexpected synthetic transport ${url}`);
    const call: Call = {
      server, route: url.pathname, body: JSON.parse(String(options?.body)),
      auth: new Headers(options?.headers).get('Authorization'),
    };
    calls.push(call);
    if (url.pathname === '/api/xingye/phone-generate') {
      const kind = String(call.body.kind);
      call.marker = `${kind}-${server}-${modelCalls(kind, server).length}`;
      if (beforeModel) await beforeModel(call);
      if (kind === 'reading_annotation') return Response.json({ ok: true, result: { title: 'Synthetic note', annotation: call.marker } });
      if (kind === 'sms_history') return Response.json({ ok: true, result: {
        contacts: (call.body.contacts as { targetType: string; targetId: string }[]).map(target => ({
          ...target, messages: [{ from: 'owner', content: call.marker }],
        })),
      } });
      throw new Error(`Unexpected model kind ${kind}`);
    }
    if (url.pathname !== '/api/xingye/storage') throw new Error(`Unexpected route ${url}`);
    const response = await app.request(url.pathname, options);
    if (afterWrite && ['writeJson', 'appendJsonl', 'appendEventLog'].includes(String(call.body.action))) await afterWrite(call);
    return response;
  });
  useStore.setState({ agents: [owner], currentAgentId: owner.id });
  for (const server of ['one', 'two']) {
    select(server);
    books[server] = await importBooksForAgent(owner.id, [
      { key: 'first', title: 'First book', authors: ['Synthetic'] },
      { key: 'second', title: 'Second book', authors: ['Synthetic'] },
    ], { reason: 'synthetic fixture', interests: [] });
  }
  select('one'); await refreshXingyeAgentPersistence(owner.id); calls = [];
});

afterEach(() => {
  cleanup(); resetXingyePersistenceForTests(); vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it('fences both pending models across X -> Y -> X while each fresh generation keeps its own content', async () => {
  const release = deferred(), enteredSms = deferred(), enteredReading = deferred();
  beforeModel = async call => {
    if (call.server !== 'one' || !call.marker?.endsWith('-1')) return;
    (call.body.kind === 'sms_history' ? enteredSms : enteredReading).resolve();
    await release.promise;
  };
  const oldSms = sms().catch((error: unknown) => error);
  view(); await enter(); annotate();
  await act(async () => { await Promise.all([enteredSms.promise, enteredReading.promise]); });
  await switchTo('two'); await enter('Second book', NEXT_PASSAGE);
  await preview('reading_annotation-two-1'); await act(async () => { await sms(); }); await save();
  await switchTo('one'); await enter('Second book', NEXT_PASSAGE);
  await preview('reading_annotation-one-2'); await act(async () => { await sms(); });
  await act(async () => { release.resolve(); expect(await oldSms).toMatchObject({ name: 'XingyePersistenceBindingError' }); });
  expect(screen.getByLabelText('TA 的批注（中文，可改）')).toHaveValue('reading_annotation-one-2');
  await save();
  expect(notes('one')).toMatchObject([{ content: 'reading_annotation-one-2', metadata: { bookId: books.one[1].id, quote: { text: NEXT_PASSAGE } } }]);
  expect(notes('two')).toMatchObject([{ content: 'reading_annotation-two-1', metadata: { bookId: books.two[1].id } }]);
  expect(getSmsThread(owner.id, 'agent', 'peer')?.messages.map(m => m.content)).toEqual(['sms_history-one-2']);
  expect(disk('two', smsPath)).toContain('sms_history-two-1');
  expect(disk('one', smsPath)).not.toContain('sms_history-one-1');
  expect(getSmsHistoryGenerationState(owner.id)?.contactsIncluded).toHaveLength(1);
  for (const call of calls) {
    expect(call.auth).toBe(`Bearer synthetic-${call.server}`);
    expect(JSON.stringify(call.body)).not.toContain('synthetic-one');
    expect(JSON.stringify(call.body)).not.toContain('synthetic-two');
    expect(call.body).not.toHaveProperty('connection');
  }
});

it.each(['success', 'lost ACK'])('retains admitted X SMS and reading writes after %s without clearing the Y draft', async outcome => {
  const release = deferred(), enteredSms = deferred(), enteredReading = deferred();
  let smsArmed = true, readingArmed = true;
  afterWrite = async call => {
    if (call.server !== 'one') return;
    if (smsArmed && call.body.action === 'writeJson' && call.body.relativePath === smsPath) {
      smsArmed = false; enteredSms.resolve(); await release.promise;
      if (outcome === 'lost ACK') throw new Error('synthetic old X ACK unknown');
    }
    if (readingArmed && call.body.action === 'appendJsonl' && call.body.relativePath === 'apps/reading_notes/entries.jsonl') {
      readingArmed = false; enteredReading.resolve(); await release.promise;
    }
  };
  const oldSms = sms().catch((error: unknown) => error);
  view(); await enter(); await preview('reading_annotation-one-1');
  fireEvent.click(screen.getByRole('button', { name: '保存批注' }));
  await act(async () => { await Promise.all([enteredSms.promise, enteredReading.promise]); });
  act(() => { select('two'); });
  const switching = refreshXingyeAgentPersistence(owner.id);
  await enter('Second book', NEXT_PASSAGE); await preview('reading_annotation-two-1');
  fireEvent.change(screen.getByLabelText('TA 的批注（中文，可改）'), { target: { value: 'Y edit survives both old completions' } });
  await act(async () => {
    release.resolve();
    const result = await oldSms;
    expect(result).toMatchObject(outcome === 'lost ACK' ? { message: 'synthetic old X ACK unknown' } : { name: 'XingyePersistenceBindingError' });
    await switching;
  });
  await waitFor(() => expect(readingEvents('one')).toHaveLength(1));
  expect(screen.getByLabelText('TA 的批注（中文，可改）')).toHaveValue('Y edit survives both old completions');
  expect(notes('one')).toMatchObject([{ content: 'reading_annotation-one-1', metadata: { bookId: books.one[0].id } }]);
  expect(notes('two')).toEqual([]); expect(readingEvents('two')).toEqual([]);
  if (getXingyePersistenceStorage() === null) await act(async () => { await flushXingyePersistenceNow(); });
  expect(getXingyePersistenceStorage()).not.toBeNull();
  await act(async () => { await sms(); }); await save();
  expect(notes('two')).toMatchObject([{ content: 'Y edit survives both old completions', metadata: { bookId: books.two[1].id } }]);
  expect(disk('two', smsPath)).toContain('sms_history-two-1');
  expect(disk('two', smsPath)).not.toContain('sms_history-one-1');
  await switchTo('one'); const count = modelCalls('sms_history').length;
  await act(async () => { await sms(); });
  expect(modelCalls('sms_history')).toHaveLength(count);
  expect(getSmsThread(owner.id, 'agent', 'peer')?.messages.map(m => m.content)).toEqual(['sms_history-one-1']);
  expect(getSmsHistoryGenerationState(owner.id)?.contactsIncluded).toHaveLength(1);
  expect(readingEvents('one')).toHaveLength(1); expect(readingEvents('two')).toHaveLength(1);
});

it.each(['book', 'passage round trip'])('changes the reading %s without cancelling valid SMS in the same connection generation', async change => {
  const release = deferred(), enteredSms = deferred(), enteredReading = deferred();
  beforeModel = async call => {
    if (!call.marker?.endsWith('-1')) return;
    (call.body.kind === 'sms_history' ? enteredSms : enteredReading).resolve();
    await release.promise;
  };
  const pendingSms = sms(); view(); await enter(); annotate();
  await act(async () => { await Promise.all([enteredSms.promise, enteredReading.promise]); });
  if (change === 'book') {
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '返回列表' })); await enter('Second book', NEXT_PASSAGE);
  } else {
    fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: NEXT_PASSAGE } });
    fireEvent.change(screen.getByLabelText('原文（用户提供）'), { target: { value: PASSAGE } });
  }
  await preview('reading_annotation-one-2');
  await act(async () => { release.resolve(); await pendingSms; });
  expect(screen.getByLabelText('TA 的批注（中文，可改）')).toHaveValue('reading_annotation-one-2');
  await save();
  expect(notes('one')).toMatchObject([{ content: 'reading_annotation-one-2', metadata: {
    bookId: books.one[change === 'book' ? 1 : 0].id, quote: { text: change === 'book' ? NEXT_PASSAGE : PASSAGE },
  } }]);
  expect(getSmsThread(owner.id, 'agent', 'peer')?.messages.map(m => m.content)).toEqual(['sms_history-one-1']);
  expect(getSmsHistoryGenerationState(owner.id)?.contactsIncluded).toHaveLength(1);
  expect(modelCalls('sms_history')).toHaveLength(1); expect(notes('two')).toEqual([]);
});

it('preserves ambient API calls and explicit captured calls without serializing transport options', async () => {
  await switchTo('two');
  const body = { action: 'writeJson', agentId: owner.id, relativePath: 'phone/contacts.json', data: { synthetic: true } };
  await postXingyeStorage(body);
  await postXingyeStorage(body, connection('one'));
  const writes = calls.filter(c => c.body.action === 'writeJson');
  expect(writes.map(c => [c.server, c.auth])).toEqual([['two', 'Bearer synthetic-two'], ['one', 'Bearer synthetic-one']]);
  expect(writes.map(c => c.body)).toEqual([body, body]);
  expect(disk('one', 'phone/contacts.json')).toEqual(disk('two', 'phone/contacts.json'));
});
