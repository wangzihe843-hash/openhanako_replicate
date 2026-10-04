import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../lib/pi-sdk/index.ts';
import { flushSessionManagerSnapshot } from '../core/session-jsonl-file.ts';
import { memoryScopeFromBranch, SESSION_MEMORY_SCOPE_RECORD } from '../core/session-memory-scope.ts';
import { retrySessionTurn } from '../core/session-turn-actions.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const parentScope = { version: 1, agentId: 'hana', realm: 'story', worldId: 'world-one', branchId: 'parent-story', knowledge: 'character', characterId: 'alice', viewpoint: 'character' };
const childScope = { ...parentScope, branchId: 'child-story' };

describe('retry keeps a narrative child identity across inherited-history rewind', () => {
  it.each(['immediate user fork', 'later inherited edit'] as const)('%s preserves scope before projection, invalidation and dispatch, then cold restart', async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-retry-scope-')); roots.push(root);
    const sessionsDir = path.join(root, 'sessions'); fs.mkdirSync(sessionsDir);
    let manager = SessionManager.create(root, sessionsDir);
    manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: parentScope });
    const inputId = manager.appendMessage({ role: 'user', content: 'Open the door', timestamp: Date.now() });
    const assistantId = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'The door opens' }] } as unknown as Parameters<SessionManager['appendMessage']>[0]);
    const parentFile = manager.getSessionFile()!;
    const parentBytes = fs.readFileSync(parentFile, 'utf8');
    const childFile = manager.createBranchedSession(mode === 'immediate user fork' ? inputId : assistantId)!;
    manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: childScope, previousScope: parentScope });
    flushSessionManagerSnapshot(manager);
    if (mode === 'later inherited edit') {
      manager.appendMessage({ role: 'user', content: 'What is inside?', timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'A room' }] } as unknown as Parameters<SessionManager['appendMessage']>[0]);
    }
    const scope = () => memoryScopeFromBranch(manager.getBranch(), 'hana');
    const engine = {
      getSessionManifest: () => ({ ownerAgentId: 'hana', currentLocator: { path: childFile } }),
      getSessionIdForPath: () => 'sess_child', getSessionMemoryScope: scope,
      ensureSessionLoaded: async () => ({ sessionManager: manager, refreshContext: () => { expect(scope()).toEqual(childScope); } }),
      isSessionStreaming: () => false,
      setSessionBranchHead: vi.fn(() => { expect(scope()).toEqual(childScope); }),
    };
    await retrySessionTurn(engine, { sessionId: 'sess_child', target: { role: 'user', entryId: inputId }, replacementText: 'Knock instead' }, {
      invalidateDerivedState: () => { expect(scope()).toEqual(childScope); },
      submit: async (_engine, opts) => {
        opts.beforeInputSideEffects();
        expect(scope()).toEqual(childScope);
        manager.appendMessage({ role: 'user', content: opts.text, timestamp: Date.now() });
        return {};
      },
    });
    manager = SessionManager.open(childFile, sessionsDir);
    expect(scope()).toEqual(childScope);
    expect(fs.readFileSync(parentFile, 'utf8')).toBe(parentBytes);
    expect(memoryScopeFromBranch(SessionManager.open(parentFile, sessionsDir).getBranch(), 'hana')).toEqual(parentScope);
    expect(manager.getEntries().filter(entry => entry.type === 'message' && entry.id === inputId)).toHaveLength(1);
  });

  it('restores the prior child scope if retry commit fails after scope preservation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-retry-scope-rollback-')); roots.push(root);
    const manager = SessionManager.create(root, root);
    manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: parentScope });
    const inputId = manager.appendMessage({ role: 'user', content: 'Open the door', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'The door opens' }] } as unknown as Parameters<SessionManager['appendMessage']>[0]);
    manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: childScope });
    const engine = {
      getSessionManifest: () => ({ ownerAgentId: 'hana', currentLocator: { path: manager.getSessionFile()! } }),
      getSessionIdForPath: () => 'sess_child', ensureSessionLoaded: async () => ({ sessionManager: manager }),
      isSessionStreaming: () => false, setSessionBranchHead: vi.fn(),
    };
    await expect(retrySessionTurn(engine, { sessionId: 'sess_child', target: { role: 'user', entryId: inputId }, replacementText: 'Knock' }, {
      invalidateDerivedState: () => { throw new Error('fixture invalidation failed'); },
      submit: async (_engine, opts) => { opts.beforeInputSideEffects(); },
    })).rejects.toThrow('fixture invalidation failed');
    expect(memoryScopeFromBranch(manager.getBranch(), 'hana')).toEqual(childScope);
    expect(memoryScopeFromBranch(SessionManager.open(manager.getSessionFile()!, root).getBranch(), 'hana')).toEqual(childScope);
  });
});
