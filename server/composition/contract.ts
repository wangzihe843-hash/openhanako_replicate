/**
 * server composition contract (open) — the route composition seam.
 *
 * `server/index.ts` is the open composition root: it unconditionally,
 * statically imports `./open-root.ts` and mounts every open
 * (redistributable) route/WS surface on the shared Hono `app`. It no
 * longer imports any closed-product route file directly.
 *
 * The full product composition (today the only composition anything
 * actually boots) additionally needs the closed-product routes — avatar,
 * cards, character-cards, desk, diary. Rather than `server/index.ts`
 * reaching for those itself, it accepts an optional `registerClosedRoutes`
 * hook on the `root` argument passed to `startServer(root)`. That hook is
 * supplied by `server/main-full.ts` (a closed, thin entry point) via
 * `./full-root.ts` (closed). `server/index.ts` itself never imports either
 * file — the `?.()` call site is a static composition-time parameter, not a
 * runtime feature switch: which composition is selected is decided once, at
 * the process-entry level (which file gets spawned/imported), never by an
 * env var or config flag read inside `startServer`.
 * Unclassified routes use a separate `registerUnclassifiedRoutes` hook at
 * the same seam, between open and closed registration. Full supplies that
 * hook; open supplies neither hook. Injection does not grant redistribution
 * permission or classify a route as closed-product.
 *
 * `ctx` carries every dependency a route factory needs explicitly (engine,
 * hub, ws plumbing, per-request-scoped services) so closed route
 * registration never has to reach for a global singleton or guess at
 * server/index.ts's internal state.
 */
import type { Hono } from "hono";

export interface CompositionContext {
  /** HanaEngine instance (loosely typed like the rest of server/index.ts). */
  engine: any;
  /** Hub instance wrapping the engine (scheduler + channel router). */
  hub: any;
  /** `@hono/node-ws`'s upgradeWebSocket, needed by the chat WS route. */
  upgradeWebSocket: any;
  /** Ticket service backing `/api/ws-ticket` and `?wsTicket=` WS auth. */
  wsTicketService: any;
  /** Loopback/bearer/session auth service shared by the global auth gate. */
  serverAuthService: any;
  /** Mutable network summary (mode/host/port) shared with `/api/access`. */
  serverRuntimeState: any;
  /** Lazy external-platform (bridge) manager accessor. */
  bridgeManagerRef: any;
  /** Blocking confirmation store shared by the confirm route + engine. */
  confirmStore: any;
  /** Product version string surfaced by `/api/server/identity`. */
  appVersion: string;
}

export interface CompositionRoot {
  /**
   * Routes whose redistribution status is still evidence-needed. The full
   * entry supplies their implementations; the open entry leaves this absent.
   * Called once after open routes and before closed-product routes, preserving
   * the full product's mount order and the shared global auth middleware.
   */
  registerUnclassifiedRoutes?: (app: Hono, ctx: CompositionContext) => void;
  /**
   * Closed-product route registration hook. Supplied by the full entry and
   * called once after open and unclassified route registration, to add
   * the closed-product surface on top of the same `app` and `ctx`.
   */
  registerClosedRoutes?: (app: Hono, ctx: CompositionContext) => void;
  /**
   * Closed-content media adapter implementations (core/media-adapters/) to
   * inject into the media runtime's built-in adapter list. Absent means the
   * open composition: zero built-in adapters, not an implicit closed import.
   */
  builtinMediaAdapters?: readonly any[];
}
