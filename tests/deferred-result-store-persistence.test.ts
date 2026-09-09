import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";

let dir: string;
const stores: DeferredResultStore[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deferred-persistence-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

it.each(["write", "rename"] as const)("retries a failed %s during shutdown and restores the latest task result", (stage) => {
  const persistPath = path.join(dir, "tasks.json");
  const store = new DeferredResultStore(null, persistPath);
  stores.push(store);
  store.defer("task-a", "/sessions/a", { type: "image" });
  vi.advanceTimersByTime(1000);
  expect(JSON.parse(fs.readFileSync(persistPath, "utf-8"))["task-a"].status).toBe("pending");

  const error = Object.assign(new Error("temporary disk failure"), { code: "EACCES" });
  const failingWrite = stage === "write"
    ? vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw error; })
    : vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw error; });
  store.resolve("task-a", { files: ["result.png"] });
  expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  expect(failingWrite).toHaveBeenCalledOnce();
  expect(JSON.parse(fs.readFileSync(persistPath, "utf-8"))["task-a"].status).toBe("pending");
  failingWrite.mockRestore();

  // No further state mutation occurs to mark the result dirty again.
  store.dispose();
  const reloaded = new DeferredResultStore(null, persistPath);
  stores.push(reloaded);
  expect(reloaded.query("task-a")).toMatchObject({
    status: "resolved",
    result: { files: ["result.png"] },
    delivered: false,
  });
});
