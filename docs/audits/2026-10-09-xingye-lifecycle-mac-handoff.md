# Xingye lifecycle: cloud acceptance and Mac handoff

The cloud code gates have passed for this candidate, based on feature/xingye-mvp at `d754c6cdf97087259ae93412d512a521f5fd781a`. Mac native acceptance remains pending. The earlier audit documents retain their historical UNVERIFIED receipts; this document records the later successful cloud verification and supersedes those pending cloud statuses only.

## Change and behavior

Manual compaction owns its session path before asynchronous SDK work and retains ownership across recovery/reload/retry. Closing admission rejects conflicting work before cleanup and keeps its path/agent/global scope through cleanup. Model switching checks closing again after asynchronous load. Busy conflicts fail with session_busy and can be retried once the owner settles. Other paths remain independent. Original hibernation entry identity, focus identity/version and late-teardown protections remain. This is not a general rollback guarantee for unrelated disk/plugin failures; an SDK operation that never settles remains busy.

The separate ustar repair restores the existing 0644/0755 permission contract after writes, including empty files, under restrictive umask. It does not alter archive path/type/content contracts. Official persistence generation classified the source changes as compatible; DATA_EPOCH stays 1, with unchanged stored schemas/migrations/Pi JSONL format.

The final smoke-only increment isolates its child OS home within its temporary application home. It does not precreate the home, Desktop or workspace: production first-run initialization creates them, and the positive smoke asserts the result. The negative smoke still requires a nonzero exit attributable to a deliberately missing required template and restores that template. Parent OS-home settings and production safety boundaries are unchanged.

## Independent cloud verification

- Full suite, 2026-10-09 03:38:17–03:48:05 UTC: 15,639 passed, 0 failed, 39 conditional skips; 1,462 passed files and 6 wholly skipped, 1,468 files total.
- Independent focused lifecycle/real locked SDK/ustar/persistence checks: 124 passed, 0 failed, 0 skipped, including the original ten concurrency regressions. SDK tests use synthetic providers and in-memory auth; no real model service acceptance is implied.
- Renderer/node/test typechecks, lint, warning ratchet and boundary passed. Warning baseline unchanged: 7,820 warnings, 0 errors, 0 additions and 61 removals; one existing tracked boundary edge, no new debt.
- Packages/client and applicable full/open server bundle builds passed. The official open build uses pinned packaged Node 24.15.0. Signed installer/release distribution was not certified.
- Official persistence scanner/generator ran twice with byte-identical fingerprint, inventory and startup receipts. Independent baseline/candidate comparison found only three intended guarded source-hash deltas and one ustar write-site excerpt; registry/schema counts remain 65, DATA_EPOCH=1, no unrelated schema/migration changes.
- Final smoke increment independently verified at 04:13:47–04:14:49 UTC: positive HTTP 200/protocol 1 and negative attributable exit 1; CLI exits 0. Related five-file run: 62 passed, 0 failed, one Windows-only skip. Syntax, script ESLint and global warning ratchet passed.

The final increment changes only a separately invoked test CLI, not production imports, dependencies, bundler inputs or TypeScript sources. The original fourteen files and protected inputs are byte-identical to the full-suite snapshot, so that full result is explicitly reused with independently verified affected script/export/workflow checks. A documentation-only handoff is added after verification.

Full-suite result SHA-256: `308168f53ea5addafda695a57ca038746a92269243a2d5c48fa5dc530432aad1`. Full-suite log SHA-256: `f560a26eb411ec8a2cca608dc611f58b8eef24255a8860c3c333313c4e196e53`. These bind retained cloud evidence; raw logs, generated outputs, dependencies, credentials and real user data are not part of this commit.

## Mac independent checkout and gates

Fetch review/xingye-lifecycle-mac-20261009 from origin and create a separate detached worktree at the fixed commit SHA provided in the cloud push report. Check git rev-parse HEAD against that SHA before testing. Keep any existing local worktree and user data intact. Install locked dependencies using the repository-supported Node version and normal npm ci; preserve real dependency/platform failures rather than changing product logic or gates.

Run the repository full suite and three typechecks, lint/warning ratchet/boundary, packages/client and applicable server builds plus both official smoke directions. Also run this focused group with synthetic/isolated session data:

```sh
npm test -- tests/session-runtime-hibernation.test.ts tests/pi-sdk-runtime-integration.test.ts tests/pi-compaction-request-shape.test.ts tests/artifact-core-ustar.test.ts tests/persistence-schema-tripwire.test.ts tests/persistence-store-registry.test.ts
```

Linux skips do not certify Mac behavior. The retained 39 skip predicates group into Mac/Electron native 24, Windows-only 11, and case-insensitive filesystem 4. On Mac, explicitly verify:

- Mac launcher 11 and real Electron Mermaid/CSP cases 2. A supported installed Electron binary may be supplied with HANA_TEST_ELECTRON_PATH.
- Native daemon ownership 10 using HANA_DAEMON_TEST_BINARY and HANA_HELPER_TEST_BINARY pointing to inspected Mac builds; use the isolated fixture, not real user sockets.
- Native Seatbelt case with HANA_NATIVE_SANDBOX_TEST=1; record actual sandbox-exec behavior without a fallback.
- Case-insensitive APFS conditions: bridge media 1, session file registry 2 and upload route 1. Windows-only cases still require Windows.
- ustar restrictive/permissive child umask 0077/0000, empty/nonempty content and normalized modes. Do not alter the parent umask globally.

Record failed/skipped predicates and exact platform versions. Avoid real user sessions, secrets or data directories. Official smoke performs its own temporary home preparation and cleanup; no real Desktop preparation is needed.

## Fifteen frozen candidate files

These hashes bind the reviewed candidate content. This handoff document is the only additional file.

| File | SHA-256 |
| --- | --- |
| build/persistence-schema-fingerprint.json | `62b8ab87d1b8e809dce5052ef92e863d94834b62de4f80c15aba3b8cc1d83bef` |
| build/persistence-store-inventory.json | `fedcf3de6f38fdc36e07a1d0e415b53577d22c1094e0924bc82cd21ed7008624` |
| core/agent-manager.ts | `d76567e2575a1d2344020006a8cdf4567136909e5e0e38158b63e1e9c9a88e24` |
| core/engine.ts | `329e786032c546cd3e1e4b8cf833ded756d41471a2747ae9d989c48383ac5473` |
| core/session-coordinator.ts | `d65f7b57558471496b2427c9a59a1ec7021e5735feffa40586baa052a9aa828f` |
| docs/audits/2026-10-08-session-manual-lifecycle-cloud-review.md | `b2caeff160e250f04fa28cb93f0c41158307950c9261fba5c0ba373bc9b0ac4c` |
| docs/audits/2026-10-09-manual-lifecycle-persistence-compatibility.md | `1772f7ef6e436651c56f2c3da5536a3830603686244d7a4e925e83af5047ccff` |
| server/routes/chat.ts | `f3d6ccb50f75aa276fe7ad7c2a7c04520dbdca56c68a879303c5d69146046c5f` |
| shared/artifact-core/ustar.cjs | `e03a39b39ddc752d77a7fabe59ec9fc163115d716a0aee31040df8fc84755760` |
| tests/agent-manager-delete-skill-bundles.test.ts | `c97df1668cdb3591e2092e8f1be5c4d9cf22ef3731cd24df9f048246209b1360` |
| tests/artifact-core-ustar.test.ts | `fcc21d6de895296e000f775b7e3d1d860d4b360fac53f19a9233bef645b88a5e` |
| tests/chat-route-switching.test.ts | `6dca628249b524517506eecf2377bbca61cc36b041e09a67598dde5167c265a5` |
| tests/path-safety-copy-regressions.test.ts | `11a7be281c14b5ce44f30cecb43ec0c38195b01cc1b2c49c869515aa3d74efc9` |
| tests/session-runtime-hibernation.test.ts | `8aa80f4a4e0b2743675f0ce18b7060efbcd8e96d53124c22b355d44ddd6ed80d` |
| scripts/smoke-open-server.mjs | `2a882e29a6a01d7c119581897ccf00dc6c26bd659b627d2160cf9cfa3d8a138e` |

## Publication boundaries

The intended review branch is review/xingye-lifecycle-mac-20261009; feature/xingye-mvp remains at the fixed baseline. This work does not merge, tag, release or alter CI/publish configuration. The existing CI workflow triggers main pushes and PRs into main, so a review-branch push alone does not trigger it. The cloud report must distinguish actual observed checks from that trigger inference.

A prior gh api repository-metadata read returned Forbidden; that error did not identify a Git repository/push policy refusal. No credential, proxy, domain or permission changes are made. Git uses the existing official origin and existing authentication; the separate API access limitation is reported with the final push/CI observation.
