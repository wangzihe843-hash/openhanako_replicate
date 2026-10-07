import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callText } from '../core/llm-client.ts';
import { createXingyeRoute } from '../server/routes/xingye.js';

vi.mock('../core/llm-client.ts', () => ({ callText: vi.fn() }));

function post(body = {}, signal) {
  const engine = {
    resolveUtilityConfig: () => ({ utility: 'utility-fixture', api: 'openai-completions', base_url: 'http://127.0.0.1:1' }),
    getAgent: () => ({ config: { models: { chat: { id: 'chat-fixture', provider: 'fixture' } } } }),
    resolveModelWithCredentials: () => ({ api: 'openai-completions', model: 'chat-fixture', base_url: 'http://127.0.0.1:1' }),
  };
  const app = new Hono().route('/api', createXingyeRoute(engine));
  return app.request('/api/xingye/phone-generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ ownerAgentId: 'fixture-agent', prompt: 'synthetic phone fixture', timeoutMs: 30_000, totalTimeoutMs: 90_000, ...body }),
  });
}

beforeEach(() => { vi.mocked(callText).mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('phone generation request lifetime', () => {
  it.each([
    new DOMException('model timed out', 'TimeoutError'),
    Object.assign(new Error('model deadline reached'), { code: 'LLM_TIMEOUT' }),
  ])('allows an attempt timeout to reach a working fallback: %s', async error => {
    vi.mocked(callText)
      .mockImplementationOnce(({ timeoutMs }) => new Promise((_, reject) => setTimeout(() => reject(error), timeoutMs)))
      .mockResolvedValueOnce('{"contacts":[]}');
    const pending = post();
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ modelTier: 'agent-chat', result: { contacts: [] } });
    expect(callText).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callText).mock.calls[1][0]).toMatchObject({ timeoutMs: 30_000, signal: expect.any(AbortSignal) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps the next attempt at the remaining total budget', async () => {
    vi.mocked(callText)
      .mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error('synthetic failure')), 30_000)))
      .mockResolvedValueOnce('{"contacts":[]}');
    const pending = post({ totalTimeoutMs: 45_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe(200);
    expect(vi.mocked(callText).mock.calls.map(([options]) => options.timeoutMs)).toEqual([30_000, 15_000]);
  });

  it('does not start a model for a request cancelled before routing', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await post({}, controller.signal)).status).toBe(408);
    expect(callText).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes request cancellation to the running model and never starts fallback', async () => {
    const controller = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    vi.mocked(callText).mockImplementation(({ signal }) => {
      started(signal);
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const pending = post({}, controller.signal);
    const modelSignal = await ready;
    controller.abort();
    expect(modelSignal.aborted).toBe(true);
    expect((await pending).status).toBe(408);
    expect(callText).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a late success after cancellation even if the provider ignored its signal', async () => {
    const controller = new AbortController();
    vi.mocked(callText).mockImplementation(async () => {
      controller.abort();
      return '{"contacts":[]}';
    });
    expect((await post({}, controller.signal)).status).toBe(408);
    expect(callText).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy callers within the single budget they supplied', async () => {
    vi.mocked(callText).mockImplementation(({ timeoutMs }) => new Promise(resolve => setTimeout(() => resolve('{"contacts":[]}'), timeoutMs + 1)));
    const pending = post({ totalTimeoutMs: undefined });
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).status).toBe(408);
    expect(callText).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains ordinary provider failure details and clears its deadline timer', async () => {
    vi.mocked(callText).mockRejectedValue(new Error('synthetic provider failure'));
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: 'model call failed', details: expect.any(Array) });
    expect(vi.getTimerCount()).toBe(0);
  });
});
