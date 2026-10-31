import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../lib/pi-sdk/index.ts';
import { retrySessionTurn, SESSION_BRANCH_RESET_RECORD_TYPE } from '../core/session-turn-actions.ts';
import { SESSION_MEMORY_SCOPE_RECORD } from '../core/session-memory-scope.ts';
import { SessionManifestStore } from '../core/session-manifest/store.ts';
import { persistExplicitSessionBranchHead, readManifestSessionBranch } from '../core/session-branch-head.ts';
import { createMemoryTicker } from '../lib/memory/memory-ticker.ts';
import { SessionSummaryManager } from '../lib/memory/session-summary.ts';
import { FactStore } from '../lib/memory/fact-store.ts';
import { ScopedDerivationStore } from '../lib/memory/scoped-derivation-store.ts';
import { readPinnedMemoryForContext, writePinnedMemoryItems } from '../lib/memory/pinned-memory-store.ts';
import { normalizeMemoryScope } from '../shared/memory-scope.ts';

const cleanups: Array<() => Promise<void>> = [];
type AssistantFixture = Extract<Parameters<SessionManager['appendMessage']>[0], { role: 'assistant' }>;
function assistantMessage(text: string): AssistantFixture {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'fixture', model: 'fixture',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}
beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('network forbidden in retry fixtures'); }));
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(realm: 'legacy' | 'story' = 'story') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-retry-pins-'));
  const agentId = 'synthetic-agent', agentDir = path.join(root, agentId), memoryDir = path.join(agentDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const memoryScope = normalizeMemoryScope({ realm, ...(realm === 'story' ? { worldId: 'world', branchId: 'main' } : {}) }, agentId);
  const manager = SessionManager.create(root, path.join(agentDir, 'sessions'));
  if (realm === 'story') manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope });
  const retainedId = manager.appendMessage({ role: 'user', content: 'RETAINED QUESTION', timestamp: Date.now() });
  manager.appendMessage(assistantMessage('RETAINED ANSWER'));
  const inputId = manager.appendMessage({ role: 'user', content: 'RETRIED QUESTION', timestamp: Date.now() });
  manager.appendMessage(assistantMessage('OLD ANSWER'));
  const sessionPath = manager.getSessionFile()!;
  const manifestStore = new SessionManifestStore({ dbPath: path.join(root, 'manifest.db') });
  const manifest = manifestStore.createForPath({ sessionPath, ownerAgentId: agentId, domain: 'home' });
  const sessionId = manifest.sessionId;
  const session = { sessionManager: manager };
  const persistHead = (head) => persistExplicitSessionBranchHead({ store: manifestStore, sessionId, sessionManager: session.sessionManager, ...head });
  persistHead({ leafId: manager.getLeafId(), reason: 'fixture' });
  const projection = () => readManifestSessionBranch({ store: manifestStore, sessionId, sessionPath });
  const summaryManager = new SessionSummaryManager(path.join(memoryDir, 'summaries'), { agentId });
  const factStore = new FactStore(path.join(memoryDir, 'facts.db'), { agentId });
  const model = vi.fn(() => { throw new Error('model forbidden in retry fixtures'); });
  const state = { accepted: 0, memoryOn: false };
  const ticker = createMemoryTicker({ agentId, agentDir, memoryDir, summaryManager, factStore,
    sessionDir: path.dirname(sessionPath), getSessionIdForPath: () => sessionId,
    getSessionMemoryScope: () => memoryScope, readSessionBranchForPath: projection,
    getMemoryMasterEnabled: () => state.memoryOn, getResolvedMemoryModel: model,
    memoryMdPath: path.join(memoryDir, 'memory.md'), todayMdPath: path.join(memoryDir, 'today.md'),
    weekMdPath: path.join(memoryDir, 'week.md'), longtermMdPath: path.join(memoryDir, 'longterm.md'), factsMdPath: path.join(memoryDir, 'facts.md'),
  });
  const sources = ticker.scopedDerivationStore;
  const originalProjection = projection();
  const aggregate = realm === 'story' ? sources.syncSessionSourceSnapshot(sessionId, memoryScope, originalProjection.messages) : null;
  summaryManager.saveSummary(sessionId, { session_id: sessionId, summary: 'TRUSTED_OLD_SUMMARY', messageCount: 4,
    ...(aggregate ? { memoryScope, sourceDependencies: [aggregate] } : {}), snapshot: '' });
  summaryManager.markProcessed(sessionId);
  if (aggregate) sources.commitArtifact({ kind: 'longterm', slot: 'fixture', memoryScope, body: 'TRUSTED_OLD_SUMMARY', dependencies: [aggregate] });
  for (const [entryId, fact] of [[retainedId, 'RETAINED_FACT'], [inputId, 'RETRIED_FACT']]) {
    factStore.add({ fact, tags: ['fixture'], session_id: sessionId, memoryScope,
      ...(aggregate ? { sourceDependencies: [sources.getSourceDependency(sessionId, entryId)] } : {}) });
  }
  summaryManager.saveSummary('unrelated', { session_id: 'unrelated', summary: 'OTHER_SUMMARY' });
  factStore.add({ fact: 'OTHER_FACT', tags: ['unrelated'], session_id: 'unrelated' });
  const provenance = (entryId) => aggregate ? [sources.getSourceDependency(sessionId, entryId)] : [{ sessionId }];
  writePinnedMemoryItems(agentDir, [
    { id: 'legacy', content: 'LEGACY_MANUAL', origin: 'manual' },
    { id: 'manual', content: 'MANUAL_PIN', memoryScope, origin: 'manual' },
    { id: 'retained', content: 'RETAINED_PIN', memoryScope, origin: 'derived', sourceStatus: 'active', sourceDependencies: provenance(retainedId) },
    { id: 'retried', content: 'RETRIED_PIN', memoryScope, origin: 'derived', sourceStatus: 'active', sourceDependencies: provenance(inputId) },
    { id: 'reality', content: 'REALITY_PIN', memoryScope: { realm: 'reality' }, origin: 'derived', sourceStatus: 'active', sourceDependencies: provenance(inputId) },
    { id: 'other', content: 'OTHER_PIN', memoryScope, origin: 'derived', sourceStatus: 'active', sourceDependencies: [{ sessionId: 'unrelated' }] },
  ]);
  const files = { markdown: path.join(agentDir, 'pinned.md'), json: path.join(agentDir, 'pinned-memory.json'), summary: summaryManager._filePath(sessionId) };
  const pinBytes = () => [fs.readFileSync(files.markdown), fs.readFileSync(files.json)];
  const beforePins = pinBytes(), originalMessages = manager.buildSessionContext().messages;
  const engine = {
    getSessionManifest: () => manifest, getSessionIdForPath: () => sessionId,
    getSessionByPath: () => session, ensureSessionLoaded: async () => session, isSessionStreaming: () => false,
    resolveSessionOwnership: () => ({ agentId }), getAgent: () => ({ memoryTicker: ticker, summaryManager, factStore }),
    setSessionBranchHead: vi.fn((_file, head) => persistHead(head)), emitEvent: vi.fn(),
  };
  type RetrySubmit = (_engine: typeof engine, input: { beforeInputSideEffects: () => void }) => Promise<unknown>;
  const retry = (submit?: RetrySubmit) => retrySessionTurn(engine, { sessionId, target: { role: 'user', entryId: inputId } }, {
    submit: submit || (async (_engine, input) => {
      input.beforeInputSideEffects();
      state.accepted++;
      session.sessionManager.appendMessage({ role: 'user', content: 'REPLACEMENT QUESTION', timestamp: Date.now() });
      return {};
    }),
  });
  const coldSession = () => {
    const current = projection();
    const reopened = SessionManager.open(sessionPath, path.dirname(sessionPath));
    if (current.selectedLeafId) reopened.branch(current.selectedLeafId); else reopened.resetLeaf();
    return reopened;
  };
  const assertRestored = () => {
    expect(state.accepted).toBe(0);
    expect(engine.emitEvent).not.toHaveBeenCalled();
    expect(session.sessionManager.buildSessionContext().messages).toEqual(originalMessages);
    expect(coldSession().buildSessionContext().messages).toEqual(originalMessages);
    expect(summaryManager.getSummary(sessionId)?.summary).toBe('TRUSTED_OLD_SUMMARY');
    expect(pinBytes()).toEqual(beforePins);
    const reopenedSources = new ScopedDerivationStore(memoryDir, { agentId });
    const reopenedSummary = new SessionSummaryManager(summaryManager.summariesDir, { agentId, scopedDerivationStore: reopenedSources });
    const reopenedFacts = new FactStore(path.join(memoryDir, 'facts.db'), { agentId });
    try {
      expect(reopenedSummary.getSummary(sessionId)?.summary).toBe('TRUSTED_OLD_SUMMARY');
      expect(reopenedFacts.searchByTags(['fixture'], null, 20, null, memoryScope).map(fact => fact.fact).sort()).toEqual(['RETAINED_FACT', 'RETRIED_FACT']);
      expect(reopenedSummary.getSummary('unrelated')?.summary).toBe('OTHER_SUMMARY');
      expect(reopenedFacts.searchByTags(['unrelated'], null)).toHaveLength(1);
      if (realm === 'story') {
        expect(reopenedSources.areDependenciesCurrent(reopenedSummary.getSummary(sessionId).sourceDependencies, memoryScope)).toBe(true);
        // The next real prompt-source refresh must keep facts supported by the restored transcript.
        reopenedSources.syncSessionSourceSnapshot(sessionId, memoryScope, projection().messages);
        expect(reopenedFacts.invalidateSourceEntries(sessionId, reopenedSources.getSessionDependencies(sessionId, memoryScope))).toBe(0);
        expect(reopenedSources.readCompiledContext(memoryScope)).toContain('TRUSTED_OLD_SUMMARY');
      }
      expect(readPinnedMemoryForContext(agentDir, memoryScope)).toContain('RETRIED_PIN');
      expect(readPinnedMemoryForContext(agentDir, normalizeMemoryScope({ realm: 'reality' }, agentId))).toContain('REALITY_PIN');
    } finally { reopenedFacts.close(); }
    expect(model).not.toHaveBeenCalled();
  };
  cleanups.push(async () => { await ticker.stop(); factStore.close(); manifestStore.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, agentDir, memoryDir, memoryScope, sessionId, sessionPath, session, inputId, files, sources, summaryManager,
    factStore, ticker, engine, state, model, retry, coldSession, assertRestored, pinBytes, beforePins, originalMessages };
}

function failWrite(file: string, { afterRename = false, persistent = false } = {}) {
  let failures = 0;
  const rename = fs.renameSync, write = fs.writeFileSync;
  const shouldFail = (source: fs.PathLike | number) => String(source) === `${file}.tmp` && (persistent || failures === 0);
  const fail = () => { throw Object.assign(new Error('SYNTHETIC_PIN_WRITE_EIO'), { code: 'EIO' }); };
  const spy = afterRename
    ? vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (shouldFail(source)) { failures++; rename(source, destination); fail(); }
      return rename(source, destination);
    })
    : vi.spyOn(fs, 'writeFileSync').mockImplementation((source, ...args) => {
      if (shouldFail(source)) { failures++; fail(); }
      return write(source, ...args);
    });
  return { spy, failures: () => failures };
}
function rejectFacts(f) {
  f.factStore.db.exec(`CREATE TRIGGER reject_fixture_facts BEFORE ${f.memoryScope.realm === 'story' ? 'UPDATE OF source_status' : 'DELETE'} ON facts BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_FACT_FAILURE'); END;`);
}

// Reopen in a new Node process before any helper can refresh the source graph.
function readFreshMemory(f: ReturnType<typeof fixture>) {
  const moduleUrl = (name: string) => pathToFileURL(path.resolve('lib/memory', name)).href;
  const code = `
    const { ScopedDerivationStore } = await import(${JSON.stringify(moduleUrl('scoped-derivation-store.ts'))});
    const { SessionSummaryManager } = await import(${JSON.stringify(moduleUrl('session-summary.ts'))});
    const { FactStore } = await import(${JSON.stringify(moduleUrl('fact-store.ts'))});
    const sources = new ScopedDerivationStore(${JSON.stringify(f.memoryDir)}, { agentId: 'synthetic-agent' });
    const summaries = new SessionSummaryManager(${JSON.stringify(f.summaryManager.summariesDir)}, { agentId: 'synthetic-agent', scopedDerivationStore: sources });
    const facts = new FactStore(${JSON.stringify(path.join(f.memoryDir, 'facts.db'))}, { agentId: 'synthetic-agent' });
    const scope = ${JSON.stringify(f.memoryScope)}, summary = summaries.getSummary(${JSON.stringify(f.sessionId)});
    console.log(JSON.stringify({ summary, current: summary && sources.areDependenciesCurrent(summary.sourceDependencies, scope),
      compiled: sources.readCompiledContext(scope), facts: facts.searchByTags(['fixture'], null, 20, null, scope).map(x => x.fact).sort() }));
    facts.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

describe('Retry source write ownership and uncertain rename completion', () => {
  it('keeps the legacy string-fingerprint rollback contract and rejects stale owners', () => {
    const f = fixture(), checkpoint = f.sources.createRollbackCheckpoint();
    const before = fs.readFileSync(f.sources.manifestPath), old = f.sources.getSourceDependency(f.sessionId);
    f.sources.restoreRollbackCheckpoint(checkpoint, checkpoint.fingerprint);
    expect(fs.readFileSync(f.sources.manifestPath)).toEqual(before);
    f.sources.invalidateSource(f.sessionId);
    const invalidated = fs.readFileSync(f.sources.manifestPath), fingerprint = f.sources.getStateFingerprint();
    expect(() => f.sources.restoreRollbackCheckpoint(checkpoint, checkpoint.fingerprint)).toThrow('refusing to overwrite');
    expect(fs.readFileSync(f.sources.manifestPath)).toEqual(invalidated);
    f.sources.restoreRollbackCheckpoint(checkpoint, fingerprint);
    const restored = new ScopedDerivationStore(f.memoryDir, { agentId: 'synthetic-agent' }).getSourceDependency(f.sessionId);
    expect(restored.generation).toBe(old.generation);
    expect(restored.writeFence).toBeGreaterThan(old.writeFence);
    expect(f.sources.commitArtifact({ kind: 'facts', slot: 'late-legacy-caller', memoryScope: f.memoryScope,
      body: 'STALE_PENDING_RESULT', dependencies: [old] })).toBeNull();
  });

  for (const step of [1, 2]) for (const phase of ['temp', 'rename-before', 'rename-after'] as const) {
    it(`restores source write ${step} at ${phase}, including fresh-process dependency fences`, async () => {
      const f = fixture(), before = fs.readFileSync(f.sources.manifestPath), old = f.sources.getSourceDependency(f.sessionId);
      const write = fs.writeFileSync, rename = fs.renameSync;
      const failure = Object.assign(new Error(`SOURCE_${step}_${phase}`), { code: 'EIO' });
      let calls = 0, failed = false;
      const shouldFail = (file: fs.PathLike | number) => String(file) === `${f.sources.manifestPath}.tmp` && ++calls === step;
      const spy = phase === 'temp'
        ? vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
          if (shouldFail(file)) { failed = true; throw failure; }
          return write(file, ...args);
        })
        : vi.spyOn(fs, 'renameSync').mockImplementation((file, destination) => {
          if (shouldFail(file)) {
            failed = true;
            if (phase === 'rename-after') rename(file, destination);
            throw failure;
          }
          return rename(file, destination);
        });
      await expect(f.retry()).rejects.toBe(failure);
      spy.mockRestore();
      expect(failed).toBe(true);
      const fresh = readFreshMemory(f);
      expect(fresh.summary.summary).toBe('TRUSTED_OLD_SUMMARY');
      expect(fresh.current).toBe(true);
      expect(fresh.compiled).toContain('TRUSTED_OLD_SUMMARY');
      expect(fresh.facts).toEqual(['RETAINED_FACT', 'RETRIED_FACT']);
      expect(JSON.parse(fs.readFileSync(f.sources.manifestPath, 'utf8')).version).toBe(1);
      const current = f.sources.getSourceDependency(f.sessionId);
      expect(current.generation).toBe(old.generation);
      if (step === 1 && phase !== 'rename-after') {
        expect(fs.readFileSync(f.sources.manifestPath)).toEqual(before);
        expect(current).toEqual(old);
      } else {
        expect(current.writeFence).toBeGreaterThan(old.writeFence);
        expect(f.sources.commitArtifact({ kind: 'facts', slot: 'late-source', memoryScope: f.memoryScope,
          body: 'STALE_PENDING_RESULT', dependencies: [old] })).toBeNull();
      }
      f.assertRestored();
    });
  }

  for (const step of [1, 2]) for (const afterRename of [false, true]) for (const separateStore of [false, true]) {
    it(`preserves concurrent graph at source write ${step}, after=${afterRename}, separate=${separateStore}`, async () => {
      const f = fixture(), rename = fs.renameSync;
      const writer = separateStore ? new ScopedDerivationStore(f.memoryDir, { agentId: 'synthetic-agent' }) : f.sources;
      let calls = 0, concurrentBytes: Buffer;
      const failure = new Error('SOURCE_FAILURE_AFTER_CONCURRENT_WRITE');
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
        if (String(dst) === f.sources.manifestPath && ++calls === step) {
          if (afterRename) rename(src, dst);
          writer.registerSource({ sessionId: 'third-party', memoryScope: f.memoryScope, revision: 'AUTHORITATIVE_NEW_SOURCE' });
          concurrentBytes = fs.readFileSync(f.sources.manifestPath);
          throw failure;
        }
        return rename(src, dst);
      });
      await expect(f.retry()).rejects.toMatchObject({ code: 'session_memory_rollback_failed', cause: failure,
        message: expect.stringContaining('refusing to overwrite newer provenance') });
      spy.mockRestore();
      expect(fs.readFileSync(f.sources.manifestPath)).toEqual(concurrentBytes!);
      expect(new ScopedDerivationStore(f.memoryDir, { agentId: 'synthetic-agent' }).getSourceDependency('third-party')?.revision).toBe('AUTHORITATIVE_NEW_SOURCE');
      expect(f.pinBytes()).toEqual(f.beforePins);
      expect(f.factStore.searchByTags(['fixture'], null, 20, null, f.memoryScope)).toHaveLength(2);
      expect(f.coldSession().buildSessionContext().messages).toEqual(f.originalMessages);
      expect(f.state.accepted).toBe(0);
    });
  }

  it.each([false, true])('does not adopt a concurrent version between the two source writes (separate=%s)', async separateStore => {
    const f = fixture(), invalidate = f.summaryManager.invalidateSession.bind(f.summaryManager);
    const writer = separateStore ? new ScopedDerivationStore(f.memoryDir, { agentId: 'synthetic-agent' }) : f.sources;
    let concurrentBytes: Buffer;
    vi.spyOn(f.summaryManager, 'invalidateSession').mockImplementation((...args) => {
      const result = invalidate(...args);
      writer.registerSource({ sessionId: 'third-party', memoryScope: f.memoryScope, revision: 'BETWEEN_SOURCE_WRITES' });
      concurrentBytes = fs.readFileSync(f.sources.manifestPath);
      return result;
    });
    await expect(f.retry()).rejects.toMatchObject({ code: 'session_memory_rollback_failed',
      cause: expect.objectContaining({ code: 'scoped_memory_rollback_conflict' }) });
    expect(fs.readFileSync(f.sources.manifestPath)).toEqual(concurrentBytes!);
    expect(f.pinBytes()).toEqual(f.beforePins);
    expect(f.state.accepted).toBe(0);
  });

  for (const step of [1, 2]) for (const afterRestoreRename of [false, true]) {
    it(`reports failed compensation after source ${step}, restore renamed=${afterRestoreRename}`, async () => {
      const f = fixture(), rename = fs.renameSync;
      let calls = 0, lastBytes: Buffer;
      const originalFailure = new Error('ORIGINAL_SOURCE_EIO');
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
        if (String(dst) === f.sources.manifestPath) {
          calls++;
          if (calls === step) { rename(src, dst); throw originalFailure; }
          if (calls === step + 1) {
            if (afterRestoreRename) rename(src, dst);
            lastBytes = fs.readFileSync(f.sources.manifestPath);
            throw new Error('SOURCE_RESTORE_EIO');
          }
        }
        return rename(src, dst);
      });
      await expect(f.retry()).rejects.toMatchObject({ code: 'session_memory_rollback_failed', cause: originalFailure,
        message: expect.stringContaining('SOURCE_RESTORE_EIO') });
      spy.mockRestore();
      expect(calls).toBe(step + 1);
      expect(fs.readFileSync(f.sources.manifestPath)).toEqual(lastBytes!);
      expect(readFreshMemory(f).facts).toEqual(['RETAINED_FACT', 'RETRIED_FACT']);
      expect(f.pinBytes()).toEqual(f.beforePins);
      expect(f.coldSession().buildSessionContext().messages).toEqual(f.originalMessages);
      expect(f.state.accepted).toBe(0);
    });
  }

  it.each([1, 2])('reports unreadable rollback ownership after source write %s without blind overwrite', async step => {
    const f = fixture(), rename = fs.renameSync, read = fs.readFileSync;
    let calls = 0, blockRead = false, readFailures = 0, committedBytes: Buffer;
    const failure = new Error('ORIGINAL_SOURCE_EIO');
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
      if (String(dst) === f.sources.manifestPath && ++calls === step) {
        rename(src, dst); committedBytes = read(f.sources.manifestPath); blockRead = true; throw failure;
      }
      return rename(src, dst);
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (blockRead && String(file) === f.sources.manifestPath) { readFailures++; throw new Error('SOURCE_REREAD_EIO'); }
      return read(file, ...args);
    });
    await expect(f.retry()).rejects.toMatchObject({ code: 'session_memory_rollback_failed', cause: failure,
      message: expect.stringContaining('SOURCE_REREAD_EIO') });
    readSpy.mockRestore(); renameSpy.mockRestore();
    expect(readFailures).toBe(1);
    expect(fs.readFileSync(f.sources.manifestPath)).toEqual(committedBytes!);
    expect(f.pinBytes()).toEqual(f.beforePins);
    expect(f.state.accepted).toBe(0);
  });

  it.each([1, 2])('restores old v1 records with absent writeFence after source write %s', async step => {
    const f = fixture();
    for (const file of [f.sources.manifestPath, f.files.summary]) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify(data, (key, value) => key === 'writeFence' ? undefined : value));
    }
    f.summaryManager._cache.clear();
    const old = f.sources.getSourceDependency(f.sessionId), rename = fs.renameSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
      if (String(dst) === f.sources.manifestPath && ++calls === step) { rename(src, dst); throw new Error('OLD_RECORD_SOURCE_EIO'); }
      return rename(src, dst);
    });
    await expect(f.retry()).rejects.toThrow('OLD_RECORD_SOURCE_EIO');
    spy.mockRestore();
    expect(readFreshMemory(f).current).toBe(true);
    expect(f.sources.getSourceDependency(f.sessionId).writeFence).toBeGreaterThan(old.writeFence);
    f.assertRestored();
  });

  it('survives repeated source failures, cold session reopen, then a committed retry', async () => {
    const f = fixture();
    for (const step of [1, 2, 1, 2]) {
      const rename = fs.renameSync;
      let calls = 0;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
        if (String(dst) === f.sources.manifestPath && ++calls === step) { rename(src, dst); throw new Error('REPEATED_SOURCE_EIO'); }
        return rename(src, dst);
      });
      await expect(f.retry()).rejects.toThrow('REPEATED_SOURCE_EIO');
      spy.mockRestore();
      expect(readFreshMemory(f).current).toBe(true);
      f.assertRestored();
      f.session.sessionManager = f.coldSession();
    }
    await f.retry();
    expect(f.state.accepted).toBe(1);
    const fresh = readFreshMemory(f);
    expect(fresh.summary).toBeNull();
    expect(fresh.facts).toEqual(['RETAINED_FACT']);
  });
});

describe('Retry memory/pin compensation with real ticker, JSONL and SQLite', () => {
  it.each(['legacy', 'story'] as const)('leaves all memory untouched when %s pin preparation cannot read JSON', async realm => {
    const f = fixture(realm), originalRead = fs.readFileSync;
    const invalidate = vi.spyOn(f.summaryManager, 'invalidateSession');
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (String(file) === f.files.json) throw Object.assign(new Error('SYNTHETIC_PIN_READ_EIO'), { code: 'EIO' });
      return originalRead(file, ...args);
    });
    await expect(f.retry()).rejects.toThrow('SYNTHETIC_PIN_READ_EIO');
    expect(invalidate).not.toHaveBeenCalled();
    spy.mockRestore();
    f.assertRestored();
  });

  it.each(['legacy', 'story'] as const)('compensates %s pin writes at each two-file boundary', async realm => {
    // Repeated attempts in the same session also exercise restored source fences.
    const f = fixture(realm);
    for (const file of [f.files.markdown, f.files.json]) {
      for (const afterRename of [false, true]) {
        const fault = failWrite(file, { afterRename });
        await expect(f.retry()).rejects.toThrow('SYNTHETIC_PIN_WRITE_EIO');
        fault.spy.mockRestore();
        expect(fault.failures()).toBe(1);
        f.assertRestored();
        f.session.sessionManager = f.coldSession();
      }
    }
    await f.retry();
    expect(f.state.accepted).toBe(1);
    expect(f.summaryManager.getSummary(f.sessionId)).toBeNull();
  });

  it('rejects malformed pin JSON before any derived-memory mutation', async () => {
    const f = fixture();
    fs.writeFileSync(f.files.json, '{invalid');
    const invalidate = vi.spyOn(f.summaryManager, 'invalidateSession');
    await expect(f.retry()).rejects.toThrow(SyntaxError);
    expect(invalidate).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.files.json, 'utf8')).toBe('{invalid');
    expect(f.summaryManager.getSummary(f.sessionId)?.summary).toBe('TRUSTED_OLD_SUMMARY');
    expect(f.factStore.searchByTags(['fixture'], null, 20, null, f.memoryScope)).toHaveLength(2);
  });

  it('keeps partially written temporary pin bytes out of the authoritative state', async () => {
    const f = fixture(), write = fs.writeFileSync;
    let failed = false;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file) === `${f.files.json}.tmp` && !failed) {
        failed = true;
        write(file, '{partial');
        throw new Error('PARTIAL_TEMP_WRITE');
      }
      return write(file, ...args);
    });
    await expect(f.retry()).rejects.toThrow('PARTIAL_TEMP_WRITE');
    spy.mockRestore();
    f.assertRestored();
  });

  it('restores the previous source graph if retained-source synchronization fails', async () => {
    const f = fixture();
    const sync = vi.spyOn(f.sources, 'syncSessionSourceSnapshot').mockImplementationOnce(() => { throw new Error('SOURCE_SYNC_FAILED'); });
    await expect(f.retry()).rejects.toThrow('SOURCE_SYNC_FAILED');
    sync.mockRestore();
    f.assertRestored();
  });

  it.each([false, true])('keeps the ticker pending count on failure and clears it on success (%s)', async success => {
    const f = fixture();
    f.ticker.notifyTurn(f.sessionPath);
    if (success) await f.retry();
    else {
      const fault = failWrite(f.files.json);
      await expect(f.retry()).rejects.toThrow('SYNTHETIC_PIN_WRITE_EIO');
      fault.spy.mockRestore();
    }
    f.state.memoryOn = true;
    // The model resolver throws locally, before any provider invocation.
    await f.ticker.notifySessionEnd(f.sessionPath);
    expect(f.model).toHaveBeenCalledTimes(success ? 0 : 1);
  });

  it('does not attempt a redundant restore write after a persistent first-write failure', async () => {
    const f = fixture(), fault = failWrite(f.files.markdown, { persistent: true });
    await expect(f.retry()).rejects.toMatchObject({ code: 'EIO' });
    expect(fault.failures()).toBe(1);
    fault.spy.mockRestore();
    f.assertRestored();
  });

  it.each(['legacy', 'story'] as const)('restores pins after the final %s fact transaction aborts', async realm => {
    const f = fixture(realm), beforeToken = f.sources.getSourceDependency(f.sessionId);
    const invalidate = f.factStore.invalidateSourceEntries.bind(f.factStore), deleteBySession = f.factStore.deleteBySession.bind(f.factStore);
    let pinStateAtCommit;
    const factSpy = realm === 'story'
      ? vi.spyOn(f.factStore, 'invalidateSourceEntries').mockImplementation((...args) => {
        pinStateAtCommit = JSON.parse(fs.readFileSync(f.files.json, 'utf8')).items.find(pin => pin.id === 'retried').sourceStatus;
        return invalidate(...args);
      })
      : vi.spyOn(f.factStore, 'deleteBySession').mockImplementation((...args) => deleteBySession(...args));
    rejectFacts(f);
    await expect(f.retry()).rejects.toThrow('SYNTHETIC_FACT_FAILURE');
    expect(factSpy).toHaveBeenCalledTimes(1);
    if (realm === 'story') expect(pinStateAtCommit).toBe('stale');
    f.factStore.db.exec('DROP TRIGGER reject_fixture_facts');
    f.assertRestored();
    if (beforeToken) {
      expect(f.sources.getSourceDependency(f.sessionId).writeFence).toBeGreaterThan(beforeToken.writeFence);
      expect(f.sources.commitArtifact({ kind: 'facts', slot: 'late', memoryScope: f.memoryScope, body: 'STALE_RESULT', dependencies: [beforeToken] })).toBeNull();
    }
  });

  it.each([false, true])('restores memory when summary removal fails (after removal: %s)', async afterRemoval => {
    const f = fixture(), unlink = fs.unlinkSync;
    let failed = false;
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (String(file) === f.files.summary && !failed) {
        failed = true;
        if (afterRemoval) unlink(file);
        throw new Error('SYNTHETIC_SUMMARY_FAILURE');
      }
      return unlink(file);
    });
    await expect(f.retry()).rejects.toThrow('SYNTHETIC_SUMMARY_FAILURE');
    spy.mockRestore();
    f.assertRestored();
  });

  it('attempts pin compensation even when summary compensation itself fails', async () => {
    const f = fixture();
    rejectFacts(f);
    const save = vi.spyOn(f.summaryManager, 'saveSummary').mockImplementation(() => { throw new Error('SUMMARY_RESTORE_FAILED'); });
    await expect(f.retry()).rejects.toMatchObject({ code: 'session_memory_rollback_failed', status: 500, cause: expect.objectContaining({ message: 'SYNTHETIC_FACT_FAILURE' }) });
    expect(save).toHaveBeenCalledOnce();
    expect(f.pinBytes()).toEqual(f.beforePins);
    expect(f.summaryManager.getSummary(f.sessionId)).toBeNull();
    expect(f.coldSession().buildSessionContext().messages).toEqual(f.originalMessages);
    expect(f.state.accepted).toBe(0);
  });

  it('still restores pins when the provenance restore cannot overwrite a newer graph', async () => {
    const f = fixture();
    vi.spyOn(f.factStore, 'invalidateSourceEntries').mockImplementation(() => {
      f.sources.registerSource({ sessionId: 'concurrent', memoryScope: f.memoryScope, revision: 'new-authoritative' });
      throw new Error('SYNTHETIC_FACT_FAILURE');
    });
    await expect(f.retry()).rejects.toMatchObject({ code: 'session_memory_rollback_failed', message: expect.stringContaining('newer provenance') });
    expect(f.pinBytes()).toEqual(f.beforePins);
    expect(f.sources.getSourceDependency('concurrent').revision).toBe('new-authoritative');
    expect(f.summaryManager.getSummary(f.sessionId)).toBeNull();
    expect(f.state.accepted).toBe(0);
  });

  it('reports incomplete pin compensation without undoing successful summary/fact recovery', async () => {
    const f = fixture();
    rejectFacts(f);
    const write = fs.writeFileSync;
    let jsonWrites = 0;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file) === `${f.files.json}.tmp` && ++jsonWrites === 2) throw new Error('PIN_RESTORE_FAILED');
      return write(file, ...args);
    });
    await expect(f.retry()).rejects.toMatchObject({ code: 'session_memory_rollback_failed', message: expect.stringContaining('PIN_RESTORE_FAILED') });
    spy.mockRestore();
    expect(f.summaryManager.getSummary(f.sessionId)?.summary).toBe('TRUSTED_OLD_SUMMARY');
    expect(f.factStore.searchByTags(['fixture'], null, 20, null, f.memoryScope)).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(f.files.json, 'utf8')).items.find(pin => pin.id === 'retried').sourceStatus).toBe('stale');
    expect(f.state.accepted).toBe(0);
  });

  it('refuses to overwrite a later pin edit during compensation', async () => {
    const f = fixture();
    vi.spyOn(f.factStore, 'invalidateSourceEntries').mockImplementation(() => {
      const data = JSON.parse(fs.readFileSync(f.files.json, 'utf8'));
      data.items.find(pin => pin.id === 'manual').content = 'NEW_AUTHORITATIVE_PIN';
      fs.writeFileSync(f.files.json, JSON.stringify(data));
      throw new Error('SYNTHETIC_FACT_FAILURE');
    });
    await expect(f.retry()).rejects.toMatchObject({ code: 'session_memory_rollback_failed', message: expect.stringContaining('refusing to overwrite') });
    expect(fs.readFileSync(f.files.json, 'utf8')).toContain('NEW_AUTHORITATIVE_PIN');
    expect(f.summaryManager.getSummary(f.sessionId)?.summary).toBe('TRUSTED_OLD_SUMMARY');
  });

  it('keeps restored memory and cold history when both rollback marker and head writes fail', async () => {
    const f = fixture(), append = f.session.sessionManager.appendCustomEntry.bind(f.session.sessionManager);
    const fault = failWrite(f.files.json);
    vi.spyOn(f.session.sessionManager, 'appendCustomEntry').mockImplementation((type, data: unknown) => {
      if (type === SESSION_BRANCH_RESET_RECORD_TYPE && data !== null && typeof data === 'object' && 'rolledBack' in data && data.rolledBack) throw new Error('ROLLBACK_APPEND_FAILED');
      return append(type, data);
    });
    const persist = f.engine.setSessionBranchHead.getMockImplementation()!;
    f.engine.setSessionBranchHead.mockImplementation((file, head) => {
      if (head.reason === 'replay_rollback') throw new Error('ROLLBACK_HEAD_FAILED');
      return persist(file, head);
    });
    await expect(f.retry()).rejects.toThrow('ROLLBACK_APPEND_FAILED');
    fault.spy.mockRestore();
    f.assertRestored();
  });

  it('leaves the state untouched if submit preflight rejects before commit', async () => {
    const f = fixture();
    await expect(f.retry(async () => { throw new Error('SUBMIT_PREFLIGHT_FAILED'); })).rejects.toThrow('SUBMIT_PREFLIGHT_FAILED');
    f.assertRestored();
  });

  it('preserves Markdown authority and file permissions after partial normalization', async () => {
    const f = fixture();
    fs.writeFileSync(f.files.markdown, '- EXTERNAL_MANUAL_EDIT\n');
    const earlier = new Date(Date.now() - 10000), later = new Date(Date.now() - 5000);
    fs.utimesSync(f.files.json, earlier, earlier);
    fs.utimesSync(f.files.markdown, later, later);
    fs.chmodSync(f.files.json, 0o600); fs.chmodSync(f.files.markdown, 0o600);
    const before = f.pinBytes(), fault = failWrite(f.files.json);
    await expect(f.retry()).rejects.toThrow('SYNTHETIC_PIN_WRITE_EIO');
    fault.spy.mockRestore();
    expect(f.pinBytes()).toEqual(before);
    expect(fs.statSync(f.files.markdown).mtimeMs).toBeGreaterThan(fs.statSync(f.files.json).mtimeMs + 1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(f.files.markdown).mode & 0o777).toBe(0o600);
      expect(fs.statSync(f.files.json).mode & 0o777).toBe(0o600);
    }
    expect(readPinnedMemoryForContext(f.agentDir, normalizeMemoryScope(undefined, 'synthetic-agent'))).toContain('EXTERNAL_MANUAL_EDIT');
  });

  it('removes only newly created pin files when fact commit fails on an empty pin store', async () => {
    const f = fixture();
    fs.unlinkSync(f.files.markdown); fs.unlinkSync(f.files.json);
    rejectFacts(f);
    await expect(f.retry()).rejects.toThrow('SYNTHETIC_FACT_FAILURE');
    expect(fs.existsSync(f.files.markdown)).toBe(false);
    expect(fs.existsSync(f.files.json)).toBe(false);
    expect(f.summaryManager.getSummary(f.sessionId)?.summary).toBe('TRUSTED_OLD_SUMMARY');
  });

  it.each(['legacy', 'story'] as const)('keeps a successful %s retry committed across reload', async realm => {
    const f = fixture(realm);
    await f.retry();
    expect(f.state.accepted).toBe(1);
    expect(f.summaryManager.getSummary(f.sessionId)).toBeNull();
    expect(f.coldSession().buildSessionContext().messages).toEqual(f.session.sessionManager.buildSessionContext().messages);
    expect(f.factStore.searchByTags(['fixture'], null, 20, null, f.memoryScope).map(fact => fact.fact)).toEqual(realm === 'story' ? ['RETAINED_FACT'] : []);
    const pins = JSON.parse(fs.readFileSync(f.files.json, 'utf8')).items;
    expect(pins.find(pin => pin.id === 'retried').sourceStatus).toBe(realm === 'story' ? 'stale' : 'active');
    expect(pins.find(pin => pin.id === 'retained').sourceStatus).toBe('active');
    expect(pins.find(pin => pin.id === 'reality').sourceStatus).toBe('active');
    expect(readPinnedMemoryForContext(f.agentDir, f.memoryScope)).toContain('MANUAL_PIN');
    expect(f.model).not.toHaveBeenCalled();
  });
});
