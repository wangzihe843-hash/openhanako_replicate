# Cloud regression persistence review — 2026-10-01

Classification: **compatible forward upgrade**, retaining DATA_EPOCH 1, Pi 0.87.1 / JSONL version 3, and all SQLite store-local versions. No existing user history, effect receipt, source snapshot or hidden scoped pin is deleted or reclassified. This review follows the restored 103-file L1/L2 implementation and its earlier persistence review, rather than replacing that work.

## Accepted-input task retry lineage

The optional engine-authored `hana-session-task-retry` custom record has version 1, `agentId`, `turnInputEntryId`, and the ordered original `actions`. Each action carries an explicit original `effectId` plus its original tool-call identity and optional logical identity/input digest. It contains no secret receipt token.

The engine writes this record after the actual retry input is persisted and before provider or effect dispatch. A pending branch-reset prefix alone conveys no retry authorization. If the accepted input cannot be established, dispatch fails closed. The runtime binding is prepared once per retry invocation, and a second intervening input cannot claim it. The record survives process restart and an interrupted effect result. A same-owner user-created session fork preserves explicit receipt identity just as it preserves a tool result; this does not re-key or execute the original effect. The current runtime agent/session checks, argument checks, strict action order, unknown-state handling and missing-ledger refusal remain enforced.

Existing sessions with no record retain their original tool-call/result based recovery. Unknown or malformed explicit record versions fail closed. No bulk rewrite or migration is necessary. Ordinary new operations remain distinct even if their content is identical.

## Narrative child scope on rewind

When retry/edit would discard the active explicit scope marker, the engine appends the same validated scope before publishing the rewind head or projecting the prompt/messages. This uses the existing `hana-memory-scope` format, including branch, character and viewpoint identity. It does not reclassify inherited source history or change the parent's session. Existing rollback paths preserve the previous child scope.

## Expression variant transport and rollback

Each expression-only provider dispatch uses the current allowed/rebound model and a fresh scoped/provenance-validated Agent prompt. It does not copy the cached main-session prompt or mutate the main prefix contract/provider affinity. These changes do not alter durable prompt or model data.

A failed adoption with a lost head-store acknowledgement needs explicit JSONL recovery because the restored original is a sibling of the rejected replacement. The optional version-1 `hana-dialogue-variant-rollback-v1` record stores `sessionId`, `candidateId`, `sourceEntryId`, `rejectedEntryId` and `restoredLeafId`. It is appended under the rejected replacement, pointing to the restored ready-candidate leaf on the original branch. A final ready-candidate append leaves the physical tail canonical too. The live manager stays on that restored branch; forks use the existing current-branch opener so an interruption before the final tail append is also projected correctly. The branch projector validates ownership, source/candidate identity, sibling relation and append ordering before redirecting a rejected lineage; malformed local recovery records fail closed. Authorized active-branch SDK forks do not copy the off-branch marker or its rejected sibling, so ordinary child sessions require no exception to validation. The exact implementation and cold/fork regression tests are guarded by the fingerprint.

Recovery is append-only. A failed durable recovery write is surfaced rather than claiming the original answer is safe. The existing immutable source and candidate entries remain available for recovery/audit.

## Memory and settings projections

Scoped compilation and deep-fact extraction now apply the existing PII scrubber at derived input/output/cache boundaries. Raw source snapshots, hashes, dependencies, generations and revision checks remain unchanged. Existing active derived caches are also scrubbed at the read-only runtime projection boundary before truncation, covering initial prompts and reflections before background maintenance. Unsafe cached text is superseded when rebuilt/reused. Neither operation destructively cleans source history or reclassifies its scope. The settings pin snapshot and replacement partition use the same exact default legacy/shared scope, preserving story/reality and nondefault legacy author/character records.

## Guard coverage and compatibility limits

The existing session-JSONL registry additionally fingerprints `core/session-turn-actions.ts` and `lib/session-jsonl.ts`, covering the retry writer and recovery projector. The effect-ledger contract remains under its existing registry owner. The official inventory scanner and fingerprint writer are used after source freeze; no exemptions or drift checks are relaxed.

Older binaries may ignore the new retry/recovery records, just as older scope-unaware binaries ignore scoped-memory boundaries. Do not downgrade a populated home in place: use a compatible pre-upgrade backup. This is forward-readable additive metadata, not a guarantee that older executables enforce the new recovery/isolation semantics. No Windows desktop pass is claimed by cloud tests.
