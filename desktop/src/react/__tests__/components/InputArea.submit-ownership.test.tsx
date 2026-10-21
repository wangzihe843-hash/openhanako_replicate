// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { JSONContent } from '@tiptap/core';
import { HOME_DRAFT_KEY } from '../../../../../shared/input-drafts';
import { sessionScopedValue } from '../../stores/session-slice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../components/InputArea';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  useRealSession: false,
  socketAvailable: true,
  onSend: null as null | (() => Promise<void>),
  activateWorkspaceDesk: vi.fn(async () => {}),
  doc: { type: 'doc', content: [] } as JSONContent,
  onUpdate: null as null | (() => void),
  clearContent: vi.fn(),
  ensureSession: vi.fn(),
  hanaFetch: vi.fn(),
  upsertOptimisticSessionFirstMessage: vi.fn(),
  wsSend: vi.fn(),
}));

vi.mock('@tiptap/react', () => ({
  useEditor: () => {
    const chain: Record<string, unknown> = {};
    chain.clearContent = vi.fn(() => chain);
    chain.deleteRange = vi.fn(() => chain);
    chain.insertContent = vi.fn(() => chain);
    chain.focus = vi.fn(() => chain);
    chain.run = vi.fn();
    return {
      commands: {
        focus: vi.fn(),
        clearContent: mocks.clearContent,
        scrollIntoView: vi.fn(),
        setContent: vi.fn((doc: JSONContent) => { mocks.doc = doc || { type: 'doc', content: [] }; }),
        insertContent: vi.fn(),
      },
      chain: () => chain,
      getText: () => '',
      getJSON: () => mocks.doc,
      state: { tr: { setMeta: vi.fn(() => ({})) } },
      view: { dispatch: vi.fn() },
      on: vi.fn((event: string, fn: () => void) => { if (event === 'update') mocks.onUpdate = fn; }),
      off: vi.fn(),
    };
  },
  EditorContent: () => React.createElement('div', { 'data-testid': 'editor' }),
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('../../components/input/extensions/skill-badge', () => ({
  SkillBadge: {},
}));

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

vi.mock('../../components/input/InputControlBar', () => ({
  InputControlBar: ({
    canSend,
    onSend,
    isStreaming,
    hasInput,
    onSteer,
    onStop,
    showAudioInput,
    onAudioToggle,
    audioRecordingActive,
  }: {
    canSend: boolean;
    onSend: () => Promise<void>;
    isStreaming?: boolean;
    hasInput?: boolean;
    onSteer?: () => void;
    onStop?: () => void;
    showAudioInput?: boolean;
    onAudioToggle?: () => void;
    audioRecordingActive?: boolean;
  }) => { mocks.onSend = onSend; return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'send',
        disabled: isStreaming ? !hasInput : !canSend,
        onClick: isStreaming ? onSteer : onSend,
      },
      'send',
    ),
    showAudioInput
      ? React.createElement(
        'button',
        { type: 'button', 'data-testid': 'record-audio', onClick: onAudioToggle },
        audioRecordingActive ? 'stop' : 'record',
      )
      : null,
    isStreaming
      ? React.createElement('button', { type: 'button', 'data-testid': 'stop', onClick: onStop }, 'stop')
      : null,
  ); },
}));

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

describe('InputArea submit ownership', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useRealSession = false;
    mocks.socketAvailable = true;
    mocks.wsSend.mockReset();
    mocks.activateWorkspaceDesk.mockResolvedValue();
    useStore.setState({ drafts: {}, draftDocs: {}, pendingSessionSwitchPath: null });
    mocks.doc = { type: 'doc', content: [] };
    mocks.clearContent.mockImplementation(() => { mocks.doc = { type: 'doc', content: [] }; });
    mocks.ensureSession.mockResolvedValue({
      sessionId: 'sess_media',
      sessionPath: '/session/media.jsonl',
      agentId: 'hana',
    });
    seedSession();
    mocks.hanaFetch.mockImplementation(async (path: string) => expressionControlsResponse(path) ?? new Response(JSON.stringify({
      models: {
        vision_enabled: true,
        vision: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
      },
    }), { status: 200 }));
    window.platform = {
      readFileBase64: vi.fn(async () => 'IMAGE_BASE64'),
    } as unknown as typeof window.platform;
    delete (window as unknown as { hana?: unknown }).hana;
  });


  it.each(['text', 'attachment'])('retains same-session %s added during delayed image reading', async kind => {
    let release!: (s: string) => void;
    window.platform = { readFileBase64: vi.fn(() => new Promise<string>(r => { release = r; })) } as unknown as typeof window.platform;
    render(React.createElement(InputArea));
    fireEvent.click(screen.getByTestId('send'));
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    if (kind === 'text') {
      // Drive the real InputArea editor-update subscription; it calls the real draft action.
      mocks.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'NEXT UNSENT MESSAGE' }] }] };
      act(() => { mocks.onUpdate?.(); });
      expect(useStore.getState().drafts.sess_media).toBe('NEXT UNSENT MESSAGE');
    } else {
      const newer = { fileId: 'next-file', path: '/synthetic/next.txt', name: 'next.txt', isDirectory: false };
      act(() => { useStore.setState({ attachedFiles: [...useStore.getState().attachedFiles, newer], attachedFilesBySession: {'/session/media.jsonl': [...useStore.getState().attachedFiles, newer]} }); });
      expect(useStore.getState().attachedFiles).toHaveLength(2);
    }
    release('SYNTHETIC_BYTES');
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.displayMessage.text).toBe('');
    expect(JSON.stringify(payload)).not.toContain('NEXT UNSENT MESSAGE');
    expect(JSON.stringify(payload)).not.toContain('next-file');
    if (kind === 'text') {
      expect(useStore.getState().drafts.sess_media).toBe('NEXT UNSENT MESSAGE');
      expect(JSON.stringify(mocks.doc)).toContain('NEXT UNSENT MESSAGE');
    } else {
      expect(useStore.getState().attachedFiles.map(f => f.fileId)).toEqual(['next-file']);
      expect((useStore.getState().attachedFilesBySession.sess_media || useStore.getState().attachedFilesBySession['/session/media.jsonl']).map(f => f.fileId)).toEqual(['next-file']);
    }
  });

  function write(text: string, doc?: JSONContent) {
    act(() => {
      mocks.doc = doc ?? { type: 'doc', content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [] };
      mocks.onUpdate?.();
    });
  }
  function draft(key = '/session/media.jsonl') {
    const state = useStore.getState();
    return sessionScopedValue(state, state.drafts, key) || '';
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function submit() {
    let result!: Promise<void>;
    act(() => { result = mocks.onSend!(); });
    return result;
  }
  async function delayed(text = 'SUBMITTED') {
    const gate = deferred<string>();
    window.platform.readFileBase64 = vi.fn(() => gate.promise);
    render(React.createElement(InputArea));
    write(text);
    const result = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    return { gate, result };
  }
  async function finish(run: Awaited<ReturnType<typeof delayed>>) {
    await act(async () => { run.gate.resolve('SYNTHETIC_BYTES'); await run.result; });
    return JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
  }
  const added = { fileId: 'new-file', path: '/synthetic/new.txt', name: 'new.txt' };

  it('clears an unchanged successful submission', async () => {
    const run = await delayed();
    const sent = await finish(run);
    expect(sent.displayMessage.text).toBe('SUBMITTED');
    expect(draft()).toBe('');
    expect(mocks.doc.content).toEqual([]);
    expect(useStore.getState().attachedFiles).toEqual([]);
  });
  it('retains the same text retyped after clearing while waiting', async () => {
    const run = await delayed();
    write(''); write('SUBMITTED');
    await finish(run);
    expect(draft()).toBe('SUBMITTED');
    expect(JSON.stringify(mocks.doc)).toContain('SUBMITTED');
  });
  it('retains an identical replacement editor transaction without an intermediate empty value', async () => {
    const run = await delayed('A');
    write('A');
    await finish(run);
    expect(draft()).toBe('A');
    expect(JSON.stringify(mocks.doc)).toContain('A');
  });
  it('retains a new rich-text atom with empty serialized text', async () => {
    const run = await delayed('');
    write('', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'skillBadge', attrs: { name: 'synthetic-skill' } }] }] });
    const sent = await finish(run);
    expect(sent.skills).toBeUndefined();
    expect(JSON.stringify(mocks.doc)).toContain('synthetic-skill');
    expect(JSON.stringify(useStore.getState().draftDocs.sess_media)).toContain('synthetic-skill');
  });
  it('keeps a deliberate empty replacement draft without restoring submitted text', async () => {
    const run = await delayed(); write('');
    await finish(run);
    expect(useStore.getState().drafts.sess_media).toBe('');
    expect(mocks.doc.content).toEqual([]);
  });
  it('removes submitted attachments after reorder while preserving a new attachment', async () => {
    const run = await delayed();
    act(() => {
      useStore.getState().addAttachedFile(added);
      useStore.getState().setAttachedFiles([...useStore.getState().attachedFiles].reverse());
    });
    await finish(run);
    expect(useStore.getState().attachedFiles.map(f => f.fileId)).toEqual(['new-file']);
  });
  it('preserves a removed and re-added identical attachment occurrence', async () => {
    const run = await delayed();
    const original = useStore.getState().attachedFiles[0];
    act(() => { useStore.getState().removeAttachedFile(0); useStore.getState().addAttachedFile(original); });
    await finish(run);
    expect(useStore.getState().attachedFiles).toEqual([original]);
  });
  it('does not resurrect a removed attachment', async () => {
    const run = await delayed();
    act(() => { useStore.getState().removeAttachedFile(0); });
    await finish(run);
    expect(useStore.getState().attachedFiles).toEqual([]);
  });
  it('keeps newer quotes including a re-added equal quote', async () => {
    const quote = { text: 'SUBMITTED_QUOTE', sourceKind: 'chat' as const, sourceTitle: 'Synthetic', charCount: 15 };
    useStore.getState().addQuotedSelection(quote);
    const run = await delayed();
    const original = useStore.getState().quotedSelections[0];
    act(() => {
      useStore.getState().removeQuotedSelection(0);
      useStore.getState().addQuotedSelection(original);
      useStore.getState().addQuotedSelection({ ...quote, text: 'NEW_QUOTE' });
    });
    const sent = await finish(run);
    expect(sent.displayMessage.quotedText).toBe('SUBMITTED_QUOTE');
    expect(useStore.getState().quotedSelections.map(q => q.text)).toEqual(['SUBMITTED_QUOTE', 'NEW_QUOTE']);
  });
  it.each([false, true])('clears only unchanged document context; reattach=%s', async reattach => {
    useStore.setState({ previewOpen: true, activeTabId: 'doc', previewItems: [{ id: 'doc', filePath: '/synthetic/document.md', title: 'Document' }] } as never);
    useStore.getState().setDocContextAttached(true);
    const run = await delayed();
    if (reattach) act(() => { useStore.getState().setDocContextAttached(false); useStore.getState().setDocContextAttached(true); });
    const sent = await finish(run);
    expect(sent.displayMessage.attachments.some((f: { path: string }) => f.path === '/synthetic/document.md')).toBe(true);
    expect(useStore.getState().docContextAttached).toBe(reattach);
  });
  it('preserves document context selected away and back while waiting', async () => {
    useStore.setState({ previewOpen: true, activeTabId: 'doc-a', previewItems: [
      { id: 'doc-a', filePath: '/synthetic/a.md', title: 'A' },
      { id: 'doc-b', filePath: '/synthetic/b.md', title: 'B' },
    ] } as never);
    useStore.getState().setDocContextAttached(true);
    const run = await delayed();
    act(() => { useStore.setState({ activeTabId: 'doc-b' }); useStore.setState({ activeTabId: 'doc-a' }); });
    await finish(run);
    expect(useStore.getState().docContextAttached).toBe(true);
  });
  it.each([false, true])('preserves edits after session/role switch; return to source=%s', async back => {
    const run = await delayed();
    act(() => {
      const state = useStore.getState();
      useStore.setState({ currentSessionId: 'sess_b', currentSessionPath: '/session/b.jsonl', currentAgentId: 'other',
        sessions: [...state.sessions, { path: '/session/b.jsonl', sessionId: 'sess_b', agentId: 'other' }],
        sessionLocatorsById: { ...state.sessionLocatorsById, sess_b: { path: '/session/b.jsonl' } }, attachedFiles: [] } as never);
    });
    write('OTHER DRAFT');
    if (back) {
      act(() => { const state = useStore.getState(); useStore.setState({ currentSessionId: 'sess_media', currentSessionPath: '/session/media.jsonl', currentAgentId: 'hana', attachedFiles: sessionScopedValue(state, state.attachedFilesBySession, '/session/media.jsonl') || [] }); });
      write('NEW SOURCE DRAFT');
    }
    const sent = await finish(run);
    expect(sent.sessionId).toBe('sess_media');
    expect(draft('/session/b.jsonl')).toBe('OTHER DRAFT');
    expect(draft()).toBe(back ? 'NEW SOURCE DRAFT' : '');
    expect(JSON.stringify(mocks.doc)).toContain(back ? 'NEW SOURCE DRAFT' : 'OTHER DRAFT');
  });
  it('rejects two submissions in the same synchronous turn', async () => {
    const gate = deferred<string>();
    window.platform.readFileBase64 = vi.fn(() => gate.promise);
    render(React.createElement(InputArea)); write('SUBMITTED');
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { const send = mocks.onSend!; first = send(); second = send(); });
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await Promise.all([first, second]); });
    expect(mocks.wsSend).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'throw'])('preserves draft and attachments on local send failure: %s', async kind => {
    const run = await delayed();
    if (kind === 'missing') mocks.socketAvailable = false;
    else mocks.wsSend.mockImplementationOnce(() => { throw new Error('synthetic send failure'); });
    await act(async () => {
      run.gate.resolve('SYNTHETIC_BYTES');
      if (kind === 'throw') await expect(run.result).rejects.toThrow('synthetic send failure');
      else await run.result;
    });
    expect(draft()).toBe('SUBMITTED');
    expect(useStore.getState().attachedFiles).toHaveLength(1);
    mocks.socketAvailable = true;
    await act(async () => { await mocks.onSend!(); });
    expect(draft()).toBe('');
  });
  it('keeps file-only fallback and consumes only the submitted image after a read failure', async () => {
    const run = await delayed(); write('NEXT');
    await act(async () => { run.gate.reject(new Error('synthetic read failure')); await run.result; });
    const sent = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(sent.images).toBeUndefined();
    expect(sent.displayMessage.attachments[0].fileId).toBe('sf_pasted');
    expect(draft()).toBe('NEXT');
    expect(useStore.getState().attachedFiles).toEqual([]);
  });
  it('keeps all input when one native audio read fails after an image succeeds', async () => {
    useStore.setState({ models: [{ id: 'synthetic', provider: 'openai', name: 'Synthetic', input: ['text', 'image', 'audio'], audio: true, audioTransport: 'openai-input-audio', isCurrent: true }] } as never);
    useStore.getState().addAttachedFile({ path: '/synthetic/broken.wav', name: 'broken.wav' });
    window.platform.readFileBase64 = vi.fn(async path => { if (path.endsWith('.wav')) throw new Error('synthetic audio failure'); return 'SYNTHETIC_BYTES'; });
    render(React.createElement(InputArea)); write('SUBMITTED');
    await act(async () => { await mocks.onSend!(); });
    expect(mocks.wsSend).not.toHaveBeenCalled();
    expect(draft()).toBe('SUBMITTED');
    expect(useStore.getState().attachedFiles).toHaveLength(2);
  });
  it.each(['create', 'activate', 'after-activate'])('transfers edits through real ensureSession and switchSession: %s delay', async stage => {
    mocks.useRealSession = true;
    const create = deferred<Response>(), activate = deferred<Response>(), desk = deferred<void>();
    const image = deferred<string>();
    window.platform.readFileBase64 = vi.fn(() => image.promise);
    const defaultFetch = mocks.hanaFetch.getMockImplementation()!;
    mocks.hanaFetch.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === '/api/sessions/new-detached') return create.promise;
      if (path === '/api/sessions/switch') return activate.promise;
      if (path === '/api/sessions/history' || path.startsWith('/api/sessions/history?')) return Promise.resolve(new Response(JSON.stringify({ messages: [] })));
      return defaultFetch(path, opts);
    });
    mocks.activateWorkspaceDesk.mockImplementationOnce(() => desk.promise);
    useStore.setState({ currentSessionPath: null, currentSessionId: null, pendingNewSession: true, pendingDraftId: 'synthetic-pending', welcomeVisible: true, sessions: [], attachedFilesBySession: {} });
    render(React.createElement(InputArea)); write('SUBMITTED');
    const result = submit();
    const nextInput = () => { write('NEXT'); act(() => { useStore.getState().addAttachedFile(added); }); };
    if (stage === 'create') nextInput();
    await act(async () => { create.resolve(new Response(JSON.stringify({ path: '/session/new.jsonl', sessionId: 'sess_new', agentId: 'hana' }))); });
    await waitFor(() => expect(mocks.hanaFetch.mock.calls.some(([url]) => url === '/api/sessions/switch')).toBe(true));
    if (stage === 'activate') nextInput();
    await act(async () => { activate.resolve(new Response(JSON.stringify({ ok: true, sessionId: 'sess_new', agentId: 'hana', workspaceFolders: [] }))); });
    await waitFor(() => expect(useStore.getState().currentSessionId).toBe('sess_new'));
    if (stage === 'after-activate') nextInput();
    await act(async () => { desk.resolve(); });
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    await act(async () => { image.resolve('SYNTHETIC_BYTES'); await result; });
    const sent = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(sent.sessionId).toBe('sess_new');
    expect(sent.displayMessage.text).toBe('SUBMITTED');
    expect(draft('/session/new.jsonl')).toBe('NEXT');
    expect(draft(HOME_DRAFT_KEY)).toBe('');
    expect(JSON.stringify(mocks.doc)).toContain('NEXT');
    expect(useStore.getState().attachedFiles.map(f => f.fileId)).toEqual(['new-file']);
  });
  it('retains pending input when session creation fails', async () => {
    useStore.setState({ currentSessionId: null, currentSessionPath: null, pendingNewSession: true, pendingDraftId: 'failure', sessions: [] });
    mocks.ensureSession.mockResolvedValueOnce(null);
    render(React.createElement(InputArea)); write('SUBMITTED');
    await act(async () => { await mocks.onSend!(); });
    expect(mocks.wsSend).not.toHaveBeenCalled();
    expect(draft(HOME_DRAFT_KEY)).toBe('SUBMITTED');
    expect(useStore.getState().attachedFiles).toHaveLength(1);
  });

  it('retains new input during streaming interjection', async () => {
    useStore.setState({ streamingSessions: ['sess_media'] });
    const gate = deferred<string>();
    window.platform.readFileBase64 = vi.fn(() => gate.promise);
    render(React.createElement(InputArea)); write('SUBMITTED');
    fireEvent.click(screen.getByTestId('send'));
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    write('NEXT');
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); });
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(mocks.wsSend.mock.calls[0][0])).type).toBe('interject');
    expect(draft()).toBe('NEXT');
  });
  it('never consumes a replacement pending draft after cancellation', async () => {
    const create = deferred<{ sessionPath: string; sessionId: string; agentId: string }>();
    mocks.ensureSession.mockReturnValueOnce(create.promise);
    useStore.setState({ currentSessionId: null, currentSessionPath: null, pendingNewSession: true, pendingDraftId: 'old', sessions: [] });
    render(React.createElement(InputArea)); write('SUBMITTED');
    const result = submit();
    act(() => { useStore.setState({ pendingDraftId: 'replacement', attachedFiles: [] }); });
    write('REPLACEMENT');
    act(() => { useStore.getState().addAttachedFile(added); });
    await act(async () => { create.resolve({ sessionId: 'sess_old', sessionPath: '/session/old.jsonl', agentId: 'hana' }); await result; });
    expect(draft(HOME_DRAFT_KEY)).toBe('REPLACEMENT');
    expect(useStore.getState().attachedFiles.map(f => f.fileId)).toEqual(['new-file']);
    expect(JSON.parse(String(mocks.wsSend.mock.calls[0][0])).sessionId).toBe('sess_old');
  });

});
