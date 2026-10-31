import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runFeishuWorkerFixture } from "./helpers/feishu-worker-process.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const phases = new URL("./fixtures/feishu-worker-phases.mjs", import.meta.url).href;
const options = (scenario: string, script: string) => ({
  scenario, cwd, timeoutMs: 5_000, env: { ...process.env },
  args: ["--import", phases, "--input-type=module", "-e", script],
});
const marker = "FEISHU_WORKER_DIAGNOSTIC ";

async function failure(config: Parameters<typeof runFeishuWorkerFixture>[0], verify = () => {}) {
  const error = await runFeishuWorkerFixture(config, verify).then(() => null, error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain(marker);
  const receipt = JSON.parse(error.message.slice(error.message.indexOf(marker) + marker.length));
  const saved = JSON.parse(await readFile(receipt.receiptFile, "utf8"));
  expect(saved).toEqual(receipt);
  // Tests consume their intentional failure artifacts; genuine suite failures
  // leave theirs on disk and also print every field in the Vitest error log.
  await rm(dirname(receipt.receiptFile), { recursive: true, force: true });
  return { error, receipt };
}

describe("Feishu Worker child failure receipts (no network)", () => {
  it("preserves a silent numeric exit, original cause and ordered process events", async () => {
    const verify = vi.fn();
    const { error, receipt } = await failure(options("silent-exit", "process.exitCode = 23;"), verify);
    expect(verify).not.toHaveBeenCalled();
    expect(error.cause).toMatchObject({ code: 23, signal: null, killed: false });
    expect(receipt).toMatchObject({ scenario: "silent-exit", cwd, executable: process.execPath,
      platform: process.platform, nodeVersion: process.version, stdout: "", stderr: "",
      timeoutMs: 5_000, error: { code: 23, signal: null, killed: false }, phaseReadError: null });
    expect(receipt.pid).toBeGreaterThan(0);
    expect(receipt.elapsedMs).toBeGreaterThan(0);
    expect(Date.parse(receipt.completedUTC)).toBeGreaterThanOrEqual(Date.parse(receipt.startedUTC));
    expect(receipt.events.map(event => event.event)).toEqual(["spawn", "exit", "callback", "close"]);
    expect(receipt.events.find(event => event.event === "exit")).toMatchObject({ code: 23, signal: null });
    expect(receipt.events.every((event, i, events) => i === 0 || event.elapsedMs >= events[i - 1].elapsedMs)).toBe(true);
    const trace = receipt.phases.trim().split("\n").map(line => JSON.parse(line));
    expect(trace[0]).toMatchObject({ scenario: "silent-exit", stage: "preload:enter", pid: receipt.pid, threadId: 0 });
    expect(trace.at(-1)).toMatchObject({ stage: "process:exit", code: 23 });
  });

  it("keeps complete stdout and stderr, including noise and Windows-style paths", async () => {
    const stdout = "noise before marker\r\nD:\\a\\open hanako#100%\\fixture.mjs\n";
    const stderr = "synthetic diagnostic\r\n";
    const script = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 24;`;
    const { receipt } = await failure(options("output-retained", script));
    expect(receipt).toMatchObject({ stdout, stderr, error: { code: 24 } });
    expect(receipt.args.at(-1)).toBe(script);
  });

  it("preserves the platform's native self-termination result", async () => {
    const { receipt } = await failure(options("signal-exit", 'process.kill(process.pid, "SIGTERM");'));
    // libuv on Windows records a signal only when the parent calls child.kill().
    // A self-kill uses TerminateProcess(..., 1); the parent observes exit code 1.
    const expected = process.platform === "win32" ? { code: 1, signal: null } : { code: null, signal: "SIGTERM" };
    expect(receipt.error).toMatchObject(expected);
    expect(receipt.events.find(event => event.event === "exit")).toMatchObject(expected);
    expect(receipt.phases).toContain('"stage":"preload:enter"');
  });

  it("keeps the configured deadline and killed flag for an actual child timeout", async () => {
    const config = { ...options("timeout", "setInterval(() => {}, 1000);"), timeoutMs: 250 };
    const { receipt } = await failure(config);
    expect(receipt.timeoutMs).toBe(250);
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(230);
    expect(receipt.error).toMatchObject({ killed: true, signal: "SIGTERM" });
  });

  it("reports ENOENT spawn errors separately from a started child", async () => {
    const config = { ...options("missing-executable", ""), executable: join(tmpdir(), "feishu-diagnostic-no-such-executable", "node") };
    const { receipt } = await failure(config);
    expect(receipt.pid).toBeNull();
    expect(receipt.error).toMatchObject({ code: "ENOENT" });
    expect(receipt.events.some(event => event.event === "spawn")).toBe(false);
    expect(receipt.events.find(event => event.event === "error").error.code).toBe("ENOENT");
    expect(receipt.phaseReadError.code).toBe("ENOENT");
  });

  it.each(["", "unrelated stdout\n", "FEISHU_WORKER_OBSERVATION {truncated\n"])(
    "retains successful-process output when observation validation fails: %j", async stdout => {
      const validation = new Error("synthetic observation/JSON assertion failure");
      const { error, receipt } = await failure(options("invalid-observation", `process.stdout.write(${JSON.stringify(stdout)});`), () => { throw validation; });
      expect(error.cause).toBe(validation);
      expect(receipt.stdout).toBe(stdout);
      expect(receipt.events.find(event => event.event === "exit")).toMatchObject({ code: 0, signal: null });
      expect(receipt.error.message).toBe(validation.message);
    },
  );

  it("does not suppress an uncaught child exception", async () => {
    const { receipt } = await failure(options("uncaught", 'throw new Error("synthetic uncaught failure");'));
    expect(receipt.error.code).toBe(1);
    expect(receipt.stderr).toContain("synthetic uncaught failure");
    expect(receipt.phases).toContain('"stage":"process:uncaughtException"');
  });

  it("does not keep an unsettled top-level await alive or hide its exit code", async () => {
    const { receipt } = await failure(options("unsettled-await", "await new Promise(() => {});"));
    expect(receipt.error).toMatchObject({ code: 13, signal: null, killed: false });
    expect(receipt.phases).toContain('"stage":"process:beforeExit"');
  });

  it("records main and Worker initialization in the same case without adding output", async () => {
    const script = `
      import { Worker } from "node:worker_threads";
      import { once } from "node:events";
      const worker = new Worker(new URL("data:text/javascript,process.exitCode%20%3D%2026"), { execArgv: ["--import", ${JSON.stringify(phases)}] });
      const [code] = await once(worker, "exit");
      process.exitCode = code;
    `;
    const { receipt } = await failure(options("worker-trace", script));
    expect(receipt).toMatchObject({ stdout: "", stderr: "", error: { code: 26 } });
    const trace = receipt.phases.trim().split("\n").map(line => JSON.parse(line));
    expect(trace.some(event => event.stage === "preload:enter" && event.isMainThread === false && event.threadId > 0)).toBe(true);
    expect(trace.every(event => event.scenario === "worker-trace" && event.pid === receipt.pid)).toBe(true);
  });

  it("keeps concurrent case identities and phase files separate", async () => {
    const results = await Promise.all(["first-case", "second-case"].map(scenario => failure(options(scenario, "process.exitCode = 25;"))));
    expect(results[0].receipt.phaseFile).not.toBe(results[1].receipt.phaseFile);
    for (const [index, { receipt }] of results.entries()) {
      expect(receipt.phases).toContain(receipt.scenario);
      expect(receipt.phases).not.toContain(results[1 - index].receipt.scenario);
    }
  });

  it("removes successful receipts without changing validation behavior", async () => {
    const verify = vi.fn(({ stdout }) => expect(stdout.trim()).toBe("synthetic-success"));
    await expect(runFeishuWorkerFixture(options("success", 'console.log("synthetic-success");'), verify)).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledOnce();
  });
});
