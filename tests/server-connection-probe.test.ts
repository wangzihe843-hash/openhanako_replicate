import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createServerConnectionProbe } = require('../desktop/server-connection-probe.cjs');
const appUrl = 'file:///D:/fixture/renderer/settings.html';
const input = { baseUrl: 'https://fixture.invalid/prefix', credential: 'synthetic-key' };

function fixture() {
  const fetch = vi.fn().mockImplementation(async () => new Response('{"ok":true}'));
  const frame = { url: appUrl };
  const sender = { isDestroyed: () => false, mainFrame: frame, session: { fetch } };
  const event = { sender, senderFrame: frame };
  const probe = createServerConnectionProbe(() => [{ webContents: sender, url: appUrl }]);
  return { probe, event, fetch };
}

describe('controlled desktop server connection', () => {
  it('uses the initiating session for exactly login and identity, preserving URL prefixes', async () => {
    const { probe, event, fetch } = fixture();
    fetch.mockResolvedValueOnce(new Response('{"ok":true}')).mockResolvedValueOnce(new Response('{"serverId":"fixture"}'));
    expect(await probe(event, input)).toEqual({ serverId: 'fixture' });
    expect(fetch).toHaveBeenNthCalledWith(1, `${input.baseUrl}/api/web-auth/login`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ credential: input.credential }), credentials: 'include', redirect: 'error', signal: expect.any(AbortSignal),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, `${input.baseUrl}/api/server/identity`, expect.objectContaining({
      headers: { Authorization: 'Bearer synthetic-key' }, credentials: 'include', redirect: 'error',
    }));
  });

  it.each(['destroyed window', 'frame', 'window', 'document'])('rejects an untrusted %s before any request', async kind => {
    const { probe, event, fetch } = fixture();
    if (kind === 'destroyed window') event.sender.isDestroyed = () => true;
    if (kind === 'frame') event.senderFrame = { url: appUrl };
    if (kind === 'window') event.sender = { ...event.sender };
    if (kind === 'document') event.senderFrame.url = 'file:///D:/fixture/untrusted.html';
    await expect(probe(event, input)).rejects.toThrow('only available in application settings');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows settings query and fragment without changing the trusted document', async () => {
    const { probe, event, fetch } = fixture();
    event.senderFrame.url = `${appUrl}?tab=server#connection`;
    await expect(probe(event, input)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'file:///D:/FIXTUR~1/renderer/settings.html',
    'file:///D:/fixture/renderer/SETTINGS.html',
  ])('does not assume a different file URL denotes the trusted document: %s', async url => {
    const { probe, event, fetch } = fixture();
    event.senderFrame.url = url;
    await expect(probe(event, input)).rejects.toThrow('only available in application settings');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['login', 'identity'])('rechecks sender after reading the %s response', async stage => {
    const { probe, event, fetch } = fixture();
    const navigatedResponse = () => new Response(new ReadableStream({
      pull(controller) {
        event.senderFrame.url = 'file:///D:/fixture/untrusted.html';
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
      },
    }));
    if (stage === 'identity') fetch.mockResolvedValueOnce(new Response('{"ok":true}'));
    fetch.mockImplementationOnce(navigatedResponse);
    await expect(probe(event, input)).rejects.toThrow('only available in application settings');
    expect(fetch).toHaveBeenCalledTimes(stage === 'login' ? 1 : 2);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it.each(['file:///tmp/server', 'https://user:secret@fixture.invalid', 'https://fixture.invalid/?token=x', 'https://fixture.invalid/#x'])('rejects invalid connection target %s', async baseUrl => {
    const { probe, event, fetch } = fixture();
    await expect(probe(event, { ...input, baseUrl })).rejects.toThrow('HTTP(S) URL');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not request identity after a failed login', async () => {
    const { probe, event, fetch } = fixture();
    fetch.mockResolvedValueOnce(new Response('{"error":"denied"}', { status: 401 }));
    await expect(probe(event, input)).rejects.toThrow('401');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('closes an unfinished error response after reporting a failed login', async () => {
    let responseClosed = false;
    const server = createServer((_request, response) => {
      response.once('close', () => { responseClosed = true; });
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.write('{"error":"synthetic denial"}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const { probe, event, fetch } = fixture();
    fetch.mockImplementation(globalThis.fetch);
    try {
      await expect(probe(event, { ...input, baseUrl: `http://127.0.0.1:${address.port}` })).rejects.toThrow('401');
      await vi.waitFor(() => expect(responseClosed).toBe(true), { timeout: 1000, interval: 10 });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('bounds remote response sizes', async () => {
    const { probe, event, fetch } = fixture();
    fetch.mockResolvedValueOnce(new Response(' '.repeat(1024 * 1024 + 1)));
    await expect(probe(event, input)).rejects.toThrow('too large');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
