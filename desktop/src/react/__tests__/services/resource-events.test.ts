/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const hanaFetch = vi.hoisted(() => vi.fn(async (path: string) => ({
  json: async () => (path.endsWith('/watch') ? { ok: true, watchId: 'watch-1' } : { ok: true }),
})));

vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch }));

describe('resource-events', () => {
  afterEach(() => {
    vi.resetModules();
    hanaFetch.mockClear();
  });

  it('shares one backend resource watch per local file and releases it after the last subscriber leaves', async () => {
    const { retainLocalFileResourceWatch } = await import('../../services/resource-events');

    const releaseFirst = retainLocalFileResourceWatch('/tmp/note.md');
    const releaseSecond = retainLocalFileResourceWatch('/tmp/note.md');
    await Promise.resolve();

    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(hanaFetch).toHaveBeenCalledWith('/api/resource-io/watch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ resource: { kind: 'local-file', path: '/tmp/note.md' } }),
    }));

    releaseFirst();
    await Promise.resolve();
    expect(hanaFetch).toHaveBeenCalledTimes(1);

    releaseSecond();
    await Promise.resolve();
    await Promise.resolve();

    expect(hanaFetch).toHaveBeenCalledWith('/api/resource-io/watch/watch-1', expect.objectContaining({
      method: 'DELETE',
    }));
  });
});
