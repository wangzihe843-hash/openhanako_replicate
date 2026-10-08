# macOS desktop integration persistence review — 2026-10-08

Classification: **compatible**. `DATA_EPOCH` remains **1**. This review covers the runtime lifecycle, macOS pet, shortcut recording and microphone-entitlement integration over local HEAD `12a9037756d5680fd725cec3a1679e1ce2ba56fd` on `feature/xingye-mvp`. It does not use remote `524424c8` as a substitute for that newer local baseline.

## Exact evidence and source identity

The independent Mac full run completed with 15,498 passing, seven failing and 11 skipped tests. All seven failures belong to `tests/persistence-schema-tripwire.test.ts` and have the same stale review/payload cause. The supplied read-only official generation reproduces a different payload solely because the guarded `desktop/main.cjs` executable source changed. The independent baseline-source override restores the committed payload.

- Committed payload: `sha256:46c6b5b23726b284ee91ea73fe5ac6caaa0bb587db26dd5df964e17f9a4418a6`
- Expected final payload from the supplied official generation: `sha256:c8d6907fdf919c0aef2ebdd6d9e0521ffe3d1a787e6a45fe1ebcb7f49a335320`
- Final integrated `desktop/main.cjs` file SHA-256: `84f6b11701a849f5e3de753f372df9d7f25cf6ebf651c76a3605af113f490dbb`
- Final `desktop/src/shared/pet-window-state.cjs` file SHA-256: `1ffa98506de8ec9b00a81f00dec1a1d6641af1784968f66654be17c88fa257cf`
- Final `desktop/src/shared/artifact-boot.cjs` file SHA-256: `f42459125c8fc4742c7c53f0630a4c5e95e76c5e2112eb85b7768cd4543e5f78`

The only substantive fingerprint delta is the `sourceHash` of `desktop-window-version-state`, whose canonical source is `desktop/main.cjs`: `sha256:9060b1d872922624b837eb1df2e4f0e8aec7722eeacba11d5553ef328b92eef3` becomes `sha256:0210cc68200835fe515a03b55d56576f1007762d28e4ed684d016e5cfae9bb70`. The payload seal and explicit review seal change accordingly. The previous compatible-review reasoning is preserved and this review is appended.

The source digest deliberately covers the whole executable parse tree of the owner module. Lifecycle edits therefore demand review even when disk formats do not change. The digest algorithm, generator, source exclusions, registry and every test assertion remain unchanged.

## Store-local compatibility reasoning

`desktop-window-version-state` remains optional shell-local presentation/update metadata, separate from durable agent and session identity.

- **Main window:** `user/window-state.json` keeps the existing bounds and `isMaximized` shape, JSON reader and serialized writer
- **Quick Chat:** `user/quick-chat-window-state.json` keeps the existing bounds, `chatWidth` and `chatHeight` handling, preservation of prior fields and fallback behavior
- **Release bookmark:** `user/last-seen-version.json` keeps its existing `{version}` format and announcement reader; no new bookmark is introduced
- **Pet window:** `user/pet-window-state.json` remains version 1 with `bounds`, `visible`, `paused`, `clickThrough` and `alwaysOnTop`. Defaults, option normalization, JSON layout, per-process temporary path, write/rename ordering and failed-temp cleanup are unchanged. macOS now writes this existing presentation contract; the reader remains unchanged. An absent state file still uses existing defaults
- **Runtime lifecycle:** choosing a compatible renderer for an authenticated reused server and reconnecting browser commands with current port/token/generation changes process coordination. The patch introduces no new version of the reviewed window state or release bookmark
- **Other two integration areas:** shortcut capture records existing accelerator strings; the audio entitlement changes packaging capability. Neither introduces a persistence store or changes this schema contract

The supplied baseline/generated payloads were validated independently with the unchanged generator's pure payload/review validation functions. After removing the single reviewed source digest and its payload seal, the payloads compare exactly. Registry and ownership, write-site mappings, exclusions, all other guarded sources, SQLite DDL and `userVersion`, `DATA_EPOCH=1`, TypeScript 5.9.3 `parse-tree-v1` provenance, Pi 1.0.3 package identity/integrity and JSONL version 3 are identical.

No migration or epoch bump is required for this compatible presentation-state/lifecycle integration. This is not a general downgrade guarantee or approval of unrelated writes.

## Review checks

Cloud review verified the supplied transfer and each of its 18 file hashes. The exact integrated main source equals the reviewed runtime-plus-pet patch result. Twelve relevant readers, writers, bounds helpers and option normalizers are byte-identical across the original/runtime-plus-pet reference comparison. Twenty-four paired persistence cases execute the actual pet source section with mocked filesystem/timers: missing and malformed state, existing version-1 and legacy options, negative-display bounds, unknown fields, successful atomic rename and failed-rename cleanup. Existing Windows behavior is unchanged and Darwin uses the same persisted bytes.

These are source/compatibility checks, not a substitute for the complete generator on the final Mac tree, real Vitest, native GUI, signing or packaging acceptance. No production source, dependency, lockfile, permission, OS setting or test expectation is modified by this repin.

## Required final-tree regeneration

The review delivery contains an **expected-only** fingerprint snapshot and its exact compatible-review text. That snapshot is derived from the supplied official Mac-generated payload; it is not described as a fresh full cloud generation. Do not copy it over the repository record or apply hand-written fingerprint hunks.

After the source above is frozen and local continuation is authorized, invoke the existing writer from the repository root, using the supplied review text:

```sh
node scripts/generate-persistence-schema-fingerprint.mjs \
  --classification compatible \
  --compatibility-reason "$(cat /absolute/path/to/delivery/compatibility-reason.txt)"
```

The generated record must match the supplied expected-only snapshot byte-for-byte and keep the exact expected payload above. If any source, parser, store, registry or dependency produces an additional difference, stop and review it instead of changing the expected hash. Run the official writer again and verify byte-for-byte idempotence.

Then run the unchanged schema/registry/startup guards:

```sh
npm test -- tests/persistence-schema-tripwire.test.ts tests/persistence-store-registry.test.ts tests/persistence-startup-receipt.test.ts
npm test
npm run typecheck
npm run lint
```

Recheck that the 19 integrated candidate files, package/lock and protected baseline receipts remain unchanged. Any later executable edit to `desktop/main.cjs` invalidates this seal and requires renewed generation/review. This document records the review and required checks; it does not claim those post-repin checks have already passed or authorize a commit, push, permission grant or deferred helper/security branch.
