import { Agent, type AgentEvent, type AgentOptions } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { installToolOutcomeAdapter } from "../lib/pi-sdk/tool-outcome-adapter.ts";

const usage = {
  input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function runTool(afterToolCall?: AgentOptions["afterToolCall"], mode: "failure" | "success" | "implicit-success" | "throw" = "failure") {
  const requests: TranscriptContext[] = [];
  const events: AgentEvent[] = [];
  const result = {
    content: [{ type: "text" as const, text: mode === "failure" ? "denied" : "completed" }],
    details: { origin: "tool" }, structuredContent: { ok: mode !== "failure", reason: mode === "failure" ? "denied" : "completed" },
    ...(mode === "implicit-success" ? {} : { isError: mode === "failure" }), usage,
  };
  const agent = new Agent({
    initialState: {
      model: { id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions",
        baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1000 },
      tools: [{ name: "fixture_tool", label: "Fixture", description: "Synthetic tool", parameters: Type.Object({}),
        execute: async () => {
          if (mode === "throw") throw new Error("synthetic tool failure");
          return result;
        } }],
    },
    afterToolCall,
    streamFn: (model, context) => {
      requests.push(structuredClone(context));
      const first = requests.length === 1;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(), usage,
        content: first ? [{ type: "toolCall", id: "fixture-call", name: "fixture_tool", arguments: {} }]
          : [{ type: "text", text: "done" }], stopReason: first ? "toolUse" : "stop",
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end(message);
      return stream;
    },
  });
  agent.subscribe(event => { events.push(event); });
  installToolOutcomeAdapter({ agent });
  await agent.prompt("exercise the synthetic tool");
  const completed = events.find(event => event.type === "tool_execution_end");
  if (!completed || completed.type !== "tool_execution_end") throw new Error("missing finalized tool result");
  const message = agent.state.messages.find(entry => entry.role === "toolResult");
  return { completed, message, requests, original: result };
}

describe("Pi native tool outcomes through the Hana adapter", () => {
  it.each(["success", "implicit-success"] as const)("preserves %s and structured data through a native no-op hook", async mode => {
    const hook = vi.fn<NonNullable<AgentOptions["afterToolCall"]>>(async () => undefined);
    const { completed, message, requests, original } = await runTool(hook, mode);
    expect(hook.mock.calls[0][0]).toMatchObject({ isError: false, result: original });
    expect(completed.isError).toBe(false);
    expect(completed.result).toEqual(original);
    expect(message).toMatchObject({ isError: false, content: original.content, details: original.details });
    expect(requests[1].messages.find(entry => entry.role === "toolResult")).toMatchObject({ isError: false });
  });

  it("respects an extension marking a successful result as failure without replacing structured data", async () => {
    const { completed, message, original } = await runTool(async () => ({ isError: true }), "success");
    expect(completed.isError).toBe(true);
    expect(completed.result.structuredContent).toEqual(original.structuredContent);
    expect(message).toMatchObject({ isError: true });
  });

  it("reports a thrown tool error through the native hook, finalized event and provider context", async () => {
    const hook = vi.fn<NonNullable<AgentOptions["afterToolCall"]>>(async () => undefined);
    const { completed, message, requests } = await runTool(hook, "throw");
    const errorContent = [{ type: "text", text: "synthetic tool failure" }];
    expect(hook.mock.calls[0][0]).toMatchObject({ isError: true, result: { content: errorContent, details: {} } });
    expect(completed).toMatchObject({ isError: true, result: { content: errorContent, details: {} } });
    expect(completed.result).not.toHaveProperty("structuredContent");
    expect(message).toMatchObject({ isError: true, content: errorContent });
    expect(requests[1].messages.find(entry => entry.role === "toolResult")).toMatchObject({ isError: true });
  });

  it("reports a thrown extension hook without leaking the successful tool's structured data", async () => {
    const { completed, message } = await runTool(async () => { throw new Error("synthetic hook failure"); }, "success");
    const errorContent = [{ type: "text", text: "synthetic hook failure" }];
    expect(completed).toMatchObject({ isError: true, result: { content: errorContent, details: {} } });
    expect(completed.result).not.toHaveProperty("structuredContent");
    expect(message).toMatchObject({ isError: true, content: errorContent });
  });

  it("allows an extension to recover a thrown tool with matching replacement data", async () => {
    const patch = { isError: false, content: [{ type: "text" as const, text: "recovered" }],
      details: { recovered: true }, structuredContent: { recovered: true } };
    const { completed, message } = await runTool(async () => patch, "throw");
    expect(completed).toMatchObject({ isError: false, result: {
      content: patch.content, details: patch.details, structuredContent: patch.structuredContent,
    } });
    expect(message).toMatchObject({ isError: false, content: patch.content, details: patch.details });
  });

  it.each(["absent", "no-op"])("keeps structured failure data with the hook %s", async mode => {
    const hook = mode === "no-op" ? vi.fn(async () => undefined) : undefined;
    const { completed, message, original } = await runTool(hook);
    expect(completed.isError).toBe(true);
    expect(completed.result).toMatchObject(original);
    expect(message).toMatchObject({ role: "toolResult", isError: true, content: original.content, details: original.details });
    // Structured results belong to the finalized event, not canonical LLM messages.
    expect(message).not.toHaveProperty("structuredContent");
    if (hook) expect(hook).toHaveBeenCalledWith(expect.objectContaining({ isError: true, result: original }), expect.any(AbortSignal));
  });

  it("keeps structured data and usage when a hook changes only details", async () => {
    const { completed, original } = await runTool(async () => ({ details: { origin: "extension" } }));
    expect(completed.isError).toBe(true);
    expect(completed.result).toMatchObject({ details: { origin: "extension" }, structuredContent: original.structuredContent, usage });
  });

  it("respects an extension's explicit recovery", async () => {
    const hook = vi.fn<NonNullable<AgentOptions["afterToolCall"]>>(async () => ({ isError: false, details: { recovered: true } }));
    const { completed, message, original } = await runTool(hook);
    expect(hook.mock.calls[0][0].isError).toBe(true);
    expect(completed.isError).toBe(false);
    expect(completed.result.structuredContent).toEqual(original.structuredContent);
    expect(message).toMatchObject({ isError: false, details: { recovered: true } });
  });

  it("drops stale structured data when an extension replaces content", async () => {
    const content = [{ type: "text" as const, text: "different result" }];
    const { completed } = await runTool(async () => ({ content }));
    expect(completed.result.content).toEqual(content);
    expect(completed.result.structuredContent).toBeUndefined();
  });

  it("uses matching new structured data supplied with replacement content", async () => {
    const patch = { content: [{ type: "text" as const, text: "replacement" }], structuredContent: { replacement: true } };
    const { completed } = await runTool(async () => patch);
    expect(completed.result).toMatchObject(patch);
  });

  it("keeps native usage and termination overrides", async () => {
    const replacedUsage = { ...usage, input: 10, totalTokens: 12 };
    const { completed, requests } = await runTool(async () => ({ usage: replacedUsage, terminate: true }));
    expect(completed.result).toMatchObject({ usage: replacedUsage, terminate: true, structuredContent: { ok: false } });
    expect(requests).toHaveLength(1);
  });

  it("installs legacy projection once without changing native hooks or stored history", async () => {
    const stored = [
      { role: "toolResult", isError: false, content: [{ type: "text", text: "denied" }], details: { errorCode: "TOOL_DENIED" } },
      { role: "toolResult", isError: false, content: [{ type: "text", text: "ok" }], details: { error: "warning" } },
    ];
    const previousTransform = vi.fn(async () => stored);
    const hook = vi.fn();
    const agent = { afterToolCall: hook, transformContext: previousTransform };
    installToolOutcomeAdapter({ agent });
    const installed = agent.transformContext;
    installToolOutcomeAdapter({ agent });
    expect(agent.transformContext).toBe(installed);
    expect(agent.afterToolCall).toBe(hook);
    const projected = await agent.transformContext();
    expect(previousTransform).toHaveBeenCalledTimes(1);
    expect(projected[0].isError).toBe(true);
    expect(projected[1]).toBe(stored[1]);
    expect(stored[0].isError).toBe(false);
  });
});
