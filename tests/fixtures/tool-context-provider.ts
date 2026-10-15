import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as mistral } from "@earendil-works/pi-ai/api/mistral-conversations";
import { stream as bedrock } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

export const providers = { "openai-completions": completions, "openai-responses": responses,
  "anthropic-messages": anthropic, "mistral-conversations": mistral, "bedrock-converse-stream": bedrock };

// One valid parent invocation through each installed provider. Only transport is
// synthetic; parsing, schema validation, scheduling and nested dispatch are real.
export function events(api: string, name: string) {
  const id = "parent001", raw = "{}";
  if (api === "openai-responses") {
    const item = { type: "function_call", id: "fc_parent", call_id: id, name, arguments: "" };
    return [
      { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: raw },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: raw },
      { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: raw, status: "completed" } },
      { type: "response.completed", response: { id: "resp_fixture", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
  }
  if (api === "anthropic-messages") return [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model: "fixture", usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  if (api === "bedrock-converse-stream") return [
    { messageStart: { role: "assistant" } },
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: id, name } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: raw } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "tool_use" } },
  ];
  return [
    { id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0,
      delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: raw } }] }, finish_reason: null }] },
    { id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

export function transport(api: string, name: string) {
  const body = events(api, name).map(event => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export function finished(model): ReturnType<typeof createAssistantMessageEventStream> {
  const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "done" }],
    api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}
