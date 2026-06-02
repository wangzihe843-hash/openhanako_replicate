import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReusableSubagentStore,
  REUSABLE_SUBAGENT_STORE_VERSION,
} from "../lib/reusable-subagent-store.js";

describe("ReusableSubagentStore", () => {
  let tmpDir = null;
  let storePath = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reusable-store-"));
    storePath = path.join(tmpDir, "reusable-subagents.json");
  });
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("首次 get 返回 null；beginRun 后记录 childSessionPath + runCount=1 + 组件字段", () => {
    const store = new ReusableSubagentStore(storePath);
    expect(store.get("毛毛::探索")).toBeNull();

    const rec = store.beginRun("毛毛::探索", {
      childSessionPath: "/reusable/aaa.jsonl",
      parentSessionPath: "/parent.jsonl",
      agentId: "毛毛",
      taskSuffix: "探索",
    });
    expect(rec).toMatchObject({
      reuseKey: "毛毛::探索",
      childSessionPath: "/reusable/aaa.jsonl",
      parentSessionPath: "/parent.jsonl",
      agentId: "毛毛",
      taskSuffix: "探索",
      runCount: 1,
    });
    expect(typeof rec.createdAt).toBe("string");
    expect(typeof rec.lastRunAt).toBe("string");
    expect(store.get("毛毛::探索").runCount).toBe(1);
  });

  it("同 key 二次 beginRun：runCount 累加，childSessionPath 更新，createdAt 不变", () => {
    const store = new ReusableSubagentStore(storePath);
    const first = store.beginRun("毛毛::探索", {
      childSessionPath: "/r/a.jsonl", agentId: "毛毛", taskSuffix: "探索",
    });
    const second = store.beginRun("毛毛::探索", {
      childSessionPath: "/r/a.jsonl", agentId: "毛毛", taskSuffix: "探索",
    });
    expect(second.runCount).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("finishRun 更新 summary/lastStatus，不增加 runCount", () => {
    const store = new ReusableSubagentStore(storePath);
    store.beginRun("k", { childSessionPath: "/r/a.jsonl", agentId: "a", taskSuffix: "s" });
    const done = store.finishRun("k", { summary: "干完了", status: "resolved" });
    expect(done.runCount).toBe(1);
    expect(done).toMatchObject({ summary: "干完了", lastStatus: "resolved" });
  });

  it("finishRun 对未知 key 返回 null，不静默建空记录（不兜底）", () => {
    const store = new ReusableSubagentStore(storePath);
    expect(store.finishRun("ghost", { summary: "x" })).toBeNull();
    expect(store.get("ghost")).toBeNull();
  });

  it("remove 删除记录（build-to-delete），重复 remove 返回 false", () => {
    const store = new ReusableSubagentStore(storePath);
    store.beginRun("k", { childSessionPath: "/r/a.jsonl", agentId: "a", taskSuffix: "s" });
    expect(store.remove("k")).toBe(true);
    expect(store.get("k")).toBeNull();
    expect(store.remove("k")).toBe(false);
  });

  it("removeByAgentId：删某 agent 的所有实例，别的 agent 不受影响", () => {
    const store = new ReusableSubagentStore(storePath);
    store.beginRun("毛毛::探索", { childSessionPath: "/r/a.jsonl", agentId: "毛毛", taskSuffix: "探索" });
    store.beginRun("毛毛::下笔", { childSessionPath: "/r/b.jsonl", agentId: "毛毛", taskSuffix: "下笔" });
    store.beginRun("butter::调研", { childSessionPath: "/r/c.jsonl", agentId: "butter", taskSuffix: "调研" });
    expect(store.removeByAgentId("毛毛")).toBe(2);
    expect(store.get("毛毛::探索")).toBeNull();
    expect(store.get("毛毛::下笔")).toBeNull();
    expect(store.get("butter::调研")).toBeTruthy();
    expect(store.removeByAgentId("nobody")).toBe(0); // 无匹配返回 0
  });

  it("removeBySession：删某 parent session 的所有实例，别的 session 不受影响", () => {
    const store = new ReusableSubagentStore(storePath);
    store.beginRun("kA1", { childSessionPath: "/r/a1.jsonl", agentId: "毛毛", taskSuffix: "探索", parentSessionPath: "/s/a.jsonl" });
    store.beginRun("kA2", { childSessionPath: "/r/a2.jsonl", agentId: "毛毛", taskSuffix: "下笔", parentSessionPath: "/s/a.jsonl" });
    store.beginRun("kB1", { childSessionPath: "/r/b1.jsonl", agentId: "毛毛", taskSuffix: "探索", parentSessionPath: "/s/b.jsonl" });
    expect(store.removeBySession("/s/a.jsonl")).toBe(2);
    expect(store.get("kA1")).toBeNull();
    expect(store.get("kA2")).toBeNull();
    expect(store.get("kB1")).toBeTruthy(); // 别的 session 不动
    expect(store.removeBySession("/s/none")).toBe(0);
  });

  it("不同 key 互相隔离", () => {
    const store = new ReusableSubagentStore(storePath);
    store.beginRun("毛毛::探索", { childSessionPath: "/r/a.jsonl", agentId: "毛毛", taskSuffix: "探索" });
    store.beginRun("毛毛::下笔", { childSessionPath: "/r/b.jsonl", agentId: "毛毛", taskSuffix: "下笔" });
    expect(store.get("毛毛::探索").childSessionPath).toBe("/r/a.jsonl");
    expect(store.get("毛毛::下笔").childSessionPath).toBe("/r/b.jsonl");
    expect(store.list()).toHaveLength(2);
  });

  it("持久化：写盘后新实例 restore 出 childSessionPath + runCount + 终态摘要 + version", () => {
    const store = new ReusableSubagentStore(storePath);
    store.beginRun("k", { childSessionPath: "/r/a.jsonl", agentId: "a", taskSuffix: "s" });
    store.beginRun("k", { childSessionPath: "/r/a.jsonl", agentId: "a", taskSuffix: "s" });
    store.finishRun("k", { summary: "done", status: "resolved" });

    const restored = new ReusableSubagentStore(storePath);
    expect(restored.get("k")).toMatchObject({
      childSessionPath: "/r/a.jsonl",
      runCount: 2,
      summary: "done",
      lastStatus: "resolved",
    });
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(onDisk.schemaVersion).toBe(REUSABLE_SUBAGENT_STORE_VERSION);
    expect(onDisk.instances.k.reuseKey).toBe("k");
  });

  it("read-time：v1 全局条目 / 无版本裸 map 整体丢弃（破坏性 per-session 迁移），不崩且可续写", () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    // v1（全局 agentId::suffix 作用域）旧数据：key 无 session 维度，无法重映射到 per-session。
    fs.writeFileSync(storePath, JSON.stringify({ schemaVersion: 1, instances: { "old::k": { childSessionPath: "/r/old.jsonl" } } }));
    const store = new ReusableSubagentStore(storePath);
    expect(store.size).toBe(0);              // v1 旧条目整体丢弃
    expect(store.get("old::k")).toBeNull();
    store.beginRun("k", { childSessionPath: "/r/a.jsonl", agentId: "a", taskSuffix: "s" });
    expect(store.get("k").runCount).toBe(1); // 起空账本后正常写入 v2
  });

  it("损坏 JSON 文件不崩（按空账本起步）", () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "{ not valid json");
    const store = new ReusableSubagentStore(storePath);
    expect(store.size).toBe(0);
    // 仍可正常写入
    store.beginRun("k", { childSessionPath: "/r/a.jsonl", agentId: "a", taskSuffix: "s" });
    expect(store.get("k").runCount).toBe(1);
  });

  // ---- 串行锁（per-reuseKey，杜绝并发写同一 JSONL）----

  it("isBusy：无运行 false，运行中 true，跑完回落 false", async () => {
    const store = new ReusableSubagentStore(storePath);
    expect(store.isBusy("k")).toBe(false);
    let release;
    const gate = new Promise((r) => { release = r; });
    const p = store.runSerialized("k", async () => { await gate; });
    expect(store.isBusy("k")).toBe(true);
    release();
    await p;
    expect(store.isBusy("k")).toBe(false);
  });

  it("runSerialized：同 key 串行（第二个在第一个完成后才开始）", async () => {
    const store = new ReusableSubagentStore(storePath);
    const order = [];
    let release1;
    const gate1 = new Promise((r) => { release1 = r; });
    const p1 = store.runSerialized("k", async () => { order.push("s1"); await gate1; order.push("e1"); });
    const p2 = store.runSerialized("k", async () => { order.push("s2"); });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["s1"]); // 第二个被串行挡住，还没开始
    release1();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["s1", "e1", "s2"]);
  });

  it("runSerialized：不同 key 并行（互不阻塞）", async () => {
    const store = new ReusableSubagentStore(storePath);
    const order = [];
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const pa = store.runSerialized("A", async () => { order.push("sA"); await gateA; order.push("eA"); });
    const pb = store.runSerialized("B", async () => { order.push("sB"); });
    await new Promise((r) => setTimeout(r, 0));
    // B 不被 A 的 gate 阻塞，已开始
    expect(order).toContain("sA");
    expect(order).toContain("sB");
    releaseA();
    await Promise.all([pa, pb]);
  });

  it("runSerialized：第一个抛错不阻断第二个", async () => {
    const store = new ReusableSubagentStore(storePath);
    const p1 = store.runSerialized("k", async () => { throw new Error("boom"); });
    const p2 = store.runSerialized("k", async () => "ok");
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
  });
});
