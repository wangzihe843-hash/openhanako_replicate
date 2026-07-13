import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import pointerStoreModule from "../shared/artifact-core/pointer-store.cjs";

const {
  artifactsRoot,
  pointerPath,
  readPointer,
  writePointer,
  promote,
  demoteToPrevious,
  readQuarantine,
  isQuarantined,
  appendQuarantine,
  acquireLock,
  atomicWriteJson,
} = pointerStoreModule as {
  artifactsRoot: (homeDir: string) => string;
  pointerPath: (homeDir: string, channel: string, slot: string) => string;
  readPointer: (homeDir: string, channel: string, slot: string) => Promise<any>;
  writePointer: (homeDir: string, channel: string, slot: string, value: any) => Promise<void>;
  promote: (homeDir: string, channel: string) => Promise<any>;
  demoteToPrevious: (homeDir: string, channel: string) => Promise<any>;
  readQuarantine: (homeDir: string) => Promise<any[]>;
  isQuarantined: (homeDir: string, channel: string, train: number) => Promise<boolean>;
  appendQuarantine: (homeDir: string, entry: any) => Promise<any[]>;
  acquireLock: (homeDir: string, opts?: any) => Promise<{ release: () => Promise<void> } | null>;
  atomicWriteJson: (filePath: string, value: unknown) => Promise<void>;
};

const tempDirs: string[] = [];

function makeHomeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pointer-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("pointer-store: read/write pointers", () => {
  it("returns null for a pointer that doesn't exist yet", async () => {
    const homeDir = makeHomeDir();
    expect(await readPointer(homeDir, "stable", "current")).toBeNull();
  });

  it("round-trips a pointer value through atomic write", async () => {
    const homeDir = makeHomeDir();
    await writePointer(homeDir, "stable", "current", { train: 5, version: "1.0.0" });
    expect(await readPointer(homeDir, "stable", "current")).toEqual({ train: 5, version: "1.0.0" });
  });

  it("leaves no leftover temp file after a successful write", async () => {
    const homeDir = makeHomeDir();
    await writePointer(homeDir, "stable", "current", { train: 1 });
    const dirEntries = fs.readdirSync(path.join(artifactsRoot(homeDir), "pointers"));
    expect(dirEntries.every((f) => !f.includes(".tmp-"))).toBe(true);
  });
});

describe("pointer-store: promote atomicity", () => {
  it("promotes next -> current, current -> previous", async () => {
    const homeDir = makeHomeDir();
    await writePointer(homeDir, "stable", "current", { train: 1 });
    await writePointer(homeDir, "stable", "next", { train: 2 });

    const result = await promote(homeDir, "stable");

    expect(result.promoted).toBe(true);
    expect(await readPointer(homeDir, "stable", "current")).toEqual({ train: 2 });
    expect(await readPointer(homeDir, "stable", "previous")).toEqual({ train: 1 });
    expect(await readPointer(homeDir, "stable", "next")).toBeNull();
  });

  it("is a no-op when there is no next pointer", async () => {
    const homeDir = makeHomeDir();
    await writePointer(homeDir, "stable", "current", { train: 1 });

    const result = await promote(homeDir, "stable");

    expect(result.promoted).toBe(false);
    expect(await readPointer(homeDir, "stable", "current")).toEqual({ train: 1 });
  });

  it("a leftover .tmp- file from a simulated interrupted write does not affect subsequent reads", async () => {
    const homeDir = makeHomeDir();
    await writePointer(homeDir, "stable", "current", { train: 1 });

    // Simulate a crash mid-write: temp file written, rename never happened.
    const pointersDir = path.dirname(pointerPath(homeDir, "stable", "current"));
    fs.mkdirSync(pointersDir, { recursive: true });
    const leftoverTmp = path.join(pointersDir, "stable.current.json.tmp-99999-deadbeef");
    fs.writeFileSync(leftoverTmp, JSON.stringify({ train: 999, corrupt: true }));

    // The real pointer is unaffected: readers never open by glob/prefix, only exact name.
    expect(await readPointer(homeDir, "stable", "current")).toEqual({ train: 1 });

    // promote() must also be unaffected by the stray temp file.
    await writePointer(homeDir, "stable", "next", { train: 2 });
    const result = await promote(homeDir, "stable");
    expect(result.promoted).toBe(true);
    expect(await readPointer(homeDir, "stable", "current")).toEqual({ train: 2 });
    expect(await readPointer(homeDir, "stable", "previous")).toEqual({ train: 1 });

    // Leftover garbage file is still just inert bytes on disk, never read.
    expect(fs.existsSync(leftoverTmp)).toBe(true);
  });

  it("an interrupted atomicWriteJson (temp written, rename simulated as never happening) leaves the prior file intact", async () => {
    const homeDir = makeHomeDir();
    const targetPath = path.join(artifactsRoot(homeDir), "pointers", "stable.current.json");
    await atomicWriteJson(targetPath, { train: 1 });

    // Simulate the crash: write the temp file for a *second* write but skip renaming it in.
    const tmpPath = `${targetPath}.tmp-simulated-crash`;
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ train: 2 }));
    // (no rename — this is the crash)

    const raw = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    expect(raw).toEqual({ train: 1 });
  });
});

describe("pointer-store: demoteToPrevious", () => {
  it("pops previous into current", async () => {
    const homeDir = makeHomeDir();
    await writePointer(homeDir, "stable", "current", { train: 2 });
    await writePointer(homeDir, "stable", "previous", { train: 1 });

    const result = await demoteToPrevious(homeDir, "stable");

    expect(result.demoted).toBe(true);
    expect(await readPointer(homeDir, "stable", "current")).toEqual({ train: 1 });
  });

  it("is a no-op when there is no previous pointer", async () => {
    const homeDir = makeHomeDir();
    await writePointer(homeDir, "stable", "current", { train: 2 });

    const result = await demoteToPrevious(homeDir, "stable");
    expect(result.demoted).toBe(false);
  });
});

describe("pointer-store: quarantine", () => {
  it("starts empty", async () => {
    const homeDir = makeHomeDir();
    expect(await readQuarantine(homeDir)).toEqual([]);
    expect(await isQuarantined(homeDir, "stable", 412)).toBe(false);
  });

  it("appends a train and it becomes quarantined (short-circuit check)", async () => {
    const homeDir = makeHomeDir();
    await appendQuarantine(homeDir, { channel: "stable", train: 412, reason: "crash-loop" });

    expect(await isQuarantined(homeDir, "stable", 412)).toBe(true);
    expect(await isQuarantined(homeDir, "stable", 413)).toBe(false);
    expect(await isQuarantined(homeDir, "beta", 412)).toBe(false);
  });

  it("is idempotent for the same channel/train", async () => {
    const homeDir = makeHomeDir();
    await appendQuarantine(homeDir, { channel: "stable", train: 412 });
    await appendQuarantine(homeDir, { channel: "stable", train: 412 });
    const list = await readQuarantine(homeDir);
    expect(list.filter((e) => e.channel === "stable" && e.train === 412)).toHaveLength(1);
  });
});

describe("pointer-store: directory-level lock", () => {
  it("a second acquire fails while the first holder is still holding it", async () => {
    const homeDir = makeHomeDir();
    const first = await acquireLock(homeDir);
    expect(first).not.toBeNull();

    const second = await acquireLock(homeDir);
    expect(second).toBeNull();

    await first!.release();
  });

  it("a new acquire succeeds after release", async () => {
    const homeDir = makeHomeDir();
    const first = await acquireLock(homeDir);
    await first!.release();

    const second = await acquireLock(homeDir);
    expect(second).not.toBeNull();
    await second!.release();
  });

  it("steals a stale lock older than staleMs", async () => {
    const homeDir = makeHomeDir();
    const first = await acquireLock(homeDir, { staleMs: 10 });
    expect(first).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 30));

    const second = await acquireLock(homeDir, { staleMs: 10 });
    expect(second).not.toBeNull();
    await second!.release();
  });
});
