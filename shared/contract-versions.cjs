"use strict";

/**
 * shared/contract-versions.cjs — the single source for the two hot-update
 * contract version numbers.
 *
 * Every train manifest (seed and published trains alike) carries a
 * `contract: { preload, serverProtocol }` field, validated for shape by
 * `shared/artifact-core/manifest.cjs`. This file is where those numbers
 * actually come from — manifest construction, the shell-side OTA gate,
 * the server-identity handshake, and the renderer-side runtime comparison
 * all require this module instead of writing their own literal copy.
 *
 * PRELOAD_API_VERSION — the preload API surface the shell (this Electron
 * build) exposes to the renderer. A train whose manifest declares a higher
 * `contract.preload` than this constant depends on preload capabilities
 * this shell doesn't have; that train must not be activated on this shell,
 * exactly like the existing minShell gate (`isShellVersionSufficient`) —
 * it's "the shell is too old" in a different shape.
 *
 * SERVER_PROTOCOL_VERSION — the renderer<->server runtime protocol this
 * build speaks. It's checked at runtime through the existing
 * server-identity handshake: diagnostic only, never a gate, because the
 * renderer and server inside one already-running install are supposed to
 * always match (they're built and shipped together) — a mismatch here is
 * itself the interesting signal, not something to hide by refusing to run.
 *
 * Versioning rule (additive-only): bump either number ONLY when new
 * content actually depends on a capability an old shell/server does not
 * have. A bump means old shells stop receiving new trains (surfaced to the
 * user as "please update the app") until they update the app itself — a
 * real cost, so don't bump casually.
 */

const PRELOAD_API_VERSION = 1;
const SERVER_PROTOCOL_VERSION = 1;

module.exports = {
  PRELOAD_API_VERSION,
  SERVER_PROTOCOL_VERSION,
};
