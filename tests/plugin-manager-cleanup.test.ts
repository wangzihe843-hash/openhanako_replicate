import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginManager } from "../core/plugin-manager.ts";
import { EventBus } from "../hub/event-bus.ts";

let root: string;
let pluginsDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-cleanup-"));
  pluginsDir = path.join(root, "plugins");
  fs.mkdirSync(pluginsDir);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

function plugin(id: string, source: string) {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id, trust: "full-access" }));
  fs.writeFileSync(path.join(dir, "index.js"), source);
  return dir;
}

function manager(loadTimeoutMs = 1_000, cleanupTimeoutMs = 20) {
  return new PluginManager({
    pluginsDirs: [path.join(root, "empty-builtin"), pluginsDir],
    dataDir: path.join(root, "data"),
    bus: new EventBus(),
    loadTimeoutMs,
    cleanupTimeoutMs,
    preferencesManager: {
      getAllowFullAccessPlugins: () => true,
      getDisabledPlugins: () => [],
      setDisabledPlugins: () => {},
    },
  } as ConstructorParameters<typeof PluginManager>[0]);
}

describe("bounded plugin cleanup", () => {
  it("continues startup and disposes contributions when onload and onunload both hang", async () => {
    const state = { cleaned: [] as string[] };
    vi.stubGlobal("__cleanupBoundary", state);
    const dir = plugin("a-stuck", `
      export default class {
        async onload() {
          this.ctx.registerTool({ name: "dynamic", execute() {} });
          this.register(() => { globalThis.__cleanupBoundary.cleaned.push("first"); });
          this.register(async () => { throw new Error("disposable rejected"); });
          this.register(() => new Promise(() => {}));
          this.register(() => { globalThis.__cleanupBoundary.cleaned.push("last"); });
          await new Promise(() => {});
        }
        async onunload() { await new Promise(() => {}); }
      }
    `);
    fs.mkdirSync(path.join(dir, "tools"));
    fs.writeFileSync(path.join(dir, "tools", "static.js"),
      'export const name="static"; export const description="static"; export function execute() {}');
    plugin("z-after", "export default class {}");
    const pm = manager();
    pm.scan();

    await pm.loadAll();

    expect(pm.getPlugin("a-stuck").status).toBe("failed");
    expect(pm.getPlugin("z-after").status).toBe("loaded");
    expect(pm.getAllTools({ includeShadowed: true })).toEqual([]);
    expect(state.cleaned).toEqual(["last", "first"]);
    expect(pm.getPlugin("a-stuck").instance).toBeNull();
  }, 5_000);

  it("awaits healthy onunload and async disposables once in reverse registration order", async () => {
    const state = { steps: [] as string[] };
    vi.stubGlobal("__cleanupBoundary", state);
    plugin("healthy", `
      export default class {
        onload() {
          this.register(async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            globalThis.__cleanupBoundary.steps.push("first");
          });
          this.register(() => { globalThis.__cleanupBoundary.steps.push("second"); });
        }
        async onunload() {
          await new Promise(resolve => setTimeout(resolve, 5));
          globalThis.__cleanupBoundary.steps.push("unload");
        }
      }
    `);
    const pm = manager(500, 500);
    pm.scan();
    await pm.loadAll();
    await pm.unloadPlugin("healthy");
    await pm.unloadPlugin("healthy");
    expect(state.steps).toEqual(["unload", "second", "first"]);
    expect(pm.getPlugin("healthy").status).toBe("unloaded");
  });

  it("keeps an old timed-out onload from registering into the same entry after reload", async () => {
    const state = {
      generations: 0,
      releaseOld: () => {},
      releaseNew: () => {},
      oldResumed: false,
      lateDisposed: false,
    };
    vi.stubGlobal("__cleanupBoundary", state);
    plugin("reload", `
      export default class {
        async onload() {
          const state = globalThis.__cleanupBoundary;
          if (++state.generations === 1) {
            await new Promise(resolve => { state.releaseOld = resolve; });
            this.ctx.registerTool({ name: "obsolete", execute() {} });
            this.register(async () => { state.lateDisposed = true; });
            state.oldResumed = true;
          } else {
            this.ctx.registerTool({ name: "current", execute() {} });
            await new Promise(resolve => { state.releaseNew = resolve; });
          }
        }
        async onunload() { await new Promise(() => {}); }
      }
    `);
    const pm = manager(1_000, 10);
    pm.scan();
    await pm.loadAll();
    const original = pm.getPlugin("reload");
    expect(original.status).toBe("failed");

    const reload = pm.enablePlugin("reload");
    await vi.waitFor(() => expect(state.generations).toBe(2), { interval: 5, timeout: 1_000 });
    state.releaseOld();
    await vi.waitFor(() => expect(state.oldResumed && state.lateDisposed).toBe(true), { interval: 2 });
    expect(pm.getPlugin("reload")).toBe(original);
    expect(original._activationPromise).not.toBeNull();
    state.releaseNew();
    await reload;

    expect(original.status).toBe("loaded");
    expect(original.activationState).toBe("activated");
    expect(pm.getAllTools().map(tool => tool.name)).toEqual(["reload_current"]);
    await pm.unloadPlugin("reload");
  });

  it("cleans a lazy activation timeout even when onunload also hangs", async () => {
    const state = { unloads: 0, disposed: 0 };
    vi.stubGlobal("__cleanupBoundary", state);
    const dir = plugin("lazy-timeout", `
      export default class {
        async onload() {
          this.ctx.registerTool({ name: "partial", execute() {} });
          this.register(() => { globalThis.__cleanupBoundary.disposed++; });
          await new Promise(() => {});
        }
        async onunload() {
          globalThis.__cleanupBoundary.unloads++;
          await new Promise(() => {});
        }
      }
    `);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "lazy-timeout", trust: "full-access", activationEvents: ["onPageOpen"],
    }));
    fs.mkdirSync(path.join(dir, "tools"));
    fs.writeFileSync(path.join(dir, "tools", "static.js"),
      'export const name="static"; export const description="static"; export function execute() {}');
    const pm = manager(200, 20);
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("lazy-timeout").status).toBe("loaded");
    await expect(pm.activatePlugin("lazy-timeout", { event: "onPageOpen" })).rejects.toThrow(/timed out/);
    expect(pm.getPlugin("lazy-timeout")).toMatchObject({ status: "failed", activationState: "failed", instance: null });
    expect(state).toEqual({ unloads: 1, disposed: 1 });
    expect(pm.getAllTools({ includeShadowed: true })).toEqual([]);
  });

  it("does not let an old lazy activation failure clean a re-enabled runtime", async () => {
    const state = { generations: 0, rejectOld: (_error: Error) => {}, disposed: [] as number[] };
    vi.stubGlobal("__cleanupBoundary", state);
    const dir = plugin("lazy-reload", `
      export default class {
        async onload() {
          const state = globalThis.__cleanupBoundary;
          const generation = ++state.generations;
          this.register(() => { state.disposed.push(generation); });
          this.ctx.registerTool({ name: "generation" + generation, execute() {} });
          if (generation === 1) await new Promise((resolve, reject) => { state.rejectOld = reject; });
        }
      }
    `);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "lazy-reload", trust: "full-access", activationEvents: ["onPageOpen"],
    }));
    const pm = manager(1_000, 20);
    pm.scan();
    await pm.loadAll();
    const oldActivation = pm.activatePlugin("lazy-reload", { event: "onPageOpen" });
    const oldFailure = expect(oldActivation).rejects.toThrow("old activation failure");
    await vi.waitFor(() => expect(state.generations).toBe(1), { interval: 5 });
    await pm.disablePlugin("lazy-reload");
    await pm.enablePlugin("lazy-reload");
    await pm.activatePlugin("lazy-reload", { event: "onPageOpen" });
    state.rejectOld(new Error("old activation failure"));
    await oldFailure;
    expect(pm.getPlugin("lazy-reload")).toMatchObject({ status: "loaded", activationState: "activated" });
    expect(pm.getAllTools().map(tool => tool.name)).toEqual(["lazy-reload_generation2"]);
    expect(state.disposed).toEqual([1]);
    await pm.unloadPlugin("lazy-reload");
    expect(state.disposed).toEqual([1, 2]);
  });

  it("does not register a declarative tool whose import completes after unload", async () => {
    const state = { release: () => {}, started: false };
    vi.stubGlobal("__cleanupBoundary", state);
    const dir = plugin("late-import", "export default class {}");
    fs.mkdirSync(path.join(dir, "tools"));
    fs.writeFileSync(path.join(dir, "tools", "late.js"), `
      globalThis.__cleanupBoundary.started = true;
      await new Promise(resolve => { globalThis.__cleanupBoundary.release = resolve; });
      export const name = "late";
      export const description = "late";
      export function execute() {}
    `);
    const pm = manager();
    pm.scan();
    await pm.loadAll();
    expect(state.started).toBe(true);
    expect(pm.getPlugin("late-import").status).toBe("failed");
    state.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pm.getAllTools({ includeShadowed: true })).toEqual([]);
    expect(pm.getPlugin("late-import").instance).toBeNull();
  });
});
