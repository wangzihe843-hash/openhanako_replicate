# Windows Cloud Recovery Validation

Status: Windows validation passed, with the retained first-run timeout and
baseline limitations below. Source publication is restricted to the audited
120 paths on `origin/feature/xingye-mvp`.

The recovery increment is integrated and four bugs found during real Windows
EXE acceptance have focused regressions. The current 119-path source lock was
created on 2026-10-04 at 13:57:19 UTC. Persistence/closure checks and all 18 final
Windows gates passed. The newly built EXE then passed all 37 acceptance checks
across four actual desktop launches, finishing at 15:05:28 UTC.
Earlier builds remain historical evidence, not the basis of final acceptance.

## Integration And Preservation

- Target branch: `feature/xingye-mvp`; origin:
  `https://github.com/wangzihe843-hash/openhanako_replicate.git`.
- Audited starting HEAD and origin tip:
  `a8e2d9d96ada9b5f5f775588fa2ab0d3e228246e`.
- Recovery ZIP: `openhanako-cloud-regression-recovery-checkpoint-20261002.zip`,
  2,114,242 bytes, SHA-256
  `e148e7dab2f4ba9e0817ca1ef7a3bc28eafc97f6b28b72691f0c612f52b9b72d`.
- All 103 initial overlay files matched their manifest byte for byte. The extra
  tracked `lib/session-jsonl.ts` preimage differed only in checkout line endings;
  its HEAD blob and normalized content matched.
- A recoverable backup preserves all 115 initially dirty files, patch preimages,
  index, binary diffs and a verified HEAD Git bundle outside the repository.
- Only the checked 32-file increment was applied with `git apply`. All 116
  resulting source hashes matched the recovered manifest before the fixes below.
  No whole-directory overlay, reset, clean or unknown-file overwrite was used.
- Final scope is 119 frozen source paths plus this audit document: 120 intended
  commit paths. The 12 unrelated pre-existing untracked files remain unchanged
  and excluded. Raw logs, screenshots, test homes and build products are excluded.
- Pi remains 0.87.1; root dependency manifests are unchanged. Lock SHA-256:
  `ad79e12e80571711fdfd823f4ddf32fbd755ea93f337a438e85fc72a9a5181ae`.
- Scope audits also check for unexpected dirty paths and credential-shaped
  values. The three matches were inspected and are explicit synthetic scrubber
  fixtures, not production credentials.

## Windows Acceptance Fixes

1. **Model configuration EPERM.** Pi registration starts asynchronous readers
   of models.json. The previous order could synchronously replace that file
   before those readers completed on Windows. ModelManager now publishes the
   projection before SDK registration and awaits registry refresh at startup.
   The real ModelManager regression reproduces the old failure and verifies
   publication ordering and refreshed availability. No ACL or security-tool
   change is involved; Pi remains 0.87.1.
2. **Expression adoption after SDK metadata.** A latest reply followed by valid
   model_change/thinking_level_change records was incorrectly considered
   historical. Generation/adoption now preserve and reappend only valid SDK
   metadata alongside the existing custom suffix. Fingerprints still reject
   intervening changes. Tests cover metadata preservation and stale adoption.
3. **Session-scoped tool grants.** The desktop coordinator omitted getSessionPath
   when building tools. Capability lookup consequently could not find the owning
   session and refused an explicitly granted channel.post. The tool set now
   closes over its own existing path reference. The regression loads two
   sessions and verifies their independent paths/grants. The red focused run
   had 107 passes and one failure; the fixed run passed all 108. No global grant
   or permission-policy relaxation was added.
4. **Stable-ID retry dispatch.** The provider guard is installed with the
   sessionId runtime-map key but previously looked it up as a file locator.
   This yielded a null identity and rejected a real task retry before dispatch.
   It now uses the owning entry's sessionId, retaining legacy locator fallback
   and strict mismatched-owner rejection. The test uses a locator-aware
   manifest double, covers both key forms, and rejects different agent/session
   identities before provider dispatch or lineage persistence. Red: 49 passed,
   one failed with the exact EXE error. Green: all 50 ownership/retry cases passed.

Compatible receipts were regenerated only with the project's official generators.
They still describe 65 stores, 890 discovered sites, 8,590 closure files and the
existing one-edge boundary baseline. DATA_EPOCH remains 1. Current payload:
`sha256:28e367906e3c5f22d4ea2ccb1d078f46142c31f65ab33d99ec7a6752ad344990`.

## Current Windows Gates

Windows x64, Node 24.15.0. Jobs use isolated home/application-data/temp directories;
model credentials are not inherited. Test scope, assertions and deadlines are
unchanged. The complete suite uses one worker, the configuration that passed the
previous full run on this 16 GB host.

| Gate | Fourth-fix result | Evidence |
| --- | --- | --- |
| Focused ownership/retry regressions | 50/50 passed | 2026-10-04T13-52-21-230Z |
| Session permission/tool regressions | 108/108 passed | Same focused run |
| Types, lint and boundary before resealing | Passed | Same focused run |
| Official receipt regeneration | Passed | 2026-10-04T13-56-34-312Z |
| Persistence/closure checks after freeze | 58/58 passed, 159.182 s | 2026-10-04T13-57-19-412Z |
| Complete Windows suite | 15,117 passed, 0 failed, 41 skipped; 1,919.874 s | Same post-freeze run |
| Final three typechecks, lint and boundary | Passed; 0 new lint warnings, 0 errors | Same post-freeze run |
| Windows opt-in manual cases | 6/6 passed | Same post-freeze run |
| Packages, client, server and seed | Passed fresh build | 2026-10-04T14-34-21-759Z |
| Standalone, standalone smoke and MinGit | Passed | Same fresh build run |
| Electron shell and NSIS, publish never | Passed, 186.163 s / 223.063 s | Same fresh build run; no install/release |
| Packaged server and desktop lifecycle smokes | 10/10 server checks; desktop lifecycle passed | Same fresh build run, 40.998 s / 57.538 s |
| Open composition build and smoke | Passed; smoke required one unchanged rerun | Build run above; smoke 2026-10-04T15-01-02-178Z |
| Real newly built Windows EXE | 37/37 passed, four launches | packaged-acceptance-final; completed 15:05:28 UTC |

The current complete suite's JSON confirms 41 skips: six opt-in Windows cases,
separately executed and passed, plus 35 platform-specific permission/symlink/POSIX
cases. The full suite ran from 13:59:58 to 14:31:58 UTC on 2026-10-04.
The lint ratchet reports 7,861 existing warnings, zero added, 20 removed and zero
errors. All three TypeScript project checks passed.

The final proof, generated at 15:02:11 UTC, ties all 119 frozen paths to 18 fresh
successful gates and nine artifact hashes. Each real EXE launch additionally
verified seven selected installed server/runtime files, including the compiled
bundle and all three Pi 0.87.1 package manifests. The three-fix proof was archived,
not reused. Selected final SHA-256 hashes are below; the proof records all nine.

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| dist/win-unpacked/HanaAgent.exe | 226,990,080 | `2f95deff20cfb2b5c914eea267ebb31e704362201b47c75d02ea8e2506c06ee0` |
| dist/win-unpacked/resources/app.asar | 87,281,461 | `2049849ffde5e8f366724a95323f6c8b29439474d9b73874a4709ff8a6aaac46` |
| dist/HanaAgent-0.450.0-Windows-x64.exe | 858,428,348 | `d4dfdc4091cb30098b7783c7b08e9fea88eb8b48fe3d170e7c1b5221735879e1` |
| seed/server-0.450.0-win32-x64.tar.gz | 393,406,286 | `bc5c79df06604f07285ea893874c440bfd29deddeade65f521c73f4ce2868647` |
| dist-standalone/HanaCore-0.450.0-Windows-x64.tar.gz | 435,124,675 | `5b1b68bd452c335820ce528a29c5d2ef56352a0fe508bee3ffdfffaeda9493dc` |

## Actual EXE Acceptance

The program under test is `dist/win-unpacked/HanaAgent.exe`, not a development
server or an old installed copy. Each fresh attempt uses a new isolated home,
loopback-only deterministic model provider and synthetic credentials. Real GUI
interactions and authenticated APIs of the packaged server are both used; this
does not imply that every assertion is a GUI click.

Electron 42.3.0 / Node 24.15.0 run without --no-sandbox or a development Node
override. Process inspection verifies the installed hana-server.exe beneath
hana-win-sandbox.exe. Owned desktops/controllers/servers are shut down normally
between cold-recovery stages. Fault preparation occurs only after they exit.

The final fourth-fix run passed all 37 assertions, including every cloud-repair
group below. Desktop PIDs were 10728, 36828, 14404 and 1184; each has its own
runtime proof. All four desktops/controllers exited normally, and the final
server-info.json was absent after shutdown. Screenshots from this run were
visually checked, including successful cold retry and unknown-receipt refusal.

| Cloud repair | Passed actual Windows evidence | Stage |
| --- | --- | --- |
| 1. Stable original effect through repeated retry | New successful tool calls return the original committed receipt; cold retry and unknown-receipt refusal do not duplicate the effect | taskRetry, taskRetryCold, taskRetryUnknown |
| 2. Child scope survives rollback | Inherited-history edit retains child scope and leaves the parent unchanged | fork |
| 3. Derived/old-cache memory scrubbing | Actual prompt excludes synthetic secrets; raw artifact/provenance remain unchanged; invalidated source is excluded | memoryProjection |
| 4. Writable default settings partition only | Settings snapshot excludes hidden private partitions | pins |
| 5. Default pin replacement preserves private entries | Author and character entries remain intact | pins |
| 6. Current model policy | Disabled model rejects expression generation before provider dispatch | modelPolicy |
| 7. Current scoped expression prompt | Fresh pin appears, request is tool-free and uses an independent cache key | variants |
| 8. Adoption cold rollback | Original answer recovers after injected interrupted adoption; subsequent fork uses recovered history | coldCheck |
| 9. Retry/edit cold rollback and retry/adoption composition | Original history/scope recover and fork correctly; successful effect retry followed by expression adoption retains one effect | coldCheck, taskRetryCold |
| 10. Bulk private pin partition boundary | HTTP 400 before either partition changes | pins |

Acceptance also covers story/reality and director/character scope saves,
preview/discard/adoption, cancellation and late-result suppression, pin
partitions, model catalog saves, preservation of SDK metadata, and persisted
history/scope across actual desktop restarts.

The user explicitly approved channel.post for the synthetic task session. The
application grant is per session, not per target; the harness additionally
requires exactly one fixed local fixture channel and fixed synthetic content.
No alternate provider or global permission mode bypasses a refusal. No real
external message, payment or production-data mutation is involved.

A retry only passes if a **new** successful channel tool invocation returns the
same effect identity and committed receipt, not merely if a denied call leaves
the count unchanged. Unknown-receipt retry must remain an error/unverified result
without a new effect or attempt. After the fault case, the exact synthetic
receipt backup is restored offline and verified by a further real restart.
These checks exercise the channel.post pilot, not arbitrary tool idempotence.

## Retained Failed Attempts

All times below are UTC. Failed logs and later passes are retained separately.

- The initial full suite had 15,099 passes and 11 failures. Nine fixture-audit
  failures came from a harness temp path containing a `tests` segment. Changing
  it to `phase-tests` required no product/assertion change. Two unchanged
  server-home cases exceeded their 15-second first-load deadline. A 27-case
  isolated rerun and the complete four-worker 15,110/0 rerun passed.
- The first two Windows bug reproductions had 39 passes and two failures.
  An intermediate model fix still hit EPERM; the completed fix passed 41/41.
  The next full run had 15,104 passes, nine failures and 41 skips: seven stale
  persistence fingerprints and two unchanged server-home timeouts. Official
  receipt regeneration and focused checks passed, then the two-worker suite
  passed 15,113/0 with 41 skips.
- Electron builder initially could not create two macOS dylib symlinks while
  extracting winCodeSign-2.6.0.7z. No protection or signature check was disabled.
  After explicit user approval, one UAC-elevated extraction/build succeeded.
  Later shell/NSIS builds reused that cache under the normal user. Desktop
  acceptance itself was not elevated.
- Full-server and open-server smokes in several rounds exceeded the original
  60-second startup deadline; unchanged reruns passed. In the three-fix round,
  server smoke passed 10/10 in 28.440 seconds on rerun; open smoke passed positive
  and missing-asset negative checks in 72.617 seconds total. The underlying
  first-load latency is unattributed. Cold-start performance stability is not
  certified, and the failed starts are not erased by a passing rerun.
- The superseded two-fix EXE recorded 30 passing assertions and three harness
  failures caused by navigation/model-reselection timing. UI stages were then
  serialized and made to await the correct session transcript. Effect checks
  were not counted as passed while user permission was pending.
- After explicit permission, the pre-third-fix EXE refused the tool with
  TOOL_APPROVAL_UNAVAILABLE and zero effects. This led to fix 3.
- After the user's network interruption/reboot, the three-fix full run had
  15,113 passes, one failure and 41 skips: an unchanged storage-contract source
  scan exceeded 10 seconds. Its four cases passed unchanged in 264 ms alone.
  A subsequent two-worker full run was stopped after five failures across
  wikiquote, open-library and agent-switch route tests, whose first imports took
  14-22 seconds. Its partial log is not a complete result. Only its verified
  owned process tree was stopped. All four affected files passed 29/29 alone.
  The unchanged single-worker suite then passed 15,114/0 with 41 skips.
- That three-fix build passed all 18 gates. Two new EXE harness attempts failed
  because the deliberate catalog-disable test did not restore the agent default:
  restoring only an existing session was insufficient, and the next foreground
  choice intentionally does not affect detached sessions. The harness now
  restores the saved default via the identity-addressed agent settings API.
  Product model policy was not changed.
- The next real EXE performed one approved local effect with a valid receipt,
  then its first UI task retry failed with effect_retry_scope_mismatch before
  provider dispatch. No second effect occurred. This led to fix 4, reproduced
  by the 49/1 red test run and followed by the 50/0 green run. The three-fix
  build and all its acceptance evidence are explicitly archived as superseded.
- The fourth-fix build's first open smoke timed out in the positive startup
  race at the unchanged 60-second limit (60.875 seconds total). Cleanup was
  verified: no matching open-server process remained, the required asset was
  present, and no negative-test backup remained. The identical command passed
  both positive and missing-asset negative checks on rerun in 65.198 seconds
  total. No source, assertion or deadline changed. All 37 subsequent final EXE
  assertions passed without an acceptance rerun.

## Limits And Follow Up

- NSIS is built but installation/uninstallation is not tested. The unpacked
  EXE is the real desktop under test. The EXE/installer are not Authenticode
  signed; the ephemeral seed key does not certify production signing or OTA
  trust. The production OTA manifest is rejected by the fixture trust set as
  expected, and no update is installed.
- The deterministic provider validates plumbing/isolation, not external-model
  quality. It does not generate the automatic rolling-summary schema, so its
  summary-format warnings are not a passed memory-summary quality test.
- The three-fix EXE also logged a shutdown summary ENOENT with a stable sessionId
  interpreted as a path. The notifySessionEnd(key)/notifySessionEnd(sessionPath)
  caller pattern and stable-ID runtime-map key already exist in baseline
  a8e2d9d. This background-memory cleanup path is unchanged and remains a
  separate follow-up; scoped-memory acceptance does not certify it.
- In the final unknown-receipt screenshot, the card correctly shows unknown
  execution and unverified receipt status, but its generic channel subtitle
  still says the message was saved locally. That subtitle and its binding in
  TaskOutcomeCard.tsx already exist in baseline a8e2d9d and were not changed.
  This UI-copy ambiguity remains a follow-up; acceptance relies on the explicit
  unknown/error status, HTTP 404/unverified receipt, and unchanged effect count.
- Windows' remaining platform skips, original lint warnings and one-edge
  boundary baseline are disclosed, not silently treated as absent.
- Historical Linux/cloud results (15,136 passed, 15 skipped; packaged smoke
  10/10) and the previous build's UI results are reference only.

## Evidence Index

Raw evidence lives outside the repository in the local
`openhanako-recovery-20261003` directory. It is not part of the source commit.

| Evidence | Location within that directory |
| --- | --- |
| Original backup and overlay verification | premerge-backup/manifest.json, saved patches/index/Git bundle; merge-verification.json |
| Initial tests, focused rerun, complete pass | validation/2026-10-03T14-10-35-231Z, 14-28-21-892Z, 14-30-16-658Z |
| First build and server smoke attempts | validation/2026-10-03T14-44-34-054Z, 15-08-57-713Z, 15-10-41-890Z |
| Desktop/open attempts and approved UAC build | validation/2026-10-03T15-11-35-107Z, 15-16-53-140Z, 15-46-41-787Z |
| Initial actual EXE | build-proof.json; packaged-acceptance |
| First Windows fixes, red/intermediate/green | validation/2026-10-03T16-42-20-689Z, 16-44-07-513Z, 16-47-20-240Z |
| Two-fix reseal/full/build/runtime runs | validation/2026-10-03T16-49-00-098Z, 17-08-53-711Z, 17-14-57-482Z, 17-37-37-271Z, 18-03-39-977Z, 18-08-59-052Z |
| Archived two-fix proof and acceptance | build-proof-final.json.before-permission-fix; windows-source-lock-final.json.before-permission-fix; packaged-acceptance-final.before-permission-fix |
| Permission regression red/green/reseal | validation/2026-10-03T23-31-01-369Z, 23-33-14-145Z, 23-39-50-020Z |
| Resumed three-fix gates and scan rerun | validation/2026-10-04T11-49-47-025Z, 12-17-32-727Z |
| Aborted rerun and unchanged focused pass | validation/2026-10-04T12-18-10-761Z, 12-26-04-544Z |
| Three-fix complete pass/build/smokes | validation/2026-10-04T12-26-45-284Z, 12-58-19-427Z, 13-26-33-145Z, 13-32-25-276Z |
| Archived three-fix proof, lock and EXE | build-proof-final.json.before-retry-identity-fix; windows-source-lock-final.json.before-retry-identity-fix; packaged-acceptance-final.before-retry-identity-fix |
| Model-default harness failures | packaged-acceptance-final.model-selection-failure; packaged-acceptance-final.pending-model-failure |
| Fourth-fix red/green, reseal and full gates | validation/2026-10-04T13-50-31-747Z, 13-52-21-230Z, 13-56-34-312Z, 13-57-19-412Z |
| Final fresh builds and retained open-smoke timeout | validation/2026-10-04T14-34-21-759Z |
| Unchanged open-smoke rerun | validation/2026-10-04T15-01-02-178Z |
| Final source/build/artifact proof | build-proof-final.json; windows-source-lock-final.json |
| Final 37-check EXE acceptance and four runtime proofs | packaged-acceptance-final/results.json, orchestration.json, runtime-proof-10728.json, runtime-proof-36828.json, runtime-proof-14404.json, runtime-proof-1184.json |
| Current source lock and scope audits | windows-source-lock-final.json; timestamped final-scope-audit-*.json |
| Original detailed audit narrative | windows-audit-before-consolidation.md |
| Final screenshots | Ignored repository output/playwright/cloud-regression-final-20261004-r5; ten PNGs |
| Superseded screenshots | Ignored repository output/playwright/cloud-regression-final-20261004 and -r2/-r3/-r4 |

All current gates and actual EXE requirements above have passed. The publication
procedure stages only the audited 120 paths, rechecks both origin URLs and the
branch/tip, uses a non-force push to origin/feature/xingye-mvp only, then verifies
the remote commit and preservation of the 12 unrelated files. The resulting
commit is identified by Git history and the external publication receipt, not
by a self-referential hash in this document. No release or main-branch change
is authorized by this validation.
