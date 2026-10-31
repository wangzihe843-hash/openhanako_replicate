import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

type Output = { stdout: string; stderr: string };
type FixtureOptions = {
  scenario: string;
  executable?: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
};

function errorDetails(error: unknown) {
  const value = error instanceof Error ? error : new Error(String(error));
  const extra = value as Partial<ExecFileException> & { errno?: number; syscall?: string; path?: string };
  return { name: value.name, message: value.message, stack: value.stack,
    code: extra.code ?? null, signal: extra.signal ?? null, killed: extra.killed ?? null,
    errno: extra.errno ?? null, syscall: extra.syscall ?? null, path: extra.path ?? null };
}

// Keep failures observable even when a child dies before producing any output.
// This helper owns only test diagnostics; it does not retry or change deadlines.
export async function runFeishuWorkerFixture(options: FixtureOptions, verify: (output: Output) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "feishu-worker-receipt-"));
  const phaseFile = join(directory, "phases.jsonl");
  const receiptFile = join(directory, "receipt.json");
  const executable = options.executable ?? process.execPath;
  const startedUTC = new Date().toISOString();
  const began = performance.now();
  const events: Array<Record<string, unknown>> = [];
  const mark = (event: string, fields: Record<string, unknown> = {}) => {
    events.push({ event, elapsedMs: performance.now() - began, ...fields });
  };
  let pid: number | undefined;
  const result = await new Promise<Output & { error: Error | null }>(resolve => {
    try {
      const child = execFile(executable, options.args, {
        cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8",
        env: { ...options.env, HANA_FEISHU_TEST_PHASE_FILE: phaseFile, HANA_FEISHU_TEST_SCENARIO: options.scenario },
      }, (error, stdout, stderr) => {
        mark("callback");
        resolve({ error, stdout, stderr });
      });
      pid = child.pid;
      child.once("spawn", () => mark("spawn"));
      child.once("error", error => mark("error", { error: errorDetails(error) }));
      child.once("exit", (code, signal) => mark("exit", { code, signal }));
      child.once("close", (code, signal) => mark("close", { code, signal }));
    } catch (error) {
      mark("spawn-throw");
      resolve({ error, stdout: "", stderr: "" });
    }
  });
  const completedUTC = new Date().toISOString();
  const elapsedMs = performance.now() - began;
  let phases = "";
  let phaseReadError: ReturnType<typeof errorDetails> | null = null;
  try { phases = await readFile(phaseFile, "utf8"); }
  catch (error) { phaseReadError = errorDetails(error); }
  try {
    if (result.error) throw result.error;
    // The caller's original observation/JSON/business assertions stay intact.
    verify(result);
  } catch (cause) {
    const receipt = {
      scenario: options.scenario, executable, args: options.args, cwd: options.cwd,
      platform: process.platform, arch: process.arch, nodeVersion: process.version,
      parentPid: process.pid, pid: pid ?? null, startedUTC, completedUTC, elapsedMs,
      timeoutMs: options.timeoutMs, events, error: errorDetails(cause),
      stdout: result.stdout, stderr: result.stderr, phaseFile, phases, phaseReadError, receiptFile,
      receiptWriteError: null as ReturnType<typeof errorDetails> | null,
    };
    try { await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + "\n"); }
    catch (error) { receipt.receiptWriteError = errorDetails(error); }
    // Include the full receipt in the failure log as CI may discard its temp dir.
    throw new Error(`Worker fixture ${options.scenario} failed\nFEISHU_WORKER_DIAGNOSTIC ${JSON.stringify(receipt)}`, { cause });
  }
  await rm(directory, { recursive: true, force: true });
}
