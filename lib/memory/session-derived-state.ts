import { preparePinnedMemoryInvalidation } from "./pinned-memory-store.ts";
import type { ScopedWriteExpectation } from "./scoped-derivation-store.ts";

function cloneMemorySnapshot(value: any) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Atomically invalidate the mutable memory derived from one Session.
 *
 * Source/summary/pin writes are reversible and precede the final atomic SQLite
 * fact transaction. A failed fact transaction leaves facts unchanged, and we
 * compensate the preceding file mutations. Scoped provenance keeps its compare-
 * and-restore fence; legacy compiled aggregates remain intentionally outside it.
 */
export function invalidateSessionDerivedStateSync(input: any = {}) {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  const summaryManager = input.summaryManager;
  const factStore = input.factStore;
  if (!sessionId) throw new Error("memory invalidation requires sessionId");
  if (typeof summaryManager?.invalidateSession !== "function") {
    throw new Error("session summary invalidation is unavailable");
  }
  if (typeof factStore?.deleteBySession !== "function") {
    throw new Error("session fact invalidation is unavailable");
  }
  if (typeof summaryManager?.getSummary !== "function" || typeof summaryManager?.saveSummary !== "function") {
    throw new Error("session summary invalidation rollback is unavailable");
  }

  const retainedMessageCount = Number(input.retainedMessageCount);
  const summarySnapshot = cloneMemorySnapshot(summaryManager.getSummary(sessionId));
  const scopedStore = input.scopedDerivationStore || summaryManager.scopedDerivationStore;
  const hasScopedSource = Boolean(scopedStore?.getSourceDependency?.(sessionId))
    || Boolean(summarySnapshot?.memoryScope && summarySnapshot.memoryScope.realm !== "legacy");
  const scopedCheckpoint = hasScopedSource ? scopedStore?.createRollbackCheckpoint?.() : null;
  const scopedExpectation: ScopedWriteExpectation = scopedCheckpoint ? { fingerprint: scopedCheckpoint.fingerprint } : null;
  // Pin reads can migrate two files. Prepare a side-effect-free snapshot before
  // touching any derived state, then include both writes in this compensation.
  const pinnedInvalidation = input.agentDir
    ? preparePinnedMemoryInvalidation(input.agentDir, sessionId,
      input.preserveSourceEntries ? { sourceMessages: input.sourceMessages } : {})
    : null;
  let summaryAttempted = false;
  let summaryInvalidated = false;
  let factsDeleted = 0;
  try {
    if (scopedCheckpoint) {
      scopedStore.invalidateSource(sessionId, { reason: input.reason || "session source invalidated", preserveEntries: input.preserveSourceEntries === true,
        expectation: scopedExpectation });
    }
    const summaryOptions = {
      ...(Number.isInteger(retainedMessageCount) && retainedMessageCount >= 0 ? { retainedMessageCount } : {}),
      ...(input.preserveSourceEntries ? { preserveSourceEntries: true } : {}),
      ...(scopedCheckpoint ? { skipScopedInvalidation: true } : {}),
    };
    summaryAttempted = true;
    summaryInvalidated = Object.keys(summaryOptions).length
      ? summaryManager.invalidateSession(sessionId, summaryOptions)
      : summaryManager.invalidateSession(sessionId);
    const preserveEntries = input.preserveSourceEntries && Array.isArray(input.sourceMessages) && scopedStore;
    if (preserveEntries) {
      scopedStore.syncSessionSourceSnapshot(sessionId, input.memoryScope, input.sourceMessages, scopedExpectation);
    }
    pinnedInvalidation?.apply();
    // Nothing fallible may follow this atomic fact mutation inside the commit.
    if (preserveEntries && typeof factStore.invalidateSourceEntries === "function") {
      factsDeleted = factStore.invalidateSourceEntries(sessionId,
        scopedStore.getSessionDependencies(sessionId, input.memoryScope));
    } else {
      factsDeleted = factStore.deleteBySession(sessionId);
    }
  } catch (error) {
    const rollbackErrors = [];
    try {
      let scopedRestored = false;
      if (scopedCheckpoint) {
        scopedRestored = scopedStore.restoreRollbackCheckpoint(scopedCheckpoint, scopedExpectation);
        if (summarySnapshot?.sourceDependencies) {
          summarySnapshot.sourceDependencies = scopedStore.rebaseRollbackDependencies(summarySnapshot.sourceDependencies);
        }
        if (summarySnapshot?.snapshotSourceDependencies) {
          summarySnapshot.snapshotSourceDependencies = scopedStore.rebaseRollbackDependencies(summarySnapshot.snapshotSourceDependencies);
        }
      }
      // Even the first source write may have committed before throwing. Restore
      // the summary's rebased fences although summary invalidation never began.
      if (summaryAttempted || scopedRestored) {
        if (summarySnapshot) summaryManager.saveSummary(sessionId, summarySnapshot);
        else summaryManager.invalidateSession(sessionId, scopedCheckpoint ? { skipScopedInvalidation: true } : undefined);
      }
    } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    // A failed provenance/summary restore must not prevent independent pin repair.
    try { pinnedInvalidation?.rollback(); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length) {
      const rollbackFailure: any = new Error(
        `session memory invalidation failed and rollback was incomplete (${rollbackErrors.map(error => error?.message || error).join("; ")})`,
        { cause: error },
      );
      rollbackFailure.code = "session_memory_rollback_failed";
      rollbackFailure.status = 500;
      throw rollbackFailure;
    }
    throw error;
  }

  return {
    sessionId,
    summaryInvalidated,
    factsDeleted,
    aggregateHistoryPreserved: true,
  };
}
