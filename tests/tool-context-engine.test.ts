import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
interface ContextObservation {
  scenario: string;
  api: string;
  parentName: string;
  parentEnd: { toolCallId: string };
  childStart: { toolCallId: string; parentToolCallId: string };
  nested: { toolCall: { id: string }; result: { content: Array<{ type: string; text: string }> } };
  hooks: Array<{ type: string; name: string; isError?: boolean }>;
  signals: { parentAborted: boolean; contextAborted: boolean };
}
let observed: { rows: ContextObservation[]; network: number; computerHost: null };
beforeAll(async () => {
  // A subprocess keeps real HanaEngine initialization and provider transport
  // mocks isolated from other suites. It uses temporary configuration only.
  const { stdout } = await promisify(execFile)(process.execPath, ["tests/fixtures/tool-context-engine.mjs"], {
    cwd: root, timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
  });
  const result = stdout.split("\n").find(line => line.startsWith("CONTEXT_RESULTS "));
  expect(result, stdout).toBeDefined();
  observed = JSON.parse(result.slice("CONTEXT_RESULTS ".length));
}, 50_000);

function row(scenario, api = "openai-completions", parentName = "fixture_parent") {
  const result = observed.rows.find(r => r.scenario === scenario && r.api === api && r.parentName === parentName);
  expect(result).toBeDefined();
  return result;
}

function expectSuccess(result: ContextObservation) {
  expect(result).toMatchObject({ parentCount: 1, childCount: 1, requests: 2, executeToolType: "function",
    descriptors: { executeEnumerable: false, toolsGetter: "function", modelGetter: "function" },
    sessionBound: true, signals: { parent: true, child: true, defaultShared: true, parentAborted: false, contextAborted: false },
    approvals: 1, staleTools: true, staleModel: true, staleExecute: true });
  const parentId = result.parentEnd.toolCallId, childId = result.nested.toolCall.id;
  expect(childId).toBe(`${parentId}/1`);
  expect(result.childStart).toMatchObject({ toolCallId: childId, parentToolCallId: parentId, toolName: "fixture_child" });
  expect(result.nested).toMatchObject({ isError: false, toolCall: { name: "fixture_child", arguments: { value: 7 } },
    result: { content: [{ type: "text", text: "child:7" }], details: { value: 7 } } });
  expect(result.parentEnd).toMatchObject({ isError: false, result: result.nested.result });
  expect(result.hooks).toEqual([
    { type: "tool_call", name: result.parentName, id: parentId },
    { type: "tool_call", name: "fixture_child", id: childId, parent: parentId },
    { type: "tool_result", name: "fixture_child", id: childId, parent: parentId, isError: false },
    { type: "tool_result", name: result.parentName, id: parentId, isError: false },
  ]);
}

describe("HanaEngine nested tool context", () => {
  it.each(["openai-completions", "openai-responses", "anthropic-messages", "mistral-conversations", "bedrock-converse-stream"])(
    "executes one parent and child with IDs, signals, results and hooks via %s", api => {
      expectSuccess(row("success", api));
    });

  it.each(["fixture_dynamic_parent", "fixture_file_parent"])("preserves the context through %s", parentName => {
    expectSuccess(row("success", "openai-completions", parentName));
  });

  it.each([
    ["deny", "TOOL_APPROVAL_DENIED", 1],
    ["read-only", "ACTION_BLOCKED_BY_READ_ONLY", 0],
    ["approval-drift", "TOOL_INVOCATION_CHANGED_BEFORE_EXECUTION", 1],
  ])("executes no child on %s", (scenario, errorCode, approvals) => {
    const result = row(scenario);
    expect(result).toMatchObject({ parentCount: 1, childCount: 0, approvals,
      nested: { isError: true, result: { details: { errorCode } } }, parentEnd: { isError: true } });
    expect(result.hooks.find(h => h.type === "tool_result" && h.name === "fixture_child")).toMatchObject({ isError: true });
  });

  it.each([
    ["scope", "story_tool_disabled"], ["cancel", "Operation aborted"], ["hook-block", "synthetic hook denial"],
  ])("executes no child on %s", (scenario, message) => {
    const result = row(scenario);
    expect(result).toMatchObject({ parentCount: 1, childCount: 0, approvals: 0, nested: { isError: true } });
    expect(result.nested.result.content[0].text).toContain(message);
    if (scenario === "cancel") expect(result.signals).toMatchObject({ parentAborted: true, contextAborted: true });
  });

  it("propagates child failures through parent results and both hooks", () => {
    const result = row("child-error");
    expect(result).toMatchObject({ parentCount: 1, childCount: 1, nested: { isError: true }, parentEnd: { isError: true } });
    expect(result.nested.result.content[0].text).toBe("synthetic child error");
    expect(result.hooks.filter(h => h.type === "tool_result").map(h => h.isError)).toEqual([true, true]);
  });

  it("does not call external services or initialize computer use", () => {
    expect(observed).toMatchObject({ network: 0, computerHost: null });
    expect(observed.rows).toHaveLength(14);
  });
});
