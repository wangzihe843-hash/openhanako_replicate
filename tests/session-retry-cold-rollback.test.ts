import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../lib/pi-sdk/index.ts';
import { SessionManifestStore } from '../core/session-manifest/store.ts';
import { flushSessionManagerSnapshot } from '../core/session-jsonl-file.ts';
import { persistExplicitSessionBranchHead, readManifestSessionBranch } from '../core/session-branch-head.ts';
import { retrySessionTurn, SESSION_BRANCH_RESET_RECORD_TYPE } from '../core/session-turn-actions.ts';
import { memoryScopeFromBranch, SESSION_MEMORY_SCOPE_RECORD } from '../core/session-memory-scope.ts';
import { projectCurrentSessionBranchEntries, readCurrentSessionBranch, SESSION_RETRY_TRANSACTION_RECORD_TYPE } from '../lib/session-jsonl.ts';

const roots: string[] = [];
const stores: SessionManifestStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const parentScope = { version: 1, agentId: 'hana', realm: 'story', worldId: 'world', branchId: 'parent', knowledge: 'shared' };
const childScope = { ...parentScope, branchId: 'child' };

function fixture({ child = false, initialHead = true, assistant = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-retry-cold-'));
  roots.push(root);
  const manager = SessionManager.create(root, path.join(root, 'sessions'));
  if (child) manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: parentScope });
  const inputId = manager.appendMessage({ role: 'user', content: 'Original question', timestamp: Date.now() });
  if (assistant) manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Original answer' }], timestamp: Date.now() } as unknown as Parameters<SessionManager['appendMessage']>[0]);
  if (child) manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: childScope });
  const originalLeafId = manager.getLeafId()!;
  const originalMessages = manager.buildSessionContext().messages;
  const file = manager.getSessionFile()!;
  const store = new SessionManifestStore({ dbPath: path.join(root, 'manifest.db') });
  stores.push(store);
  const manifest = store.createForPath({ sessionPath: file, ownerAgentId: 'hana', domain: 'home' });
  const sessionId = manifest.sessionId;
  const persistHead = (head: { leafId: string | null; reason: string }) => persistExplicitSessionBranchHead({ store, sessionId, sessionManager: manager, ...head });
  if (initialHead) persistHead({ leafId: originalLeafId, reason: 'fixture' });
  const state = { failure: '' as '' | 'before' | 'after', unavailable: false, accepted: false };
  const refreshContext = vi.fn(() => {});
  const engine = {
    getSessionManifest: () => manifest,
    getSessionIdForPath: () => sessionId,
    ensureSessionLoaded: async () => ({ sessionManager: manager, refreshContext }),
    isSessionStreaming: () => false,
    setSessionBranchHead: vi.fn((_file: string, head: { leafId: string | null; reason: string }) => {
      if (state.unavailable || state.failure === 'before') throw new Error('head store unavailable');
      persistHead(head);
      if (state.failure === 'after') {
        state.unavailable = true;
        throw new Error('head acknowledgement lost');
      }
    }),
    emitEvent: vi.fn(),
  };
  const invalidate = vi.fn(() => {});
  const retry = () => retrySessionTurn(engine, { sessionId, target: { role: 'user', entryId: inputId }, replacementText: 'Replacement question' }, {
    invalidateDerivedState: invalidate,
    submit: async (_engine, input) => {
      input.beforeInputSideEffects();
      state.accepted = true;
      manager.appendMessage({ role: 'user', content: input.text, timestamp: Date.now() });
      return {};
    },
  });
  const cold = () => {
    // Read the actual SQLite row. A reconstructed "expected" row would miss
    // the distinction between before-write and lost-acknowledgement failures.
    const projection = readCurrentSessionBranch(file, { branchHead: store.getBranchHead(sessionId) });
    const reopened = SessionManager.open(file, path.dirname(file));
    if (projection.selectedLeafId) reopened.branch(projection.selectedLeafId); else reopened.resetLeaf();
    return { projection, reopened, messages: reopened.buildSessionContext().messages };
  };
  return { manager, file, store, sessionId, persistHead, state, refreshContext, engine, invalidate, retry, cold, inputId, originalLeafId, originalMessages };
}

describe('retry write-ahead cold rollback', () => {
  it.each([
    { child: false, failure: 'before' as const }, { child: false, failure: 'after' as const },
    { child: true, failure: 'before' as const }, { child: true, failure: 'after' as const },
  ])('restores original history and scope with an unavailable head store ($child, $failure)', async ({ child, failure }) => {
    const f = fixture({ child });
    f.state.failure = failure;
    await expect(f.retry()).rejects.toThrow(/head/);
    expect(f.state.accepted).toBe(false);
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(f.engine.emitEvent).not.toHaveBeenCalled();
    expect(f.manager.buildSessionContext().messages).toEqual(f.originalMessages);
    const cold = f.cold();
    expect(cold.messages).toEqual(f.originalMessages);
    if (failure === 'after') expect(cold.projection.headResolution).toBe('retry_rollback_recovery');
    if (child) expect(memoryScopeFromBranch(cold.reopened.getBranch(), 'hana')).toEqual(childScope);
    expect(SessionManager.open(f.file, path.dirname(f.file)).buildSessionContext().messages).toEqual(f.originalMessages);
    expect(f.manager.getEntry(f.originalLeafId)).toBeDefined();
    expect(f.engine.setSessionBranchHead).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('restores cold history after scope append and initial projection failure (head=%s)', async initialHead => {
    const f = fixture({ child: true, initialHead });
    f.refreshContext.mockImplementationOnce(() => { throw new Error('initial projection failed'); });
    f.state.failure = 'before';
    await expect(f.retry()).rejects.toThrow('initial projection failed');
    expect(f.state.accepted).toBe(false);
    expect(f.cold().messages).toEqual(f.originalMessages);
    expect(memoryScopeFromBranch(f.cold().reopened.getBranch(), 'hana')).toEqual(childScope);
    expect(f.engine.setSessionBranchHead).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('recovers without a rollback append or corrective head write (child=%s)', async child => {
    const f = fixture({ child });
    const append = f.manager.appendCustomEntry.bind(f.manager);
    vi.spyOn(f.manager, 'appendCustomEntry').mockImplementation((type, data) => {
      if (type === SESSION_BRANCH_RESET_RECORD_TYPE && (data as { rolledBack?: boolean }).rolledBack) throw new Error('rollback append interrupted');
      return append(type, data);
    });
    f.state.failure = 'after';
    await expect(f.retry()).rejects.toThrow('rollback append interrupted');
    expect(f.state.accepted).toBe(false);
    expect(f.cold().messages).toEqual(f.originalMessages);
    expect(f.cold().projection.selectedLeafId).toBe(f.originalLeafId);
    if (child) expect(memoryScopeFromBranch(f.cold().reopened.getBranch(), 'hana')).toEqual(childScope);
  });

  it.each([true, false])('recovers an interrupted preparatory append before the head write (head=%s)', async initialHead => {
    const f = fixture({ child: true, initialHead });
    const append = f.manager.appendCustomEntry.bind(f.manager);
    vi.spyOn(f.manager, 'appendCustomEntry').mockImplementation((type, data) => {
      if (type === SESSION_MEMORY_SCOPE_RECORD) { append(type, data); throw new Error('scope acknowledgement lost'); }
      if (type === SESSION_BRANCH_RESET_RECORD_TYPE && (data as { rolledBack?: boolean }).rolledBack) throw new Error('rollback append interrupted');
      return append(type, data);
    });
    f.state.failure = 'before';
    await expect(f.retry()).rejects.toThrow('rollback append interrupted');
    expect(f.cold().messages).toEqual(f.originalMessages);
    expect(memoryScopeFromBranch(f.cold().reopened.getBranch(), 'hana')).toEqual(childScope);
    expect(f.state.accepted).toBe(false);
  });

  it('does not parent later input to an unwritten SDK rollback entry', async () => {
    const f = fixture({ child: true });
    const persist = f.manager._persist.bind(f.manager);
    const spy = vi.spyOn(f.manager, '_persist').mockImplementation(entry => {
      if (entry.type === 'custom' && entry.customType === SESSION_BRANCH_RESET_RECORD_TYPE
        && (entry.data as { rolledBack?: boolean }).rolledBack) throw new Error('disk append failed');
      persist(entry);
    });
    f.state.failure = 'after';
    await expect(f.retry()).rejects.toThrow('disk append failed');
    expect(f.manager.getLeafId()).toBe(f.originalLeafId);
    expect(f.cold().messages).toEqual(f.originalMessages);
    spy.mockRestore();
    f.manager.appendMessage({ role: 'user', content: 'Continue original story', timestamp: Date.now() });
    expect(f.cold().messages).toEqual(f.manager.buildSessionContext().messages);
    expect(memoryScopeFromBranch(f.cold().reopened.getBranch(), 'hana')).toEqual(childScope);
  });

  it.each(['transaction', 'reset'])('recovers when %s append loses acknowledgement and compensation is interrupted', async step => {
    const f = fixture({ initialHead: false });
    const append = f.manager.appendCustomEntry.bind(f.manager);
    vi.spyOn(f.manager, 'appendCustomEntry').mockImplementation((type, data) => {
      if (type === SESSION_BRANCH_RESET_RECORD_TYPE && (data as { rolledBack?: boolean }).rolledBack) throw new Error('rollback append interrupted');
      const id = append(type, data);
      if (type === (step === 'transaction' ? SESSION_RETRY_TRANSACTION_RECORD_TYPE : SESSION_BRANCH_RESET_RECORD_TYPE)) throw new Error('append acknowledgement lost');
      return id;
    });
    f.state.failure = 'before';
    await expect(f.retry()).rejects.toThrow('rollback append interrupted');
    expect(f.cold().messages).toEqual(f.originalMessages);
    expect(f.state.accepted).toBe(false);
  });

  it('keeps memory failures reversible even when head compensation becomes unavailable', async () => {
    const f = fixture();
    f.invalidate.mockImplementationOnce(() => { f.state.unavailable = true; throw new Error('invalidation failed'); });
    await expect(f.retry()).rejects.toThrow('invalidation failed');
    expect(f.cold().messages).toEqual(f.originalMessages);
    expect(f.state.accepted).toBe(false);
  });

  it('durably prepares a user-only session before the SDK has flushed an assistant', async () => {
    const f = fixture({ assistant: false });
    f.state.failure = 'after';
    await expect(f.retry()).rejects.toThrow('head acknowledgement lost');
    expect(f.cold().messages).toEqual(f.originalMessages);
  });

  it('keeps synchronous memory observers on the live retry branch before input acceptance', async () => {
    const f = fixture({ child: true });
    const observe = () => {
      const projection = readManifestSessionBranch({ store: f.store, sessionId: f.sessionId, sessionPath: f.file });
      expect(projection.messages).toEqual([]);
      expect(projection.selectedLeafId).toBe(f.manager.getLeafId());
      expect(projection.headResolution).not.toBe('retry_rollback_recovery');
    };
    f.engine.setSessionBranchHead.mockImplementation((_file, head) => { f.persistHead(head); observe(); });
    f.invalidate.mockImplementation(observe);
    await f.retry();
    expect(f.state.accepted).toBe(true);
    expect(f.cold().messages).toEqual(f.manager.buildSessionContext().messages);
  });

  it('does not let old rollback evidence override later accepted retries or intentional rewinds', async () => {
    const f = fixture({ child: true });
    f.state.failure = 'after';
    await expect(f.retry()).rejects.toThrow('head acknowledgement lost');
    const oldReset = f.manager.getEntries().find(entry => entry.type === 'custom'
      && entry.customType === SESSION_BRANCH_RESET_RECORD_TYPE && !(entry.data as { rolledBack?: boolean }).rolledBack)!;
    f.state.failure = '';
    f.state.unavailable = false;
    await f.retry();
    expect(f.state.accepted).toBe(true);
    expect(f.cold().messages).toEqual(f.manager.buildSessionContext().messages);
    expect(JSON.stringify(f.cold().messages)).toContain('Replacement question');
    f.persistHead({ leafId: oldReset.id, reason: 'explicit_select' });
    expect(f.cold().projection.selectedLeafId).toBe(oldReset.id);
    f.persistHead({ leafId: f.inputId, reason: 'explicit_select' });
    expect(f.cold().projection.selectedLeafId).toBe(f.inputId);
    expect(f.cold().messages).toHaveLength(1);
  });

  it.each(['rollback', 'success'])('keeps active-branch forks independently readable after %s', async outcome => {
    const f = fixture({ child: true });
    if (outcome === 'rollback') {
      f.state.failure = 'after';
      await expect(f.retry()).rejects.toThrow('head acknowledgement lost');
    } else await f.retry();
    const { reopened, projection: originalProjection } = f.cold();
    const childFile = reopened.createBranchedSession(reopened.getLeafId()!)!;
    flushSessionManagerSnapshot(reopened);
    expect(reopened.getBranch().some(entry => entry.type === 'custom' && entry.customType === SESSION_RETRY_TRANSACTION_RECORD_TYPE)).toBe(false);
    const projection = readCurrentSessionBranch(childFile, { branchHead: { sessionId: 'foreign-child', leafId: reopened.getLeafId(), observedTailLeafId: reopened.getEntries().at(-1)!.id } });
    expect(projection.messages.map(message => message.content)).toEqual(originalProjection.messages.map(message => message.content));
    expect(memoryScopeFromBranch(reopened.getBranch(), 'hana')).toEqual(childScope);
  });

  it.each(['version', 'sessionId', 'originalLeafId', 'sourceEntryId', 'retryBranchParentId', 'resetLink', 'restoredParent'])('rejects malformed or foreign retry evidence (%s)', async corruption => {
    const f = fixture();
    f.state.failure = 'after';
    await expect(f.retry()).rejects.toThrow();
    const entries = structuredClone(f.manager.getEntries());
    const transaction = entries.find(entry => entry.type === 'custom' && entry.customType === SESSION_RETRY_TRANSACTION_RECORD_TYPE)!;
    if (transaction.type !== 'custom') throw new Error('missing transaction');
    const data = transaction.data as Record<string, unknown>;
    if (corruption === 'version') data.version = 99;
    else if (corruption === 'sessionId') data.sessionId = 'foreign-session';
    else if (corruption === 'originalLeafId') data.originalLeafId = f.inputId;
    else if (corruption === 'sourceEntryId') data.sourceEntryId = f.originalLeafId;
    else if (corruption === 'retryBranchParentId') data.retryBranchParentId = f.inputId;
    else {
      const marker = entries.find(entry => entry.type === 'custom' && entry.customType === SESSION_BRANCH_RESET_RECORD_TYPE
        && Boolean((entry.data as { rolledBack?: boolean }).rolledBack) === (corruption === 'restoredParent'))!;
      marker.parentId = f.inputId;
    }
    expect(() => projectCurrentSessionBranchEntries(entries, { branchHead: f.store.getBranchHead(f.sessionId) }))
      .toThrow('Invalid session retry transaction');
  });
});
