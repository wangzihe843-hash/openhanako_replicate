import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../lib/memory/dream/model-runner.ts", () => ({
  atomizeDreamMemory: vi.fn(() => { throw new Error("no model allowed"); }),
  composeDreamMemory: vi.fn(), dedupeDreamMemory: vi.fn(), dreamModelId: vi.fn(),
  optimizeDreamMemory: vi.fn(), verifyDreamSections: vi.fn(),
}));
import { createMemoryDreamRunner } from "../lib/memory/dream/runner.ts";
import * as memoryCompiler from "../lib/memory/compile.ts";
import { emptyDreamState } from "../lib/memory/dream/state-store.ts";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it.each(["manual", "automatic"] as const)("B06 settles %s state-write failures and permits a later retry", async trigger => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-failure-")); dirs.push(dir);
  const resolvedModel = vi.fn(async () => { throw new Error("no model allowed"); });
  const runner = createMemoryDreamRunner({
    memoryDir: dir, memoryMdPath: path.join(dir, "memory.md"),
    getResolvedMemoryModel: resolvedModel, getLogicalDate: () => "2026-09-10",
  });
  const rename = fs.renameSync;
  const fail = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith(path.join("dream", "state.json"))) throw new Error("state write denied");
    return rename(from, to);
  });
  // Vitest reports any unhandled rejection as a failure in addition to these assertions.
  if (trigger === "automatic") expect(runner.startAutomaticIfEligible()).not.toBeNull();
  else runner.start({ trigger });
  await vi.waitFor(() => expect(runner.isRunning()).toBe(false));
  expect(runner.getStatus().status).toBe("failed");
  expect(runner.getStatus().lastRun?.error).toContain("state write denied");
  fail.mockRestore();
  if (trigger === "automatic") expect(runner.startAutomaticIfEligible()).not.toBeNull();
  else runner.start({ trigger });
  await vi.waitFor(() => expect(runner.isRunning()).toBe(false));
  expect(runner.getStatus().status).toBe("failed");
  expect(runner.getStatus().lastRun?.errorCode).toBe("dream_no_memory");
  expect(fs.existsSync(path.join(dir, "dream", "state.json"))).toBe(true);
  expect(resolvedModel).not.toHaveBeenCalled();
});

it("B06 preserves unreadable state and retries its read after repair", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-unreadable-")); dirs.push(dir);
  const statePath = path.join(dir, "dream", "state.json");
  fs.mkdirSync(path.dirname(statePath));
  fs.writeFileSync(statePath, "{ corrupt state bytes");
  const runner = createMemoryDreamRunner({
    memoryDir: dir, memoryMdPath: path.join(dir, "memory.md"),
    getResolvedMemoryModel: async () => { throw new Error("no model allowed"); },
    getLogicalDate: () => "2026-09-10",
  });
  runner.start();
  await vi.waitFor(() => expect(runner.isRunning()).toBe(false));
  expect(runner.getStatus().status).toBe("failed");
  expect(runner.getStatus().lastRun?.error).toContain("unreadable");
  expect(fs.readFileSync(statePath, "utf8")).toBe("{ corrupt state bytes");
  fs.writeFileSync(statePath, JSON.stringify(emptyDreamState()));
  runner.start();
  await vi.waitFor(() => expect(runner.isRunning()).toBe(false));
  expect(runner.getStatus().lastRun?.errorCode).toBe("dream_no_memory");
});

it("B06 handles an unexpected exception while constructing the failure report", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-report-failure-")); dirs.push(dir);
  const runner = createMemoryDreamRunner({
    memoryDir: dir, memoryMdPath: path.join(dir, "memory.md"),
    getResolvedMemoryModel: async () => { throw new Error("no model allowed"); },
    getLogicalDate: () => "2026-09-10",
  });
  const compile = vi.spyOn(memoryCompiler, "buildCompiledMemoryMarkdown").mockImplementation(() => { throw new Error("report failed"); });
  runner.start();
  await vi.waitFor(() => expect(runner.isRunning()).toBe(false));
  expect(runner.getStatus()).toMatchObject({ status: "failed", runId: null, startedAt: null });
  expect(runner.getStatus().lastRun?.error).toBe("report failed");
  compile.mockRestore();
  runner.start();
  await vi.waitFor(() => expect(runner.isRunning()).toBe(false));
  expect(runner.getStatus().lastRun?.errorCode).toBe("dream_no_memory");
});
