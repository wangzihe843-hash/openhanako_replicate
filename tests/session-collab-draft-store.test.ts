import { describe, it, expect, vi } from "vitest";
import { SessionCollabDraftStore } from "../lib/session-collab/draft-store.ts";

function makeEntry(overrides: any = {}) {
  return {
    kind: "send" as const,
    sourceSessionId: "src-1",
    draft: { targetSessionId: "dst-1", message: "hi" },
    apply: vi.fn().mockResolvedValue({ delivered: true }),
    ...overrides,
  };
}

describe("SessionCollabDraftStore", () => {
  it("create 返回公开条目且不暴露 apply 闭包", () => {
    const store = new SessionCollabDraftStore();
    const entry = store.create(makeEntry());
    expect(entry.suggestionId).toMatch(/^session_/);
    expect(entry.kind).toBe("send");
    expect((entry as any).apply).toBeUndefined();
  });

  it("apply 成功后条目即删，二次 apply 报 not-found", async () => {
    const store = new SessionCollabDraftStore();
    const { suggestionId } = store.create(makeEntry());
    const first = await store.apply(suggestionId, { message: "edited" });
    expect(first.ok).toBe(true);
    const second = await store.apply(suggestionId, {});
    expect(second).toEqual({ ok: false, reason: "not-found" });
  });

  it("apply 把编辑后的 draft 透传给闭包", async () => {
    const store = new SessionCollabDraftStore();
    const apply = vi.fn().mockResolvedValue("ok");
    const { suggestionId } = store.create(makeEntry({ apply }));
    await store.apply(suggestionId, { message: "edited" });
    expect(apply).toHaveBeenCalledWith({ message: "edited" });
  });

  it("apply 闭包抛错时条目保留，可重试", async () => {
    const store = new SessionCollabDraftStore();
    const apply = vi.fn()
      .mockRejectedValueOnce(new Error("session_busy"))
      .mockResolvedValueOnce("ok");
    const { suggestionId } = store.create(makeEntry({ apply }));
    await expect(store.apply(suggestionId, {})).rejects.toThrow("session_busy");
    const retry = await store.apply(suggestionId, {});
    expect(retry.ok).toBe(true);
  });

  it("并发二次 apply 在首次未决期间被拒绝，闭包只执行一次", async () => {
    const store = new SessionCollabDraftStore();
    let resolveApply: (v: unknown) => void;
    const apply = vi.fn(() => new Promise((res) => { resolveApply = res; }));
    const { suggestionId } = store.create(makeEntry({ apply }));
    const first = store.apply(suggestionId, {});
    const second = await store.apply(suggestionId, {});
    expect(second).toEqual({ ok: false, reason: "in-flight" });
    resolveApply!("done");
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("首次 apply 失败后 in-flight 标记清除，重试可成功", async () => {
    const store = new SessionCollabDraftStore();
    const apply = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const { suggestionId } = store.create(makeEntry({ apply }));
    await expect(store.apply(suggestionId, {})).rejects.toThrow("boom");
    const retry = await store.apply(suggestionId, {});
    expect(retry.ok).toBe(true);
  });

  it("listForSession 按源 sessionId 过滤", () => {
    const store = new SessionCollabDraftStore();
    store.create(makeEntry({ sourceSessionId: "a" }));
    store.create(makeEntry({ sourceSessionId: "b" }));
    expect(store.listForSession("a")).toHaveLength(1);
  });

  describe("discard（灰测修复 C：确认状态持久化的忽略入口）", () => {
    it("discard 已存在条目：返回被删条目的公开形态，条目随后不可再 get", () => {
      const store = new SessionCollabDraftStore();
      const entry = store.create(makeEntry());
      const discarded = store.discard(entry.suggestionId);
      expect(discarded).toMatchObject({ suggestionId: entry.suggestionId, kind: "send", sourceSessionId: "src-1" });
      expect((discarded as any).apply).toBeUndefined();
      expect(store.get(entry.suggestionId)).toBeNull();
    });

    it("discard 不存在的 suggestionId：返回 null", () => {
      const store = new SessionCollabDraftStore();
      expect(store.discard("nope")).toBeNull();
    });

    it("discard in-flight 条目：返回 null，条目不被抽掉（apply 仍在跑）", async () => {
      const store = new SessionCollabDraftStore();
      let resolveApply: (v: unknown) => void;
      const apply = vi.fn(() => new Promise((res) => { resolveApply = res; }));
      const entry = store.create(makeEntry({ apply }));
      const applyPromise = store.apply(entry.suggestionId, {});
      await new Promise((r) => setTimeout(r, 10));
      expect(store.discard(entry.suggestionId)).toBeNull();
      // 条目仍在，还能被 get 到（没被静默抽走）
      expect(store.get(entry.suggestionId)).toBeTruthy();
      resolveApply!("done");
      await expect(applyPromise).resolves.toMatchObject({ ok: true });
    });
  });
});
