# L1 / L2 scope and turn-mode validation

Base: `a8e2d9d96ada9b5f5f775588fa2ab0d3e228246e`, `feature/xingye-mvp`.

## Product entry points

- Xingye chat entry → session selector → **记忆范围**. Choose compatibility, reality, or narrative; narrative includes world, branch, character/director viewpoint, and new-memory visibility. The narrative default is character-private. Use a blank chat without an authored greeting. Existing model-visible history cannot be silently reclassified, including custom inputs, assistant-only turns and compacted history.
- Assistant completion → **换个说法 / Expression variant**. Generate and inspect a tool-free expression candidate, then explicitly adopt or discard. Cancellation and navigation discard late responses. Historical responses require a fork first; adoption changes the latest completed text response only and retains preceding task results.
- Completion → **重试任务 / Retry task**. Receipt-aware retries support `channel.post`. Committed effects reuse their result; unknown effects require receipt reconciliation and never blindly resend. Unsupported side-effect tools are blocked during this mode. An explicitly new input remains a new operation even when its text is identical.
- Scoped narrative conversation → **剧情分支 / Narrative branch**. Creates a separate session and fresh branch identity through the existing fork transaction. Generic forks of narrative sessions also get a fresh narrative branch. Original history and real-effect ledger remain intact.
- **Edit and resend** preserves the legacy new-input execution behavior, with an explicit warning that real actions may run again. It is not an expression variant or receipt-aware task retry. The old API's absent-mode retry remains compatible; unknown explicit modes are rejected.

Scope APIs are `GET/PUT /api/sessions/memory-scope`; expression APIs are under `/api/sessions/turns/dialogue-variants`; the existing retry and fork routes accept `task_retry` and `narrative_branch` respectively. They retain canonical session identity and authorization checks. Clients cannot grant the populated-history scope bypass.

## Data and execution guarantees

- Missing old scope means **legacy**, never inferred reality or narrative. Existing history, summaries, manual pins and aggregates are retained. Explicit scopes do not automatically import unclassified legacy memory, role-card scenes, relationship state, or lore mirrors. Basic user-authored agent personality remains available. Story prompts distinguish the portrayed user role from the real user and omit the real-user profile and real teammate roster.
- Scope filters apply before limits to tags, FTS and LIKE, and again to actual prompt sources. Runtime scope is not a model-controlled tool argument. Character-private and director-only memory remains within agent/world/branch boundaries.
- Derived narrative memory records source entry identity, content hash, revision, dependency chain and persistent validity. Retraction/edit invalidates affected summary/day/week/long-term/fact descendants while preserving independent source entries. Mixed claims inside one transcript entry are invalidated together; the system does not guess which sentence remains true.
- Source invalidation and rollback preserve real history and independent content. Separate async write fences reject old in-flight writers after compensation. CAS guards prevent rollback from overwriting newer state. Manual confirmed pins are treated separately from derived pins.
- Scoped source refresh batches into one atomic manifest write, and writes nothing when the snapshot is unchanged. Restart retains source validity and candidate lifecycle state. Legacy opaque caches are not reused for scoped reflection.
- Narrative runtime tools are blocked except scoped memory search. Expression generation bypasses agent/tool execution and rejects tool-call output. Real task retry support remains bounded to the channel posting pilot; it is not a claim that all tools are idempotent.
- Fact-candidate direct import remains disabled. Scene archives do not enter automatic context.

See [persistence compatibility review](2026-10-01-l1-l2-persistence-compatibility.md) for the additive v4 fact schema, scoped store registration, checkpoint/restore rules and downgrade limitations.

## Validation record

The final integrated results are recorded below after the frozen run. Earlier exploratory runs are not a full pass: the first completed integration run had 14,949 passed, 37 failed and 15 skipped, with an additional failed suite import. It identified inventory/locale/test-contract drift, concurrent in-progress test imports, and Linux fixture assumptions.

Those Linux fixture failures were reproduced at the untouched base using `git archive`: missing `TEMP`, tests assuming native Computer Use support, and first-run startup attempting a nonexistent desktop workspace. Test-only fixes isolate temporary HOME/USERPROFILE, use `os.tmpdir()`, explicitly exercise a supported provider fixture, and retain/strengthen Linux rejection coverage. Production platform policy is unchanged. An unintended external MCP fixture request was replaced with a hermetic in-memory client/default rejecting fetch.

Independent review reproduced and fixed author-view candidate hiding, legacy text-hash false-staleness, scoped rollback compensation loss, and populated custom/greeting scope reassignment. Subsequent review verified generation/navigation race guards and durable scope-update compensation under both pre-write and post-write head-store failures. Regression tests include actual Pi provider-request projection after branch commit and cold persisted-head recovery, not only selector diagnostics.

### Final checks

Final Linux x64 validation on Node 24.19.0, 2026-10-01:

- Full suite (`TZ=UTC npm test`, frozen runtime source): **15,027 passed, 0 failed, 15 skipped**, across **1,424 passed test files and 1 skipped file**. Run started 06:44:31 UTC; duration 241.45 seconds. The last test-only unused binding cleanup also received a separate 5/5 scope regression pass.
- Full renderer/node/test TypeScript checks: passed.
- Full ESLint warning ratchet: passed, **0 errors and 0 added warning sites**; 19 old sites removed. The existing baseline was not increased.
- Runtime export boundary: passed with the unchanged single pre-existing edge. Persistence guards: 39/39 passed. Closure/boundary guards: 39/39 passed, deterministic regeneration verified. Final schema fingerprint: `sha256:dfbb61849d970d920a4dbc97b9d8aa94393ff78bb06a24455da7ad22d5cd1153`.
- `build:client`, `build:server`, and `verify:seed-kit`: passed. A documented throwaway local key/keyset was used only for test seed validation. No production signing credentials were used.
- Real packaged Linux server smoke: **10/10 checks passed**, including native SQLite/Jieba/Anydoc loading, authenticated startup, API authorization, persistence, graceful shutdown and process restart.
- Source/lockfile dependency versions were not changed. npm 11.9 does not honor the repository's min-release-age setting; use npm >=11.10 before subsequent dependency changes.

Real Windows startup/UI/native verification remains a separate required gate before commit/push. No online model quality, real external delivery, macOS-native behavior, production signing or release publication is claimed. Build/test artifacts contain synthetic fixture data only; no user data was migrated.
