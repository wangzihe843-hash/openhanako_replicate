import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../lib/pi-sdk/index.ts';
import { SessionManifestStore } from '../core/session-manifest/store.ts';
import { persistExplicitSessionBranchHead } from '../core/session-branch-head.ts';
import { flushSessionManagerSnapshot } from '../core/session-jsonl-file.ts';
import { retrySessionTurn, SESSION_BRANCH_RESET_RECORD_TYPE } from '../core/session-turn-actions.ts';
import { generateSessionDialogueVariant, adoptSessionDialogueVariant, DIALOGUE_VARIANT_RECORD_TYPE } from '../core/session-dialogue-variants.ts';
import { memoryScopeFromBranch, SESSION_MEMORY_SCOPE_RECORD } from '../core/session-memory-scope.ts';
import { readCurrentSessionBranch, DIALOGUE_VARIANT_ROLLBACK_RECORD_TYPE, SESSION_RETRY_TRANSACTION_RECORD_TYPE } from '../lib/session-jsonl.ts';

const roots: string[] = [];
const stores: SessionManifestStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const parentScope = { version: 1, agentId: 'hana', realm: 'story', worldId: 'world', branchId: 'parent', knowledge: 'shared' };
const childScope = { ...parentScope, branchId: 'child' };

async function fixture(child: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-retry-variant-'));
  roots.push(root);
  const manager = SessionManager.create(root, path.join(root, 'sessions'));
  if (child) manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: parentScope });
  const inputId = manager.appendMessage({ role: 'user', content: 'Original question', timestamp: Date.now() });
  const sourceId = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Original answer' }], stopReason: 'stop', timestamp: Date.now() } as unknown as Parameters<SessionManager['appendMessage']>[0]);
  if (child) manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: childScope });
  const file = manager.getSessionFile()!;
  const store = new SessionManifestStore({ dbPath: path.join(root, 'manifest.db') });
  stores.push(store);
  const manifest = store.createForPath({ sessionPath: file, ownerAgentId: 'hana', domain: 'home' });
  const sessionId = manifest.sessionId;
  const state = { loseAcknowledgement: true, unavailable: false };
  const engine = {
    getSessionManifest: () => manifest, getSessionIdForPath: () => sessionId,
    ensureSessionLoaded: async () => ({ sessionManager: manager, model: { id: 'fixture' }, refreshContext: () => {} }),
    isSessionStreaming: () => false,
    getSessionDialogueVariantStreamFn: () => async () => ({ result: async () => ({ content: [{ type: 'text', text: 'Alternative answer' }], stopReason: 'stop' }) }),
    setSessionBranchHead: (_file: string, head: { leafId: string | null; reason: string }) => {
      if (state.unavailable) throw new Error('head store unavailable');
      persistExplicitSessionBranchHead({ store, sessionId, sessionManager: manager, ...head });
      if (state.loseAcknowledgement) { state.unavailable = true; throw new Error('head acknowledgement lost'); }
    },
  };
  const retry = () => retrySessionTurn(engine, { sessionId, target: { role: 'user', entryId: inputId }, replacementText: 'Replacement question' }, {
    invalidateDerivedState: () => {},
    submit: async (_engine, input) => {
      input.beforeInputSideEffects();
      manager.appendMessage({ role: 'user', content: input.text, timestamp: Date.now() });
      return {};
    },
  });
  await expect(retry()).rejects.toThrow('head acknowledgement lost');
  state.loseAcknowledgement = false;
  state.unavailable = false;
  const recoveryEntries = manager.getEntries().filter(entry => entry.type === 'custom'
    && [SESSION_BRANCH_RESET_RECORD_TYPE, SESSION_RETRY_TRANSACTION_RECORD_TYPE].includes(entry.customType));
  const recoverySnapshot = JSON.stringify(recoveryEntries);
  const cold = () => {
    const projection = readCurrentSessionBranch(file, { branchHead: store.getBranchHead(sessionId) });
    const reopened = SessionManager.open(file, path.dirname(file));
    reopened.branch(projection.selectedLeafId!);
    return { projection, reopened };
  };
  const checkFork = () => {
    const { projection, reopened } = cold();
    const childFile = reopened.createBranchedSession(reopened.getLeafId()!)!;
    flushSessionManagerSnapshot(reopened);
    const childProjection = readCurrentSessionBranch(childFile, { branchHead: { sessionId: 'independent-child', leafId: reopened.getLeafId(), observedTailLeafId: reopened.getEntries().at(-1)!.id } });
    expect(childProjection.messages.map(message => message.content)).toEqual(projection.messages.map(message => message.content));
    if (child) expect(memoryScopeFromBranch(reopened.getBranch(), 'hana')).toEqual(childScope);
  };
  const generate = () => generateSessionDialogueVariant(engine, { sessionId, target: { role: 'assistant', entryId: sourceId } });
  return { manager, state, engine, sessionId, generate, retry, cold, checkFork, recoveryEntries, recoverySnapshot };
}

describe('retry rollback and expression variant composition', () => {
  it.each([
    { child: false, outcome: 'success' }, { child: true, outcome: 'success' },
    { child: false, outcome: 'head-after' }, { child: true, outcome: 'head-after' },
    { child: false, outcome: 'invalidation' }, { child: true, outcome: 'invalidation' },
    { child: false, outcome: 'interrupted-final' }, { child: true, outcome: 'interrupted-final' },
  ])('keeps cold retry/variant/fork history readable ($child, $outcome)', async ({ child, outcome }) => {
    const f = await fixture(child);
    const { candidate } = await f.generate();
    if (outcome === 'head-after' || outcome === 'interrupted-final') f.state.loseAcknowledgement = true;
    let compensationStarted = false;
    const append = f.manager.appendCustomEntry.bind(f.manager);
    const spy = outcome === 'interrupted-final' ? vi.spyOn(f.manager, 'appendCustomEntry').mockImplementation((type, data) => {
      if (compensationStarted && type === DIALOGUE_VARIANT_RECORD_TYPE) throw new Error('final compensation interrupted');
      const id = append(type, data);
      if (type === DIALOGUE_VARIANT_ROLLBACK_RECORD_TYPE) compensationStarted = true;
      return id;
    }) : null;
    const adoption = adoptSessionDialogueVariant(f.engine, { sessionId: f.sessionId, candidateId: candidate.candidateId }, {
      invalidateDerivedState: () => {
        if (outcome === 'invalidation') { f.state.unavailable = true; throw new Error('invalidation failed'); }
      },
    });
    if (outcome === 'success') expect((await adoption).candidate.status).toBe('adopted');
    else await expect(adoption).rejects.toThrow(outcome === 'invalidation' ? 'invalidation failed'
      : outcome === 'interrupted-final' ? 'requires recovery' : 'head acknowledgement lost');
    spy?.mockRestore();

    const cold = f.cold();
    expect(JSON.stringify(cold.projection.messages)).toContain(outcome === 'success' ? 'Alternative answer' : 'Original answer');
    if (child) expect(memoryScopeFromBranch(cold.reopened.getBranch(), 'hana')).toEqual(childScope);
    expect(JSON.stringify(f.recoveryEntries)).toBe(f.recoverySnapshot);
    const allRecoveryEntries = f.manager.getEntries().filter(entry => entry.type === 'custom'
      && [SESSION_BRANCH_RESET_RECORD_TYPE, SESSION_RETRY_TRANSACTION_RECORD_TYPE].includes(entry.customType));
    expect(allRecoveryEntries).toEqual(f.recoveryEntries);
    f.checkFork();

    f.state.loseAcknowledgement = false;
    f.state.unavailable = false;
    await f.retry();
    expect(JSON.stringify(f.cold().projection.messages)).toContain('Replacement question');
    expect(JSON.stringify(f.cold().projection.messages)).not.toContain('Original answer');
    f.checkFork();
  });

  it('copies scope contents while detaching a fork-inherited retry association', async () => {
    const f = await fixture(true);
    // A branch-only fork may retain a scope record but exclude its off-branch
    // transaction. Its scope remains meaningful; the old transaction edge does not.
    const data = { memoryScope: childScope, retryTransactionId: 'excluded-parent-transaction', timestamp: 123 };
    const scopeId = f.manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, data);
    const { candidate } = await f.generate();
    await adoptSessionDialogueVariant(f.engine, { sessionId: f.sessionId, candidateId: candidate.candidateId }, { invalidateDerivedState: () => {} });
    const scopes = f.manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === SESSION_MEMORY_SCOPE_RECORD);
    expect(scopes.at(-1)).toMatchObject({ data: { memoryScope: childScope, timestamp: 123 } });
    expect((scopes.at(-1) as { data: Record<string, unknown> }).data).not.toHaveProperty('retryTransactionId');
    expect(f.manager.getEntry(scopeId)).toMatchObject({ data });
    expect(memoryScopeFromBranch(f.cold().reopened.getBranch(), 'hana')).toEqual(childScope);
    f.checkFork();
  });
});
