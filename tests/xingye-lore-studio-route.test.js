import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callText } from "../core/llm-client.ts";
import { createXingyeRoute } from "../server/routes/xingye.js";

vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn() }));

function postTurn(body) {
  const app = new Hono();
  app.route("/api", createXingyeRoute({
    resolveUtilityConfig: () => ({
      utility: "test-model", api: "openai-completions", base_url: "http://localhost:1234",
    }),
  }));
  return app.request("/api/xingye/lore-studio/turn", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: "agent-a", displayName: "林雾", ...body }),
  });
}

beforeEach(() => vi.mocked(callText).mockReset());

describe("lore studio reviewable motivation drafts", () => {
  it("passes existing context and draft requests to the model with gap-based stopping rules", async () => {
    vi.mocked(callText).mockResolvedValue(JSON.stringify({ type: "plan", loreEntries: [], profilePatch: [] }));
    const response = await postTurn({
      backgroundStory: "想重建信任，但不愿暴露朋友的秘密。",
      existingProfile: { values: "守诺比被赞赏更重要。" },
      transcript: [{ role: "user", content: "先给草稿，例外以后补。" }],
    });
    expect(response.status).toBe(200);
    const prompt = vi.mocked(callText).mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("停止提问条件");
    expect(prompt).toContain("先给草稿，例外以后补。");
    expect(prompt).toContain("守诺比被赞赏更重要。");
    expect(prompt).toContain("什么情况下会破例");
    expect(prompt).toContain("选择要付出什么代价");
    expect(prompt).toContain("省略争议信息");
    expect(prompt).not.toContain("≥90%");
    expect(prompt).not.toContain("宁可多问");
  });

  it("returns a profile-only draft with reasons and unresolved notes while dropping unknown fields", async () => {
    vi.mocked(callText).mockResolvedValue(JSON.stringify({
      type: "plan", loreEntries: [], notes: "尚未确定何时破例，暂不写入。",
      profilePatch: [
        { field: "behaviorLogic", value: " 为赢回信任主动赴约；涉及秘密时会拒绝，接受失望的代价。 ", rationale: "来自作者给出的目标与边界。" },
        { field: "taboos", value: "不以秘密换亲近。" },
        { field: "newMotivation", value: "不得创建新字段" },
      ],
    }));
    const response = await postTurn({ backgroundStory: "资料已足够，请直接整理。" });
    const { turn } = await response.json();
    expect(turn.type).toBe("plan");
    expect(turn.loreEntries).toEqual([]);
    expect(turn.profilePatch).toEqual([
      { field: "behaviorLogic", value: "为赢回信任主动赴约；涉及秘密时会拒绝，接受失望的代价。", rationale: "来自作者给出的目标与边界。" },
      { field: "taboos", value: "不以秘密换亲近。" },
    ]);
    expect(turn.notes).toContain("尚未确定何时破例");
    expect(turn.yuan).toBeUndefined();
    expect(turn.corruptionTendency).toBeUndefined();
    expect(turn.corruptionSeed).toBeUndefined();
  });

  it("retains questions for a material knowledge gap", async () => {
    vi.mocked(callText).mockResolvedValue(JSON.stringify({
      type: "questions", questions: [{ id: "knowledge", prompt: "林雾知道朋友的秘密吗？", category: "background", options: ["知道", "不知道"] }],
    }));
    const response = await postTurn({ backgroundStory: "作者设定中朋友藏着秘密。" });
    const { turn } = await response.json();
    expect(turn.type).toBe("questions");
    expect(turn.questions[0]).toMatchObject({ allowCustom: true, prompt: "林雾知道朋友的秘密吗？" });
  });

  it("does not turn malformed model output into an accepted plan", async () => {
    vi.mocked(callText).mockResolvedValue("not json");
    const response = await postTurn({ backgroundStory: "先给草稿。" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "invalid JSON from model" });
  });
});
