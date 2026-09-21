# S1–S3 persistence compatibility review — 2026-09-21

Classification: **compatible**. DATA_EPOCH remains **1**. Reviewed against `7fe7dfc52b0d9aa7ebb9711cfcf7601af40eecbf`.

Previous payload: `sha256:660bd9fe30c878dd1647c36d8a78152e19181f2334970a617de3018c86973afd`.

Reviewed payload: `sha256:64cd41f8f1b21fb517639e0c6a57a016bb9e70afd75f0dca5d6cb719fedf82c9`.

The official generator changes only the `session-jsonl` protocol module sourceHash for `core/desktop-session-submit.ts`. Its existing origin/presentation records, serializers, Pi JSONL format/version, package integrity, branch metadata and repair paths remain unchanged. The new code merges per-turn system context and consumes a process-local scene counter after input acceptance. Existing SessionCoordinator cleanup and the `before_agent_start` hook keep that context out of persisted messages.

Expression controls live in an engine-scoped WeakMap. They add no persistent store or disk write; archive/delete only remove entries from that map. Configuration intentionally disappears on service restart. Workshop changes retain the existing draft/profile schema and explicit confirmation path.

Independent read-only scanner comparison confirms 62 stores and 866 sites; inventory and startup receipts are identical. All other fingerprint payload fields are identical, including actual SQLite schemas (session manifest v5, facts v3, file history), exemptions, store registry, site mappings and source digest provenance. No migrations, exemptions, tripwire weakening or epoch changes are needed. This review does not broaden rollback/downgrade guarantees.

The CLI runtime closure separately adds the new core and shared expression modules. Both are explicitly included in export-manifest.json. The warning and style baselines remain unchanged.
