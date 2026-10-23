// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { sessionScopedValue } from '../../stores/session-slice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../components/InputArea';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
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


describe('InputArea real editor submission lifecycle', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.clearAllMocks(); mocks.useRealSession = false; mocks.socketAvailable = true;
    mocks.wsSend.mockReset(); mocks.activateWorkspaceDesk.mockResolvedValue();
    mocks.realEditor = null;
    useStore.setState({ drafts: {}, draftDocs: {}, draftRevisions: {}, pendingSessionSwitchPath: null } as never);
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
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return {promise,resolve};
  }
  async function mount(page=false) {
    render(React.createElement(page ? ChatPage : InputArea));
    await waitFor(() => expect(mocks.realEditor?.isInitialized).toBe(true));
  }
  function write(text: string) { act(() => { mocks.realEditor!.commands.setContent(text, { emitUpdate: true }); }); }
  function submit() { let result!: Promise<void>; act(() => { result=mocks.onSend!(); }); return result; }
  function draft(path='/session/media.jsonl') { const s=useStore.getState(); return sessionScopedValue(s,s.drafts,path) || ''; }
  function pending() {
    mocks.useRealSession = true;
    useStore.setState({currentSessionPath:null,currentSessionId:null,pendingNewSession:true,pendingDraftId:'independent-pending',welcomeVisible:true,sessions:[],attachedFilesBySession:{}});
    const fallback=mocks.hanaFetch.getMockImplementation()!;
    mocks.hanaFetch.mockImplementation(async (path:string,opts?:RequestInit) => {
      if(path==='/api/sessions/new-detached')return new Response(JSON.stringify({path:'/session/new.jsonl',sessionId:'sess_new',agentId:'hana'}));
      if(path==='/api/sessions/switch')return new Response(JSON.stringify({ok:true,sessionId:'sess_new',agentId:'hana',workspaceFolders:[]}));
      if(path.startsWith('/api/sessions/history'))return new Response(JSON.stringify({messages:[]}));
      return fallback(path,opts);
    });
  }
  it('real editor preserves later text while sending the frozen payload', async () => {
    const gate=deferred<string>(); window.platform.readFileBase64=vi.fn(()=>gate.promise);
    await mount(); write('FIRST'); const first=submit();
    await waitFor(()=>expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    write('SECOND');
    await act(async()=>{gate.resolve('SYNTHETIC_BYTES');await first;});
    expect(JSON.parse(String(mocks.wsSend.mock.calls[0][0])).displayMessage.text).toBe('FIRST');
    expect(draft()).toBe('SECOND'); expect(mocks.realEditor!.getText()).toBe('SECOND');
  });
  it('real editor identical replacement transaction remains a new draft', async () => {
    const gate=deferred<string>(); window.platform.readFileBase64=vi.fn(()=>gate.promise);
    await mount();write('SAME');const first=submit();
    await waitFor(()=>expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    // Real select-all + replacement in ONE ProseMirror transaction (same action as equal-text paste).
    const updates=vi.fn();mocks.realEditor!.on('update', updates);
    act(() => { mocks.realEditor!.chain().selectAll().insertContent('SAME').run(); });
    expect(updates).not.toHaveBeenCalled();
    await act(async()=>{gate.resolve('SYNTHETIC_BYTES');await first;});
    expect(draft()).toBe('SAME');expect(mocks.realEditor!.getText()).toBe('SAME');
  });
  it('real editor two-transaction clear and retype keeps equal text', async () => {
    const gate=deferred<string>();window.platform.readFileBase64=vi.fn(()=>gate.promise);
    await mount();write('SAME');const first=submit();
    await waitFor(()=>expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    write('');write('SAME');await act(async()=>{gate.resolve('SYNTHETIC_BYTES');await first;});
    expect(draft()).toBe('SAME');expect(mocks.realEditor!.getText()).toBe('SAME');
  });
  it('real editor unchanged success clears all consumed text and attachments', async () => {
    await mount();write('CONSUMED');await act(async()=>{await mocks.onSend!();});
    expect(draft()).toBe('');expect(mocks.realEditor!.getText()).toBe('');expect(useStore.getState().attachedFiles).toEqual([]);
  });
  it('real ChatPage activation cannot send the same pending payload twice across its keyed remount', async () => {
    pending();const gate=deferred<string>();window.platform.readFileBase64=vi.fn(()=>gate.promise);
    await mount(true);write('ONCE');const oldEditor=mocks.realEditor;const first=submit();
    await waitFor(()=>expect(useStore.getState().currentSessionId).toBe('sess_new'));
    await waitFor(()=>expect(mocks.realEditor).not.toBe(oldEditor));
    await waitFor(()=>expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    // Actual ChatPage mounts a fresh InputArea at the new path. Click its real submit callback again.
    expect((screen.getByTestId('send') as HTMLButtonElement).disabled).toBe(false);
    const second=submit();await act(async()=>{gate.resolve('SYNTHETIC_BYTES');const results=await Promise.allSettled([first,second]);expect(results.map(r=>r.status)).toEqual(['fulfilled','fulfilled']);});
    expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    expect(mocks.wsSend.mock.calls.map(c=>JSON.parse(String(c[0])).displayMessage.text)).toEqual(['ONCE']);
  });
  it('real ChatPage activation clears the current editor after one unchanged pending send', async () => {
    pending();const gate=deferred<string>();window.platform.readFileBase64=vi.fn(()=>gate.promise);
    await mount(true);write('CONSUMED');const first=submit();
    await waitFor(()=>expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    let outcome!: PromiseSettledResult<void>;
    await act(async()=>{gate.resolve('SYNTHETIC_BYTES');[outcome]=await Promise.allSettled([first]);});
    expect(outcome.status).toBe('fulfilled');
    expect(draft('/session/new.jsonl')).toBe('');expect(mocks.realEditor!.getText()).toBe('');
    expect(useStore.getState().attachedFiles).toEqual([]);
  });
  it('real ChatPage remount preserves newer input while completing the old frozen send', async () => {
    pending();const gate=deferred<string>();window.platform.readFileBase64=vi.fn(()=>gate.promise);
    await mount(true);write('FIRST');const first=submit();
    await waitFor(()=>expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    write('NEXT');
    await act(async()=>{gate.resolve('SYNTHETIC_BYTES');await first;});
    expect(JSON.parse(String(mocks.wsSend.mock.calls[0][0])).displayMessage.text).toBe('FIRST');
    expect(draft('/session/new.jsonl')).toBe('NEXT');expect(mocks.realEditor!.getText()).toBe('NEXT');
    expect(useStore.getState().attachedFiles).toEqual([]);
  });
  it('real component releases store subscriptions after local failure and successful retry', async () => {
    const subscribe=useStore.subscribe;const live=new Set<unknown>();
    const spy=vi.spyOn(useStore,'subscribe').mockImplementation(listener=>{
      live.add(listener);const stop=subscribe(listener);return ()=>{live.delete(listener);stop();};
    });
    try {
      await mount();write('RETRY');mocks.wsSend.mockImplementationOnce(()=>{throw new Error('synthetic failure');});
      await act(async()=>{await expect(mocks.onSend!()).rejects.toThrow('synthetic failure');});
      expect(draft()).toBe('RETRY');
      await act(async()=>{await mocks.onSend!();});
      cleanup();expect(live.size).toBe(0);
    } finally { cleanup();spy.mockRestore(); }
  });


  it('submits newer text from the remounted composer while the first send is still waiting', async () => {
    pending(); const gate = deferred<string>(); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(true); write('FIRST'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    write('NEXT'); const second = submit();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await Promise.all([first, second]); });
    expect(mocks.wsSend.mock.calls.map(c => JSON.parse(String(c[0])).displayMessage.text)).toEqual(['FIRST', 'NEXT']);
    expect(draft('/session/new.jsonl')).toBe(''); expect(mocks.realEditor!.getText()).toBe('');
    expect(useStore.getState().attachedFiles).toEqual([]);
    expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });

  it('submits a new equal-text edit instead of treating it as the earlier in-flight send', async () => {
    const gate = deferred<string>(); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(); write('SAME'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    act(() => { mocks.realEditor!.chain().selectAll().insertContent('SAME').run(); });
    const second = submit();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await Promise.all([first, second]); });
    expect(mocks.wsSend.mock.calls.map(c => JSON.parse(String(c[0])).displayMessage.text)).toEqual(['SAME', 'SAME']);
    expect(draft()).toBe(''); expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });

  it('does not turn selection-only transactions or silent restoration into a new send', async () => {
    const gate = deferred<string>(); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(); write('ONCE'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    const revision = sessionScopedValue(useStore.getState(), useStore.getState().draftRevisions, '/session/media.jsonl');
    act(() => { mocks.realEditor!.commands.selectAll(); mocks.realEditor!.commands.setContent('ONCE', { emitUpdate: false }); });
    expect(sessionScopedValue(useStore.getState(), useStore.getState().draftRevisions, '/session/media.jsonl')).toBe(revision);
    const duplicate = submit();
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await Promise.all([first, duplicate]); });
    expect(mocks.wsSend).toHaveBeenCalledTimes(1); expect(draft()).toBe('');
  });

  it('retains send ownership across a same-session unmount and remount', async () => {
    const gate = deferred<string>(); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(true); write('ONCE'); const first = submit(); const oldEditor = mocks.realEditor!;
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    cleanup(); await mount(true); expect(oldEditor.isDestroyed).toBe(true);
    const duplicate = submit();
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await Promise.all([first, duplicate]); });
    expect(mocks.wsSend).toHaveBeenCalledTimes(1); expect(draft()).toBe(''); expect(mocks.realEditor!.getText()).toBe('');
    expect(useStore.getState().attachedFiles).toEqual([]); expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });

  it('releases a failed remounted send and lets the current composer retry its draft and attachments', async () => {
    pending(); const gate = deferred<string>(); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(true); write('RETRY'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    mocks.wsSend.mockImplementationOnce(() => { throw new Error('synthetic send failure'); });
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await expect(first).rejects.toThrow('synthetic send failure'); });
    expect(draft('/session/new.jsonl')).toBe('RETRY'); expect(useStore.getState().attachedFiles).toHaveLength(1);
    expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
    await act(async () => { await mocks.onSend!(); });
    expect(mocks.wsSend).toHaveBeenCalledTimes(2); expect(draft('/session/new.jsonl')).toBe('');
    expect(useStore.getState().attachedFiles).toEqual([]); expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });

  it('accepts a newly added attachment while the earlier unchanged-text payload is pending', async () => {
    pending(); const gate = deferred<string>(); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(true); write('FILES'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    act(() => { useStore.getState().addAttachedFile({ path: '/synthetic/new.txt', name: 'new.txt', fileId: 'new-file' }); });
    const second = submit();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await Promise.all([first, second]); });
    expect(mocks.wsSend).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(mocks.wsSend.mock.calls[1][0])).displayMessage.attachments.map((f: { fileId: string }) => f.fileId)).toEqual(['sf_pasted', 'new-file']);
    expect(useStore.getState().attachedFiles).toEqual([]);
  });

  it('deduplicates the newer pending send after the older send consumes shared attachments', async () => {
    const firstGate = deferred<string>(); const secondGate = deferred<string>();
    window.platform.readFileBase64 = vi.fn().mockImplementationOnce(() => firstGate.promise).mockImplementation(() => secondGate.promise);
    await mount(); write('FIRST'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    write('NEXT'); const second = submit();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { firstGate.resolve('SYNTHETIC_BYTES'); await first; });
    expect(draft()).toBe('NEXT'); expect(useStore.getState().attachedFiles).toEqual([]);
    const duplicate = submit();
    await act(async () => { secondGate.resolve('SYNTHETIC_BYTES'); await Promise.all([second, duplicate]); });
    expect(mocks.wsSend.mock.calls.map(c => JSON.parse(String(c[0])).displayMessage.text)).toEqual(['FIRST', 'NEXT']);
    expect(draft()).toBe(''); expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });

  it('shares slow pending-session creation when the user submits a newer draft', async () => {
    pending(); const create = deferred<Response>(); const gate = deferred<string>();
    const fallback = mocks.hanaFetch.getMockImplementation()!;
    mocks.hanaFetch.mockImplementation((path: string, opts?: RequestInit) => path === '/api/sessions/new-detached' ? create.promise.then(response => response.clone()) : fallback(path, opts));
    window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(true); write('FIRST'); const first = submit();
    await waitFor(() => expect(mocks.hanaFetch.mock.calls.filter(c => c[0] === '/api/sessions/new-detached')).toHaveLength(1));
    write('NEXT'); const second = submit();
    await act(async () => { create.resolve(new Response(JSON.stringify({ path: '/session/new.jsonl', sessionId: 'sess_new', agentId: 'hana' }))); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await Promise.all([first, second]); });
    expect(mocks.hanaFetch.mock.calls.filter(c => c[0] === '/api/sessions/new-detached')).toHaveLength(1);
    expect(mocks.wsSend.mock.calls.map(c => JSON.parse(String(c[0])).displayMessage.text)).toEqual(['FIRST', 'NEXT']);
    expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });

  it('preserves quote occurrences across overlapping successful sends', async () => {
    const firstGate = deferred<string>(); const secondGate = deferred<string>();
    window.platform.readFileBase64 = vi.fn().mockImplementationOnce(() => firstGate.promise).mockImplementationOnce(() => secondGate.promise);
    await mount();
    act(() => { useStore.getState().addQuotedSelection({ text: 'FIRST QUOTE', sourceTitle: 'Fixture', sourceKind: 'chat', charCount: 11 }); });
    write('FIRST'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    act(() => { useStore.getState().addQuotedSelection({ text: 'NEXT QUOTE', sourceTitle: 'Fixture', sourceKind: 'chat', charCount: 10 }); });
    write('NEXT'); const second = submit();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { firstGate.resolve('SYNTHETIC_BYTES'); await first; });
    expect(useStore.getState().quotedSelections.map(q => q.text)).toEqual(['NEXT QUOTE']);
    await act(async () => { secondGate.resolve('SYNTHETIC_BYTES'); await second; });
    expect(useStore.getState().quotedSelections).toEqual([]);
  });

  it('deduplicates newer text after older submission consumes the shared document context', async () => {
    const firstGate = deferred<string>(); const secondGate = deferred<string>();
    window.platform.readFileBase64 = vi.fn().mockImplementationOnce(() => firstGate.promise).mockImplementation(() => secondGate.promise);
    useStore.setState({ previewOpen: true, previewItems: [{ id: 'doc-a', filePath: '/synthetic/a.md', fileName: 'a.md', fileType: 'markdown' }], activeTabId: 'doc-a', docContextAttached: true } as never);
    await mount(); expect(useStore.getState().docContextAttached).toBe(true); write('FIRST'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    write('NEXT'); const second = submit();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { firstGate.resolve('SYNTHETIC_BYTES'); await first; });
    expect(useStore.getState().docContextAttached).toBe(false);
    const duplicate = submit();
    await act(async () => { secondGate.resolve('SYNTHETIC_BYTES'); await Promise.all([second, duplicate]); });
    expect(mocks.wsSend.mock.calls.map(c => JSON.parse(String(c[0])).displayMessage.text)).toEqual(['FIRST', 'NEXT']);
  });

  it('accepts a new document-context selection after an A-B-A transition', async () => {
    const gate = deferred<string>(); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    useStore.setState({ previewOpen: true, previewItems: [
      { id: 'doc-a', filePath: '/synthetic/a.md', fileName: 'a.md', fileType: 'markdown' },
      { id: 'doc-b', filePath: '/synthetic/b.md', fileName: 'b.md', fileType: 'markdown' },
    ], activeTabId: 'doc-a', docContextAttached: true } as never);
    await mount(); expect(useStore.getState().docContextAttached).toBe(true); write('CONTEXT'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    act(() => { useStore.setState({ activeTabId: 'doc-b' }); useStore.setState({ activeTabId: 'doc-a' }); });
    const second = submit();
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await Promise.all([first, second]); });
    expect(mocks.wsSend).toHaveBeenCalledTimes(2); expect(useStore.getState().docContextAttached).toBe(false);
  });

  it('does not invalidate an unchanged send when an unattached preview changes', async () => {
    const gate = deferred<string>(); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(); write('ONCE'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    act(() => { useStore.setState({ previewOpen: true, previewItems: [{ id: 'doc-b', filePath: '/synthetic/b.md', fileName: 'b.md', fileType: 'markdown' }], activeTabId: 'doc-b' } as never); });
    const duplicate = submit();
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await Promise.all([first, duplicate]); });
    expect(mocks.wsSend).toHaveBeenCalledTimes(1);
  });

  it('preserves third input when two accepted sends finish in reverse order', async () => {
    const firstGate = deferred<string>(); const secondGate = deferred<string>();
    window.platform.readFileBase64 = vi.fn().mockImplementationOnce(() => firstGate.promise).mockImplementationOnce(() => secondGate.promise);
    await mount(); write('FIRST'); const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    write('SECOND'); const second = submit(); await act(async () => { await Promise.resolve(); });
    write('THIRD');
    await act(async () => { secondGate.resolve('SYNTHETIC_BYTES'); await second; });
    await act(async () => { firstGate.resolve('SYNTHETIC_BYTES'); await first; });
    expect(mocks.wsSend.mock.calls.map(c => JSON.parse(String(c[0])).displayMessage.text)).toEqual(['SECOND', 'FIRST']);
    expect(draft()).toBe('THIRD'); expect(mocks.realEditor!.getText()).toBe('THIRD');
    expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });

  it('releases failed real session creation before retrying the same pending composer', async () => {
    pending(); const fallback = mocks.hanaFetch.getMockImplementation()!; let creations = 0;
    mocks.hanaFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/sessions/new-detached' && ++creations === 1) throw new Error('synthetic create failure');
      return fallback(path, opts);
    });
    await mount(true); write('RETRY'); await act(async () => { await mocks.onSend!(); });
    expect(mocks.wsSend).not.toHaveBeenCalled(); expect(mocks.realEditor!.getText()).toBe('RETRY');
    expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
    await act(async () => { await mocks.onSend!(); });
    expect(creations).toBe(2); expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    expect(draft('/session/new.jsonl')).toBe(''); expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });

  it('finishes store cleanup while unmounted and refuses a callback with a destroyed editor', async () => {
    const gate = deferred<string>(); window.platform.readFileBase64 = vi.fn(() => gate.promise);
    await mount(); write('ONCE'); const oldSubmit = mocks.onSend!; const first = submit();
    await waitFor(() => expect(window.platform.readFileBase64).toHaveBeenCalledTimes(1));
    cleanup(); await waitFor(() => expect(mocks.realEditor!.isDestroyed).toBe(true));
    await act(async () => { gate.resolve('SYNTHETIC_BYTES'); await first; await oldSubmit(); });
    expect(mocks.wsSend).toHaveBeenCalledTimes(1); expect(useStore.getState().attachedFiles).toEqual([]);
    await mount(); expect(mocks.realEditor!.getText()).toBe(''); expect(useStore.getState().composerSubmissions ?? []).toEqual([]);
  });
});
