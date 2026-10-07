const MAX_RESPONSE_BYTES = 1024 * 1024;

function sameDocument(actual, expected) {
  try {
    const left = new URL(actual);
    const right = new URL(expected);
    left.search = right.search = '';
    left.hash = right.hash = '';
    return left.href === right.href;
  } catch {
    return false;
  }
}

/** Only the application's main/settings documents may perform this fixed handshake. */
function createServerConnectionProbe(getTrustedTargets) {
  return async (event, input) => {
    const assertTrustedSender = () => {
      const trusted = getTrustedTargets().some(({ webContents, url }) => (
        webContents && !webContents.isDestroyed()
        && event.sender === webContents
        && event.senderFrame === webContents.mainFrame
        && sameDocument(event.senderFrame.url, url)
      ));
      if (!trusted) throw new Error('Server connection probe is only available in application settings');
    };
    assertTrustedSender();

    if (typeof input?.baseUrl !== 'string' || typeof input?.credential !== 'string' || !input.credential) {
      throw new Error('Server URL and access key are required');
    }
    const target = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
      throw new Error('Server connection requires an HTTP(S) URL without embedded credentials, query, or fragment');
    }
    const baseUrl = target.href.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Server connection timed out', 'TimeoutError')), 30_000);
    const request = async (route, init) => {
      assertTrustedSender();
      controller.signal.throwIfAborted();
      const response = await event.sender.session.fetch(`${baseUrl}${route}`, {
        ...init, credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`server connection request failed: ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error('Server connection response is empty');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            controller.abort();
            throw new Error('Server connection response is too large');
          }
          text += decoder.decode(value, { stream: true });
        }
        assertTrustedSender();
        controller.signal.throwIfAborted();
        return JSON.parse(text + decoder.decode());
      } finally {
        reader.releaseLock();
      }
    };
    try {
      await request('/api/web-auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: input.credential }),
      });
      return await request('/api/server/identity', {
        headers: { Authorization: `Bearer ${input.credential}` },
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

module.exports = { createServerConnectionProbe };
