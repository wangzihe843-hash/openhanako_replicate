import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../lib/pi-sdk/index.ts';
import { SessionCoordinator } from '../core/session-coordinator.ts';
import { retrySessionTurn, SESSION_TASK_RETRY_RECORD_TYPE } from '../core/session-turn-actions.ts';
import { EffectLedger, prepareChannelPostRetryDispatch, publicEffectRecord, runChannelPostEffect } from '../lib/task-outcome/effect-ledger.ts';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

async function fixture(status: 'committed' | 'failed' | 'unknown' | 'prepared' = 'committed') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-retry-lineage-')); roots.push(root);
  const sessionsDir = path.join(root, 'sessions'); fs.mkdirSync(sessionsDir);
  let manager = SessionManager.create(root, sessionsDir);
  let sessionId = 'sess_one';
  const ledger = new EffectLedger(root);
  const send = vi.fn(async () => ({ timestamp: 'fixture-time' }));
  const input = () => ({ ledger, agentId: 'hana', sessionIdentity: `session-id:${sessionId}`, channelId: 'ch_team', content: 'hello', lookupReceipt: () => null, send });
  const original = await runChannelPostEffect({ ...input(), toolCallId: 'original-call', send: async () => {
    if (status !== 'committed') throw Object.assign(new Error('fixture'), { code: status === 'failed' ? 'channel_write_cancelled' : 'uncertain' });
    return send();
  } });
  if (status === 'prepared') ledger.write({ ...original.record, status });
  const append = (message: unknown) => manager.appendMessage(message as Parameters<SessionManager['appendMessage']>[0]);
  let targetId = append({ role: 'user', content: 'Post hello', timestamp: Date.now() });
  append({ role: 'assistant', content: [{ type: 'toolCall', id: 'original-call', name: 'channel', arguments: { action: 'post', channel: 'ch_team', content: 'hello' } }] });
  append({ role: 'toolResult', toolCallId: 'original-call', content: [], details: { effect: publicEffectRecord(original.record) } });
  const engine = {
    getSessionManifest: () => ({ ownerAgentId: 'hana', currentLocator: { path: manager.getSessionFile()! } }),
    getSessionIdForPath: () => sessionId,
    ensureSessionLoaded: async () => ({ sessionManager: manager }), isSessionStreaming: () => false, setSessionBranchHead: vi.fn(),
  };
  const begin = (opts: { beforeInputSideEffects(): void; text: string }, callId: string, content = 'hello') => {
    opts.beforeInputSideEffects();
    targetId = append({ role: 'user', content: opts.text, timestamp: Date.now() });
    append({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'channel', arguments: { action: 'post', channel: 'ch_team', content } }] });
  };
  const retry = (submit: (engine: unknown, opts: { beforeInputSideEffects(): void; text: string }) => Promise<unknown>) => retrySessionTurn(engine,
    { sessionId, target: { role: 'user', entryId: targetId }, mode: 'task_retry' }, { submit, invalidateDerivedState: () => {} });
  const finish = async (callId: string, content = 'hello') => {
    const result = await runChannelPostEffect({ ...input(), toolCallId: callId, content });
    append({ role: 'toolResult', toolCallId: callId, content: [], details: { effect: publicEffectRecord(result.record) } });
    return result;
  };
  return { root, ledger, original, engine, input, send, append, begin, retry, finish,
    manager: () => manager,
    restart: () => { manager = SessionManager.open(manager.getSessionFile()!, sessionsDir); },
    fork: () => { manager.createBranchedSession(manager.getLeafId()!); sessionId = 'sess_child'; },
    target: (id: string) => { targetId = id; },
  };
}

describe('durable accepted-input task retry lineage', () => {
  it.each(['committed', 'failed', 'unknown', 'prepared'] as const)('survives before-effect interruption and cold restart for %s', async status => {
    const f = await fixture(status);
    await expect(f.retry(async (_engine, opts) => {
      f.begin(opts, 'first-retry');
      prepareChannelPostRetryDispatch('hana', 'session-id:sess_one');
      throw new Error('fixture interruption before effect');
    })).rejects.toThrow('fixture interruption');
    f.restart();
    const result = await f.retry(async (_engine, opts) => { f.begin(opts, 'second-retry'); return f.finish('second-retry'); });
    expect(result.record.effectId).toBe(f.original.record.effectId);
    expect(result.record.status).toBe(status === 'failed' ? 'committed' : status === 'prepared' ? 'unknown' : status);
    expect(f.send).toHaveBeenCalledTimes(status === 'committed' || status === 'failed' ? 1 : 0);
  });

  it.each(['committed', 'failed', 'unknown'] as const)('survives result-loss interruption and cold restart for %s', async status => {
    const f = await fixture(status);
    await expect(f.retry(async (_engine, opts) => {
      f.begin(opts, 'first-retry');
      await runChannelPostEffect({ ...f.input(), toolCallId: 'first-retry' });
      throw new Error('fixture result lost');
    })).rejects.toThrow('fixture result lost');
    f.restart();
    const result = await f.retry(async (_engine, opts) => { f.begin(opts, 'second-retry'); return f.finish('second-retry'); });
    expect(result.record.effectId).toBe(f.original.record.effectId);
    expect(result.record.status).toBe(status === 'unknown' ? 'unknown' : 'committed');
    expect(f.send).toHaveBeenCalledTimes(status === 'unknown' ? 0 : 1);
  });

  it.each([false, true])('persists actual input lineage before provider dispatch with stable-ID key %s', async stableIdKey => {
    const f = await fixture();
    await f.retry(async (_engine, opts) => {
      opts.beforeInputSideEffects();
      const userId = f.append({ role: 'user', content: opts.text, timestamp: Date.now() });
      const provider = vi.fn(async (..._args: unknown[]) => {
        expect(f.manager().getBranch().at(-1)).toMatchObject({ customType: SESSION_TASK_RETRY_RECORD_TYPE,
          data: { turnInputEntryId: userId, actions: [{ toolCallId: 'original-call', effectId: f.original.record.effectId }] } });
        return { result: async () => ({}) };
      });
      const sessionPath = f.manager().getSessionFile();
      const coordinator = new SessionCoordinator({ sessionManifestStore: {
        resolveByLocatorPath: locator => locator === sessionPath ? { sessionId: 'sess_one' } : null,
      } });
      vi.spyOn(coordinator, '_assertCachePrefixContract').mockImplementation(() => null);
      const agent = { streamFn: provider };
      const entry = { agentId: 'hana', ...(stableIdKey ? { sessionId: 'sess_one' } : {}), session: { agent, sessionManager: f.manager() } };
      coordinator._installCachePrefixGuard(stableIdKey ? 'sess_one' : sessionPath, entry);
      await agent.streamFn({} as never, { tools: [] } as never, {} as never);
      expect(provider).toHaveBeenCalledOnce();
      return {};
    });
  });

  it.each([
    { agentId: 'other-agent', sessionId: 'sess_one' },
    { agentId: 'hana', sessionId: 'sess_other' },
  ])('rejects a retry dispatch owned by $agentId / $sessionId', async identity => {
    const f = await fixture();
    const provider = vi.fn(async (..._args: unknown[]) => ({ result: async () => ({}) }));
    await expect(f.retry(async (_engine, opts) => {
      opts.beforeInputSideEffects();
      f.append({ role: 'user', content: opts.text, timestamp: Date.now() });
      const coordinator = new SessionCoordinator({});
      const agent = { streamFn: provider };
      const entry = { ...identity, session: { agent, sessionManager: f.manager() } };
      coordinator._installCachePrefixGuard(identity.sessionId, entry);
      return agent.streamFn({} as never, { tools: [] } as never, {} as never);
    })).rejects.toMatchObject({ code: 'effect_retry_scope_mismatch' });
    expect(provider).not.toHaveBeenCalled();
    expect(f.manager().getBranch().some(entry => entry.type === 'custom' && entry.customType === SESSION_TASK_RETRY_RECORD_TYPE)).toBe(false);
  });

  it('does not attach an abandoned retry prefix to a new identical intentional operation', async () => {
    const f = await fixture();
    await expect(f.retry(async (_engine, opts) => { opts.beforeInputSideEffects(); throw new Error('before input'); })).rejects.toThrow('before input');
    f.restart();
    f.target(f.append({ role: 'user', content: 'Post hello again', timestamp: Date.now() }));
    f.append({ role: 'assistant', content: [{ type: 'toolCall', id: 'intentional-new', name: 'channel', arguments: { action: 'post', channel: 'ch_team', content: 'hello' } }] });
    const next = await runChannelPostEffect({ ...f.input(), toolCallId: 'intentional-new', send: async () => { throw Object.assign(new Error('cancelled'), { code: 'channel_write_cancelled' }); } });
    f.append({ role: 'toolResult', toolCallId: 'intentional-new', content: [], details: { effect: publicEffectRecord(next.record) } });
    const retried = await f.retry(async (_engine, opts) => { f.begin(opts, 'new-retry'); return f.finish('new-retry'); });
    expect(retried.record.effectId).toBe(next.record.effectId);
    expect(retried.record.effectId).not.toBe(f.original.record.effectId);
    expect(retried.record.status).toBe('committed');
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('retains explicit receipt identity through an authorized file-backed session fork', async () => {
    const f = await fixture();
    await f.retry(async (_engine, opts) => { f.begin(opts, 'first-retry'); return f.finish('first-retry'); });
    f.fork(); f.restart();
    const result = await f.retry(async (_engine, opts) => { f.begin(opts, 'child-retry'); return f.finish('child-retry'); });
    expect(result.record.effectId).toBe(f.original.record.effectId);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('fails closed when an original ledger disappears or retry arguments change', async () => {
    const f = await fixture();
    await f.retry(async (_engine, opts) => { f.begin(opts, 'first-retry'); return f.finish('first-retry'); });
    await expect(f.retry(async (_engine, opts) => { f.begin(opts, 'changed', 'different'); return f.finish('changed', 'different'); }))
      .rejects.toMatchObject({ code: 'effect_identity_conflict' });
    fs.unlinkSync(path.join(f.root, '.effects', 'channel-post', `${f.original.record.effectId}.json`));
    await expect(f.retry(async (_engine, opts) => { f.begin(opts, 'missing'); return f.finish('missing'); }))
      .rejects.toMatchObject({ code: 'effect_retry_record_missing' });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('refuses to bind a later input or dispatch without an accepted input', async () => {
    const f = await fixture();
    await expect(f.retry(async (_engine, opts) => { opts.beforeInputSideEffects(); return f.finish('missing-input'); })).rejects.toThrow('persisted accepted');
    f.target(f.append({ role: 'user', content: 'Post hello', timestamp: Date.now() }));
    await expect(f.retry(async (_engine, opts) => {
      f.begin(opts, 'first');
      f.append({ role: 'user', content: 'A second input', timestamp: Date.now() });
      return f.finish('wrong-turn');
    })).rejects.toThrow('persisted accepted');
  });
});
