# Repository regression review — 2026-09-27

## Scope and method

Review baseline: `d07fa95b63f9c3114c4493c441c7cbdaa0326427` on `feature/xingye-mvp`. The uncommitted M7–M14 implementation and existing execution paths were reviewed in three parallel areas, followed by an independent integration review. Generated references, private profiles, test homes and signing keys are excluded from the commit.

| Area | Examined boundaries |
| --- | --- |
| Desktop | Real bootstrap/main entry, CommonJS bindings, preload and IPC, frame identity, navigation, main/pet lifecycle, CSP, package census and runtime dependencies |
| Backend | Role deletion, tool invocation context, session/task ownership, permissions, candidate offer settlement, channel effect ledger/receipts, experience versions, persistence and public API contracts |
| Renderer | App/input/chat/settings, async role/session changes, channel navigation and read state, pet event ordering, diary export/resources, voice cancellation and pixel room scope |
| Integration | API-to-UI contracts, CLI dependency closure, plugin package builds, open/full server compositions, persistence compatibility, Windows source and packaged startup, existing repository test and lint gates |

## Confirmed defects repaired

- Missing `powerMonitor` import caused the real desktop entrypoint to throw at startup. A CommonJS syntax/undeclared-binding gate now covers desktop, shared and server sources and checks the shell census.
- Unauthorized pet IPC responses exposed the active role/session context; pet IPC now requires an authorized window and its main frame. Pet navigation and new-window requests are blocked to keep its credential-bearing preload on the intended page.
- Deleted roles retain recovery files, so checking only `config.yaml` allowed settings/skills routes to access tombstones. The shared guard now rejects deleted roles.
- Historical workflow/subagent/deferred cards could borrow records from another session through a global task ID. Projections now check parent-session ownership.
- A background `update_settings.thinking_level` invocation could modify the focused session. The tool now captures its invoking session; unresolved explicit context fails closed.
- Topic and experience-version endpoints omitted existing settings scope mappings. Read/write permissions now match the corresponding role settings, with denial tests for chat-only and read-only clients.
- Late pet IPC snapshots/options responses could overwrite newer live state. The renderer now rejects stale responses.
- Late result-card/channel requests could navigate or mark a channel read after a session switch. Invalidation reaches the underlying state/read operations.
- Diary operations could write stale UI after role switches, including an A→B→A switch; pending exports could allocate unreleased object URLs after unmount. Role epochs, unmount cancellation, URL cleanup and visible failures now cover these paths.
- A persisted candidate URL could be rendered with an unsafe protocol. The renderer only links HTTP(S) sources.
- A real Electron Canvas test exposed CSP rejection of `fetch(data:)`, which mocked DOM tests missed. Valid embedded raster images now decode locally without broadening CSP. Real rendering verified Chinese glyphs, eight PNG pages and visible embedded image pixels.
- The packaged desktop omitted external DOCX/XLSX preview dependencies from its deliberately restricted asar. Mammoth and ExcelJS are now included in the main bundle, with a packaging contract to prevent unresolved external imports. Package verification exercises document conversion through the real preview IPC handlers.
- Concurrent CLI dependency scans shared one scratch bundle path and could delete a bundle still being traced by another scan. Scratch isolation and a controlled overlap regression cover this generation boundary without changing the dependency baseline.
- The general companion card, pixel room and standalone pet retained Chinese text after changing the application's language. Their controls and prompts now use the existing locale resources.

## Regression prevention

The Windows CI pipeline now builds every desktop client entry, runs `scripts/smoke-desktop-main-pet.cjs`, and exercises packaged server APIs/restart with `scripts/smoke-full-server.mjs`. Both use disposable data and avoid model calls. The existing full suite, permission tests, schema tripwire, warning ratchet and open-boundary checks remain enabled; no lint or boundary baseline was raised.

## Final verification

Environment: Windows x64, Node 24.15.0 and Electron 42.3.0. The host reports 22 available logical workers; final full-suite execution limits worker concurrency instead of increasing test timeouts.

| Check | Result |
| --- | --- |
| Full repository tests (`npm test -- --maxWorkers=2`) | 14,837 passed, 0 failed, 41 skipped; 1,409 passing and 2 skipped files out of 1,411; 899.98 seconds |
| Typecheck | All three TypeScript projects passed |
| Lint warning ratchet | 0 errors, 0 added warnings, 7 removed warnings; 7,874 existing warnings remain within the unchanged baseline |
| Open/closed boundary lint | Passed with the one existing tracked edge; baseline unchanged |
| Workspace package build | All four packages built successfully |
| Complete desktop client build | Main, preload, renderer, splash and theme builds passed |
| Open server composition | Build passed; real startup/HTTP smoke and missing-config rejection passed |
| Full server composition | Build and post-prune native SQLite, Jieba and Anydoc checks passed |
| Full server API smoke | 10 checks passed, including authentication, storage traversal rejection, companion API contracts and persistence across a real process restart |
| Standalone Windows server | Archive verification and runtime smoke passed, including bundled MinGit commit/clone, shell/coreutils and restricted-token command execution |
| Signed artifact seed | Latest server and renderer archives, manifest and signature verified |
| Real source desktop startup | Main/pet React and preload, shared server, trusted IPC, navigation rejection, hide/show, close/reopen and graceful cleanup passed |
| Actual packaged Windows executable | 6 checks passed: asar bootstrap and both React windows; live pet translations; signed seed/shared server; real DOCX/XLSX preview IPC; pet controls/close/reopen; graceful application/server exit |
| Diary image export | Real Electron Canvas produced eight decodable PNG pages with loaded fonts and visible image content |

All source changes were frozen before the final full-suite run. Typecheck, lint, builds, seed verification, source desktop/server smoke, standalone runtime verification and the final directory-package smoke then ran serially. No unresolved failure remained in these checks. Only review documentation was completed afterward. Detailed local logs are retained under the ignored `.cache/companion-review-20260927/` directory; private profiles, temporary signing keys and generated artifacts are excluded from version control.

During verification, the previous CI test still expected `build:renderer`; it was updated to require the complete `build:client` and the correct ordering of both real smoke commands. A later unrestricted-concurrency full run exceeded existing test deadlines and exposed the CLI scratch-file collision described above. These unsuccessful runs are not counted as a passing gate.

## Limits

Local execution covers Windows x64. macOS/Linux hardware behavior, physical audio output, and live external model/provider delivery are outside this local run. Existing platform/fixture-dependent skips remain explicit in the full-suite result. A local channel append receipt does not assert recipient delivery or reading, and the effect ledger does not claim cross-process exactly-once execution.

The local directory package uses the installed Electron distribution, a disposable artifact signing key and disabled executable signing/resource editing. Electron-builder's directory target does not generate `app-update.yml`; the smoke temporarily supplies the same metadata produced for the configured NSIS target, then removes it. Production integrity checks remain enabled. This checks the actual packaged application and signed seed activation; it does not validate installer installation, release signing, or live updater delivery.
