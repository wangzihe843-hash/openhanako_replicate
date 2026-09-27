# S6–S7 and M3–M6 persistence compatibility review — 2026-09-27

Classification: **compatible**. `DATA_EPOCH` remains **1**.

Previous payload: `sha256:845f29329e3ff939186945bdfe0d1aab2e5c39352dc5e007a1ac3f33955ed948`.

Reviewed payload: `sha256:907b9feee525edb564617b0b3086ddfa6810623528108e59a8966aa322be84eb`.

The official generator was run against the finalized store inventory and current source tree. The comparison found exactly five changed schema entries and two additional write-site mappings. Store registry, exemptions, source digest method/compiler, inventory roots and exclusions, and all other schema entries remain equal. SQLite runtime introspection shows unchanged facts schema objects and `user_version = 3`; the other SQLite stores also retain their prior runtime schemas. The site count changes from 870 to 872. Both new sites are in `lib/character-cards/service.ts` and are assigned to the existing `character-card-staging` store: copying an imported PNG card to its token-scoped package and writing a PNG image with stale card metadata stripped into an export package. The scanner's mappings for these sites share ordinal zero with older sites of the same kind, so the canonical mapping list gains two repeated mapping records, not an unregistered destination.

## Changed source contracts

| Store | Compatibility reasoning |
| --- | --- |
| `agent-facts-sqlite` | `lib/memory/fact-store.ts` adds process-local prepared-statement caches and changes only `SELECT` retrieval: channel and date predicates now run before `LIMIT` for tag, FTS and CJK fallback searches. No table, index, trigger, migration, serialized fact, or database version changes. Runtime schema introspection is identical. |
| `agent-profile` | Its `core/agent.ts` protocol module selects per-turn memory, role and lore prompt sections within budgets. It does not change profile readers/writers, paths, serialized fields, or session records. |
| `character-card-staging` | `lib/character-cards/service.ts` adds bounded PNG/V3 import and optional V3 JSON export within the existing token-scoped staging/export flow; the two new writes are registered to that store. Its `sillytavern-v2.ts` protocol module accepts V3 as an additional format and records optional lore source indices. Existing V2 metadata without indices remains readable through the old ID-suffix fallback. Existing native package paths and required fields remain readable. Exported compatibility data is synchronized with current lore rather than reviving deleted entries. |
| `plugin-task-registry` | `lib/task-registry.ts` adds a bounded, process-local task status sequence for UI polling. Existing task and schedule persistence serializers and record fields are unchanged. |
| `xingye-state` | Its changed protocol modules add optional V3 character-card compatibility metadata and prompt-only source selection. The profile normalizer still accepts V2; the new V3 value and lore source-index map are additive. Stable lore prompt reads now prefer canonical entries over a derived Markdown mirror, with a read-only legacy mirror fallback. Profile, lore and phone prompt formats on disk are not migrated or removed. |

No downgrade or rollback guarantee is extended by this review. Existing stored data remains readable by the new code. The changes do not require a coordinated `DATA_EPOCH` migration, checkpoint policy change, or schema exemption.
