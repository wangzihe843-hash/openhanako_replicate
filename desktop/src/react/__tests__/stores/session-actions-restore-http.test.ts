import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { restoreSession } from '../../stores/session-actions';

const fetchMock = vi.fn<typeof fetch>();
const target = { path: '/archive/a.jsonl', sessionId: 'archived-session' };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useStore.setState({
    serverPort: '19000', serverToken: 'test-token', serverConnections: {},
    activeServerConnection: null, activeServerConnectionId: null,
    sessions: [], sessionLocatorsById: {}, currentSessionPath: null,
    currentSessionId: null, pendingSessionSwitchPath: null,
    drafts: {}, draftDocs: {}, draftsHydratedAt: 0,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(data: unknown, status = 200, statusText = ''): Response {
  return new Response(JSON.stringify(data), { status, statusText, headers: { 'Content-Type': 'application/json' } });
}

describe('restoreSession with the real hanaFetch HTTP wrapper', () => {
  it('preserves the 409 conflict and its explanation without refreshing sessions', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'A same-name session already exists' }, 409, 'Conflict'));
    expect(await restoreSession(target)).toEqual({ status: 'conflict', error: 'A same-name session already exists' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19000/api/sessions/restore', expect.objectContaining({
      method: 'POST', body: JSON.stringify(target),
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
    }));
  });

  it('preserves the server explanation for HTTP 500', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Archive storage is unavailable' }, 500, 'Internal Server Error'));
    expect(await restoreSession(target)).toEqual({ status: 'error', error: 'Archive storage is unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the status text for a non-JSON HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 500, statusText: 'Internal Server Error' }));
    expect(await restoreSession(target)).toEqual({ status: 'error', error: 'Internal Server Error' });
  });

  it('reports network failure separately from a conflict', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection lost'));
    expect(await restoreSession(target)).toEqual({ status: 'error', error: 'connection lost' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes sessions and drafts after HTTP 200 and retains the restored identity', async () => {
    fetchMock.mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/api/sessions/restore') return jsonResponse({ restoredPath: '/sessions/a.jsonl', sessionId: 'archived-session' });
      if (url.pathname === '/api/sessions') return jsonResponse([]);
      if (url.pathname === '/api/health') return jsonResponse({});
      if (url.pathname === '/api/input-drafts') return jsonResponse({ sessions: {} });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    expect(await restoreSession(target)).toEqual({ status: 'ok', restoredPath: '/sessions/a.jsonl', sessionId: 'archived-session' });
    await vi.waitFor(() => expect(useStore.getState().draftsHydratedAt).toBeGreaterThan(0));
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toContain('/api/sessions');
    expect(paths).toContain('/api/input-drafts');
  });
});
