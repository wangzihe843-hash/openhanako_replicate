import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof import('../../hooks/use-hana-fetch').hanaFetch>(),
}));
vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.fetch }));

let useStore: typeof import('../../stores')['useStore'];
let persistence: typeof import('../../stores/input-draft-persistence');
let sync: typeof import('../../stores/input-draft-sync');
let surface: 'electron' | 'pwa';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const oldHome = () => jsonResponse({ home: { text: 'already sent', doc: { type: 'doc' } }, sessions: {} });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.fetch.mockReset().mockResolvedValue(jsonResponse({ ok: true }));
  surface = 'electron';
  ({ useStore } = await import('../../stores'));
  persistence = await import('../../stores/input-draft-persistence');
  sync = await import('../../stores/input-draft-sync');
  const workspace = await import('../../stores/workspace-ui-state-actions');
  vi.spyOn(workspace, 'resolveWorkspaceUiSurface').mockImplementation(() => surface);
  useStore.setState({
    drafts: {}, draftDocs: {}, draftsHydratedAt: 0,
    sessions: [], sessionLocatorsById: {},
    serverPort: '19000', serverToken: 'test-token', serverConnections: {},
    activeServerConnection: null, activeServerConnectionId: null,
  });
  persistence.initInputDraftPersistence();
});

afterEach(() => {
  sync.registerDraftSyncListener(null);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('input draft persistence', () => {
  it('normally restores initial server drafts without overwriting current input', async () => {
    useStore.setState({ drafts: { 'sess-typed': 'user already typing' } });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      home: { text: 'home draft', doc: { type: 'doc' }, updatedAt: 1 },
      sessions: {
        'sess-typed': { text: 'stale server copy', updatedAt: 1 },
        'sess-cold': { text: 'cold draft', updatedAt: 1 },
      },
    }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({
      __home__: 'home draft', 'sess-typed': 'user already typing', 'sess-cold': 'cold draft',
    });
    expect(useStore.getState().draftDocs.__home__).toEqual({ type: 'doc' });
    expect(useStore.getState().draftsHydratedAt).toBeGreaterThan(0);
  });

  it('debounces real slice edits and preserves home / id / legacy path request semantics', async () => {
    const store = useStore.getState();
    store.setDraft('__home__', 'h1');
    store.setDraft('__home__', 'h2');
    store.setDraft('sess-1', 'session text', { type: 'doc' });
    store.setDraft('/agents/a/sessions/legacy.jsonl', 'legacy');
    await vi.advanceTimersByTimeAsync(600);
    const bodies = mocks.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies).toHaveLength(3);
    expect(bodies.find(body => body.scope === 'home')).toMatchObject({ text: 'h2' });
    expect(bodies.find(body => body.sessionId === 'sess-1')).toMatchObject({ text: 'session text', doc: { type: 'doc' } });
    expect(bodies.find(body => body.sessionPath === '/agents/a/sessions/legacy.jsonl')).toMatchObject({ text: 'legacy' });
    mocks.fetch.mockClear();
    store.clearDraft('sess-1');
    await vi.advanceTimersByTimeAsync(600);
    expect(JSON.parse(String(mocks.fetch.mock.calls[0][1]?.body))).toMatchObject({ sessionId: 'sess-1', text: '' });
  });

  it.each(['clear', 'set-then-clear', 'empty-editor-update'])('does not restore a draft consumed by %s during delayed startup hydration', async (operation) => {
    const response = deferredResponse();
    mocks.fetch.mockReturnValueOnce(response.promise);
    const pending = persistence.hydrateInputDrafts();
    const store = useStore.getState();
    if (operation === 'set-then-clear') store.setDraft('__home__', 'typed during startup', { type: 'doc' });
    if (operation === 'empty-editor-update') store.setDraft('__home__', '');
    else store.clearDraft('__home__');
    response.resolve(oldHome());
    await pending;
    expect(useStore.getState().drafts.__home__ || '').toBe('');
    expect(useStore.getState().draftDocs.__home__).toBeUndefined();
  });

  it('does not restore a cleared draft when hydration starts while its clear is still debounced', async () => {
    useStore.getState().clearDraft('__home__');
    mocks.fetch.mockResolvedValueOnce(oldHome());
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({});
  });

  it('keeps session input and its document when local editing follows the GET', async () => {
    const response = deferredResponse();
    mocks.fetch.mockReturnValueOnce(response.promise);
    const pending = persistence.hydrateInputDrafts();
    const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
    useStore.getState().setDraft('session-new', 'new text', doc);
    response.resolve(jsonResponse({ sessions: { 'session-new': { text: 'old text', doc: { type: 'doc' } } } }));
    await pending;
    expect(useStore.getState().drafts['session-new']).toBe('new text');
    expect(useStore.getState().draftDocs['session-new']).toEqual(doc);
  });

  it('discards an older overlapping hydration even when the newer response has no draft', async () => {
    const older = deferredResponse();
    const newer = deferredResponse();
    mocks.fetch.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = persistence.hydrateInputDrafts();
    const second = persistence.hydrateInputDrafts();
    newer.resolve(jsonResponse({ sessions: {} }));
    await second;
    older.resolve(oldHome());
    await first;
    expect(useStore.getState().drafts).toEqual({});
  });

  it('restores an unconsumed draft after archive removes only its runtime cache', async () => {
    useStore.getState().setDraft('session-archived', 'keep this draft');
    await vi.advanceTimersByTimeAsync(600);
    useStore.setState({ drafts: {}, draftDocs: {} });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ sessions: { 'session-archived': { text: 'keep this draft' } } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts['session-archived']).toBe('keep this draft');
  });

  it('retires a confirmed clear for future hydration while still rejecting a pre-clear response', async () => {
    const response = deferredResponse();
    mocks.fetch.mockReturnValueOnce(response.promise);
    const pending = persistence.hydrateInputDrafts();
    useStore.getState().clearDraft('__home__');
    await vi.advanceTimersByTimeAsync(600);
    response.resolve(oldHome());
    await pending;
    expect(useStore.getState().drafts).toEqual({});
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ home: { text: 'new remote draft' } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts.__home__).toBe('new remote draft');
  });

  it('does not let an older clear acknowledgement retire a newer set-then-clear', async () => {
    const firstClear = deferredResponse();
    mocks.fetch.mockReturnValueOnce(firstClear.promise);
    useStore.getState().clearDraft('__home__');
    await vi.advanceTimersByTimeAsync(500);
    useStore.getState().setDraft('__home__', 'second input');
    useStore.getState().clearDraft('__home__');
    firstClear.resolve(jsonResponse({ ok: true }));
    await vi.advanceTimersByTimeAsync(0);
    mocks.fetch.mockResolvedValueOnce(oldHome());
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({});
  });

  it('keeps a failed clear authoritative until a later successful write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    useStore.getState().clearDraft('__home__');
    await vi.advanceTimersByTimeAsync(600);
    mocks.fetch.mockResolvedValueOnce(oldHome());
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({});
  });

  it.each(['server', 'surface'])('isolates a pending hydration and local clear across a %s switch', async (target) => {
    const response = deferredResponse();
    mocks.fetch.mockReturnValueOnce(response.promise);
    const pending = persistence.hydrateInputDrafts();
    useStore.getState().clearDraft('__home__');
    if (target === 'server') useStore.setState({ serverPort: '19001' });
    else surface = 'pwa';
    response.resolve(oldHome());
    await pending;
    expect(useStore.getState().drafts).toEqual({});
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ home: { text: 'new scope draft' } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts.__home__).toBe('new scope draft');
  });

  it('persists a clear after the older in-flight text and never hydrates that text again', async () => {
    const oldWrite = deferredResponse();
    let serverText = '';
    mocks.fetch.mockImplementation(async (_path, init) => {
      if (init?.method !== 'PUT') return jsonResponse({ home: serverText ? { text: serverText } : null });
      const body = JSON.parse(String(init.body)) as { text: string };
      if (body.text === 'old input') await oldWrite.promise;
      serverText = body.text;
      return jsonResponse({ ok: true });
    });
    useStore.getState().setDraft('__home__', 'old input');
    await vi.advanceTimersByTimeAsync(500);
    useStore.getState().clearDraft('__home__');
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    oldWrite.resolve(jsonResponse({ ok: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(serverText).toBe('');
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts.__home__).toBeUndefined();
  });

  it('continues queued clears after a failed older PUT', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oldWrite = deferredResponse();
    mocks.fetch.mockReturnValueOnce(oldWrite.promise);
    useStore.getState().setDraft('__home__', 'old input');
    await vi.advanceTimersByTimeAsync(500);
    useStore.getState().clearDraft('__home__');
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    oldWrite.reject(new Error('request failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(mocks.fetch.mock.calls[1][1]?.body))).toMatchObject({ scope: 'home', text: '' });
  });

  it('lets unrelated session writes finish while a home PUT is still pending', async () => {
    const homeWrite = deferredResponse();
    mocks.fetch.mockReturnValueOnce(homeWrite.promise);
    useStore.getState().setDraft('__home__', 'home');
    await vi.advanceTimersByTimeAsync(500);
    useStore.getState().setDraft('other-session', 'independent');
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(mocks.fetch.mock.calls[1][1]?.body))).toMatchObject({ sessionId: 'other-session', text: 'independent' });
    homeWrite.resolve(jsonResponse({ ok: true }));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('orders a newly identified session clear after its legacy path PUT', async () => {
    const legacyPath = '/agents/a/sessions/legacy.jsonl';
    const oldWrite = deferredResponse();
    let serverText = 'previous persisted text';
    mocks.fetch.mockImplementation(async (_path, init) => {
      if (init?.method !== 'PUT') return jsonResponse({ sessions: serverText ? { 'session-identity': { text: serverText } } : {} });
      const body = JSON.parse(String(init.body)) as { text: string };
      if (body.text === 'legacy input') await oldWrite.promise;
      serverText = body.text;
      return jsonResponse({ ok: true });
    });
    useStore.getState().setDraft(legacyPath, 'legacy input');
    await vi.advanceTimersByTimeAsync(500);
    useStore.setState({ sessionLocatorsById: { 'session-identity': { path: legacyPath } } });
    useStore.getState().clearDraft(legacyPath);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({});
    oldWrite.resolve(jsonResponse({ ok: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(serverText).toBe('');
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({});
  });

  it('keeps a legacy path clear authoritative after its session identity becomes known', async () => {
    const legacyPath = '/agents/a/sessions/legacy.jsonl';
    useStore.getState().clearDraft(legacyPath);
    useStore.setState({ sessionLocatorsById: { 'session-identity': { path: legacyPath } } });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ sessions: { 'session-identity': { text: 'old draft' } } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({});
  });

  it('does not let a legacy clear acknowledgement retire a newer clear by sessionId', async () => {
    const legacyPath = '/agents/a/sessions/legacy.jsonl';
    const oldClear = deferredResponse();
    mocks.fetch.mockReturnValueOnce(oldClear.promise);
    useStore.getState().clearDraft(legacyPath);
    await vi.advanceTimersByTimeAsync(500);
    useStore.setState({ sessionLocatorsById: { 'session-identity': { path: legacyPath } } });
    useStore.getState().setDraft(legacyPath, 'new input');
    useStore.getState().clearDraft(legacyPath);
    oldClear.resolve(jsonResponse({ ok: true }));
    await vi.advanceTimersByTimeAsync(0);
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ sessions: { 'session-identity': { text: 'old draft' } } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({});
  });

  it('does not shadow existing legacy path input with a stale draft returned under its new id', async () => {
    const legacyPath = '/agents/a/sessions/legacy.jsonl';
    useStore.getState().setDraft(legacyPath, 'local input');
    useStore.setState({ sessionLocatorsById: { 'session-identity': { path: legacyPath } } });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ sessions: { 'session-identity': { text: 'old draft' } } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({ [legacyPath]: 'local input' });
  });

  it('pins debounced writes to their original connection instead of writing to a newly selected server', async () => {
    useStore.getState().clearDraft('__home__');
    useStore.setState({ serverPort: '19001' });
    useStore.getState().setDraft('__home__', 'other server draft');
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.fetch.mock.calls).toHaveLength(2);
    expect(mocks.fetch.mock.calls[0][1]?.connection?.baseUrl).toBe('http://127.0.0.1:19000');
    expect(mocks.fetch.mock.calls[1][1]?.connection?.baseUrl).toBe('http://127.0.0.1:19001');
  });

  it('restores the latest local edit when an archived draft is hydrated before its PUT finishes', async () => {
    const write = deferredResponse();
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new local draft' }] }] };
    let persisted = 'old server draft';
    mocks.fetch.mockImplementation(async (_path, init) => {
      if (init?.method === 'PUT') {
        await write.promise;
        persisted = JSON.parse(String(init.body)).text;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ sessions: { 'session-archived': { text: persisted } } });
    });
    useStore.getState().setDraft('session-archived', 'new local draft', doc);
    // archiveSession retires these caches without deleting the persisted draft.
    useStore.setState({ drafts: {}, draftDocs: {} });
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts['session-archived']).toBe('new local draft');
    expect(useStore.getState().draftDocs['session-archived']).toEqual(doc);
    await vi.advanceTimersByTimeAsync(500);
    write.resolve(jsonResponse({ ok: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(persisted).toBe('new local draft');
  });

  it('keeps the local snapshot when its PUT commits after a restore GET has already started', async () => {
    const read = deferredResponse();
    const write = deferredResponse();
    mocks.fetch.mockImplementation((_path, init) => init?.method === 'PUT' ? write.promise : read.promise);
    useStore.getState().setDraft('session-archived', 'new local draft', { type: 'doc' });
    await vi.advanceTimersByTimeAsync(500);
    useStore.setState({ drafts: {}, draftDocs: {} });
    const pending = persistence.hydrateInputDrafts();
    write.resolve(jsonResponse({ ok: true }));
    await vi.advanceTimersByTimeAsync(0);
    read.resolve(jsonResponse({ sessions: { 'session-archived': { text: 'old server draft' } } }));
    await pending;
    expect(useStore.getState().drafts['session-archived']).toBe('new local draft');
    // A later restore can use a fresh remote draft; acknowledged snapshots retire.
    useStore.setState({ drafts: {}, draftDocs: {} });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ sessions: { 'session-archived': { text: 'new remote draft' } } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts['session-archived']).toBe('new remote draft');
  });

  it('preserves an unconfirmed local draft after a failed PUT and an archive restore', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    useStore.getState().setDraft('session-archived', 'unsaved local draft', { type: 'doc' });
    await vi.advanceTimersByTimeAsync(500);
    useStore.setState({ drafts: {}, draftDocs: {} });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ sessions: {} }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts['session-archived']).toBe('unsaved local draft');
    expect(useStore.getState().draftDocs['session-archived']).toEqual({ type: 'doc' });
  });

  it('restores an unconfirmed local draft even if the restore GET fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useStore.getState().setDraft('session-archived', 'unsaved local draft');
    useStore.setState({ drafts: {}, draftDocs: {} });
    mocks.fetch.mockRejectedValueOnce(new Error('restore GET offline'));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts['session-archived']).toBe('unsaved local draft');
    expect(useStore.getState().draftsHydratedAt).toBe(0);
  });

  it('does not restore a pending set that was cleared while its restore GET was in flight', async () => {
    const read = deferredResponse();
    mocks.fetch.mockReturnValueOnce(read.promise);
    useStore.getState().setDraft('session-archived', 'new local draft');
    useStore.setState({ drafts: {}, draftDocs: {} });
    const pending = persistence.hydrateInputDrafts();
    useStore.getState().clearDraft('session-archived');
    await vi.advanceTimersByTimeAsync(500);
    read.resolve(jsonResponse({ sessions: { 'session-archived': { text: 'old server draft' } } }));
    await pending;
    expect(useStore.getState().drafts).toEqual({});
  });

  it('restores pending legacy-path input under its resolved identity and prefers a newer id edit', async () => {
    const legacyPath = '/agents/a/sessions/legacy.jsonl';
    useStore.getState().setDraft(legacyPath, 'legacy pending input');
    useStore.setState({ sessionLocatorsById: { 'session-identity': { path: legacyPath } }, drafts: {}, draftDocs: {} });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ sessions: { 'session-identity': { text: 'old remote input' } } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({ 'session-identity': 'legacy pending input' });
    useStore.getState().setDraft('session-identity', 'latest identity input');
    useStore.setState({ drafts: {}, draftDocs: {} });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ sessions: {} }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({ 'session-identity': 'latest identity input' });
  });

  it('claims startup input for the first connection without leaking it into the next one', async () => {
    sync.registerDraftSyncListener(null);
    useStore.getState().setDraft('__home__', 'startup input');
    persistence.initInputDraftPersistence();
    useStore.setState({ drafts: {}, draftDocs: {} });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ home: { text: 'old original input' } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts.__home__).toBe('startup input');
    useStore.setState({ serverPort: '19001', drafts: {}, draftDocs: {} });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ home: { text: 'other connection input' } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts.__home__).toBe('other connection input');
  });

  it.each(['server', 'surface'])('never restores another scope pending snapshot across a %s switch', async (target) => {
    useStore.getState().setDraft('__home__', 'private original draft');
    useStore.setState({ drafts: {}, draftDocs: {} });
    if (target === 'server') useStore.setState({ serverPort: '19001' });
    else surface = 'pwa';
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ home: { text: 'other scope draft' } }));
    await persistence.hydrateInputDrafts();
    expect(useStore.getState().drafts).toEqual({ __home__: 'other scope draft' });
  });
});
