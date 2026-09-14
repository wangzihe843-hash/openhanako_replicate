import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn }));
import { spawnAndStream } from "../lib/sandbox/exec-helper.ts";

afterEach(() => { vi.restoreAllMocks(); spawn.mockReset(); });

function child() {
  return Object.assign(new EventEmitter(), {
    pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
}

function execute(signal?: AbortSignal, killMode = "tree") {
  return spawnAndStream("fixture", [], {
    cwd: process.cwd(), env: {}, onData: () => undefined,
    onStdout: undefined, onStderr: undefined, signal, timeout: signal ? undefined : 0.005,
    timeoutErrorValue: 7, killMode,
  });
}

describe("sandbox termination failures", () => {
  it.skipIf(process.platform !== "win32")("consumes asynchronous taskkill failure and rejects timeout without waiting forever for close", async () => {
    const process = child();
    const killer = new EventEmitter();
    const failure = Object.assign(new Error("taskkill missing"), { code: "ENOENT" });
    spawn.mockReturnValueOnce(process).mockImplementationOnce(() => {
      queueMicrotask(() => killer.emit("error", failure));
      return killer;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(execute()).rejects.toMatchObject({ message: "timeout:7", cause: failure });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("taskkill missing"));
    expect(process.stdout.destroyed).toBe(true);
  });

  it("preserves abort result and exposes the cause when process termination throws", async () => {
    const process = child();
    const failure = Object.assign(new Error("kill denied"), { code: "EPERM" });
    process.kill.mockImplementation(() => { throw failure; });
    spawn.mockReturnValue(process);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(execute(controller.signal, "process")).rejects.toMatchObject({ message: "aborted", cause: failure });
    expect(process.stdout.destroyed).toBe(true);
  });
});


it.each(["abort", "timeout"] as const)("preserves %s when kill emits an error instead of throwing", async mode => {
  const process = child();
  const failure = Object.assign(new Error("kill denied"), { code: "EPERM" });
  process.kill.mockImplementation(() => { process.emit("error", failure); return false; });
  spawn.mockReturnValue(process);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const controller = new AbortController();
  if (mode === "abort") controller.abort();
  await expect(execute(mode === "abort" ? controller.signal : undefined, "process"))
    .rejects.toMatchObject({ message: mode === "abort" ? "aborted" : "timeout:7", cause: failure });
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("kill denied"));
  expect(process.stdout.destroyed).toBe(true);
  expect(process.stderr.destroyed).toBe(true);
});

it("preserves an ordinary spawn error before cancellation", async () => {
  const process = child();
  const failure = Object.assign(new Error("spawn denied"), { code: "EACCES" });
  spawn.mockReturnValue(process);
  const result = execute(new AbortController().signal, "process");
  process.emit("error", failure);
  await expect(result).rejects.toBe(failure);
});
