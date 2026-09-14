import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { it, expect, vi, afterEach } from 'vitest';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { SessionCoordinator } from '../core/session-coordinator.ts';
import { submitDesktopSessionMessage, cancelDesktopSessionSubmission } from '../core/desktop-session-submit.ts';
import { createWorkflowTool } from '../lib/tools/workflow-tool.ts';
import { TaskRegistry } from '../lib/task-registry.ts';
const gate = () => Promise.withResolvers<void>();
const out = fs.mkdtempSync(path.join(process.env.TEMP!, 'runtime-rereview-'));
afterEach(() => vi.restoreAllMocks());

it.each(['restore', 'reload', 'stop'])('RR01 %s respects real SDK preflight ownership without receipts', async mode => {
  const entered = gate(), held = gate();
  const sp = path.join(out, 'fixture-session.jsonl');
  const trace: string[] = [];
  const model = { id: 'fixture', provider: 'fixture', input: ['text'] };
  const sdk: any = Object.create(AgentSession.prototype);
  Object.assign(sdk, {
    agent: { state: { model, messages: [], isStreaming: false } },
    sessionManager: { getSessionFile: () => sp },
    _resourceLoader: { getPrompts: () => ({ prompts: [] }) },
    _modelRegistry: { hasConfiguredAuth: () => true },
    _flushPendingBashMessages() {}, _findLastAssistantMessage() { return null; },
    _expandSkillCommand(t) { return t; }, _pendingNextTurnMessages: [],
    _extensionRunner: { hasHandlers: () => false, async emitBeforeAgentStart() { trace.push('sdk-preflight-entered'); entered.resolve(); await held.promise; trace.push('sdk-preflight-released'); } },
    _runAgentPrompt: vi.fn(async () => { trace.push('old-sdk-run-started'); }),
  });
  const agent = { id: 'fixture' };
  const c: any = new SessionCoordinator({ getAgent: () => agent, getAgentById: () => agent, getEngine: () => ({}) } as any);
  c._assertActiveDesktopSessionPath = () => {};
  c._assertSessionModelAvailable = () => {};
  c._assertCurrentActiveSessionLocator = () => {}; c._isDeletedAgentSessionPath = () => false;
  c.resolveSessionOwnership = () => ({ agentId: "fixture" }); c._ensureAgentRuntimeReady = async () => agent;
  c._cleanupAbortedSessionSidecars = () => {};
  c.preflightSessionInput = () => {};
  c._sessions.set(sp, { session: sdk, agentId: 'fixture' });
  c._teardownSessionEntry = vi.fn(async () => { trace.push('old-sdk-disposed'); });
  c._createSessionRuntime = vi.fn(async () => {
    const session = { sessionManager: { getSessionFile: () => sp } };
    c._sessions.set(sp, { session, agentId: 'fixture' });
    trace.push('replacement-registered'); return { session, sessionPath: sp };
  });
  // Real /rc router calls promptSession without submission receipt callbacks.
  const prompted = c.promptSession(sp, 'fixture text', undefined).catch(e => { trace.push('prompt-error:' + e.message); return e; });
  await entered.promise;
  expect(sdk.isStreaming).toBe(false);
  try {
    if (mode === 'stop') {
      expect(await c.abortSession(sp)).toBe(true);
      expect(c.getSessionByPath(sp)).toBeNull();
    } else {
      const replacing = mode === 'restore'
        ? c.createSession(sdk.sessionManager, out, true, model, { restore: true })
        : c.reloadSessionRuntime(sp);
      await expect(replacing).rejects.toThrow(/busy/);
      expect(c._teardownSessionEntry).not.toHaveBeenCalled();
      expect(c._createSessionRuntime).not.toHaveBeenCalled();
      expect(c._prePromptAbortControllers.size).toBe(1);
      await expect(c.promptSession(sp, "second input", undefined)).rejects.toThrow("session_busy");
    }
  } finally { held.resolve(); }
  const result = await prompted;
  if (mode === 'stop') {
    expect(sdk._runAgentPrompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: 'AbortError' });
  } else expect(sdk._runAgentPrompt).toHaveBeenCalledOnce();
  expect(c._prePromptAbortControllers.size).toBe(0);
});

it('RR02 canceled materialization must not register or process later attachments', async () => {
  const entered = gate(), held = gate(), written = gate();
  let writtenPath;
  const original = fsp.writeFile.bind(fsp);
  const trace: string[] = [];
  vi.spyOn(fsp, 'writeFile').mockImplementation(async (...args: any[]) => {
    if (String(args[0]).includes('review-attachment')) { trace.push('file-write-held'); entered.resolve(); await held.promise; }
    const result = await original(...args as [any, any]);
    writtenPath = args[0]; written.resolve(); return result;
  });
  const sp = path.join(out, 'fixture-inbound.jsonl');
  const engine: any = {
    hanakoHome: path.join(out, 'fixture-home'),
    ensureSessionLoaded: async () => ({ subscribe: () => () => {} }),
    promptSession: vi.fn(),
    registerSessionFile: vi.fn(entry => { trace.push('registered-after-cancel'); return { ...entry, id: 'fixture-file' }; }),
  };
  const pending = submitDesktopSessionMessage(engine, { sessionPath: sp, text: 'fixture',
    inboundFiles: [{ type: 'file', filename: 'review-attachment.txt', buffer: Buffer.from('synthetic fixture') }, { type: 'file', filename: 'later.txt', buffer: Buffer.from('later') }] }).catch(e => e);
  await entered.promise;
  cancelDesktopSessionSubmission(engine, sp);
  const result = await pending;
  trace.push('outer-rejected:' + result.name);
  held.resolve();
  await written.promise;
  await vi.waitFor(() => expect(fs.existsSync(writtenPath)).toBe(false));
  expect(engine.promptSession).not.toHaveBeenCalled();
  expect(engine.registerSessionFile).not.toHaveBeenCalled();
  expect(fsp.writeFile).toHaveBeenCalledTimes(1);
});

it.each(['catch', 'allSettled', 'uncaught'])('RR03 preserves recovery through %s after a child error', async mode => {
  const registry = new TaskRegistry();
  const store = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), suppressDelivery: vi.fn() };
  const tool = createWorkflowTool({ getTaskRegistry: () => registry, getDeferredStore: () => store,
    getSessionIdForPath: () => 'fixture-parent', executeIsolated: async () => { throw new Error('unexpected executor'); } } as any);
  const header = `export const meta = { name: 'fixture', description: 'fixture' };\n`;
  const child = header + `throw new Error('optional child failed')`;
  const script = header + (mode === 'uncaught'
    ? `await workflow(${JSON.stringify(child)}); return 'unreachable';`
    : mode === 'catch'
    ? `try { await workflow(${JSON.stringify(child)}); } catch (e) { log('handled child error'); } return 'recovered';`
    : `await Promise.allSettled([workflow(${JSON.stringify(child)})]); return 'recovered';`);
  await tool.execute('fixture', { script }, undefined, undefined, { sessionManager: { getSessionFile: () => '/fixture-parent.jsonl' } });
  if (mode === 'uncaught') {
    await vi.waitFor(() => expect(store.fail).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('optional child failed')));
    expect(store.resolve).not.toHaveBeenCalled();
  } else {
    await vi.waitFor(() => expect(store.resolve).toHaveBeenCalledWith(expect.any(String), "recovered"));
    expect(store.fail).not.toHaveBeenCalled();
  }
});

it('RR02 cancellation during mkdir prevents every file write and registration', async () => {
  const { materializeBridgeInboundFiles } = await import('../lib/session-files/bridge-inbound-files.ts');
  const entered = gate(), held = gate();
  const mkdir = fsp.mkdir.bind(fsp);
  vi.spyOn(fsp, 'mkdir').mockImplementation(async (...args: any[]) => {
    entered.resolve(); await held.promise;
    return mkdir(...args as [any, any]);
  });
  const writes = vi.spyOn(fsp, 'writeFile');
  const register = vi.fn();
  const controller = new AbortController();
  const pending = materializeBridgeInboundFiles({ hanakoHome: path.join(out, 'mkdir-home'),
    sessionPath: '/mkdir-test.jsonl', files: [{ filename: 'never.txt', buffer: Buffer.from('never') }],
    signal: controller.signal, registerSessionFile: register }).catch(e => e);
  await entered.promise; controller.abort(); held.resolve();
  expect(await pending).toMatchObject({ name: 'AbortError' });
  expect(writes).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});
