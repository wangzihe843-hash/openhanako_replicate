import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../lib/pi-sdk/index.ts';
import { retrySessionTurn } from '../core/session-turn-actions.ts';
import { Hono } from 'hono';
import { createSessionsRoute } from '../server/routes/sessions.ts';
import { createSessionTurnContextExtension } from '../core/session-turn-context.ts';
import { cancelDesktopSessionSubmission, submitDesktopSessionMessage, submitDesktopSessionMessageWithReceipt } from '../core/desktop-session-submit.ts';
import { clearXingyeExpressionControls, prepareXingyeExpressionTurn, readXingyeExpressionControls, updateXingyeExpressionControls } from '../core/xingye-expression-controls.ts';

const sessionPath = '/tmp/agents/role-a/sessions/scene.jsonl';
function fixture() {
  const manifests = new Map(['s1', 's2', 'fork'].map(id => [id, { sessionId: id, lifecycle: 'active', ownerAgentId: 'role-a', currentLocator: { path: id === 's1' ? sessionPath : `/tmp/agents/role-a/sessions/${id}.jsonl` } }]));
  const providerPrompts: string[] = [];
  const userInputs: string[] = [];
  const session = { subscribe: () => () => {}, sessionManager: { appendCustomEntry: vi.fn() } };
  const engine = {
    agentsDir: '/tmp/agents',
    getSessionManifest: (id: string) => manifests.get(id),
    getSessionIdForPath: (value: string) => [...manifests].find(([, m]) => m.currentLocator.path === value)?.[0],
    ensureSessionLoaded: vi.fn(async () => session),
    isSessionStreaming: () => false,
    preflightSessionInput: () => {},
    emitEvent: vi.fn(),
    promptSession: vi.fn(async (path, text, opts, hooks) => {
      hooks.afterCachePreflight();
      hooks.afterInputAccepted();
      // Real production injection hook; no scene text is placed in the user/history input.
      const extension = createSessionTurnContextExtension({ sessionPathRef: path, getTurnContext: () => opts?.context });
      const handler = extension.handlers.get('before_agent_start')![0];
      const actual = await handler({ systemPrompt: 'base character' });
      providerPrompts.push(actual?.systemPrompt ?? 'base character');
      userInputs.push(text);
    }),
  };
  const configure = (remainingTurns: number | null = 1) => updateXingyeExpressionControls(engine, 's1', 'role-a', {
    scene: { text: 'hesitate-at-the-door', remainingTurns, presets: { perspective: 'first' } },
    presets: { length: 'concise', perspective: 'third' },
  });
  const send = (id = 's1') => submitDesktopSessionMessage(engine, { sessionId: id, text: 'hello' });
  return { engine, manifests, providerPrompts, userInputs, session, configure, send };
}

describe('session expression control lifecycle', () => {
  it('expires from actual system input, restores base presets, and never writes scene text to history', async () => {
    const f = fixture(); f.configure(2);
    await f.send(); await f.send(); await f.send();
    expect(f.providerPrompts.slice(0, 2).every(text => text.includes('hesitate-at-the-door'))).toBe(true);
    expect(f.providerPrompts[0]).toContain('第一人称');
    expect(f.providerPrompts[0]).not.toContain('第三人称');
    expect(f.providerPrompts[2]).not.toContain('hesitate-at-the-door');
    expect(f.providerPrompts[2]).toContain('第三人称');
    expect(f.userInputs).toEqual(['hello', 'hello', 'hello']);
    expect(JSON.stringify(f.session.sessionManager.appendCustomEntry.mock.calls)).not.toContain('hesitate-at-the-door');
    expect(readXingyeExpressionControls(f.engine, 's1').scene).toBeNull();
  });

  it('isolates other sessions, new branches, owners and restarted engines while reads preserve remaining turns', async () => {
    const f = fixture(); f.configure(3);
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(3);
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(3);
    await f.send('s2'); await f.send('fork');
    expect(f.providerPrompts).toEqual(['base character', 'base character']);
    expect(readXingyeExpressionControls({ ...f.engine }, 's1').scene).toBeNull();
    expect(() => readXingyeExpressionControls(f.engine, 's1', 'role-b')).toThrow('owner mismatch');
    f.manifests.get('s1')!.ownerAgentId = 'role-b';
    expect(readXingyeExpressionControls(f.engine, 's1').scene).toBeNull();
  });

  it('rejects invalid duration and presets without altering the existing state', () => {
    const f = fixture(); f.configure(3);
    for (const remainingTurns of [0, -1, 1.5, 21, '3', undefined]) {
      expect(() => updateXingyeExpressionControls(f.engine, 's1', 'role-a', { scene: { text: 'x', remainingTurns } })).toThrow();
    }
    for (const presets of [[], null, { length: ['concise', 'detailed'] }, { length: 'invalid' }, { unexpected: true }, JSON.parse('{"__proto__":{"length":"concise"}}'), { constructor: 'bad' }, { toString: 'bad' }]) {
      expect(() => updateXingyeExpressionControls(f.engine, 's1', 'role-a', { presets })).toThrow();
    }
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(3);
  });

  it('supports until-closed and preset-only scenes, with immutable snapshots and revision protection', () => {
    const f = fixture(); f.configure(null);
    const turn = prepareXingyeExpressionTurn(f.engine, 's1', sessionPath, { system: 'external context', beforeUser: 'rag' });
    turn.accept(); turn.accept();
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBeNull();
    expect(turn.context?.system).toContain('external context');
    expect(turn.context?.beforeUser).toBe('rag');
    updateXingyeExpressionControls(f.engine, 's1', 'role-a', { scene: { text: '', remainingTurns: 1, presets: { length: 'detailed' } } });
    turn.accept();
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(1);
    const oldTurn = prepareXingyeExpressionTurn(f.engine, 's1', sessionPath, null);
    f.configure(5); oldTurn.accept();
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(5);
    updateXingyeExpressionControls(f.engine, 's1', 'role-a', { scene: null });
    expect(readXingyeExpressionControls(f.engine, 's1').scene).toBeNull();
    clearXingyeExpressionControls(f.engine, 's1');
    expect(readXingyeExpressionControls(f.engine, 's1').presets).toEqual({});
  });

  it('does not consume preflight rejection and consumes accepted failures exactly once', async () => {
    const f = fixture(); f.configure(2);
    f.engine.promptSession.mockImplementationOnce(async () => { throw new Error('preflight failed'); });
    await expect(f.send()).rejects.toThrow('preflight failed');
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(2);
    f.engine.promptSession.mockImplementationOnce(async (_p, _t, _o, hooks) => {
      hooks.afterCachePreflight(); hooks.afterInputAccepted(); hooks.afterInputAccepted();
      throw new Error('provider failed');
    });
    await expect(f.send()).rejects.toThrow('provider failed');
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(1);
    await f.send();
    expect(readXingyeExpressionControls(f.engine, 's1').scene).toBeNull();
  });

  it('receipts and accepted cancellation cannot consume a scene twice', async () => {
    const f = fixture(); f.configure(3);
    const run = submitDesktopSessionMessageWithReceipt(f.engine, { sessionId: 's1', text: 'hello' });
    await run.accepted; await run.completion;
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(2);
    let finish!: () => void;
    f.engine.promptSession.mockImplementationOnce(async (_p, _t, _o, hooks) => {
      hooks.afterCachePreflight(); hooks.afterInputAccepted();
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const canceled = submitDesktopSessionMessageWithReceipt(f.engine, { sessionId: 's1', text: 'hello' });
    await canceled.accepted;
    cancelDesktopSessionSubmission(f.engine, sessionPath);
    await expect(canceled.completion).rejects.toThrow('aborted');
    finish();
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(1);
  });

  it('real user-turn retries use remaining controls and never resurrect an expired scene', async () => {
    const f = fixture(); f.configure(2);
    const manager = SessionManager.inMemory('/tmp');
    const target = manager.appendMessage({ role: 'user', content: 'retry me', timestamp: 1 });
    f.session.sessionManager = manager as unknown as typeof f.session.sessionManager;
    Object.assign(f.engine, { setSessionBranchHead: vi.fn() });
    const originalPrompt = f.engine.promptSession.getMockImplementation()!;
    f.engine.promptSession.mockImplementation(async (...args) => {
      await originalPrompt(...args);
      manager.appendMessage({ role: 'user', content: args[1], timestamp: 2 });
    });
    await f.send();
    await retrySessionTurn(f.engine, { sessionId: 's1', target: { role: 'user', entryId: target } }, { invalidateDerivedState: vi.fn() });
    const newTarget = manager.getBranch().findLast(entry => entry.type === 'message')!.id;
    await retrySessionTurn(f.engine, { sessionId: 's1', target: { role: 'user', entryId: newTarget } }, { invalidateDerivedState: vi.fn() });
    expect(f.providerPrompts[1]).toContain('hesitate-at-the-door');
    expect(f.providerPrompts[2]).not.toContain('hesitate-at-the-door');
  });

  it('fails closed for stale owner/lifecycle or locator before applying controls', () => {
    const f = fixture(); f.configure();
    expect(() => prepareXingyeExpressionTurn(f.engine, 's1', '/wrong', null)).toThrow('locator mismatch');
    const turn = prepareXingyeExpressionTurn(f.engine, 's1', sessionPath, null);
    f.manifests.get('s1')!.lifecycle = 'archived';
    expect(() => turn.accept()).toThrow('active session');
    expect(() => prepareXingyeExpressionTurn(f.engine, 's1', sessionPath, null)).toThrow('active session');
  });
});

describe('expression control REST boundary', () => {
  const request = (app: Hono, body: unknown) => app.request('/sessions/expression-controls', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('reads/writes scoped state and rejects wrong owner, invalid input and inactive sessions', async () => {
    const f = fixture(); const app = new Hono(); app.route('/', createSessionsRoute(f.engine));
    expect((await request(app, { sessionId: 's1', agentId: 'role-a', scene: { text: 'scene', remainingTurns: 2 } })).status).toBe(200);
    const read = await app.request('/sessions/expression-controls?sessionId=s1');
    expect(await read.json()).toMatchObject({ agentId: 'role-a', scene: { text: 'scene', remainingTurns: 2 } });
    expect((await request(app, { sessionId: 's1', agentId: 'role-b', scene: null })).status).toBe(409);
    expect((await request(app, { sessionId: 's1', agentId: 'role-a', scene: { text: 'bad', remainingTurns: 0 } })).status).toBe(400);
    expect((await request(app, { sessionId: 'missing', agentId: 'role-a' })).status).toBe(404);
    f.manifests.get('s1')!.lifecycle = 'archived';
    expect((await app.request('/sessions/expression-controls?sessionId=s1')).status).toBe(409);
  });
  it('denies ungranted authenticated principals', async () => {
    const f = fixture(); const app = new Hono<{ Variables: { authPrincipal: unknown } }>();
    app.use('*', async (c, next) => {
      c.set('authPrincipal', { kind: 'plugin', pluginId: 'untrusted', principalId: 'plugin:untrusted' });
      await next();
    });
    app.route('/', createSessionsRoute(f.engine));
    expect((await app.request('/sessions/expression-controls?sessionId=s1')).status).toBe(403);
    expect((await app.request('/sessions/expression-controls', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', agentId: 'role-a' }) })).status).toBe(403);
  });

  it('rejects mutations while submission is pending before streaming begins and rejects a concurrent send', async () => {
    const f = fixture(); f.configure(); const app = new Hono(); app.route('/', createSessionsRoute(f.engine));
    let release!: (value: unknown) => void;
    f.engine.ensureSessionLoaded.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.send();
    expect((await request(app, { sessionId: 's1', agentId: 'role-a', scene: null })).status).toBe(409);
    await expect(f.send()).rejects.toThrow('session_busy');
    expect(readXingyeExpressionControls(f.engine, 's1').scene?.remainingTurns).toBe(1);
    release(f.session); await first;
  });
});
