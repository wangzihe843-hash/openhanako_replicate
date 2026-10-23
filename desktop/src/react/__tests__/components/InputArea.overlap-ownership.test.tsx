// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { HOME_DRAFT_KEY } from '../../../../../shared/input-drafts';
import { sessionScopedValue } from '../../stores/session-slice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  attempts: [] as Array<Promise<PromiseSettledResult<void>>>,
  realEditor: null as import('@tiptap/core').Editor | null,
  useRealSession: false,
  socketAvailable: true,
  onSend: null as null | (() => Promise<void>),
  activateWorkspaceDesk: vi.fn(async () => {}),
  ensureSession: vi.fn(),
  hanaFetch: vi.fn(),
  upsertOptimisticSessionFirstMessage: vi.fn(),
  wsSend: vi.fn(),
}));

vi.mock('@tiptap/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@tiptap/react')>();
  return { ...actual, useEditor: (...args: Parameters<typeof actual.useEditor>) => {
    const editor = actual.useEditor(...args); mocks.realEditor = editor; return editor;
  } };
});
import { ChatPage } from '../../components/app/ChatPage';
vi.mock('../../components/WelcomeScreen', () => ({ WelcomeScreen: () => null }));
vi.mock('../../components/chat/ChatArea', () => ({ ChatArea: () => null }));
import { createTestTranslator } from '../helpers/i18n-test-strings';

const testT = createTestTranslator();

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: testT }),
}));

vi.mock('../../hooks/use-config', () => ({
  fetchConfig: vi.fn(async () => ({})),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (path: string, opts?: RequestInit) => mocks.hanaFetch(path, opts),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../stores/session-actions', async importOriginal => {
  const actual = await importOriginal<typeof import('../../stores/session-actions')>();
  return { ...actual,
    ensureSession: (...args: Parameters<typeof actual.ensureSession>) => mocks.useRealSession
      ? actual.ensureSession(...args) : mocks.ensureSession(...args),
    loadSessions: vi.fn(),
    upsertOptimisticSessionFirstMessage: mocks.upsertOptimisticSessionFirstMessage,
  };
});
vi.mock('../../utils/ui-helpers', () => ({ loadModels: vi.fn() }));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  searchDeskFiles: vi.fn(async () => []),
  toggleJianSidebar: vi.fn(),
  activateWorkspaceDesk: mocks.activateWorkspaceDesk,
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: vi.fn(() => mocks.socketAvailable ? { send: mocks.wsSend } : null),
}));

vi.mock('../../MainContent', () => ({
  attachFilesFromPaths: vi.fn(),
}));

vi.mock('../../components/input/SlashCommandMenu', () => ({
  SlashCommandMenu: () => null,
}));

vi.mock('../../components/input/FileMentionMenu', () => ({
  FileMentionMenu: () => null,
}));

vi.mock('../../components/input/InputStatusBars', () => ({
  InputStatusBars: () => null,
}));

vi.mock('../../components/input/InputContextRow', () => ({
  InputContextRow: () => null,
}));

// Observe outcomes but render the real toolbar and SendButton. Every submission
// below enters through its DOM button, including retries while another send waits.
vi.mock('../../components/input/InputControlBar', async importOriginal => {
  const actual = await importOriginal<typeof import('../../components/input/InputControlBar')>();
  return { InputControlBar: (props: React.ComponentProps<typeof actual.InputControlBar>) => {
    mocks.onSend = props.onSend as () => Promise<void>;
    return React.createElement(actual.InputControlBar, { ...props, onSend: () => {
      const result = props.onSend();
      mocks.attempts.push(Promise.allSettled([result]).then(([outcome]) => outcome));
    } });
  } };
});

vi.mock('../../hooks/use-slash-items', () => ({
  useSkillSlashItems: () => [],
  useServerSlashCommandItems: () => [],
}));

vi.mock('../../utils/paste-upload-feedback', () => ({
  notifyPasteUploadFailure: vi.fn(),
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));

function seedSession() {
  useStore.setState({
    currentSessionPath: '/session/media.jsonl',
    currentSessionId: 'sess_media',
    currentAgentId: 'hana',
    sessions: [{
      path: '/session/media.jsonl',
      sessionId: 'sess_media',
      agentId: 'hana',
      agentName: 'Hana',
    }],
    sessionLocatorsById: { sess_media: { path: '/session/media.jsonl' } },
    connected: true,
    pendingNewSession: false,
    pendingDraftId: null,
    welcomeVisible: false,
    selectedAgentId: null,
    streamingSessions: [],
    inlineErrors: {},
    attachedFiles: [{
      fileId: 'sf_pasted',
      path: '/tmp/hana/session-files/pasted.png',
      name: 'pasted.png',
      isDirectory: false,
    }],
    attachedFilesBySession: {
      '/session/media.jsonl': [{
        fileId: 'sf_pasted',
        path: '/tmp/hana/session-files/pasted.png',
        name: 'pasted.png',
        isDirectory: false,
      }],
    },
    docContextAttached: false,
    quoteCandidate: null,
    quotedSelections: [],
    quotedSelection: null,
    models: [{
      id: 'deepseek-chat',
      provider: 'deepseek',
      name: 'DeepSeek Chat',
      input: ['text'],
      isCurrent: true,
    }],
    sessionModelsByPath: {},
    previewItems: [],
    previewOpen: false,
    activeTabId: null,
    chatSessions: {},
    serverPort: 3210,
    serverToken: null,
    modelSwitching: false,
  } as never);
  useStore.getState().clearSession('/session/media.jsonl');
  useStore.getState().initSession('/session/media.jsonl', [], false);
}

function expressionControlsResponse(path: string): Response | null {
  if (!path.startsWith('/api/sessions/expression-controls?')) return null;
  return new Response(JSON.stringify({
    sessionId: new URL(path, 'http://localhost').searchParams.get('sessionId'),
    agentId: useStore.getState().currentAgentId,
    presets: {},
    scene: null,
  }), { status: 200 });
}


describe('Composer consumption preserves edit ownership through real UI lifecycles', () => {
  const gates: Array<() => void> = [];
  beforeEach(() => {
    vi.clearAllMocks(); mocks.useRealSession = false; mocks.socketAvailable = true;
    mocks.wsSend.mockReset(); mocks.activateWorkspaceDesk.mockResolvedValue();
    mocks.realEditor = null; mocks.attempts = []; gates.length = 0;
    useStore.setState({ drafts: {}, draftDocs: {}, draftRevisions: {}, composerSubmissions: [], pendingSessionSwitchPath: null });
    seedSession();
    mocks.ensureSession.mockResolvedValue({ sessionId: 'sess_media', sessionPath: '/session/media.jsonl', agentId: 'hana' });
    mocks.hanaFetch.mockImplementation(async (path: string) => expressionControlsResponse(path) ?? new Response(JSON.stringify({ models: { vision_enabled: true, vision: { id: 'qwen-vl', provider: 'dashscope', input: ['text','image'] } } })));
    window.platform = { readFileBase64: vi.fn(async () => 'SYNTHETIC_BYTES') } as unknown as typeof window.platform;
    delete (window as unknown as { hana?: unknown }).hana;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  });
  afterEach(async () => {
    await act(async () => { gates.forEach(release => release()); await Promise.all(mocks.attempts); });
    cleanup(); vi.unstubAllGlobals();
    expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });
  function deferred<T>(fallback: T) {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    gates.push(() => resolve(fallback));
    return { promise, resolve };
  }
  async function mount() {
    render(React.createElement(ChatPage));
    await waitFor(() => expect(mocks.realEditor?.isInitialized).toBe(true));
  }
  function write(text: string) { act(() => { mocks.realEditor!.commands.setContent(text, { emitUpdate: true }); }); }
  function click() {
    const count = mocks.attempts.length;
    const button = screen.getByRole('button', { name: testT('chat.send') });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(mocks.attempts).toHaveLength(count + 1);
    return mocks.attempts[count];
  }
  async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
  function draft() { const s = useStore.getState(); return sessionScopedValue(s, s.drafts, s.currentSessionPath || HOME_DRAFT_KEY) || ''; }
  function revision() { const s = useStore.getState(); return sessionScopedValue(s, s.draftRevisions, s.currentSessionPath || HOME_DRAFT_KEY) || 0; }
  function sent() { return mocks.wsSend.mock.calls.map(c => JSON.parse(String(c[0]))); }
  type Extra = 'file' | 'quote' | 'context';
  function addExtra(extra: Extra) {
    act(() => {
      if (extra === 'file') useStore.getState().addAttachedFile({ fileId: 'extra-file', path: '/synthetic/extra.txt', name: 'extra.txt' });
      if (extra === 'quote') useStore.getState().addQuotedSelection({ text: 'EXTRA QUOTE', sourceTitle: 'Fixture', sourceKind: 'chat', charCount: 11 });
      if (extra === 'context') useStore.setState({ previewOpen: true, previewItems: [{ id: 'doc-c', filePath: '/synthetic/context.md', fileName: 'context.md', fileType: 'markdown' }], activeTabId: 'doc-c', docContextAttached: true } as never);
    });
  }
  function expectExtra(payload: { displayMessage: { attachments?: Array<{ fileId?: string; path?: string }>; quotedText?: string } }, extra: Extra, present: boolean) {
    const message = payload.displayMessage;
    const found = extra === 'quote' ? message.quotedText?.includes('EXTRA QUOTE')
      : message.attachments?.some(file => extra === 'file' ? file.fileId === 'extra-file' : file.path === '/synthetic/context.md');
    expect(found ?? false).toBe(present);
  }
  function expectResidual(extra: Extra) {
    expect(draft()).toBe(''); expect(mocks.realEditor!.getText()).toBe('');
    expect(useStore.getState().attachedFiles.map(f => f.fileId)).toEqual(extra === 'file' ? ['extra-file'] : []);
    expect(useStore.getState().quotedSelections.map(q => q.text)).toEqual(extra === 'quote' ? ['EXTRA QUOTE'] : []);
    expect(useStore.getState().docContextAttached).toBe(extra === 'context');
  }
  function expectEmpty() {
    expect(draft()).toBe(''); expect(mocks.realEditor!.getText()).toBe('');
    expect(useStore.getState().attachedFiles).toEqual([]);
    expect(useStore.getState().quotedSelections).toEqual([]);
    expect(useStore.getState().docContextAttached).toBe(false);
  }
  function slowCreation() {
    mocks.useRealSession = true;
    useStore.setState({ currentSessionPath: null, currentSessionId: null, pendingNewSession: true, pendingDraftId: 'overlap-pending', welcomeVisible: true, sessions: [], attachedFilesBySession: {} });
    const response = () => new Response(JSON.stringify({ path: '/session/new.jsonl', sessionId: 'sess_new', agentId: 'hana' }));
    const creation = deferred(response());
    const fallback = mocks.hanaFetch.getMockImplementation()!;
    mocks.hanaFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/sessions/new-detached') return creation.promise;
      if (path === '/api/sessions/switch') return new Response(JSON.stringify({ ok: true, sessionId: 'sess_new', agentId: 'hana', workspaceFolders: [] }));
      if (path.startsWith('/api/sessions/history')) return new Response(JSON.stringify({ messages: [] }));
      return fallback(path, opts);
    });
    return () => creation.resolve(response());
  }

  for (const extra of ['file', 'quote', 'context'] as const) {
    for (const lifecycle of ['mounted', 'remounted', 'slow-create'] as const) {
      for (const secondFails of [false, true]) {
        it(`${extra}, ${lifecycle}, second ${secondFails ? 'fails then retries' : 'succeeds'}: consumption cannot grant another submission`, async () => {
          const firstGate = deferred('FIRST'), secondGate = deferred('SECOND');
          window.platform.readFileBase64 = vi.fn().mockImplementationOnce(() => firstGate.promise).mockImplementation(() => secondGate.promise);
          const activate = lifecycle === 'slow-create' ? slowCreation() : null;
          await mount(); write('SAME'); const initialEditor = mocks.realEditor!;
          const first = click(); await flush();
          addExtra(extra); const second = click(); await flush();
          if (activate) {
            expect(mocks.hanaFetch.mock.calls.filter(c => c[0] === '/api/sessions/new-detached')).toHaveLength(1);
            await act(async () => { activate(); });
          }
          await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(2));
          if (activate) expect(initialEditor.isDestroyed).toBe(true);
          const edit = revision();
          const duplicateBefore = click(); await flush();
          expect((await duplicateBefore).status).toBe('fulfilled');
          expect(window.platform.readFileBase64).toHaveBeenCalledTimes(2);
          const snapshots: Array<{ text: string; files: string[] }> = [];
          const stop = useStore.subscribe(state => snapshots.push({
            text: sessionScopedValue(state, state.drafts, state.currentSessionPath || HOME_DRAFT_KEY) || '',
            files: state.attachedFiles.map(file => file.fileId || ''),
          }));
          await act(async () => { firstGate.resolve('FIRST'); expect((await first).status).toBe('fulfilled'); });
          stop();
          const cleared = snapshots.filter(snapshot => snapshot.text === '');
          expect(cleared.length).toBeGreaterThan(0);
          expect(cleared.every(snapshot => !snapshot.files.includes('sf_pasted'))).toBe(true);
          expectResidual(extra); expect(revision()).toBe(edit);
          if (lifecycle === 'remounted') {
            const oldEditor = mocks.realEditor!; cleanup(); await mount();
            expect(oldEditor.isDestroyed).toBe(true); expect(mocks.realEditor).not.toBe(oldEditor);
            expectResidual(extra); expect(revision()).toBe(edit);
          }
          const duplicateAfter = click(); await flush();
          expect((await duplicateAfter).status).toBe('fulfilled');
          expect(window.platform.readFileBase64).toHaveBeenCalledTimes(2);
          expect(mocks.wsSend).toHaveBeenCalledTimes(1);
          if (secondFails) mocks.wsSend.mockImplementationOnce(() => { throw new Error('synthetic second send failure'); });
          await act(async () => { secondGate.resolve('SECOND'); expect((await second).status).toBe(secondFails ? 'rejected' : 'fulfilled'); });
          expect(sent().map(s => s.displayMessage.text)).toEqual(['SAME', 'SAME']);
          expectExtra(sent()[0], extra, false); expectExtra(sent()[1], extra, true);
          if (secondFails) {
            expectResidual(extra); expect(useStore.getState().composerSubmissions).toEqual([]);
            await act(async () => { expect((await click()).status).toBe('fulfilled'); });
            const retry = sent()[2]; expect(retry.displayMessage.text).toBe(''); expectExtra(retry, extra, true);
            expect(retry.displayMessage.attachments?.some((f: { fileId?: string }) => f.fileId === 'sf_pasted')).not.toBe(true);
            expect(mocks.wsSend).toHaveBeenCalledTimes(3);
          } else expect(mocks.wsSend).toHaveBeenCalledTimes(2);
          expectEmpty();
          const count = mocks.attempts.length;
          fireEvent.click(screen.getByRole('button', { name: testT('chat.send') }));
          expect(mocks.attempts).toHaveLength(count);
        });
      }
    }

    it(`${extra}: a real same-text edit after consumption is a new eligible send`, async () => {
      const firstGate = deferred('FIRST'), secondGate = deferred('SECOND');
      window.platform.readFileBase64 = vi.fn().mockImplementationOnce(() => firstGate.promise).mockImplementation(() => secondGate.promise);
      await mount(); write('SAME'); const first = click(); await flush(); addExtra(extra); const second = click(); await flush();
      await act(async () => { firstGate.resolve('FIRST'); await first; });
      const before = revision(); write('SAME');
      // One equal-document transaction (update suppressed) is also a real edit.
      const written = revision(); act(() => { mocks.realEditor!.chain().selectAll().insertContent('SAME').run(); });
      expect(revision()).toBeGreaterThan(written); expect(written).toBeGreaterThan(before);
      await act(async () => { expect((await click()).status).toBe('fulfilled'); });
      expect(mocks.wsSend).toHaveBeenCalledTimes(2);
      await act(async () => { secondGate.resolve('SECOND'); await second; });
      expect(sent().map(s => s.displayMessage.text)).toEqual(['SAME', 'SAME', 'SAME']); expectEmpty();
    });

    it(`${extra}: reverse completion keeps a later same-text edit owned by its editor transaction`, async () => {
      const firstGate = deferred('FIRST'), secondGate = deferred('SECOND');
      window.platform.readFileBase64 = vi.fn().mockImplementationOnce(() => firstGate.promise).mockImplementation(() => secondGate.promise);
      await mount(); write('SAME'); const first = click(); await flush(); addExtra(extra); const second = click(); await flush();
      await act(async () => { secondGate.resolve('SECOND'); await second; }); expectEmpty();
      write('SAME'); const edit = revision();
      await act(async () => { firstGate.resolve('FIRST'); await first; });
      expect(draft()).toBe('SAME'); expect(revision()).toBe(edit);
      await act(async () => { await click(); });
      expect(sent().map(s => s.displayMessage.text)).toEqual(['SAME', 'SAME', 'SAME']); expectEmpty();
    });
  }
  it('application read-only transitions do not count as editor changes or release a live claim', async () => {
    const gate = deferred('BYTES'); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(); write('UNCHANGED'); const first = click(); await flush(); const edit = revision();
    act(() => useStore.setState({ sessions: useStore.getState().sessions.map(s => ({ ...s, agentDeleted: true })) }));
    expect(mocks.realEditor!.isEditable).toBe(false);
    act(() => useStore.setState({ sessions: useStore.getState().sessions.map(s => ({ ...s, agentDeleted: false })) }));
    expect(mocks.realEditor!.isEditable).toBe(true);
    expect(revision()).toBe(edit);
    const duplicate = click(); await flush(); expect((await duplicate).status).toBe('fulfilled');
    expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve('BYTES'); await first; });
    expect(mocks.wsSend).toHaveBeenCalledTimes(1); expectEmpty();
  });

});
