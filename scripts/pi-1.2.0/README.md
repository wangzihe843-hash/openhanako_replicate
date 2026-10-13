# Pi 1.2.0 preparation checkpoint

This review branch keeps the working dependency baseline at **1.0.3**. It is not
an accepted dependency upgrade. Baseline commit:
`1c715cbb502ffcf2e2d5de264903a3df67fc4420`.

The upstream release is `v1.2.0` at
`06a466935536f8c9bcacb2d5efc0fc021be1bdff`. The seven package publication cooling
periods finish after `2026-10-13T23:03:25.459Z`; activation is deliberately held
until `2026-10-13T23:04:00Z` (October 14, 07:04 Beijing time). Keep `.npmrc` intact
and use npm >= 11.10.0. Do not install candidate packages before this boundary.

## Prepared changes

- A version-bound `lib/pi-sdk/run-lifecycle.ts` keeps Pi's reviewed run loop and
  extends its startup failure cleanup over Hana's preflight callback. It does
  not retry input or wait on its own idle promise. Suspended hooks remain
  suspended until they return; abort fences their late input.
- The coordinator separates startup busy state from a newly persisted input.
  A cancelled preflight cannot synthesize `turn_end` for the previous turn.
  `handled` and `queued` preflight reports do not commit Hana input side effects.
- Raw credential get remains asynchronous. Only exact Pi 1.2.0 disables Hana's
  outer acquisition retry, leaving upstream's 10 synchronous / 6 asynchronous
  total attempts. Callback/read/write failures remain visible; deletion still
  shares the refresh lock.
- The Windows driver installs the pinned old adapter's 1.0.3 lock in a separate
  directory. The candidate uses its own dependency tree, with versions and paths
  in the evidence. Portable fixture success is not native Windows acceptance.
- `candidate.patch` contains only the version-bound activation: three direct
  dependencies and seven overrides at exact 1.2.0, the version guard, removal of
  the obsolete chord packaging constraint, and the persistence version assertion.
  `candidate.json` seals patch/file hashes and the reviewed npm integrities.

The extracted `_startRun` test fixture and adapted loop originate from Pi's
[MIT-licensed source](https://github.com/earendil-works/pi/tree/06a466935536f8c9bcacb2d5efc0fc021be1bdff).
The copyright notice is in `tests/fixtures/pi-upstream-LICENSE.txt`. This source
harness exposes the original busy/idle failure; it is not installed-SDK proof.

## Continue after the cooling period

Fetch the exact checkpoint SHA supplied with this branch's handoff, verify it,
and continue on `review/pi-1.2.0-prep-20261013`. Preserve unrelated local edits.
Do not merge into or push to `feature/xingye-mvp` until independent acceptance.

```sh
git rev-parse HEAD
git status --short
node scripts/pi-1.2.0/activate.mjs --check
node scripts/pi-1.2.0/activate.mjs --apply
npm install --package-lock-only --ignore-scripts
npm ci
node scripts/patch-pi-sdk.cjs
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-codemode @earendil-works/pi-mcp @earendil-works/pi-telemetry @earendil-works/pi-tui --all
```

Inspect the lock diff: all installed copies of the seven Pi packages must be
1.2.0, and their `integrity` must match `candidate.json`. Stop on drift. The lock
is intentionally regenerated after cooling, never hand-fabricated. New non-Pi
transitives must also satisfy npm's cooling policy.

Run the real integration, auth rotation, tool-once, stream-guard, Azure,
cache-preserving compaction and prefix tests. The candidate-specific tests must
run instead of skip. Verify both user and custom `before_agent_start`, callback
rejection, hung-hook stop, no prior-turn binding, next input, and idle settlement.
Check persistence schema changes against the old v3 JSONL fixtures before
regenerating its fingerprint. There is currently **no evidence requiring a
DATA_EPOCH migration**; do not increment it solely for a dependency version bump.

```sh
node node_modules/vitest/vitest.mjs run tests/pi-sdk-run-lifecycle.test.ts tests/pi-sdk-runtime-integration.test.ts tests/pi-sdk-auth-acquisition-budget.test.ts tests/pi-sdk-auth-storage-concurrency.test.ts tests/pi-sdk-version-guard.test.ts tests/session-coordinator.test.ts tests/session-retry-memory-scope.test.ts tests/desktop-session-submit.test.ts
# Only after reviewing the actual candidate's persistence contract:
node scripts/generate-persistence-schema-fingerprint.mjs --classification compatible --compatibility-reason 'Reviewed Pi 1.2.0 JSONL v3 compatibility, old-session reopen and persistence tests; no stored shape migration required.'
npm run typecheck
npm run lint:warnings
npm test
npm run build:client
```

Run ordinary CI on the exact candidate commit, including native Windows
`node scripts/probe-windows-auth-lock.mjs` with Node 24.15.0, and server packaging
gates. Have a separate 6.1-sol/high reviewer assess the exact final SHA. Any real
SDK, Windows, fingerprint, install, build or CI failure remains a merge blocker.
This preparation makes no changes to the existing MCP issuer validation.

## Preparation validation (installed Pi 1.0.3)

On macOS arm64, Node 24.21.0 / npm 11.19.0:

- Full `npm test`: **1,472 files passed**, 4 skipped; **15,915 tests passed**,
  35 skipped. Seven skipped tests specifically require an installed Pi 1.2.0;
  they are not represented as accepted candidate behavior.
- `npm run typecheck`, `npm run lint:warnings` (0 added warnings, 0 errors),
  `npm run build:client`, the SDK guard and open-source boundary lint passed.
- The source-level lifecycle regression includes the unchanged upstream failure,
  callback rejection, user/custom suspended-hook abort, no previous-turn binding,
  next input, and non-replayed queued persistence.
- The baseline persistence fingerprint was regenerated with an explicit
  compatible review. The baseline dependency manifests and `.npmrc` are unchanged.

The first full run was sandbox-limited (loopback listen denied and Electron
launch blocked). The passing full run used formally approved local-test
permissions. Native Windows, installed Pi 1.2.0, the future candidate lock and
fingerprint, and remote CI remain pending. This is a recoverable preparation
checkpoint, not a statement that the upgrade is ready to merge.
