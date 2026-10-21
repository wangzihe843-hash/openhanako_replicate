import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn().mockResolvedValue("compiled") }));
vi.mock("../lib/i18n.ts", () => ({ getLocale: () => "zh-CN" }));
import { callText } from "../core/llm-client.ts";
import { compileEditableFacts, compileLongterm, migrateLegacyWeekToLongterm } from "../lib/memory/compile.ts";
import { writeCompiledResetMarker } from "../lib/memory/compiled-memory-state.ts";
import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
let root: string;
const model = { model: "test", api: "openai-completions", api_key: "test", base_url: "http://invalid.test" };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-read-failure-"));
  vi.mocked(callText).mockReset().mockResolvedValue("compiled");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in memory fixtures"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

// Target the intended file, regardless of earlier reset-marker reads. Keep the
// fault one-shot so the existing post-failure verification can read retained data.
function failReadOnce(target: string, failure: Error) {
  const readFile = fs.readFileSync;
  const injected = vi.fn();
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file === target && injected.mock.calls.length === 0) {
      injected(file);
      throw failure;
    }
    return readFile(file, options);
  });
  return injected;
}

describe("memory compilation read failures", () => {
  it.each(["EACCES", "EIO"])("preserves old long-term memory on %s without invoking the model", async (code) => {
    const target = path.join(root, "longterm.md");
    const original = Buffer.from("已有的重要记忆。\r\n");
    fs.writeFileSync(target, original);
    const failure = Object.assign(new Error("memory unreadable"), { code });
    const readFile = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === target) throw failure;
      return readFile(file, options);
    });
    await expect(compileLongterm("new input", target, model)).rejects.toBe(failure);
    expect(readFile(target)).toEqual(original);
    expect(callText).not.toHaveBeenCalled();
    expect(fs.existsSync(`${target}.fingerprint`)).toBe(false);
  });

  it("reports an unreadable fingerprint instead of repeating compilation", async () => {
    const target = path.join(root, "longterm.md");
    fs.writeFileSync(target, "existing memory");
    const failure = Object.assign(new Error("fingerprint unreadable"), { code: "EIO" });
    const injected = failReadOnce(`${target}.fingerprint`, failure);
    await expect(compileLongterm("new input", target, model)).rejects.toBe(failure);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(injected).toHaveBeenCalledWith(`${target}.fingerprint`);
    expect(fs.readFileSync(target, "utf-8")).toBe("existing memory");
    expect(callText).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EIO"])("does not replace or remove unreadable legacy memory on %s", async (code) => {
    const source = path.join(root, "week.md");
    const target = path.join(root, "longterm.md");
    fs.writeFileSync(source, "legacy memory");
    const failure = Object.assign(new Error("legacy source unreadable"), { code });
    const injected = failReadOnce(source, failure);
    await expect(migrateLegacyWeekToLongterm(root, target, model)).rejects.toBe(failure);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(injected).toHaveBeenCalledWith(source);
    expect(fs.readFileSync(source, "utf-8")).toBe("legacy memory");
    expect(fs.existsSync(`${source}.migrated.bak`)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(callText).not.toHaveBeenCalled();
  });

  describe.each(["compileLongterm", "migrateLegacyWeekToLongterm"])("%s reset marker failures", (operation) => {
    it.each(["EACCES", "EIO"])("fails closed on marker %s without modifying memory or invoking the model", async (code) => {
      const marker = path.join(root, "reset.json");
      const markerBytes = JSON.stringify({ compiledResetAt: "2026-10-15T00:00:00.000Z", resetRevision: "test-reset" });
      const source = path.join(root, "week.md");
      const target = path.join(root, "longterm.md");
      fs.writeFileSync(marker, markerBytes);
      fs.writeFileSync(source, "legacy memory");
      fs.writeFileSync(target, "existing memory");
      fs.writeFileSync(`${target}.fingerprint`, "existing fingerprint");
      const failure = Object.assign(new Error("reset marker unreadable"), { code });
      const injected = failReadOnce(marker, failure);
      const work = operation === "compileLongterm"
        ? compileLongterm("new input", target, model)
        : migrateLegacyWeekToLongterm(root, target, model);
      const error = await work.catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Memory reset marker is unreadable");
      expect(error.cause).toBe(failure);
      expect(injected).toHaveBeenCalledTimes(1);
      expect(injected).toHaveBeenCalledWith(marker);
      expect(fs.readFileSync(marker, "utf-8")).toBe(markerBytes);
      expect(fs.readFileSync(source, "utf-8")).toBe("legacy memory");
      expect(fs.readFileSync(target, "utf-8")).toBe("existing memory");
      expect(fs.readFileSync(`${target}.fingerprint`, "utf-8")).toBe("existing fingerprint");
      expect(fs.existsSync(`${source}.migrated.bak`)).toBe(false);
      expect(callText).not.toHaveBeenCalled();
    });
  });

  it("still creates long-term memory when no prior memory exists", async () => {
    const target = path.join(root, "longterm.md");
    await expect(compileLongterm("first memory", target, model)).resolves.toBe("compiled");
    expect(fs.readFileSync(target, "utf-8")).toContain("compiled");
  });
});

describe("editable Facts authoritative reads", () => {
  const watermark = "2026-10-20T11:00:00.000Z";
  const pendingAt = "2026-10-20T12:00:00.000Z";
  const original = Buffer.from("TRUSTED_OLD_FACTS\r\n- 已有事实。\r\n");
  const merged = "TRUSTED_OLD_FACTS\n- 已有事实。\nPENDING_FACT_DELTA";
  function fixture() {
    const target = path.join(root, "facts.md");
    const statePath = path.join(root, "editable-facts-state.json");
    fs.writeFileSync(target, original);
    fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, lastCompiledSummaryUpdatedAt: watermark, updatedAt: watermark }, null, 2) + "\n");
    const stateBytes = fs.readFileSync(statePath);
    const records = [
      { session_id: "consumed", updated_at: watermark, summary: "### Key Facts\nCONSUMED_FACT_DELTA" },
      { session_id: "pending", updated_at: pendingAt, summary: "### Key Facts\nPENDING_FACT_DELTA" },
    ];
    const summaryManager = {
      getAllSummaries: () => records,
      getSummariesInRange: () => [],
      getDirtySessions: () => [],
    };
    const compile = () => compileEditableFacts(summaryManager, target, model);
    const prompt = () => String(vi.mocked(callText).mock.calls.at(-1)?.[0].messages[0].content);
    const readWatermark = () => JSON.parse(fs.readFileSync(statePath, "utf8")).lastCompiledSummaryUpdatedAt;
    return { target, statePath, stateBytes, records, summaryManager, compile, prompt, readWatermark };
  }
  function expectDelta(f: ReturnType<typeof fixture>, includesOld = true) {
    if (includesOld) expect(f.prompt()).toContain("TRUSTED_OLD_FACTS");
    else expect(f.prompt()).not.toContain("TRUSTED_OLD_FACTS");
    expect(f.prompt()).toContain("PENDING_FACT_DELTA");
    expect(f.prompt()).not.toContain("CONSUMED_FACT_DELTA");
  }

  it.each(["EIO", "EACCES", "EISDIR", undefined])("propagates %s, preserves bytes and unconsumed delta, then retries", async (code) => {
    const f = fixture();
    const failure = Object.assign(new Error("synthetic Facts read failure"), { code });
    const injected = failReadOnce(f.target, failure);
    await expect(f.compile()).rejects.toBe(failure);
    expect(injected).toHaveBeenCalledExactlyOnceWith(f.target);
    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.target)).toEqual(original);
    expect(fs.readFileSync(f.statePath)).toEqual(f.stateBytes);
    expect(fs.readdirSync(root).sort()).toEqual(["editable-facts-state.json", "facts.md"]);

    vi.mocked(callText).mockResolvedValueOnce(merged);
    await expect(f.compile()).resolves.toBe("compiled");
    expect(callText).toHaveBeenCalledOnce();
    expectDelta(f);
    expect(fs.readFileSync(f.target, "utf8")).toBe(merged);
    expect(f.readWatermark()).toBe(pendingAt);
    await expect(f.compile()).resolves.toBe("skipped");
    expect(callText).toHaveBeenCalledOnce();
  });

  it("still permits synthetic ENOENT at the merge read", async () => {
    const f = fixture();
    fs.writeFileSync(f.target, "");
    const injected = failReadOnce(f.target, Object.assign(new Error("synthetic missing Facts"), { code: "ENOENT" }));
    vi.mocked(callText).mockResolvedValueOnce("PENDING_FACT_DELTA");
    await expect(f.compile()).resolves.toBe("compiled");
    expect(injected).toHaveBeenCalledOnce();
    expect(callText).toHaveBeenCalledOnce();
    expectDelta(f, false);
    expect(fs.readFileSync(f.target, "utf8")).toBe("PENDING_FACT_DELTA");
    expect(f.readWatermark()).toBe(pendingAt);
  });

  it("keeps real first-use initialization without replaying pre-existing summaries", async () => {
    const f = fixture();
    fs.unlinkSync(f.target);
    fs.unlinkSync(f.statePath);
    await expect(f.compile()).resolves.toBe("compiled");
    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.target, "utf8")).toBe("");
    expect(f.readWatermark()).toBe(pendingAt);
    f.records.push({ session_id: "future", updated_at: "2026-10-20T13:00:00.000Z", summary: "### Key Facts\nFUTURE_FACT_DELTA" });
    await expect(f.compile()).resolves.toBe("compiled");
    expect(callText).toHaveBeenCalledOnce();
    expect(f.prompt()).toContain("FUTURE_FACT_DELTA");
    expect(f.prompt()).not.toContain("PENDING_FACT_DELTA");
  });

  it("keeps initialization of a missing file with an existing watermark", async () => {
    const f = fixture();
    fs.unlinkSync(f.target);
    await expect(f.compile()).resolves.toBe("compiled");
    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.target, "utf8")).toBe("");
    expect(fs.readFileSync(f.statePath)).toEqual(f.stateBytes);
    await expect(f.compile()).resolves.toBe("compiled");
    expect(callText).toHaveBeenCalledOnce();
    expectDelta(f, false);
    expect(f.readWatermark()).toBe(pendingAt);
  });

  it("normally merges only the pending delta with the trusted baseline", async () => {
    const f = fixture();
    vi.mocked(callText).mockResolvedValueOnce(merged);
    await expect(f.compile()).resolves.toBe("compiled");
    expectDelta(f);
    expect(fs.readFileSync(f.target, "utf8")).toBe(merged);
    expect(f.readWatermark()).toBe(pendingAt);
    await expect(f.compile()).resolves.toBe("skipped");
    expect(callText).toHaveBeenCalledOnce();
  });

  it("keeps the no-fact-delta path model-free and preserves the body", async () => {
    const f = fixture();
    f.records[1].summary = "### Key Facts\nNone";
    await expect(f.compile()).resolves.toBe("compiled");
    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.target)).toEqual(original);
    expect(f.readWatermark()).toBe(pendingAt);
  });

  it.each(["AbortError", "Error"])("keeps a %s from the provider retryable without publication", async (name) => {
    const f = fixture();
    const failure = Object.assign(new Error("synthetic model failure"), { name });
    vi.mocked(callText).mockRejectedValueOnce(failure);
    await expect(f.compile()).rejects.toBe(failure);
    expect(fs.readFileSync(f.target)).toEqual(original);
    expect(fs.readFileSync(f.statePath)).toEqual(f.stateBytes);
    vi.mocked(callText).mockResolvedValueOnce(merged);
    await expect(f.compile()).resolves.toBe("compiled");
    expect(callText).toHaveBeenCalledTimes(2);
    expectDelta(f);
    expect(f.readWatermark()).toBe(pendingAt);
  });

  it("retains reset fencing while a Facts model call is pending", async () => {
    const f = fixture();
    let release!: (value: string) => void;
    vi.mocked(callText).mockReturnValueOnce(new Promise<string>((resolve) => { release = resolve; }));
    const pending = f.compile();
    expect(callText).toHaveBeenCalledOnce();
    writeCompiledResetMarker(root);
    fs.writeFileSync(f.target, "FACTS_AFTER_RESET");
    fs.writeFileSync(f.statePath, "STATE_AFTER_RESET");
    release("STALE_FACTS");
    await expect(pending).resolves.toBe("superseded");
    expect(fs.readFileSync(f.target, "utf8")).toBe("FACTS_AFTER_RESET");
    expect(fs.readFileSync(f.statePath, "utf8")).toBe("STATE_AFTER_RESET");
  });

  it("retains completion-order publication for concurrent compiles in one reset generation", async () => {
    const f = fixture();
    let firstRelease!: (value: string) => void;
    let secondRelease!: (value: string) => void;
    vi.mocked(callText)
      .mockReturnValueOnce(new Promise<string>((resolve) => { firstRelease = resolve; }))
      .mockReturnValueOnce(new Promise<string>((resolve) => { secondRelease = resolve; }));
    const first = f.compile();
    const second = f.compile();
    secondRelease("SECOND_COMPILE");
    await expect(second).resolves.toBe("compiled");
    firstRelease("FIRST_COMPILE");
    await expect(first).resolves.toBe("compiled");
    expect(callText).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(f.target, "utf8")).toBe("FIRST_COMPILE");
    expect(f.readWatermark()).toBe(pendingAt);
  });

  it.each(["EIO", "EACCES"])("the real ticker records %s and retries the unfinished Facts step", async (code) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T13:00:00.000Z"));
    const f = fixture();
    // Today has already consumed these summaries; keep the real ticker focused
    // on the pending Facts step without replacing any compiler implementation.
    fs.writeFileSync(path.join(root, "today.md"), "");
    fs.writeFileSync(path.join(root, "today-state.json"), JSON.stringify({
      schemaVersion: 1, logicalDate: "2026-10-20", lastCompiledSummaryUpdatedAt: pendingAt,
    }));
    const sessionDir = path.join(root, "sessions");
    fs.mkdirSync(sessionDir);
    const ticker = createMemoryTicker({
      agentId: "synthetic-facts-agent", agentDir: root, memoryDir: root,
      summaryManager: f.summaryManager, factStore: {}, sessionDir,
      getResolvedMemoryModel: () => model, getMemoryMasterEnabled: () => true,
      getDreamAutoEnabled: () => false, getTimezone: () => "UTC",
      memoryMdPath: path.join(root, "memory.md"), factsMdPath: f.target,
      todayMdPath: path.join(root, "today.md"), weekMdPath: path.join(root, "week.md"),
      longtermMdPath: path.join(root, "longterm.md"),
    });
    const read = fs.readFileSync;
    const failure = Object.assign(new Error(`synthetic ticker ${code}`), { code });
    let factsReads = 0;
    // The ticker first samples lines for reminders; the next read is the actual
    // compiler baseline. Later assemble reads succeed, isolating this contract.
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === f.target && ++factsReads === 2) throw failure;
      return read(file, options);
    });
    try {
      await ticker.tick();
      expect(ticker.getHealthStatus()).toMatchObject({ compileFacts: { failCount: 1, lastErrorMsg: failure.message, lastSuccessAt: null } });
      expect(callText).not.toHaveBeenCalled();
      expect(read(f.target)).toEqual(original);
      expect(read(f.statePath)).toEqual(f.stateBytes);
      const dailyPath = path.join(root, "daily-state.json");
      const failedState = JSON.parse(read(dailyPath, "utf8"));
      expect(failedState.completedSteps.compileFacts).toBeUndefined();
      expect(failedState.dailyCompletedAt).toBeNull();
      spy.mockRestore();
      vi.mocked(callText).mockResolvedValueOnce(merged);
      await ticker.tick();
      expect(ticker.getHealthStatus()).toMatchObject({ compileFacts: { failCount: 0, lastErrorMsg: null } });
      expect(callText).toHaveBeenCalledOnce();
      expectDelta(f);
      expect(f.readWatermark()).toBe(pendingAt);
      const retriedState = JSON.parse(read(dailyPath, "utf8"));
      expect(retriedState.completedSteps.compileFacts).toEqual(expect.any(String));
      expect(retriedState.dailyCompletedAt).toEqual(expect.any(String));
      expect(read(f.target, "utf8")).toBe(merged);
    } finally {
      spy.mockRestore();
      await ticker.stop();
    }
  });
});
