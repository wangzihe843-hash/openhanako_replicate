# Reset lifecycle: persistence compatibility

Classification: **compatible forward addition**, relative to `af4c8303f859c0f2577003b6b89b8e950689f89d`. DATA_EPOCH remains **1**. There is no SQLite DDL, store-local SQLite version, dependency or epoch migration change. This declaration describes the reset candidate's persisted protocol; it does not authorize sharing an active home with an older binary, or certify full product/Mac acceptance.

`shared/persistence/store-registry.ts` is the canonical ownership declaration. The official scanner copies its descriptors into the inventory; regenerating that inventory alone cannot discover a missing path contract. The `agent-memory` descriptor therefore explicitly registers each actual archive shape, the active legacy `editable-facts.md` source, and `week.md.migrated.bak`. It keeps file ownership narrow and adds no catch-all path, exclusion or exemption. Its protocol sources include the ten reset implementation modules so future drift in the daily/journal writers or boundary consumers also requires review.

## Persisted shapes and readers

| Record | Written shape and interpretation |
| --- | --- |
| `memory/reset.json` | No numeric schema version. C (compiled reset) and F (full reset) write `compiledResetAt`, a fresh UUID `resetRevision`, and `updatedAt`. F also writes `factsResetAt`, a fresh UUID `factsResetRevision`, `v1Retired: true`, and `channelSources`. C preserves the existing F fields. Equal timestamps are allowed; revisions distinguish resets in the same millisecond. |
| `channelSources[channelId]` within that marker | `{messageCount, prefixHash}`: nonnegative safe integer count and lowercase 64-hex SHA-256 digest of the parsed message prefix. Start with SHA-256 of the empty string; each message hashes the preceding hex digest followed by `JSON.stringify([sender, timestamp, body])`. Positions are assigned before self-message filtering and window truncation. No chat body is copied into the marker. |
| `memory/daily-state.json` | Existing `schemaVersion: 4`, `logicalDate`, `resetAt`, `completedSteps`, `dailyCompletedAt`, `updatedAt`, plus optional `resetRevision`. The reader normalizes missing/non-string revision to null; logical date, reset timestamp and revision must match before restoring progress. A superseded checkpoint causes work to run again rather than skipping a new generation. |
| `memory/dream/pending-apply.json` | Writers retain `schemaVersion: 1`, `revisionId`, `startedAt`, and `operation` (`dream` or `restore`); restore also has `targetRevisionId`. New journals add `reset: {memoryDir, domain, resetAt, revision}`. The token uses the normalized absolute memory directory and compiled domain. The recovery reader validates current identity; this registration does not claim a new strict journal schema parser. |
| `memory/dream/revisions/{revisionId}.json` | The existing version-1 snapshot shape is unchanged. A journal references a separate revision; it is not a self-contained snapshot. The existing ten-revision pruning policy and explicit pre-restore safety revisions remain. |

Only a missing reset marker (`ENOENT`) means no reset. Valid historical timestamp-only markers remain readable; missing/non-string compiled revisions normalize to null. New writers emit UUIDs but readers do not require every legacy revision string to be a UUID. Unreadable/malformed markers, invalid timestamps and incomplete or invalid F tuples block automatic work. This is not a migration that repairs arbitrary damaged metadata.

Identity-less historical Dream journals recover automatically only when no marker exists. Stale or foreign-home journals are retired to the archive; current journals retain the existing rollback behavior. Explicit historical revision restore remains permitted and writes a journal bound to the current identity. Moving a home does not make an old absolute-path journal valid in the new location. A journal's referenced revision must still exist for recovery.

The existing channel Markdown, DM format and read bookmarks do not change. `memorySource` is non-enumerable metadata on parsed messages, not a new serialized field. Its durable boundary belongs to `agent-memory`, not the channels or channel-post-effects stores. An edited, truncated or reordered prefix blocks automatic memory extraction; a new explicit F establishes a new boundary. C retains that F boundary. Chat history and bookmark delivery continue under their existing contract. F retires automatic v1 import through the facts-domain marker while retaining `memories.db`; `.v2-migrated` itself is unchanged.

## Named retired sources and recovery

The archive has no index or new manifest version. `archiveRetiredMemorySources` creates a unique `memory/reset-archive/retired-{archiveId}/` directory and synchronously renames named sources while keeping their relative paths and bytes:

- `daily/{date}.md` and `daily/{date}.md.fingerprint`, for ordinary dated files.
- `editable-facts.md` and `dream/pending-apply.json`.
- `week.md` when legacy week migration finds an existing `week.md.migrated.bak`. The original backup is preserved; a first backup is created exclusively.

The archive suffix is a storage locator, not a reset revision. Multiple resets, retries or journal retirements may create separate archives. No automatic reader imports these paths and no automatic archive pruning is added. Reset leaves original sessions, raw channel files, v1 database, existing backups and historical Dream revisions in place; ordinary revision retention still applies. There is no archive browser or automatic bulk restore.

Checkpoint the registered active memory files, identity/checkpoint records, journal/revisions and named archives together; include facts and channels for an operation affecting their F boundary. The real checkpoint provider expands these exact paths and copies/hash-verifies their bytes. Registering them changes checkpoint coverage, not reset selection or reader behavior. Restoring a checkpoint requires compatible readers and a coordinated decision about the marker and source histories. Do not restore a marker independently or replay an archived pending journal blindly. Selected authored content may be explicitly edited/imported/restored under the current identity; the existing daily PUT only edits dates that already exist.

Archive I/O failure propagates. A reset can already have published its new marker, cleared SQLite facts or moved some files when a later step fails. The published identity is not rolled back. Preserve both moved and remaining sources, report failure, and retry explicitly; this is not a cross-file crash transaction. Hand-built symlink layouts remain an existing conditional hardening item outside the ordinary-file guarantee, with no new link support in this registration change.

## Compatibility and rollback limits

Valid old data remains readable by the new implementation without a conversion batch: optional marker/checkpoint/journal fields and separate archives do not require a DATA_EPOCH increase. Live SQLite introspection must retain facts `user_version=4`, file history `0`, and session manifest `5`, with identical schema objects. The channels and effect-ledger shapes, Pi session format and lockfile remain unchanged.

Old binaries do not honor the new F boundary, revision identity or journal token. They may re-import retained v1 data, summarize pre-reset channel history, replay an old journal or drop F fields when writing a compiled reset. **Code rollback is not data rollback; downgrade against the same active home is not certified.** Retain archives and original sources, never rewind a published reset marker to simulate recovery, and make any data recovery an explicit operation with compatible readers.

The fingerprint's `compatible` review is a forward-reading declaration with these limitations, not a claim that old binaries enforce new semantics. Official inventory/fingerprint generation must preserve scanner rules, exemptions, source digest method, existing negative assertions and startup phases. Independent full-suite, build/smoke and Mac acceptance remain separate gates.
