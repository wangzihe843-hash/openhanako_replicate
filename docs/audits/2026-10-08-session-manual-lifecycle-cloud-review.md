# Manual compaction and runtime lifecycle — cloud handoff

Current status: **V4 — UNVERIFIED, prepared for final independent static review**. HEAD remains `d754c6cdf97087259ae93412d512a521f5fd781a` on `feature/xingye-mvp`; no commit/push. Dependencies are incomplete. Controlled unit results do not establish real-SDK, complete cloud or Mac native acceptance.

## V4: model-switch admission after loading

Independent V3 static review confirmed the three V2 closing repairs below and identified one remaining interval: `switchSessionModel` checked closing before awaiting `ensureSessionLoaded`, but did not recheck when that await resumed. The real load queue could finish and release its path before the model continuation resumed. An agent/global close could then acquire its fence and wait on A's teardown while the model continuation for loaded B proceeded to change focus, model and metadata; B would subsequently be disposed by that close.

The production delta from V3 is one `_assertSessionRuntimeOpen(sessionPath)` immediately after the load await, plus an explanatory comment. It runs before reading the replacement entry or updating focus. The existing synchronous `_switching` reservation still protects the subsequent model operation. V3 batch preflight, closing scope order, scoped cleanup and compact ownership are unchanged; there is no new reservation type or queue wait.

Three controlled regressions first failed on unchanged V3 production code: both `closeAllSessions` and `discardSessionsForAgent`, and deletion of the active agent with an actual AgentManager foreground switch to another agent. Each runs the real coordinator load against the synthetic SDK factory, pauses only the model caller's continuation after the load queue/construction record are empty, starts closing, holds A's teardown, then resumes B. The assertions require rejection before `setModel`, model metadata writes, cache-prefix renewal or focus mutation. The two direct close cases also verify a successful switch on a fresh runtime after closing completes. The active-agent case runs the real switch queue and coordinator creation for the replacement agent, with synthetic agent readiness, and verifies that replacement focus survives deletion.

V4 evidence is in `/workspace/scratch/xingye-lifecycle-v4-20261008`. `repair.patch` contains the complete baseline-to-V4 candidate; `review-delta-v3.patch` is only for a verified V3 copy. V3 source files, patch and archive were verified before editing; the old archive remains unchanged with SHA-256 `bfa1ea3ad81283ac399cefc74d5c9f4dbda1331c5a4eb11deff2ddf2da1de25b` and Library ID `libfile_46637ce1c10c8191a14029115126107d`.

| V4 check | Outcome | Receipt |
| --- | --- | --- |
| New post-load regressions on V3 production source | 3 expected failures; model switching resolved while closing was active | `model-load-before.log/json`, `model-load-before-results.json` |
| Final targeted snapshot, 16:08:19–16:08:31 UTC | 57 passed (45 synthetic lifecycle, 5 existing hibernation units, 7 model-switch units); 10 original concurrency cases filtered; one deletion fixture suite blocked at collection by missing nested `typebox`; exit 1 | `focused-final.log/json`, `focused-final-results.json` |
| TypeScript renderer/node/test configurations | Each exits 2 before source checking: TS2688, missing `retry` | `static-checks.json`, `typecheck-*.log` |
| Targeted lint / warning ratchet | Exit 2 / 1 before source checking: missing `brace-expansion` | `lint-targeted.log`, `lint-warning-ratchet.log` |
| Syntax parser | Two TS files changed since V3, no syntax diagnostics; not semantic type checking | `syntax-check.json` |

The original ten concurrency tests remain byte-identical and were not rerun; filtered cases are not passes and their known SDK fixture block is not waived. All V4 test processes used fresh temporary `HANA_HOME`, `HANAKO_HOME` and `PI_CODING_AGENT_DIR` with synthetic session files. The reported executor disconnect was checked using actual successful commands: at 16:07:09 UTC the workspace, branch, fixed HEAD and exact V3 archive hash were readable; the existing reproduction process was collected rather than restarted. No environment switch or permission/403 workaround was used.

No dependency installation/download, ordinary network access, full test, fingerprint/CLI-closure generation, registry/security configuration change, commit or push was performed in V4. The requested official Library archive save follows. Dependency completion, real-SDK/original regressions, types/lint/ratchet, applicable full cloud checks, official persistence compatibility review, independent final static review and Mac native acceptance remain pending.

## V3: closing admission and destructive callers (retained in V4)

Independent V2 review identified three gaps: batch close could dispose A before hitting reserved B and leaving C plus final cleanup untouched; close/discard could miss a reserved path while replacement creation had not published an entry; and agent deletion swallowed the resulting cleanup failure and continued to dispose the agent/write a tombstone. Fourteen controlled regressions failed against V2 before production changes, confirming all three. V2 archive SHA-256 is `4a2cbe4afa9ffdda54848a77a9d8d91d4fe0fc9b2a9fc867a585b3f960ad1a27`; V2 patch SHA-256 is `00874f9272d46e9f6bc459e95671aa5190b154b8d320cb901ad355eaa47eeb2e`.

V3 uses an explicit **fail-fast close policy**: a conflicting compact, queued lifecycle operation, runtime construction, model switch or overlapping close rejects with `session_busy` before the closing operation changes runtimes, timers, sidecars or focus. The caller can retry after that operation settles. It does not wait on its own operation/queue or discard a runtime still in use.

After preflight succeeds, a path/agent/global closing scope prevents new matching compact, model, input, load, reload and creation admissions until cleanup completes. Unpublished paths remain represented by their compaction owner, operation queue and construction record rather than relying only on cache enumeration. Creation without an existing path queue is tracked too. Creation admission checks the close before consuming foreground choices. Different paths/agents remain independent unless a global close is active.

Engine disposal acquires the global scope before its first resource mutation and before entering its existing manifest-closing `finally`. Agent deletion acquires its agent scope before foreground switching and holds it through runtime cleanup, agent disposal and tombstone publication; it no longer catches runtime cleanup rejection and continues deletion. Scoped cleanup callbacks avoid recursively reacquiring the same closing scope. The original compact Symbol ownership/finally, scoped recovery, and published hibernation focus/identity guards remain intact.

This policy makes busy refusal occur before destructive effects; it is not a general rollback transaction for unrelated plugin/storage/agent-disposal faults. Permanently pending SDK operations continue to cause busy refusal. Force-abort/streaming behavior was not redesigned. The patch does not add retries, cancellation timeouts or a new queue wait.

V3 evidence is in `/workspace/scratch/xingye-lifecycle-v3-20261008`; `repair.patch` is the complete baseline-to-V3 candidate, `review-delta-v2.patch` isolates the V2-to-V3 changes, and `manifest.json` lists the eight files and exact SHA-256 values. Paths from this container are provenance only; the Library archive is the cross-environment handoff.

| V3 check | Outcome | Receipt |
| --- | --- | --- |
| Fourteen closing regressions against V2 | 14 expected failures | `closing-before.log/json` |
| Expanded synthetic group before final foreground-admission assertion | 42 passed, 15 filtered | `manual-final.log/json` |
| Final targeted snapshot | 54 passed, 10 original concurrency cases filtered; one deletion-fixture suite blocked at collection by missing nested `typebox`; command exit 1 | `focused-final.log/json`, `focused-final-results.json` |
| TypeScript renderer/node/test configurations | Each exits 2 before source checking: TS2688, missing `retry` | `static-checks.json`, `typecheck-*.log` |
| Targeted lint / warning ratchet | Exit 2 / 1 before checking source: missing `brace-expansion` | `lint-targeted.log`, `lint-warning-ratchet.log` |
| Syntax parser | Seven edited TS files, no syntax diagnostics; not semantic type checking | `syntax-check.json` |

The final 54 passes are 42 synthetic manual/lifecycle cases, five existing hibernation unit cases and seven existing model-switch unit cases. V3 adds twenty cases to V2: all-or-nothing busy preflight for A/B/C followed by successful retry after compact success/failure; shutdown failure cleanup; engine resource preservation; actual SDK-factory barriers **before** replacement publication for recovery/fresh close/discard/batch/agent requests; deletion during held compact and after pre-publication creation failure; propagation of unexpected cleanup rejection; closing-first admission; other-path/other-agent progress; an agent-dispose/tombstone barrier; and unpublished creation without a queue. SDK operations remain synthetic. The original ten concurrency tests remain byte-identical and were not rerun under the known dependency block; their earlier fixture failures are not accepted or replaced.

No dependency installation/download, registry/network configuration change, full test, CLI closure generation or persistence fingerprint update was performed for V3. The sole later network operation is the requested official Library upload. The old 403 origin remains unresolved. No umask, Pi, compaction helper, path-safety, CI or release changes are included. The added agent-manager source change belongs to the reviewed destructive caller and must be included in the official guarded-source compatibility review where applicable.

Required next steps remain normal locked dependency installation with a successful receipt, real-SDK and original regression checks, types/lint/ratchet, applicable full cloud tests, official fingerprint compatibility review/generation, independent sol6.1/high cloud review and Mac native acceptance. The candidate remains UNVERIFIED until those steps complete.

## Historical V2 receipt (superseded by V3 above)

V2 status was prepared but incomplete; the three closing gaps above prevent accepting that snapshot. The following sections retain its original evidence.

## V2 repair after static review

The first candidate below was insufficient across two intervals identified in `STATIC_REVIEW.md/json`: the locked SDK awaits `abort()` before setting its compact busy marker, and recovery reload returns a replacement before the helper retries. Before revising production code, three new synthetic abort-window cases failed on that candidate: WebSocket, desktop compact and fresh desktop compact all allowed hibernation to return true during the held abort. This is controlled scheduling evidence, not execution of the real SDK compact implementation.

The coordinator now synchronously reserves a normalized session path in `withSessionCompaction`, before invoking the callback or any SDK await. Admission checks runtime identity, closing/switching state, queued lifecycle work, streaming/pre-prompt state, and both SDK/direct compact state. The reservation persists across old-entry removal, replacement creation, recovery callbacks, retry, and fresh compact's final snapshot refresh. `finally` releases only that operation's reservation on success or failure.

The callback receives a scoped reload bound to the same path and owner. It joins the existing runtime queue; the outer compact does not occupy that queue, so recovery does not await its own compact promise. Public reload cannot supply this owner, and an expired scoped callback is rejected. Hibernation/LRU, explicit restore, model switching and input admission observe the reservation; other paths have independent keys. Coordinated teardown checks ownership, allowing the owner's recovery while rejecting a competing close/discard, and keeps a disposed entry closed until removal from cache.

WebSocket ordinary/instant compact and both engine manual compact methods use the boundary. WebSocket acceptance is sent after reservation succeeds. Two existing route fixtures were updated for the required facade method; no permissive production fallback or dependency shim was added. The published focus, identity and focus-version hibernation behavior remains intact. No compaction helper, Pi adapter/SDK, path-safety implementation, CI/release configuration, package/lockfile, stored schema or migration was changed. All new owner state is in memory.

The follow-up performed no installation, download, network operation, registry change, permission/umask change, full test run, CLI closure generation or persistence fingerprint generation. No explicit tool safety refusal occurred. The existing HTTP 403 origin remains unknown; mirror service, authentication and network policy cannot be distinguished from the retained logs. The independent ustar permission issue remains outside this patch.

## V2 validation and deliverables

Current evidence: `/workspace/scratch/xingye-lifecycle-followup-20261008`. Receipts record exact commands, working directory, UTC start/end and child exit code. Tests use fresh temporary `HANA_HOME`, `HANAKO_HOME` and `PI_CODING_AGENT_DIR`, synthetic sessions, released barriers and drained pending operations; no real user data or secrets were inspected. `repair.patch` and `manifest.json` contain the complete current diff and absolute file paths/SHA-256 values.

| Check | Result | Evidence |
| --- | --- | --- |
| Previous candidate, asynchronous abort window | 3 expected failures: hibernation returned true | `abort-before.log/json` |
| Revised candidate, manual regression group | 22 passed; 15 other cases filtered by this targeted invocation | `manual-after.log/json` |
| Final focused run of four relevant files | 34 passed, 10 failed; 2 additional suites failed collection; exit 1 | `focused-tests.log/json`, `focused-results.json` |
| Three TypeScript configurations | Each exited 2 before source checking: missing `retry` type definitions (TS2688) | `static-checks.json`, `typecheck-*.log` |
| Targeted ESLint / warning ratchet | Exit 2 / 1 before linting: missing `brace-expansion` | `lint-targeted.log`, `lint-warning-ratchet.log` |
| TypeScript parser, five edited TS files | No syntax diagnostics; not semantic type checking | `syntax-check.json` |
| Patch and original-test preservation | Whitespace result and preservation checks recorded in manifest | `diff-check.txt`, `manifest.json` |

The 34 passing cases comprise all 22 added synthetic manual cases, five pre-existing hibernation unit cases and seven pre-existing model-switch unit cases. The new coverage holds an asynchronous abort, a completed coordinator reload before helper retry, and retry itself; exercises all three ordinary surfaces with successful/failed retries; checks competing teardown/reload/model switch/prompt and other-path progress; and covers queued-before-shutdown rejection, failed fresh refresh, expired reload capability and failed recovery creation. Two-second bounds detect operations that do not settle. These tests exercise production admission and recovery with controlled SDK boundaries, not actual SDK/provider execution.

The original ten concurrency cases remain unchanged and fail in `beforeEach` importing the real SDK SessionManager because nested `@earendil-works/pi-ai/node_modules/typebox/index.js` is missing. No lifecycle assertion is reached. `chat-route-switching.test.ts` and `chat-compaction-events.test.ts` fail collection on the same package. These failures are not waived or replaced. The old full-run evidence below predates this revision and cannot validate it.

## V2 acceptance notes (historical)

1. Complete exact locked installation through the authorized environment configuration, including required mirror packages and native SQLite, and retain its successful receipt. No alternate source/network workaround was attempted here.
2. Independently review reservation lifetime, scoped reload, queue interactions, cleanup and callers affected by closing state. No new recursive queue edge was found. Permanently pending SDK compact/abort/shutdown can still keep a path busy; the patch does not release a runtime while its operation remains pending. Force-abort/streaming shutdown semantics were not redesigned.
3. With dependencies complete, rerun final synthetic and original hibernation tests, route/model/compaction suites, all type checks, lint/warning ratchet and applicable full cloud tests. Validate the real locked SDK's abort/busy timing; the asynchronous synthetic stand-in is not SDK acceptance proof. Previously diagnosed residual full-test failures remain separate work.
4. Use the official persistence generator with HEAD overrides for the three changed production sources to reproduce the committed baseline, review final payload differences, use the compatible writer only if justified, and verify idempotence/tripwires. No CLI closure or persistence digest was generated or edited in this follow-up.
5. Parent arranges independent sol6.1/high cloud review and subsequent Mac native acceptance. The candidate stays uncommitted pending that process.

## Historical first-candidate receipt (superseded by the revision above)

The remaining sections retain the earlier setup and failed full-run evidence. Their references to ten added cases, final commands and the first guard-only repair describe that earlier snapshot, not current acceptance.

## Executor and setup receipt

- Cloud executor started successfully on 2026-10-08. The first successful local command was `pwd`, returning `/workspace` (approximately 13:31 UTC).
- Repository: `/workspace/openhanako_replicate`; origin: `https://github.com/wangzihe843-hash/openhanako_replicate.git`.
- Initial branch `work` pointed to main's `85f59fd075f808d172f9c420070d40072527b2af`. Initial tracked and untracked status was clean. No setup changes were overwritten.
- After verifying `git ls-remote`, normal `git fetch origin feature/xingye-mvp` and `git switch -c feature/xingye-mvp d754c6cdf97087259ae93412d512a521f5fd781a` selected the required baseline. HEAD remains that SHA.
- No applicable `AGENTS.md`, repository `.agents/skills`, or workspace skill files were present. Application skills under `skills2set` were not used as coding instructions.
- Node `v24.19.0`, npm `11.9.0`, Linux x64. `node_modules` was initially absent. No successful environment install/start-skill receipt was observed; configuration publication status cannot be inferred from this executor.
- Ran `npm ci --cache /tmp/xingye-npm-cache --no-audit --no-fund`. The lock contains 77 `registry.npmmirror.com` tarball addresses. Download logs returned HTTP 403, for example:

  ```text
  2459 http fetch GET 403 https://registry.npmmirror.com/node-domexception/-/node-domexception-1.0.0.tgz 657ms (cache skip)
  ```

  The npm diagnostic log is `/tmp/xingye-npm-cache/_logs/2026-10-08T13_32_40_105Z-debug-0.log`. Its filename records command start time, not the exact time of each HTTP response. There was no progress after its initial downloads. SIGTERM was sent at 13:41:15 UTC; the still-running installation was terminated at 13:41:58 UTC (exit 137). Dependencies remain partially installed; lifecycle scripts and native installation did not finish.
- No tool approval-review rejection occurred. The download 403s were not bypassed by changing registries, lockfiles, tools, environments, account settings, or system security settings.

## Confirmed defect and repair

While hibernation awaited extension shutdown, its entry remained discoverable without the busy marker checked by model switching. The WebSocket manual compact route did not check that marker either. Three synthetic tests against the unmodified production baseline demonstrated both compact modes reporting success and model switching resolving while the shutdown barrier remained held (`manual-before.log`).

Hibernation now holds the existing `_switching` marker across teardown and releases it in `finally`, following the existing reload/LRU convention. Manual WebSocket compaction checks the same marker before sending `compaction_accepted`. The original model-switch guard therefore also rejects attempts during shutdown. No new operation queue or recursive queue acquisition was introduced. The existing queue, entry-identity checks, focus ownership checks, and focus-version behavior remain intact.

The same issue was then confirmed in the two manual engine entry points, `compactDesktopSession` and `freshCompactDesktopSession`: both invoked the old runtime's `compact` while the shutdown barrier was held (`engine-before.log`). Each now performs the same busy check. These additions address the same manual lifecycle issue, without changing helper, Pi, path-safety, CI, or release code.

Requests arriving during shutdown receive a busy failure and may be retried after restoration. Other session paths remain usable. The patch does not promise that every possible lifecycle interleaving has been exhaustively validated.

## Synthetic regressions

Ten added tests in `tests/session-runtime-hibernation.test.ts` exercise the imported coordinator, WebSocket handler, compaction recovery helper, and real engine facade methods. SDK operations are controlled mocks; the application is not booted and credentials are not loaded. Each test uses a newly created `hana-manual-hibernate-*` temporary directory and synthetic JSONL, drains its tracked operations, and removes the directory. Two-second deadlines detect hanging operations.

Coverage includes ordinary and instant manual compact after shutdown starts, model switching after shutdown starts, both engine compact entry points, operations on a different path, retry on a restored runtime, shutdown rejection, model and compact failure cleanup, the reverse operation-before-hibernation ordering, and successful/failed runtime recovery without recursive queue waits. These are behavioral entry-point tests, not copied lifecycle implementations.

The existing ten real-SDK hibernation concurrency tests were retained. They could not initialize their fixtures in this executor because the installed SDK's nested `typebox` dependency is missing. Their failure is explicitly separate from the ten new synthetic tests passing.

## Validation receipts

Logs are in `/tmp/xingye-lifecycle-20261008` and copied to `/workspace/scratch/xingye-lifecycle-20261008` for handoff. Direct Node invocations used the packages already downloaded by the interrupted install; npm executable links were not yet installed. No dependency shim or test exclusion was added to the repository.

| Check | Outcome | Evidence |
| --- | --- | --- |
| Original production baseline, three new manual regressions | 3 expected failures: both compact modes succeeded during shutdown; model switch resolved | `manual-before.log` |
| Engine entry-point reproduction before their guards | 2 expected failures: old runtime compact was called | `engine-before.log` |
| Final ten added synthetic regressions | 10 passed; 15 other tests filtered out by this targeted invocation | `manual-final.log` |
| Existing real-SDK hibernation tests | 10 fixture-initialization failures due missing nested `typebox`; no concurrency assertion reached | `full-test.log`, `full-results.json` |
| Three TypeScript configurations | Each exited 2: TS2688, missing type definition `retry` | `typecheck-renderer.log`, `typecheck-node.log`, `typecheck-test.log` |
| ESLint | Exited 2 before linting: missing `brace-expansion` | `lint.log` |
| Warning ratchet | Exited 1 before linting: missing `brace-expansion` | `lint-warning-ratchet.log` |
| Official persistence baseline generation | Exited 1: missing `better-sqlite3` native bindings | `persistence-review.log` |
| One full cloud test run | 1,187 files passed, 275 failed, 6 skipped; 12,126 tests passed, 566 failed, 39 skipped; exit 1 | `full-test.log`, `full-results.json`, `full-test-summary.json` |
| Whitespace / patch check | `git diff --check` passed | Final worktree check |

The full run took 439.61 seconds and used the repository's normal test exclusions with `--maxWorkers=2`, default and JSON reporters. `HANA_HOME`, `HANAKO_HOME`, and `PI_CODING_AGENT_DIR` pointed to dedicated temporary test directories; no real user data was inspected. The full run began before the two later engine guards/tests were added, so it is **not** an acceptance run of the final patch. The final targeted run covers those additions. No full rerun was attempted with the same known dependency failures.

Of the 566 failed test assertions, 388 reported missing SDK `typebox`, 146 reported missing SQLite bindings directly, and others include downstream startup or fingerprint assertions. There were also 225 failed files that could not collect tests. All failures have not been independently attributed to the environment; the full run is failed, not waived. `full-test-summary.json` retains categorized first failure messages and all 39 skips. Native Mac launcher/daemon/seatbelt checks and Windows smoke checks are among the skips. No actual failed assertion's first error was a loopback permission denial in this run; negative-test log messages containing EPERM/EACCES are not being counted as platform denials.

The full run generated a large change to `build/cli-runtime-closure.json`. That file was clean initially and was restored to HEAD after the run; it is not part of this patch. The known main-only AtomGit workflow issue was not modified.

Final targeted command:

```sh
node node_modules/vitest/vitest.mjs run tests/session-runtime-hibernation.test.ts \
  -t 'manual operations during runtime hibernation' --reporter=verbose
```

## Persistence review and remaining acceptance work

The intended change concerns only runtime admission and an in-memory busy flag; it adds no stored field, JSONL record, SQLite DDL, schema version, or migration. DATA_EPOCH is unchanged. However, guarded source fingerprints will need the official compatibility review/repin after dependencies work. The existing fingerprint was deliberately left untouched: the official generator failed while opening its temporary real SQLite store, before it could reproduce the committed baseline. No digest was manually edited and no check was weakened.

After the environment setup is successfully installed/published, the parent should:

1. Complete the exact locked dependency installation through an authorized environment configuration; verify its receipt and native modules. This task did not change dependency sources or request new permissions.
2. Rerun the final targeted tests, all existing hibernation regressions, model/compaction/route tests, all three type configurations, lint, warning ratchet, and applicable full tests.
3. Use `generatePersistenceSchemaFingerprint` with HEAD source overrides for `core/session-coordinator.ts`, `core/engine.ts`, and `server/routes/chat.ts` to reproduce the committed baseline, then compare the final generated payload. Inspect all differences, record compatibility reasoning, run the official writer with `--classification compatible --compatibility-reason ...`, and verify idempotence and persistence-tripwire tests. Do not substitute hand-edited hashes.
4. Arrange the requested independent sol6.1/high cloud review, then Mac native acceptance when the Mac is available. The current patch remains uncommitted and is not ready to be labelled fully accepted.
