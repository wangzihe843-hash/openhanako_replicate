# Recovered cloud implementation and second review — 2026-10-02

## Recovery provenance

The base is `feature/xingye-mvp` at `a8e2d9d96ada9b5f5f775588fa2ab0d3e228246e`. Both original review archives were verified by their recorded sizes and SHA-256, applied through their guarded scripts, and checked across the combined 103-file overlay. Its source manifest again has SHA-256 `90be2dcd63ea859751469ef3f6830200db2baa46a4b0b20e2939b632ec44e227`.

The subsequent source/test edits were reconstructed from their retained exact edit records. Every original-fragment guard matched. The resulting incremental patch was applied in an isolated fixture and all recreated bytes matched the recovered source. Official persistence generation then reproduced the retained prior payload exactly: `sha256:86b1d1df1fdb9cb69dde1ec5b4b64c9dcc00d5900b2fcd2f273c13b7dbd5ccc5`. The scanner remained at 65 stores / 890 sites; the runtime closure remained at 8,590 files with its single unchanged existing boundary edge.

This establishes the recovered guarded implementation; it does not manufacture lost test logs. The observed historical full run was 15,084 passing tests before the final old-cache read projection fix. After that fix, TypeScript, lint and boundary checks passed, but the full rerun terminal output and build/smoke results were not observed before workspace loss. Fresh end-to-end validation is required and recorded separately below.

The recovered source was saved durably before dependency installation or long checks. The lockfile remains unchanged, with SHA-256 `ad79e12e80571711fdfd823f4ddf32fbd755ea93f337a438e85fc72a9a5181ae`.

## New confirmed findings in this review

### Retry rollback after a lost branch-head acknowledgement

A head write could persist the rewind and then throw. The old acknowledgement flags suppressed durable compensation. The live session restored its original question/answer, but a cold read using the stored head selected the rewind and hid the original turn. A plain append on the original branch is insufficient because the branch reader intentionally refuses continuation of a previously discarded observed tail.

The fix introduces an optional off-branch `hana-session-retry-transaction-v1` intent before any rewind. Its version-1 data contains the stable session identity, original leaf, source input and retry parent. Reset/rollback markers use version 2 and reference the unique retry transaction; copied scope metadata also identifies that transaction. Recovery is limited to the unfinished attempt, with no accepted replacement input and a matching original head/tail window. Later explicit rewinds and new retries remain authoritative. User-only, unflushed persistent SDK sessions flush the write-ahead intent using the existing snapshot helper; already-flushed histories are not rewritten. Same-process memory observers bypass interrupted-retry recovery while that operation is active; this in-process guard is cleared in finally and is absent after a cold restart.

Expression adoption does not clone retry control/reset records into its replacement branch. Copied memory-scope payloads stay intact while obsolete retry-transaction associations are detached. The original audit entries are preserved; combined retry-to-variant success/failure/fork tests cover this interaction.

The protocol is additive within Pi JSONL v3. No history is deleted or reclassified, no SQLite schema or DATA_EPOCH changes, and old sessions without the records keep their established behavior. The reader and writer remain covered by the session-JSONL persistence fingerprint. Downgrades cannot be assumed to enforce these new recovery rules.

### Private legacy pin bulk writes targeted the shared partition

A session with legacy/author or legacy/character knowledge could pass `expectedPins` for its private partition, but bulk replacement wrote the default legacy/shared partition. The old route returned success while removing unrelated shared records and placing private replacement text in shared memory.

Bulk replacement now requires the exact normalized default scope. Nondefault scopes use the existing structured append operation. The guard is checked before mutation and preserves concurrent shared changes and all private records. Default Settings bulk PUT, its compare-and-swap behavior, and private structured append are retained. This changes no persistent file format or migration.

## Verification boundary

All reproductions and regression fixtures use synthetic local data. No real channel posts, provider requests, user credentials or production-home migration are part of this review. Windows desktop UI/native behavior remains a separate required gate. No commit, push, merge or publication is performed.

Independent bounded recheck passed all three exact reproductions and 89 focused regression cases across six files after the final cross-feature correction. This is focused evidence, not aggregate certification.

The first aggregate run passed 15,135 tests with one existing RoleDetailPanel test failure (15 skips). A gated initial-read reproduction confirmed that the test clicked Save before loading completed; its broad failure mock also intercepted the read-before-merge step rather than the intended write. The test-only correction waits for enabled Save, injects failure only into profile.json writeJson, and requires exactly one failed write. The original error assertion is retained, with no timeout increase or retries; production component bytes are unchanged. Its 28-case file and three deterministic delayed-read probes pass. The complete gates are rerun after this correction.

## Final frozen-source gates

- Complete suite: **15,136 passed, 0 failed, 15 skipped** across **1,432 passed files and 1 skipped file**, 292.74 seconds, started 2026-10-02 06:07:50 UTC
- Renderer, Node and test TypeScript projects: passed
- Full lint warning ratchet: passed, 0 errors / 0 added warning sites; existing baseline unchanged
- Open boundary and whitespace checks: passed
- All 3,113 frozen code-file hashes remained unchanged during the final run
- Final persistence payload: `sha256:7cce440e7f645bdea42ded2e58c6c1c4815878351b020f10c8ad07b82b748123`; 65 stores / 890 sites, closure 8,590 files and one unchanged existing boundary edge
- Client build and Linux x64 server packaging: passed; target Node 24.15.0 was downloaded from the official release and checksum verified
- Seed-kit verification: passed using a fixture-only signing key, without changing the production trust root
- Real packaged Linux server smoke: **10/10 passed**, including native SQLite/Jieba/Anydoc, startup/store health, unauthenticated rejection, storage path traversal checks, topic/experience APIs, graceful shutdown and data/settings persistence across a real process restart
- Final build/smoke sequence completed 2026-10-02 06:29:18 UTC

The first server packaging attempt failed on npm registry metadata with E403; the execution tool also reported a network approval cancelled before a decision. The exact existing script was retried once through normal approval using unchanged registry, cache and locked package versions. That attempt completed all build, seed and smoke stages. Both attempts are preserved separately. All Pi dependencies remain at 0.87.1. These are fixture-key validation artifacts, not production-signed release binaries.

These current aggregate results supersede earlier focused or failed runs for the same final code. Windows native/UI gates remain pending. No commit, push, merge or publication was performed.
