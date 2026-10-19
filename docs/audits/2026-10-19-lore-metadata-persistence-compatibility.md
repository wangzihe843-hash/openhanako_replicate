# Lore metadata: persistence compatibility

Classification: **compatible forward addition**, relative to `d730328f9bf6d17033d797c11e279ab1a64197ef`. DATA_EPOCH remains **1**. The desktop Lore normalizer now retains three existing optional guards through ordinary edits. No file path, store owner, required field, numeric format version, SQLite DDL, Pi contract, dependency or coordinated migration changes. This declaration does not certify downgrading the same active home to an older desktop binary.

## Ownership and persisted shape

`shared/persistence/store-registry.ts` already registers the complete `agents/{agentId}/xingye` tree under `xingye-state`. Its protocol modules already include the Lore store, persistence bridge, runtime file reader and stable-lore mirror writer. The compatibility text is updated in this canonical descriptor; no owner, path, module, write-site exemption or startup phase is added.

`xingye.loreEntries` continues to map to `xingye/lore/entries.json` for the owning agent. Reads and diagnostics normalize in memory without writing. The existing persistence bridge converts historical arrays to maps in memory; ordinary saves write the existing object-map format. Direct store/JSON-adapter input remains an object map. Existing null deletion tombstones, empty maps, invalid-file handling, explicit legacy-import policy and agent binding behavior are unchanged.

Each row still requires its existing identity and content fields. Ordinary create, update, toggle and delete serialize the entire normalized map, including untouched rows. The normalizer now preserves only these additional own fields:

| Field | Retained value and interpretation |
| --- | --- |
| `memoryScope` | Any defined JSON value, including null, scalars, arrays, invalid objects and future versions. Invalid explicit values remain available to `canReadMemoryScope` for rejection; they are never erased into missing/legacy metadata. Missing or null scope retains the shared normalizer's existing legacy interpretation. Unknown members are retained as data, not runtime authority. |
| `sourceStatus` | An own string, unchanged: no trimming, case conversion or default `active`. Non-string values are omitted, preserving the existing readers' exact-string comparisons. |
| `origin` | An own string, unchanged: no inferred `manual` or `derived`. Non-string values are omitted; unknown strings retain the existing guard semantics. |

Unknown top-level fields remain discarded by the fixed schema. Existing category, keyword, priority, visibility, identity and timestamp normalization remains unchanged. Undefined is not a persisted JSON value; an undefined in-memory guard is omitted.

Ordinary create input does not accept these guards. Update restores the previous normalized guards after applying an input patch, including callers that bypass TypeScript; toggle delegates to update. Ordinary edits cannot add, clear or promote scope/source declarations. Preserving stored metadata does not authenticate it: direct storage/API writers can already supply raw declarations, and this change does not introduce source verification.

## Reader and write semantics

The shared selector, runtime JSON reader and stable-lore reader/writer keep their existing rules. Scope mismatch or invalid scope is rejected; `sourceStatus === 'stale'` is rejected; derived records whose stored realm is not explicitly `legacy` require `sourceStatus === 'active'`. Thus missing/null scope and explicit legacy scope continue to differ for unconfirmed derived records. Unknown tokens are not newly trusted or newly classified. A stored `viewpoint` cannot grant author access; only the trusted runtime context supplies that authority.

The desktop collector still supplies the default legacy context. It now sees existing guards, so scoped, stale or unconfirmed derived rows that previously lost metadata can be excluded. This is the intended correction; there is no new session-scope plumbing or change to ordering, budgets or direct consumers that do not use the shared selector.

The unchanged storage route writes canonical JSON and synchronizes `lore-memory.md` inside its existing per-agent critical section. A mirror-write failure restores the prior canonical bytes. Canonical entries remain authoritative over legacy mirrors, including empty/deletion values. No cross-file transaction, background rewrite or recovery batch is added.

## Forward compatibility and downgrade limits

Valid historical unguarded records remain readable without conversion. Existing scoped/source metadata was already understood by shared readers before this change; the desktop now stops dropping it. The additive optional fields require no DATA_EPOCH bump under this forward-reading contract.

The exact d730 desktop normalizer can parse newly written JSON, but discards all three guards in its in-memory projection. A read alone does not change file bytes, yet its desktop selection may already include records that should be excluded. Any subsequent ordinary whole-map save strips guards from edited and untouched rows. The unchanged file readers and mirror writer then see missing legacy metadata and can include previously excluded content. **Code rollback is not data rollback; same-home downgrade is not certified.** Parse compatibility is not preservation of scope/source semantics.

Before an explicit rollback or recovery, stop active writers and keep a complete backup of the affected agent Xingye trees, including canonical entries, tombstones, authored records and mirrors, following the registered checkpoint/restore policy. Evaluate recovery with compatible readers. Do not restore a mirror alone, run old desktop writers against the only current copy, or infer lost fields from content. Returning to new code after an old save cannot reconstruct discarded metadata. This repair neither inspects real user data nor restores hypothetical historical loss.

## Review evidence and generated receipts

The original five-file candidate fails the unchanged schema tripwire: committed payload `sha256:f2805020e3077375d32e8d080b4267193b12e9481e00ba280a8e86ea7bc65ee7` versus candidate payload `sha256:953e03cd490c2faeaefc4644247d8b54a15a0b93bb2ca55b77d2d609b28f8c52`. Before this contract update, the only substantive payload delta is the registered Lore store executable hash. This is an omitted compatibility review and generated receipt, not a missing path owner or evidence requiring a migration.

An isolated comparison executes the exact d730 and candidate store source with explicit synthetic storage. It verifies unchanged unguarded normalization, read-only failure behavior, 36 raw/read/save guard cases, update bypass protection and the downgrade write loss described above. Six unchanged bridge/route/scope/selector/file-reader modules are byte-compared with d730. Synthetic disk checks show the legacy runtime reader selects only the eligible row before an old rewrite and all five rows after guards are erased; new code does not reconstruct them. The probe replaces only unused React/default-storage imports. The permanent map/legacy-array LoreEditor regression separately covers the real hook, bridge, API serializer, Hono route, mirror write and disk reload.

Run the unchanged official inventory writer and then the fingerprint writer with explicit compatible reasoning. Preserve previous review reasoning and append this review. Expected structured changes are only `xingye-state.schemaContract.compatibility`, the Lore store protocol source hash, and the associated review/payload seals. Startup receipt, source roots/exclusions, site mappings, exemptions, SQLite schemas, parser provenance and DATA_EPOCH must remain identical. Repeat generation to verify byte-for-byte idempotence; do not hand-edit a digest or lower a negative assertion.

Relevant gates are the full persistence schema tripwire, registry and startup suites; the Lore editor/store/bridge/route/selector/file-reader regressions; scope and storage-contract tests; typecheck, lint and open-boundary checks. Full product/build/Mac acceptance is a separate stage and is not implied by this review.
