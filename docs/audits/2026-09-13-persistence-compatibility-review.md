# Persistence compatibility review — 2026-09-13

Classification: **compatible**. DATA_EPOCH remains **1**. This review covers the complete frozen persistence diff, including Newton RR01–RR03 and Planck checkpoint publication retry. No global epoch migration, exemptions, generator policy or tripwire bypass is introduced.

Exact previous payload: `sha256:f85d66cd9968743c66ab1e494084e25ad4d0b6e75f5f2edb1e6e74240639385d`.

Exact reviewed payload: `sha256:38bc85c6f08b1e2de797b8c0bf80d9bc1423b601ac7f66677a875c43c9695d8e`.

The generated fingerprint embeds this document path, the compatibility reason and this exact payloadFingerprint. The official writer recomputes the payload and rejects a mismatched pin. The payload hash excludes the review envelope, preventing a self-reference.

## Method and unchanged contracts

Reviewed the current code and full diff against 6ad93159d483045493c1e4a45e3d14fded29514b. Used scripts/scan-persistent-stores.mjs (writeReceipts), scripts/generate-persistence-schema-fingerprint.mjs (generate/write and its SCHEMA_CHANGE_GUIDANCE), and scripts/compute-cli-closure.mjs (writeCliRuntimeClosure/writeOpenBoundaryBaseline). Runtime SQLite introspection compares actual schemas, not guessed source declarations.

There remain 62 registry stores and 62 schema entries. Source hashing remains TypeScript 5.9.3 / parse-tree-v1. Pi remains 0.80.3 with the same package integrity and CURRENT_SESSION_VERSION 3. The manifest database remains v5; its DDL and file-history DDL are identical. Inventory roots/exclusions, exemptions, epoch, and startup phases are unchanged. The regenerated startup receipt is byte-identical. Only registry, schema entries and site mappings change in the payload body.

## All 14 changed schema entries

| Store | Compatibility reasoning |
| --- | --- |
| agent-facts-sqlite | user_version 2 → 3 adds only session_fact_commits(session_id TEXT PRIMARY KEY, revision TEXT NOT NULL). Runtime introspection confirms zero removed/changed existing table, FTS, index or trigger objects. Transactional migration preserves existing rows; fact commit and revision receipt share a transaction; delete/clear invalidate receipts. |
| agent-profile | core/agent.ts adds workflow dependency access to task registry/stable session identity; authored profile paths and formats remain unchanged. |
| channels | Existing Markdown/frontmatter/message format remains. Locked append rechecks existence, member and cancellation, then opens without O_CREAT to avoid recreating a removed channel. |
| data-epoch-checkpoints | Waits for hash stream close before directory publication. Final rename reuses the unchanged renameWithBusyRetry helper: Windows EPERM/EACCES/EBUSY only, at most 8 attempts and 15.85 seconds of scheduled delays. Same source/target each attempt; no target deletion or repeat capture; other errors propagate immediately. Existing failure cleanup only removes this staging tree. Checkpoint bytes, metadata and verification remain unchanged. |
| desk-cover-upload-staging | Encompassing desk route digest changes for validation of explicit jian content before deletion. Cover staging contract remains unchanged. |
| device-access-registries | Adds in-memory revocation/expiry listeners. Existing version 1 device/credential/pairing serialization remains. |
| file-history-sqlite | Same runtime schema. Existing origin/op_context fields preserve restore capture and prevent preimage coalescing. Required preimage capture precedes overwrite. |
| plugin-task-registry | Timer wakeup rechecks nextRunAt; captured record identity prevents late handlers from overwriting/remaking a replacement/deleted task. Same serializers. |
| server-runtime-info | CORS integration changes the source module digest; server-info writer/reader format is unchanged. |
| session-drafts-and-projects | Failed corrupt-file quarantine propagates instead of exposing an empty loaded state. Same file paths, normalizers and schema. |
| session-jsonl | Runtime creation/focus ownership and cancellable engine-scoped submission retain existing JSONL metadata and branch-head formats. RR01 holds input ownership through SDK preflight/completion, checks all acceptance paths, quarantines canceled old runtime and identity-checks cleanup. No Pi format or repair contract change. |
| session-sidecars | Bridge writes the same identity metadata before fallible input work, re-reads index to preserve other conversations and completes cleanup on branch-sync errors. Existing layout remains. |
| workflow-state | Journal and activity reader remain unchanged. Existing task terminal states support cancellation/drain. RR03 waits for settled children without overriding root-handled errors; uncaught failure still aborts and drains. No journal format change. |
| xingye-state | Contact-profile mapping adds a file in the existing tree. CAS adds an HTTP operation over existing JSONL records, compares expected state under the agent lock and preserves identity/other rows including malformed lines. Strict persistence acknowledgement/connection guards prevent stale writes. Lore writes sanitized Markdown via temporary rename with canonical rollback on ordinary derived-write failure. Existing JSON/JSONL/Markdown remain readable. |

## Registry coverage and additional writer audit

Only agent-memory and xingye-state descriptors changed. The exact X1 local key is xingye.phoneContactProfiles; its path is agents/{agentId}/xingye/phone/contact-profiles.json, owned by the existing xingye-state tree. Checkpoint/identity text explicitly includes contact profiles without an overlapping owner.

Memory reset.json and longterm/daily .md.fingerprint paths already existed in unchanged writers. Both HEAD and current pinned-memory-store.ts use path.join(agentDir, 'pinned-memory.json'); correcting the descriptor from memory/pinned-memory.json to agents/{agentId}/pinned-memory.json repairs registration, not a disk migration.

The final site inventory is 855 → 862. The complete six-module delta is:

| Module | Old → new sites | Explanation |
| --- | --- | --- |
| core/data-epoch-checkpoint-provider.ts | 11 → 10 | Direct rename delegates to the existing retry helper; source digest records the call/import and helper remains scanned. |
| desktop/file-text-io.cjs | 1 → 4 | Exclusive temporary creation/write, rename and cleanup, under the existing external-file exemption. Same UTF-8 content; expected-version checks precede commit; no delete fallback. |
| lib/channels/channel-store.ts | 12 → 12 | appendFile becomes handle.writeFile for the guarded existing channel. |
| lib/session-files/bridge-inbound-files.ts | 2 → 3 | RR02 adds cancellation checks and exclusive wx writes, then removes only this call's unregistered file if canceled. Cache path, sidecar serialization and returned attachment shape remain unchanged. All sites belong to existing session-files; already registered attachments remain. |
| server/routes/xingye-storage.js | 10 → 12 | Temporary cleanup and canonical rollback operations. |
| shared/xingye-lore-memory-file.js | 2 → 4 | Atomic publish/temporary cleanup; registry siteRules include rename/remove-path. |

No unclassified site or new exemption was accepted. Deep-memory receipt recovery and dream-state failure handling were also inspected: existing memory summary/state format is retained; failed reads/writes no longer silently replace authoritative data.

## CLI receipts

The exact generated CLI closure still has 9689 files: 708 source graph, 11 runtime assets, 8970 NFT trace. No file is added or removed; no other top-level closure field changes. Six existing files gain importer provenance: desktop-session-submit from coordinator; device-registry from chat route; debug-log from workflow-tool; activation.cjs from checkpoint provider under cli-entry and server-bootstrap; pointer-store.cjs and ustar.cjs through activation.cjs under those same roots. The latter transitive requires already exist in the unchanged helper. These are all attributable to this patch's four direct import additions; no dependency/platform/toolchain churn is accepted.

Open-boundary baseline remains byte-identical: one evidence-needed edge, zero added/removed edges. Official generation still writes it so exact-regeneration checks cover the final closure.

## Freeze evidence, validation and limits

The final coordinator byte SHA256 is 1ae7287bc36cc7e76fa7e0ff9fa6e522e16d23df9d0bcec8f1dda30ab891c8ea. The final checkpoint provider byte SHA256 is 402d66c5ac35e75787eb8cd5c57130a7a1a0969db637dcd9981f373e888b7512. Both were verified before generation. Newton's machine-readable follow-up runs report 289/289 and 156/156 passed; Planck reports 38/38. These are separate focused runs, not an aggregate full-suite result.

The final four-file verification run passed **58/58** (registry 16, schema tripwire 18, CLI census 21, secondhand 3), exit 0, in 147.16 seconds. CLI deterministic matching, two independent runs and in-place byte-exact regeneration all passed. The test log, exit status and final source/artifact hashes are recorded in output/audit-fixes-2026-09-10/receipts/result.md and freeze.json. Validation uses independent temporary home/log paths and installed dependencies. The facts tripwire assertion alone changes v2 → v3; deterministic generation and all drift detection stay enabled.

Compatibility means this upgrade can read and migrate existing data. It does not certify old binaries maintaining new receipt invariants while writing v3 databases. Lore rollback covers ordinary I/O errors, not a crash between two file publications; agent locks remain per process. No downgrade or cross-process transaction guarantee is added. The checkpoint retry is bounded and preserves errors; it does not identify the external Windows lock holder.

## Secret-fs final freeze addendum — 2026-09-13

Final shared/secret-fs.ts byte SHA256: **530800a93bd8386da2c03b4659d1f3170664182cd93377c3985354d2111e2ff0**, verified against Planck secret-rename-freeze.json. Only this production file changed among the 925 previously recorded inputs. Exact reviewed persistence payload remains **sha256:38bc85c6f08b1e2de797b8c0bf80d9bc1423b601ac7f66677a875c43c9695d8e**.

The private synchronous helper is used only in the existing Windows branch of writeSecretFileSync. EPERM/EACCES/EBUSY receive at most six rename attempts, with Atomics.wait delays 10/20/40/80/160ms (310ms total scheduled waiting, excluding syscall/scheduling time). All attempts retain the same temporary bytes and destination; no target deletion or temp rewrite occurs. Other errors/exhaustion rethrow the original exception. Original temp cleanup, POSIX branch, API, UTF-8 content, .tmp naming and 0600/0700 permission policy stay unchanged. This compatible retry behavior needs no persisted schema migration.

Official scanner inventory/startup output and a fresh generatePersistenceSchemaFingerprint with the existing exact review pin are all byte-identical. The existing generic-secret-fs-primitives exemption covers this shared helper: both rename sites keep their kinds/excerpts/ordinals, and the helper is not a schemaSource/protocolModule hashed by a descriptor. No policy or source coverage was changed to force a match. This addendum and the updated freeze/input manifest bind the reviewed helper byte hash explicitly.

No import/require/dynamic call, asset or dependency metadata changed. Official computeCliRuntimeClosure({ includeNftTrace: false }) matches all 719 source/runtime-asset entries, provenance and metadata after excluding NFT-only entries/provenance from the committed comparison. The generated open-boundary baseline is byte-identical. All five build receipts remain byte-identical to the previous freeze; prior full CLI census 21/21 and 9689-file output remain applicable. No expensive NFT census or four-file rerun was needed.

Current isolated validation: persistence-store-registry **16/16**, persistence-schema-tripwire **18/18**, total **34/34**, exit 0, 18.85 seconds. The matching and drift checks remain enabled. Planck's separately read machine-readable evidence reports **25 passed, 0 failed, 11 existing native POSIX permission tests skipped on Windows**; those skips do not certify native Linux permission behavior. Latest evidence and exact hashes: output/audit-fixes-2026-09-10/receipts/secret-receipt-impact.json, secret-tests.json, result.md and freeze.json.
