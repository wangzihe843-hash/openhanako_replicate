# Secret-space atomic deletion persistence review

Classification: **compatible forward protocol addition** relative to `ec6927a21264d98421710a58134edfe2d4cc6868`. DATA_EPOCH remains **1**. No path, owner, required field, numeric format version, SQLite schema, dependency or migration changes. This review covers the dedicated deletion action and its client; it does not certify concurrent use by old writers or a same-home downgrade.

## Write scope and identity

The existing `xingye-state` store owns `agents/{agentId}/xingye`. The new `deleteSecretSpaceRecord` action accepts only the seven existing `secret-space/{category}.jsonl` paths: state, draft_reply, dream, saved_item, unsent_moment, memory_fragment and interview. Existing agent, reserved-scope and path/symlink checks still apply. It uses the existing atomic writer and same-directory temporary file/rename; its failures clean up temporary output. The route may create the existing Xingye root during path validation, but missing category files return `deleted: false` without creating a category file.

The selector is the former renderer algorithm, now shared with the server: recordId, then key, then id, then the existing category/createdAt/title/body-or-content/summary FNV-1a legacy digest. Finite numeric IDs, including zero, keep their string conversion. No ID is generated on disk. Only the first matching object row is removed. Duplicates require separate explicit deletions. Invalid JSON, non-object JSON, invalid UTF-8, blank lines, CRLF and other non-target bytes are copied unchanged, including a missing final newline. This replaces the old renderer's survivor enrichment; it does not migrate, normalize or compact existing rows.

The old `deleteJsonlRecord` action retains its key/id/positional contract for existing clients and drafts. No path or protocol is silently redirected to the new matcher. Pinned memory continues to use the separate pinned path and compare-and-swap behavior.

The dedicated action checks an explicit seven-category allowlist. `drafts`, `interview-drafts`, unknown names and unregistered future categories return HTTP 400 whether or not their files exist, without atomic publication or client success events. The shared path helper and generic read/write/delete actions are unchanged; this enforces the dedicated protocol scope, not a new caller permission model. Future categories require an explicit registration and corresponding contract tests.

Before JSON parsing or identity selection, the dedicated action validates the complete original line byte slice with `node:buffer.isUtf8`. An invalid sequence anywhere in the line makes that line ineligible for deletion; its bytes remain untouched even if replacement decoding would yield parseable JSON or collide with a valid ID. Valid UTF-8 U+FFFD and JSON-escaped U+FFFD remain valid targets. The existing JSON BOM acceptance boundary is unchanged. This is not a repair or migration of corrupted data, and does not change the permissive legacy list/generic readers.

## Lock and event semantics

Read, first-match selection and atomic publication run inside `withXingyeAgentEventLock(agentId)`, shared with `appendJsonl` and server draft writes. There is no nested acquisition. Same-agent requests serialize and another agent can proceed. The Promise queue is local to one service process: independent OS writers and external file edits remain outside this guarantee. A generic whole-file `write` remains an explicit replacement operation.

The client sends one dedicated request and accepts only `ok === true` with boolean `deleted`. Only true emits the existing category deletion event and changed notification. The event is appended after deletion releases the lock, through the existing event log API; event append is best effort and is not a cross-file transaction. False emits no success notification. A failure or malformed reply cannot trigger snapshot writeback, retries or survivor enrichment. Cancellation after a server commit is an uncertain client outcome, not a rollback; a later explicit retry can return false.

## Version, old services and rollback

No persisted format or DATA_EPOCH change is required: both old and new readers can read surviving JSONL bytes. A real ec baseline server rejects the new action with HTTP 400 `invalid action`; the new client reports that a server upgrade is required and leaves the file untouched. Client and server must be upgraded together. Old clients still use the old snapshot writer against a new server and can lose concurrent changes; this review does not extend the lock guarantee to those clients.

Code rollback does not restore deliberately deleted rows. The existing checkpoint/restore policy remains in force: retain a complete coherent Xingye tree for the same agent/scope, including authored records, IDs, drafts and consumed-event markers; stop writers and use an explicit compatible recovery procedure. Do not restore a stale JSONL snapshot automatically, infer deleted contents, or replay a delete after a lost response. This change has no new backup, migration or automatic data-recovery behavior.

## Review receipt and evidence requirements

Update `xingye-state.schemaContract.compatibility` in the registry and regenerate the inventory with its official writer. Register `shared/xingye-secret-space-record-id.ts` because it determines which persisted row is removed, and `desktop/src/react/xingye/xingye-secret-space-store.ts` because it controls request, confirmation and fallback behavior. The renderer ID wrapper only re-exports the guarded helper; it owns no separate algorithm or filesystem path.

Regenerate the fingerprint with an explicit compatible review, preserving earlier reasoning. Expected payload changes are the Xingye contract text, these two protocol module registrations/digests and the route source digest, plus payload/review seals. Source roots/exclusions, site mappings, exemptions, other stores, SQLite DDL, startup receipt, parser provenance and DATA_EPOCH remain unchanged. Repeat generation and compare bytes. Do not edit a digest by hand.

Required focused checks include unchanged old UI assertions plus dedicated-action/cancel/error/no-fallback checks; real store/Hono/synthetic-disk concurrent append/delete and duplicate delete; identity priority and raw-byte preservation; old generic deletion and real old-server rejection; schema tripwire including negative semantic mutations of both newly registered modules; registry/startup receipts, typecheck, lint and compilation. Native Electron, listening services and packaged smoke remain separate gates and must not be launched by a broad test command without permission and proven isolation.

The final boundary revision adds official-category present/missing cases, draft/unknown/future rejection with generic key/id/position controls, invalid UTF-8 sequence cases, valid replacement-character controls, and corrupt-before-valid collisions at every stable-ID priority. The actual client list/delete/storage-response/event chain is exercised through Hono `app.request` against synthetic temporary bytes. Removal of either new route guard must fail the persistence fingerprint tripwire. Review generation retains all earlier reasoning; relative to the preceding candidate, only the Xingye compatibility text, route source digest and review/payload seals should change.
