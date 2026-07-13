import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/session-collab/delivery.ts", () => ({
  deliverAgentMessage: vi.fn(),
}));

import { createSessionTool } from "../lib/tools/session-tool.ts";
import { SessionCollabDraftStore } from "../lib/session-collab/draft-store.ts";
import { deliverAgentMessage } from "../lib/session-collab/delivery.ts";

// 沿用 tests/session-tool-read.test.ts 的 makeEngine/makeTool/CTX/run 模式，
// 差异：getDraftStore 返回真实 SessionCollabDraftStore 实例（不 mock，直接验 one-shot 链路），
// deliverAgentMessage 整体 mock 掉（跨 session 投递不是本文件的验证范围）。
function makeEngine(overrides: any = {}) {
  return {
    getSessionManifest: vi.fn().mockReturnValue({ currentLocator: { path: "/tmp/a.jsonl" }, ownerAgentId: "hana" }),
    resolveSessionOwnership: vi.fn().mockReturnValue({ agentId: "hana" }),
    getSessionIdForPath: vi.fn().mockReturnValue("sid-src"),
    isSessionStreaming: vi.fn().mockReturnValue(false),
    getAgent: vi.fn().mockReturnValue({ agentName: "Hana" }),
    ...overrides,
  };
}

const DEFAULT_ROSTER = [{ id: "hana", name: "Hana" }, { id: "kimi", name: "Kimi" }];

function makeTool(engine: any, store: any, roster: any[] = DEFAULT_ROSTER) {
  return createSessionTool({
    getEngine: () => engine,
    getDraftStore: () => store,
    listAgents: () => roster,
    agentId: "hana",
    getAgentName: () => "Hana",
  });
}

const CTX = { sessionManager: { getSessionFile: () => "/tmp/src.jsonl" } };

async function run(tool: any, params: any) {
  return tool.execute("t1", params, undefined, undefined, CTX);
}

beforeEach(() => {
  vi.mocked(deliverAgentMessage).mockReset().mockResolvedValue({ accepted: true, targetSessionId: "x" } as any);
});

describe("session tool write side", () => {
  it("send 缺 message 报错文本含 send 用法段（draft card）", async () => {
    const store = new SessionCollabDraftStore();
    const result = await run(makeTool(makeEngine(), store), { action: "send", sessionId: "sid-a" });
    const text = result.content?.[0]?.text || "";
    expect(text).toContain("draft card");
  });

  it("send 目标=源 session 拒绝", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine({ getSessionIdForPath: vi.fn().mockReturnValue("sid-a") });
    const result = await run(makeTool(engine, store), { action: "send", sessionId: "sid-a", message: "hi" });
    const text = result.content?.[0]?.text || "";
    expect(text).toContain("current session");
  });

  it("send 成功：产草稿卡", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine();
    const result = await run(makeTool(engine, store), { action: "send", sessionId: "sid-a", message: "hi" });
    expect(result.details).toMatchObject({
      kind: "session_send_draft",
      target: { type: "session", sessionId: "sid-a" },
      draft: { targetSessionId: "sid-a", message: "hi" },
    });
    expect(typeof result.details.suggestionId).toBe("string");
    const entry = store.get(result.details.suggestionId);
    expect(entry).toBeTruthy();
    expect(entry.kind).toBe("send");
  });

  it("send 的 apply 闭包透传编辑值", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine();
    const result = await run(makeTool(engine, store), { action: "send", sessionId: "sid-a", message: "hi" });
    const suggestionId = result.details.suggestionId;
    await store.apply(suggestionId, { message: "edited" });
    expect(deliverAgentMessage).toHaveBeenCalledWith(engine, {
      targetSessionId: "sid-a",
      message: "edited",
      from: { agentId: "hana", agentName: "Hana" },
    });
  });

  it("create 的 agent 不存在", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine();
    const result = await run(makeTool(engine, store, DEFAULT_ROSTER), { action: "create", agent: "nope", message: "hi" });
    const text = result.content?.[0]?.text || "";
    expect(text).toContain("hana");
    expect(text).toContain("kimi");
  });

  it("create 成功：产草稿卡", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine();
    const result = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });
    expect(result.details).toMatchObject({
      kind: "session_create_draft",
      draft: { agentId: "kimi", model: null, title: null, firstMessage: "hi" },
    });
  });

  it("create 的 apply 闭包：建 session + 投递首条消息", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine({
      createSessionForAgent: vi.fn().mockResolvedValue({ sessionPath: "/tmp/new.jsonl", sessionId: "sid-new", agentId: "kimi" }),
      persistSessionMeta: vi.fn(),
    });
    const result = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });
    const suggestionId = result.details.suggestionId;
    const applied = await store.apply(suggestionId);
    expect(engine.createSessionForAgent).toHaveBeenCalledWith(
      "kimi", undefined, true, undefined, { workspaceFolders: [], visibleInSessionList: true },
    );
    expect(deliverAgentMessage).toHaveBeenCalledWith(engine, expect.objectContaining({ targetSessionId: "sid-new" }));
    expect(applied.result).toEqual({ sessionId: "sid-new" });
  });

  it("create 半成功：首条消息投递失败", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine({
      createSessionForAgent: vi.fn().mockResolvedValue({ sessionPath: "/tmp/new.jsonl", sessionId: "sid-new", agentId: "kimi" }),
      persistSessionMeta: vi.fn(),
    });
    vi.mocked(deliverAgentMessage).mockReset().mockRejectedValue(new Error("session_busy"));
    const result = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });
    const suggestionId = result.details.suggestionId;
    await expect(store.apply(suggestionId)).rejects.toThrow(/^first_message_failed:sid-new:/);
  });
});
