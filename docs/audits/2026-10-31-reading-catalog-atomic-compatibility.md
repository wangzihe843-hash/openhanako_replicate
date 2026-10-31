# Reading book catalog atomic mutations (XM04)

`mutateReadingBookCatalog` is an additive action restricted to
`apps/reading_notes/book-catalog.jsonl`. It reads the latest file, imports/merges
the submitted books or deletes by book ID, and atomically publishes under the
existing per-agent in-process lock. An import no longer submits the caller's
entire bookshelf. Different owners retain independent locks and files.

The layout, DATA_EPOCH 1, existing IDs, creation times, dedupe rules, tag identity
and 20-book import limit are unchanged. New imports carry proposed IDs/timestamps
from the existing client factories. The server revalidates and normalizes them,
preserves an existing matching book's ID, and rejects a new ID collision before
publishing any of the batch. Metadata supplementation and tag merging use the
latest row. Empty imports and missing-ID deletions do not rewrite the file.

Unmodified lines retain their original bytes, including malformed JSON/UTF-8,
unknown rows, blank lines, CRLF and absent final newlines. An appended record
requires adding a separator if the existing last line had none. Modified rows
retain unknown fields and existing tag objects, including their unknown fields;
only the known supplemented metadata, tags and update time change. Duplicate
legacy dedupe keys are not automatically collapsed: the last recognized row is
the import target, matching the old lookup choice without erasing earlier rows.
Deletion removes recognized rows with the requested normalized book ID, as the
previous store did, and never matches another book's Open Library `key`.

The response explicitly contains `ok: true`, `imported` and boolean `deleted`.
The current client rejects unsupported actions, malformed receipts and transport
or disk failures. It never retries or falls back to `writeJsonl` automatically.
A lost response may mean the operation committed; this action does not promise
exactly-once delivery. Importing an existing dedupe key preserves its ID and
does not duplicate an identical tag; deleting an absent ID returns false.

Old generic storage APIs remain available with their previous semantics. Old
snapshot-writing clients remain outside this concurrency guarantee and can still
overwrite concurrent changes; upgrade client and server together. A new client
connected to an old server fails visibly without changing its catalog. An old
injected development backend without the optional atomic capability also fails
explicitly. localStorage transactions are synchronous within one JS realm;
neither cross-tab localStorage nor multiple server processes sharing one home
are claimed to be serialized by this change.

Concurrent explicit import and delete of the same book follow server commit
order. An import committed after deletion is a new import with a new ID. No
tombstone is introduced to block intentional reimport. Unrelated acknowledged
imports/deletions cannot be undone by an older client snapshot in the new path.

No data migration or automatic repair is performed. Code rollback reintroduces
the race and does not recover lost books or undo valid deletions. Restore only
from a confirmed compatible complete agent tree checkpoint, considering reading
notes that reference book IDs. No real user catalog is touched by the tests.

Validation uses real catalog stores, independent HTTP backends, Hono requests
and temporary files, plus the real reading React component with synthetic model
results. This is macOS Node/jsdom evidence, not Windows or native GUI validation.
