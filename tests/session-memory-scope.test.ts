import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCoordinator } from '../core/session-coordinator.ts';
import { SessionManager } from '../lib/pi-sdk/index.ts';
import { flushSessionManagerSnapshot } from '../core/session-jsonl-file.ts';
import { memoryScopeFromBranch } from '../core/session-memory-scope.ts';
import { seedXingyeSessionGreeting } from '../core/xingye-session-greeting.ts';
import { readCurrentSessionBranch } from '../lib/session-jsonl.ts';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
const story = { version: 1, agentId: 'hana', realm: 'story', worldId: 'w1', branchId: 'b1', knowledge: 'character', characterId: 'alice', viewpoint: 'character' };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-session-scope-')); roots.push(root);
  const agentsDir = path.join(root, 'agents');
  const sessionsDir = path.join(agentsDir, 'hana', 'sessions'); fs.mkdirSync(sessionsDir, { recursive: true });
  const manager = SessionManager.create(root, sessionsDir);
  flushSessionManagerSnapshot(manager);
  const sessionPath = manager.getSessionFile()!;
  const session = { sessionManager: manager, isStreaming: false };
  const coordinator = new SessionCoordinator({ agentsDir, agentIdFromSessionPath: () => 'hana', isAgentDeleted: () => false });
  coordinator.sessions.set(sessionPath, { agentId: 'hana', session });
  vi.spyOn(coordinator, 'ensureSessionLoaded').mockResolvedValue(session);
  vi.spyOn(coordinator, 'setSessionBranchHead').mockImplementation(() => ({}));
  return { coordinator, manager, sessionPath, sessionsDir, session };
}

describe('trusted session memory scope', () => {
  it('persists explicit scope on an empty session and restores identical viewer identity', async () => {
    const { coordinator, sessionPath, sessionsDir } = fixture();
    expect(coordinator.getSessionMemoryScope(sessionPath).realm).toBe('legacy');
    await coordinator.setSessionMemoryScope(sessionPath, story);
    expect(memoryScopeFromBranch(SessionManager.open(sessionPath, sessionsDir).getBranch(), 'hana')).toEqual(story);
  });
  it('rejects reclassification of populated history and agent substitution without changing the branch', async () => {
    const { coordinator, manager, sessionPath } = fixture();
    await coordinator.setSessionMemoryScope(sessionPath, story);
    manager.appendMessage({ role: 'user', content: 'Private A', timestamp: Date.now() });
    const leaf = manager.getLeafId();
    await expect(coordinator.setSessionMemoryScope(sessionPath, { ...story, characterId: 'bob' })).rejects.toThrow('已有对话');
    await expect(coordinator.setSessionMemoryScope(sessionPath, { ...story, agentId: 'other' })).rejects.toThrow('different agent');
    expect(manager.getLeafId()).toBe(leaf);
    expect(coordinator.getSessionMemoryScope(sessionPath)).toEqual(story);
  });
  it('rolls back a failed durable scope commit and blocks a streaming session', async () => {
    const { coordinator, manager, sessionPath, sessionsDir, session } = fixture();
    vi.mocked(coordinator.setSessionBranchHead).mockImplementation(() => { throw new Error('disk full'); });
    await expect(coordinator.setSessionMemoryScope(sessionPath, story)).rejects.toThrow('disk full');
    expect(memoryScopeFromBranch(manager.getBranch(), 'hana').realm).toBe('legacy');
    expect(memoryScopeFromBranch(SessionManager.open(sessionPath, sessionsDir).getBranch(), 'hana').realm).toBe('legacy');
    session.isStreaming = true;
    await expect(coordinator.setSessionMemoryScope(sessionPath, story)).rejects.toThrow('session_busy');
  });
  it('does not reclassify custom-input history or an authored assistant greeting as empty', async () => {
    const custom = fixture();
    custom.manager.appendCustomMessageEntry('task-result', 'A real task already completed', true);
    await expect(custom.coordinator.setSessionMemoryScope(custom.sessionPath, story)).rejects.toThrow('已有对话');
    const greeting = fixture();
    seedXingyeSessionGreeting({ ...greeting.session, agent: { state: { messages: [] } } },
      { agentId: 'hana', text: 'An authored greeting in the old world' }, 'hana');
    await expect(greeting.coordinator.setSessionMemoryScope(greeting.sessionPath, story)).rejects.toThrow('不含开场白');
  });
  it('restores the prior scope on cold recovery even if the failed head commit already persisted', async () => {
    const { coordinator, manager, sessionPath, sessionsDir } = fixture();
    let persistedLeaf: string | null = null;
    vi.mocked(coordinator.setSessionBranchHead).mockImplementation((_path, state) => {
      if (state.reason === 'memory_scope') persistedLeaf = state.leafId;
      throw new Error('head store acknowledgement lost');
    });
    await expect(coordinator.setSessionMemoryScope(sessionPath, story)).rejects.toThrow('acknowledgement lost');
    expect(persistedLeaf).not.toBeNull();
    const projection = readCurrentSessionBranch(sessionPath, { branchHead: { leafId: persistedLeaf, observedTailLeafId: persistedLeaf } });
    expect(projection.headResolution).toBe('append_recovery');
    const cold = SessionManager.open(sessionPath, sessionsDir);
    cold.branch(projection.selectedLeafId!);
    expect(memoryScopeFromBranch(cold.getBranch(), 'hana').realm).toBe('legacy');
    expect(memoryScopeFromBranch(manager.getBranch(), 'hana').realm).toBe('legacy');
  });
});
