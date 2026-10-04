function cloneMemorySnapshot(value: any) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Atomically invalidate the mutable memory derived from one Session.
 *
 * The summary lives on disk while deep facts live in SQLite. FactStore deletes
 * one Session with a single SQLite statement, so a thrown delete leaves facts
 * unchanged; in that case we compensate the preceding summary mutation from a
 * durable snapshot. Scoped provenance is compensated first with a compare-and-
 * restore fence; legacy compiled aggregates remain intentionally outside it.
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
  let expectedScopedFingerprint = scopedCheckpoint?.fingerprint;
  let summaryInvalidated = false;
  let factsDeleted = 0;
  try {
    if (scopedCheckpoint) {
      scopedStore.invalidateSource(sessionId, { reason: input.reason || "session source invalidated", preserveEntries: input.preserveSourceEntries === true });
      expectedScopedFingerprint = scopedStore.getStateFingerprint();
    }
    const summaryOptions = {
      ...(Number.isInteger(retainedMessageCount) && retainedMessageCount >= 0 ? { retainedMessageCount } : {}),
      ...(input.preserveSourceEntries ? { preserveSourceEntries: true } : {}),
      ...(scopedCheckpoint ? { skipScopedInvalidation: true } : {}),
    };
    summaryInvalidated = Object.keys(summaryOptions).length
      ? summaryManager.invalidateSession(sessionId, summaryOptions)
      : summaryManager.invalidateSession(sessionId);
    if (input.preserveSourceEntries && Array.isArray(input.sourceMessages) && scopedStore
      && typeof factStore.invalidateSourceEntries === "function") {
      scopedStore.syncSessionSourceSnapshot(sessionId, input.memoryScope, input.sourceMessages);
      expectedScopedFingerprint = scopedStore.getStateFingerprint();
      factsDeleted = factStore.invalidateSourceEntries(sessionId,
        scopedStore.getSessionDependencies(sessionId, input.memoryScope));
    } else {
      factsDeleted = factStore.deleteBySession(sessionId);
    }
  } catch (error) {
    try {
      if (scopedCheckpoint) {
        scopedStore.restoreRollbackCheckpoint(scopedCheckpoint, expectedScopedFingerprint);
        if (summarySnapshot?.sourceDependencies) {
          summarySnapshot.sourceDependencies = scopedStore.rebaseRollbackDependencies(summarySnapshot.sourceDependencies);
        }
        if (summarySnapshot?.snapshotSourceDependencies) {
          summarySnapshot.snapshotSourceDependencies = scopedStore.rebaseRollbackDependencies(summarySnapshot.snapshotSourceDependencies);
        }
      }
      if (summarySnapshot) summaryManager.saveSummary(sessionId, summarySnapshot);
      else summaryManager.invalidateSession(sessionId, scopedCheckpoint ? { skipScopedInvalidation: true } : undefined);
    } catch (rollbackError) {
      const rollbackFailure: any = new Error(
        `session memory invalidation failed and summary rollback was incomplete (${rollbackError?.message || rollbackError})`,
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
