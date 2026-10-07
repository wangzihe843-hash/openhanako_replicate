import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { requestPhoneAi } from './xingye-phone-ai';

vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn() }));

const input = { kind: 'contacts_enrichment' as const, ownerAgentId: 'fixture-agent', ownerProfile: null, contacts: [], prompt: 'synthetic phone fixture' };
const response = () => new Response(JSON.stringify({ ok: true, result: { contacts: [] } }));

beforeEach(() => { vi.mocked(hanaFetch).mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('phone request budget and cancellation', () => {
  it.each([[undefined, 90_000], [1, 30_000], [500_000, 120_000], [NaN, 60_000]])('normalizes %s into the server attempt budget %s', async (requested, attempt) => {
    vi.mocked(hanaFetch).mockResolvedValue(response());
    expect(await requestPhoneAi({ ...input, timeoutMs: requested })).toEqual({ raw: { contacts: [] } });
    const [, options] = vi.mocked(hanaFetch).mock.calls[0]!;
    expect(JSON.parse(options!.body as string)).toMatchObject({ timeoutMs: attempt, totalTimeoutMs: attempt * 3 });
    expect(options!.timeout).toBe(attempt * 3 + 5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still receives fallback success after one full attempt has elapsed', async () => {
    vi.mocked(hanaFetch).mockImplementation((_url, options) => new Promise((resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
      setTimeout(() => resolve(response()), 30_010);
    }));
    const pending = requestPhoneAi({ ...input, timeoutMs: 30_000 });
    const result = pending.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(30_010);
    expect(await result).toEqual({ value: { raw: { contacts: [] } } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a pre-cancelled caller before sending the request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(requestPhoneAi({ ...input, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(hanaFetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds response body reading as well as waiting for headers', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (_url, options) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })),
    }) as Response);
    const pending = requestPhoneAi({ ...input, timeoutMs: 30_000 });
    const result = pending.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(95_000);
    expect(await result).toMatchObject({ error: { name: 'TimeoutError' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards caller cancellation while reading the response body', async () => {
    const controller = new AbortController();
    let started: (value?: unknown) => void;
    const ready = new Promise(resolve => { started = resolve; });
    vi.mocked(hanaFetch).mockImplementation(async (_url, options) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        started();
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
      }),
    }) as Response);
    const pending = requestPhoneAi({ ...input, signal: controller.signal });
    const result = pending.then(value => ({ value }), error => ({ error }));
    await ready;
    controller.abort();
    expect(await result).toMatchObject({ error: { name: 'AbortError' } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
