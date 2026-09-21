import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callText } from '../core/llm-client.ts';
import { createXingyeRoute } from '../server/routes/xingye.js';
vi.mock('../core/llm-client.ts', () => ({ callText: vi.fn() }));
function post(body = {}, signal) {
  const engine = {
    resolveUtilityConfig: () => ({ utility: 'model-a', api: 'openai-completions', base_url: 'http://localhost:1234' }),
    getAgent: vi.fn(() => ({ config: { models: { chat: { id: 'model-b', provider: 'test' } } } })),
    resolveModelWithCredentials: () => ({ api: 'openai-completions', model: 'model-b', base_url: 'http://localhost:1234' }),
    prompt: vi.fn(() => { throw new Error('formal chat must not run'); }),
    createSession: vi.fn(() => { throw new Error('formal session must not be created'); }),
  };
  const app = new Hono().route('/api', createXingyeRoute(engine));
  return { engine, response: app.request('/api/xingye/lore-studio/rehearsal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ agentId: 'a', input: '一起散步', mode: 'scene', ...body }),
  }) };
}
beforeEach(() => { vi.mocked(callText).mockReset(); });
describe('isolated character rehearsal', () => {
  it.each(['日常散步', '价值冲突', '追问秘密'])('performs a tool-free text call for %s and carries author feedback', async input => {
    vi.mocked(callText).mockResolvedValue(JSON.stringify({ text: '我会赴约，但不谈秘密。', rationale: '守诺与边界同时生效。', profilePatch: [{ field: 'behaviorLogic', value: '守诺，但不透露秘密。' }, { field: 'corruptionSeed', value: '100' }] }));
    const { engine, response } = post({ input, previousText: '旧稿', feedback: '少一点解释', profile: { values: '守诺', tools: 'execute' } });
    expect((await response).status).toBe(200);
    const request = vi.mocked(callText).mock.calls[0][0];
    expect(request).not.toHaveProperty('tools');
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const prompt = request.messages[0].content;
    for (const value of [input, '旧稿', '少一点解释', '守诺']) expect(prompt).toContain(value);
    expect(prompt).not.toContain('execute');
    expect(engine.prompt).not.toHaveBeenCalled();
    expect(engine.createSession).not.toHaveBeenCalled();
  });
  it('drops forbidden patch fields and never applies accepted-looking model output', async () => {
    vi.mocked(callText).mockResolvedValue(JSON.stringify({ text: '草稿', rationale: '理由', profilePatch: [{ field: 'values', value: ' 守诺 ' }, { field: 'memory', value: '写入' }] }));
    const result = await (await post().response).json();
    expect(result.turn.profilePatch).toEqual([{ field: 'values', value: '守诺' }]);
  });
  it('rejects empty scene without a model call', async () => {
    expect((await post({ input: ' ' }).response).status).toBe(400);
    expect(callText).not.toHaveBeenCalled();
  });
  it('does not fallback after cancellation even if another model is available', async () => {
    const controller = new AbortController();
    vi.mocked(callText).mockImplementation(async ({ signal }) => {
      controller.abort();
      signal.throwIfAborted();
    });
    const response = await post({}, controller.signal).response;
    expect(response.status).toBe(408);
    expect(callText).toHaveBeenCalledTimes(1);
  });
  it('does not fallback after a model timeout', async () => {
    vi.mocked(callText).mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    expect((await post().response).status).toBe(408);
    expect(callText).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid output without fabricating a successful draft', async () => {
    vi.mocked(callText).mockResolvedValue('not JSON');
    expect((await post().response).status).toBe(502);
  });
});