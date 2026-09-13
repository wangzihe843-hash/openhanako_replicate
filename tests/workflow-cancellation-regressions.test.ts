import { describe, it, expect, vi } from 'vitest';
import { createWorkflowTool } from '../lib/tools/workflow-tool.ts';
import { createStopTaskTool } from '../lib/tools/stop-task-tool.ts';
import { SubagentRunStore } from '../lib/subagent-run-store.ts';
import { TaskRegistry } from '../lib/task-registry.ts';

const meta = `export const meta = { name: 'cancel', description: 'test' };\n`;
const ctx = { sessionManager: { getSessionFile: () => '/parent.jsonl', getCwd: () => '/' } };
function setup(executeIsolated) {
  const registry = new TaskRegistry();
  const store = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), suppressDelivery: vi.fn() };
  const runStore = new SubagentRunStore();
  vi.spyOn(runStore, "resolve"); vi.spyOn(runStore, "fail"); vi.spyOn(runStore, "abort");
  const deps = { executeIsolated, getTaskRegistry: () => registry, getDeferredStore: () => store,
    getSubagentRunStore: () => runStore, getSessionIdForPath: () => 'parent-id', getSessionPermissionMode: () => 'read_only' };
  return { registry, store, runStore, tool: createWorkflowTool(deps), stop: createStopTaskTool(deps) };
}

describe('workflow cancellation ownership', () => {
  it.each(['stop_task', 'parent'])('R02 cancels through %s and drains before publishing failure', async (mode) => {
    let release;
    let signal;
    const held = new Promise(r => { release = r; });
    const f = setup(async (_p, o) => { signal = o.signal; await held; return { replyText: 'late' }; });
    const result: any = await f.tool.execute('c', { script: meta + `return await agent('held')` }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(signal).toBeDefined());
    try {
      if (mode === 'stop_task') await f.stop.execute('s', { task_id: result.details.taskId }, undefined, undefined, ctx);
      else f.registry.abortByParentSession({ sessionId: 'parent-id' });
      expect(signal.aborted).toBe(true);
      expect(f.runStore.fail).not.toHaveBeenCalled();
      expect(f.runStore.abort).not.toHaveBeenCalled();
    } finally { release(); }
    await vi.waitFor(() => expect(f.runStore.abort).toHaveBeenCalled());
    expect(f.runStore.resolve).not.toHaveBeenCalled();
    expect(f.runStore.fail).not.toHaveBeenCalled();
    expect(f.store.suppressDelivery).toHaveBeenCalled();
    expect(f.store.resolve).not.toHaveBeenCalled();
    expect(f.registry.query(result.details.taskId)).toMatchObject({ aborted: true, status: "aborted" });
  });

  it('R03 aborts a held sibling on script failure and waits for real completion', async () => {
    let release;
    let signal;
    const held = new Promise(r => { release = r; });
    const f = setup(async (p, o) => {
      if (p === 'held') { signal = o.signal; await held; return { replyText: 'late' }; }
      return { error: 'invalid input' };
    });
    await f.tool.execute('c', { script: meta + `return await Promise.all([agent('held'), agent('fail', { retries: 0 })])` }, undefined, undefined, ctx);
    try {
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      expect(f.store.fail).not.toHaveBeenCalled();
    } finally { release(); }
    await vi.waitFor(() => expect(f.store.fail).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("invalid input")));
    expect(f.store.resolve).not.toHaveBeenCalled();
  });
});

it('R03 rejects queued work and keeps drain pending until the active executor exits', async () => {
  const { createLimiter } = await import('../lib/workflow/concurrency.ts');
  const limiter = createLimiter({ maxConcurrent: 1, maxTotal: 10 });
  const held = (Promise as any).withResolvers();
  const active = limiter.run(() => held.promise);
  const queued = vi.fn();
  const outcome = limiter.run(queued).catch(e => e);
  limiter.cancel(new Error('stopped'));
  expect(await outcome).toMatchObject({ message: 'stopped' });
  expect(queued).not.toHaveBeenCalled();
  let drained = false;
  const draining = limiter.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  held.resolve(); await active; await draining;
  expect(drained).toBe(true);
});

it('R03 does not finish a root while a consumed nested script still owns nodes', async () => {
  const held = (Promise as any).withResolvers();
  const f = setup(async () => { await held.promise; return { replyText: 'child' }; });
  const child = meta + `return await agent('held')`;
  await f.tool.execute('c', { script: meta + `workflow(${JSON.stringify(child)}).then(() => {}); return 'root'` }, undefined, undefined, ctx);
  await new Promise(r => setTimeout(r, 20));
  expect(f.store.resolve).not.toHaveBeenCalled();
  held.resolve();
  await vi.waitFor(() => expect(f.store.resolve).toHaveBeenCalled());
});
