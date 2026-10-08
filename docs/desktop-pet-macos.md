# Desktop pet: macOS MVP and acceptance

## Scope

The desktop pet supports Windows and macOS. It is a presentation of the main
window's selected session, not a second agent or session. Linux remains
unsupported. The main companion card discovers support through the existing
`pet-state` IPC result, so no renderer platform fork is needed.

On macOS, the pet uses Electron's nonactivating `panel` window type. Showing it
uses `showInactive()`. The panel is configured for first-click controls, stays
out of Mission Control, and cannot minimize. Keyboard access remains enabled.
Its pin control still switches between the floating and normal window levels.

The existing transparent, sandboxed window, dedicated preload, navigation
denial, sender/main-frame checks, drag strip, session/status polling, saved
options and DIP-coordinate bounds are retained. The pet is not parented to the
main window; hiding main leaves it alive. Opening a session from the pet restores
main and, on macOS, the Dock icon if a hidden-at-login launch had hidden it.

The macOS menu-bar icon adds Show/Hide Desktop Pet and Restore Pet Mouse
Interaction. Mouse recovery also works with main hidden, no session selected,
or a saved click-through option and no pet window yet. Its state is rebuilt on
pet changes and locale changes rather than waiting for a right click. Windows
keeps its existing tray menu and window parameters.

## Platform details and limits

- Screen work areas and window bounds stay in Electron DIP coordinates; do not
  multiply them by Retina `scaleFactor`
- On Windows, the existing `moved` event remains the drag-end clamp trigger
- On macOS, `moved` is an alias of `move`. Clamping is instead delayed until
  200 ms without movement. This is an inactivity heuristic, not a mouse-release
  detector. Pausing a held drag near a seam must be checked on a real Mac
- Display topology/metrics changes and wake still recover the pet into a
  reachable work area. Closing or quitting cancels pending Mac clamp work
- The panel API supplies Spaces/fullscreen participation without repeatedly
  transforming the application activation policy through
  `setVisibleOnAllWorkspaces()`. Native fullscreen, app-hide and Stage Manager
  behavior still require acceptance on supported macOS versions
- No new dependencies, native helpers, entitlements, global input hooks,
  Accessibility, Input Monitoring, or Screen Recording requests are added
- The pet does not render arbitrary remote pages. Its existing privileged
  bridge, sandbox, and IPC sender checks must remain intact

## Build and portable regression gates

No package/lock, Vite, or builder-manifest change is needed: `pet.html`,
`pet-preload.cjs`, the state helper and locales are already in the build paths.
Run the repository's real tools after integrating the patch:

```sh
npm test -- tests/desktop-pet-lifecycle.test.ts tests/desktop-pet-window-state.test.ts tests/desktop-runtime-lifecycle.test.ts tests/desktop-main-bindings.test.ts desktop/src/react/companion/PetApp.test.tsx desktop/src/react/components/right-workspace/CompanionStatusCard.test.tsx
npm run typecheck
npm run lint
npm test
npm run build:client
```

`desktop-pet-lifecycle.test.ts` executes the production main-process pet
functions with Electron, timers and disk replaced by deterministic test hosts.
It does not start the app, make network/model requests, or request native
permissions. Those tests cannot establish native focus, compositing or pointer
delivery behavior.

## Isolated native smoke

After the build above, on Windows or macOS:

```sh
node scripts/smoke-desktop-main-pet.cjs
```

This existing full-app smoke uses a fresh temporary `HANA_HOME` and Electron
app-data directory, no provider credentials, invisible windows, and an
ownership-checked shutdown/cleanup. On macOS it disables the separate
first-launch notification-support branch before importing the bootstrap,
because testing the pet must not request notification permission.

It checks production startup, built renderer/preloads, sandbox settings,
trusted versus rogue IPC, hide/show, pin/unpin, main close/reopen, and shutdown.
On Mac it also checks reported Spaces participation, Mission Control hiding,
non-minimizability and keyboard focusability. It does not check actual native
pointer delivery or visual compositing. Stop and report any unexpected OS
permission prompt; do not grant permissions or change TCC/settings for this
test.

The smaller `smoke-pet-window.cjs` uses its own window options and fake IPC. It
is a renderer/CSP check, not proof of the production Mac window configuration.

## Required visible macOS acceptance

Use an isolated test profile and authorized test execution. Do not run these
checks concurrently with another app acceptance run or on a dirty tree without
first preserving its rollback baseline.

1. Show pet while another app has focus. Confirm no main-window activation,
   correct transparent corners, one-click controls, and keyboard access
2. Drag across mixed-DPI displays, including negative/above-primary layouts and
   gaps. Pause a held drag at seams, release near all edges, and check that the
   drag bar remains reachable without trapping the pet on one display
3. Change Dock location/auto-hide and display scale; unplug/reconnect an external
   display; sleep/wake. Check position recovery and status resumption
4. Enable click-through. Verify real clicks and scrolling reach the underlying
   app. Recover using the menu bar with main hidden and without an active
   session; repeat after relaunch with click-through saved
5. Switch Spaces and enter/leave another app's fullscreen, pinned and unpinned.
   Verify Mission Control/Stage Manager behavior and no unwanted Dock flicker
6. Close main, reopen the current session from pet, hide/show pet repeatedly,
   use Cmd-H/app hide and hidden-at-login launch, then quit from the menu bar
7. Change locale and repeat menu recovery. Relaunch with visible/hidden,
   paused/unpaused, pinned/unpinned and click-through options saved
8. Confirm no new native permission grant is needed for the pet and no unrelated
   window, session, or active background task is changed

Native acceptance is pending until these results are recorded. Cloud-only
passing tests are not a macOS release sign-off.

## References

- [Electron v42.3 window options](https://github.com/electron/electron/blob/v42.3.0/docs/api/structures/base-window-options.md)
- [Electron v42.3 move and click-through APIs](https://github.com/electron/electron/blob/v42.3.0/docs/api/base-window.md)
- [Electron v42.3 macOS panel implementation](https://github.com/electron/electron/blob/v42.3.0/shell/browser/ui/cocoa/electron_ns_panel.mm)
- [Electron v42.3 native window implementation](https://github.com/electron/electron/blob/v42.3.0/shell/browser/native_window_mac.mm)
