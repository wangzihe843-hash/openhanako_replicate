import { describe, expect, it } from "vitest";
import { createLimiter } from "../lib/workflow/concurrency.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("workflow concurrency limiter", () => {
  it("同时在飞不超过 maxConcurrent", async () => {
    const limiter = createLimiter({ maxConcurrent: 2, maxTotal: 100 });
    let peak = 0;
    let live = 0;
    const job = () => async () => {
      live++; peak = Math.max(peak, live);
      await tick();
      live--;
      return "ok";
    };
    await Promise.all([limiter.run(job()), limiter.run(job()), limiter.run(job()), limiter.run(job())]);
    expect(peak).toBe(2);
  });

  it("超过 maxTotal 的 run 直接 reject", async () => {
    const limiter = createLimiter({ maxConcurrent: 5, maxTotal: 2 });
    await limiter.run(async () => 1);
    await limiter.run(async () => 2);
    await expect(limiter.run(async () => 3)).rejects.toThrow(/agent 总数上限/);
  });

  it("thunk 抛错时 run 的 promise reject、不卡住后续", async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxTotal: 10 });
    await expect(limiter.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });

  it("totalSpawned 永不超过 maxTotal（被拒的 agent 不计入）", async () => {
    const limiter = createLimiter({ maxConcurrent: 2, maxTotal: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => limiter.run(async () => i)),
    );
    const admitted = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    // 恰好放行 maxTotal 个，其余全拒
    expect(admitted).toBe(3);
    expect(rejected).toBe(7);
    // totalSpawned 只数真正跑过的，不被拒绝者撑爆
    expect(limiter.totalSpawned).toBe(3);
    expect(limiter.totalSpawned).toBeLessThanOrEqual(3);
  });
});
