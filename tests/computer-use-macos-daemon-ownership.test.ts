import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { createMacosCuaProvider } from "../core/computer-use/providers/macos-cua-provider.ts";

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn<(signal: NodeJS.Signals) => boolean>() });
  child.kill.mockImplementation((signal) => {
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  });
  return child;
}

const status = (ready: boolean) => ({ stdout: "", stderr: "", exitCode: ready ? 0 : 1 });
const apps = () => ({ stdout: JSON.stringify({ structuredContent: { apps: [] } }), stderr: "", exitCode: 0 });
type Runner = NonNullable<Parameters<typeof createMacosCuaProvider>[0]>["runner"];

function setup(probe: (args: string[]) => ReturnType<typeof status> | Promise<ReturnType<typeof status>>, child = fakeChild()) {
  const runner = {
    run: vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "status") return probe(args);
      if (args[0] === "version") return { stdout: "hana-daemon-ownership-v1", stderr: "", exitCode: 0 };
      return apps();
    }),
    spawn: vi.fn((..._args: Parameters<Runner["spawn"]>) => child),
  };
  const provider = createMacosCuaProvider({
    platform: "darwin", command: "/test/hana-computer-use-helper", socketPath: "/test/owned.sock",
    runner: runner as unknown as Runner, daemonStartupTimeoutMs: 20, daemonShutdownTimeoutMs: 10,
  });
  return { provider, runner, child };
}

describe("macOS daemon ownership", () => {
  it.each(["releaseLease", "stop", "dispose"] as const)("does not stop an attached daemon on %s", async (method) => {
    const { provider, runner, child } = setup(() => status(true));
    await provider.listApps();
    await provider[method]();
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(runner.run.mock.calls.every(([, args]) => args[0] !== "stop")).toBe(true);
    expect(runner.run.mock.calls.every(([, args]) => args[0] !== "version")).toBe(true);
  });

  it("requires the spawned instance identity and reaps only that child", async () => {
    const { provider, runner, child } = setup((args) => status(args.includes("--instance")));
    await provider.listApps();
    const instanceId = runner.spawn.mock.calls[0][2].env.HANA_COMPUTER_USE_INSTANCE_ID;
    expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runner.run.mock.calls[2][1]).toEqual(["status", "--socket", "/test/owned.sock", "--instance", instanceId]);
    await provider.dispose();
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(child.listenerCount("exit")).toBe(0);
    expect(runner.run.mock.calls.every(([, args]) => args[0] !== "stop")).toBe(true);
  });

  it("refuses to start a legacy helper before it can mutate the shared socket", async () => {
    const { provider, runner, child } = setup(() => status(false));
    runner.run.mockImplementation(async (_command, args) => args[0] === "version"
      ? { stdout: "0.0.1", stderr: "", exitCode: 0 }
      : status(false));
    await expect(provider.listApps()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE", details: { reason: "daemon-protocol-unsupported" },
    });
    await provider.dispose();
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not mistake a competing daemon for a successfully launched child", async () => {
    let foreignReady = false;
    const { provider, runner, child } = setup((args) => status(foreignReady && !args.includes("--instance")));
    runner.spawn.mockImplementation(() => { foreignReady = true; return child; });
    await expect(provider.listApps()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    // A later operation may attach to the winner, without gaining ownership.
    await provider.listApps();
    await provider.dispose();
    expect(runner.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(runner.run.mock.calls.every(([, args]) => args[0] !== "stop")).toBe(true);
  });

  it("rejects readiness if the child exits during the identity probe", async () => {
    const child = fakeChild();
    const { provider } = setup((args) => {
      if (!args.includes("--instance")) return status(false);
      child.emit("exit", 70, null);
      return status(true);
    }, child);
    await expect(provider.listApps()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await provider.dispose();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("forgets exited children before attaching to a replacement", async () => {
    let replacement = false;
    const { provider, child, runner } = setup((args) => status(replacement || args.includes("--instance")));
    await provider.listApps();
    child.emit("exit", 0, null);
    replacement = true;
    await provider.listApps();
    await provider.stop();
    expect(child.kill).not.toHaveBeenCalled();
    expect(runner.spawn).toHaveBeenCalledTimes(1);
    expect(runner.run.mock.calls.every(([, args]) => args[0] !== "stop")).toBe(true);
  });

  it("cleans a failed startup before allowing a new attempt", async () => {
    let ready = false;
    const { provider, runner, child } = setup((args) => status(ready && args.includes("--instance")));
    await expect(provider.listApps()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(child.kill).toHaveBeenCalledOnce();
    const next = fakeChild();
    runner.spawn.mockReturnValue(next);
    ready = true;
    await provider.listApps();
    const ids = runner.spawn.mock.calls.map(([, , options]) => options.env.HANA_COMPUTER_USE_INSTANCE_ID);
    expect(new Set(ids).size).toBe(2);
    await provider.dispose();
    expect(next.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent startup and waits for it before stopping", async () => {
    let releaseProbe: (value: ReturnType<typeof status>) => void;
    const initialProbe = new Promise<ReturnType<typeof status>>((resolve) => { releaseProbe = resolve; });
    let probes = 0;
    const { provider, runner, child } = setup(() => ++probes === 1 ? initialProbe : status(true));
    const first = provider.listApps();
    const second = provider.listApps();
    const stopping = provider.stop();
    releaseProbe(status(false));
    await Promise.all([first, second, stopping]);
    expect(runner.spawn).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("waits for exit and escalates only the same unresponsive child", async () => {
    const { provider, child } = setup((args) => status(args.includes("--instance")));
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    });
    await provider.listApps();
    await provider.dispose();
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
});
