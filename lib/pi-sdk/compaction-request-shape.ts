import {
  convertToLlm as defaultConvertToLlm,
  serializeConversation as defaultSerializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Api, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";

export const NATIVE_SUMMARIZATION_SYSTEM_PROMPT =
  `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

export class CompactionBudgetSafetyError extends Error {
  readonly code = "COMPACTION_BUDGET_UNPROVEN";

  constructor(message: string) {
    super(message);
    this.name = "CompactionBudgetSafetyError";
  }
}

export type CompactionBudgetModel = Pick<Model<Api>, "maxTokens"> & {
  contextWindow?: number;
  api?: string;
  provider?: string;
  baseUrl?: string;
  compat?: { supportsMaxOutputTokens?: boolean; outputCapRequired?: boolean };
};
export type CompactionOutputBudget = {
  outputBudgetTokens: number;
  outputBudgetSource: "wire-cap" | "model-limit";
};
export type NativeCompactionPreparation = {
  messagesToSummarize?: AgentMessage[];
  turnPrefixMessages?: AgentMessage[];
  previousSummary?: string;
  isSplitTurn?: boolean;
  settings?: { reserveTokens?: number; keepRecentTokens?: number };
};
export type CompactionBudgetMessage = Message;
export type CompactionBudgetTool = Tool;

// Reviewed Pi 1.4 simple providers serialize the context-clamped default.
// Forwarding pi-messages and registered custom APIs do not share that contract.
const CAPPED_APIS = new Set([
  "openai-completions", "azure-openai-responses", "anthropic-messages",
  "google-generative-ai", "google-vertex", "bedrock-converse-stream", "mistral-conversations",
]);

/** Budget the final serializer contract, never just buildBaseOptions' clamp. */
export function estimateDefaultCompactionOutputBudget(
  model: CompactionBudgetModel,
  messages: Message[],
  systemPrompt = "",
  tools: Tool[] = [],
): CompactionOutputBudget {
  const maxTokens = Number(model?.maxTokens);
  const contextWindow = Number(model?.contextWindow ?? 0);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || !Number.isFinite(contextWindow)) {
    throw new CompactionBudgetSafetyError("Compaction output estimation requires a finite positive model.maxTokens and finite contextWindow");
  }
  const responsesMayOmitCap = model.api === "openai-responses" && (
    model.compat?.supportsMaxOutputTokens === false
    // Pi selects ChatGPT sign-in by credential here. Planning must cover both
    // auth modes without inspecting secrets or claiming a cap will survive.
    || (model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1")
  );
  if (!CAPPED_APIS.has(model.api) && model.api !== "openai-responses" && model.api !== "openai-codex-responses") {
    throw new CompactionBudgetSafetyError(`Compaction output estimation has no reviewed wire bound for API ${String(model.api)}`);
  }
  let outputTokens: number;
  try {
    outputTokens = clampMaxTokensToContext(
      { ...model, maxTokens, contextWindow } as Model<Api>,
      normalizeContext({ systemPrompt, messages, tools }),
      maxTokens,
    );
  } catch {
    throw new CompactionBudgetSafetyError("Compaction output estimation requires valid provider messages and assistant usage");
  }
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) {
    throw new CompactionBudgetSafetyError("Compaction output estimation produced a non-finite or non-positive budget");
  }
  // Omitted-cap simple providers still run buildBaseOptions. Validate their
  // context/usage through the shared SDK path before selecting a budget;
  // the resulting clamp does not replace the model-limit planning bound.
  if (responsesMayOmitCap || model.api === "openai-codex-responses") {
    return { outputBudgetTokens: maxTokens, outputBudgetSource: "model-limit" };
  }
  return {
    outputBudgetTokens: model.api === "openai-responses" || model.api === "azure-openai-responses"
      ? Math.max(16, outputTokens)
      : outputTokens,
    outputBudgetSource: "wire-cap",
  };
}

export function estimateDefaultCompactionOutputTokens(
  ...args: Parameters<typeof estimateDefaultCompactionOutputBudget>
) {
  return estimateDefaultCompactionOutputBudget(...args).outputBudgetTokens;
}

function requestMessage(promptText: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text: promptText }],
    timestamp: Date.now(),
  };
}

function serializeNativeConversation(messages: AgentMessage[], convertToLlm, serializeConversation) {
  return serializeConversation(convertToLlm(messages));
}

export function buildNativeCompactionRequestShapes({
  preparation,
  model,
  customInstructions,
  convertToLlm = defaultConvertToLlm,
  serializeConversation = defaultSerializeConversation,
}: {
  preparation?: NativeCompactionPreparation;
  model?: CompactionBudgetModel;
  customInstructions?: string;
  convertToLlm?: (messages: AgentMessage[]) => Message[];
  serializeConversation?: (messages: Message[]) => string;
} = {}) {
  const messagesToSummarize = Array.isArray(preparation?.messagesToSummarize)
    ? preparation.messagesToSummarize
    : [];
  const turnPrefixMessages = Array.isArray(preparation?.turnPrefixMessages)
    ? preparation.turnPrefixMessages
    : [];
  const requests: Array<{
    kind: "history" | "turn-prefix";
    systemPrompt: string;
    promptText: string;
    messages: Message[];
    maxTokens: undefined;
    outputBudgetTokens?: number;
    outputBudgetSource?: CompactionOutputBudget["outputBudgetSource"];
  }> = [];

  if (!preparation?.isSplitTurn || messagesToSummarize.length > 0) {
    const conversationText = serializeNativeConversation(
      messagesToSummarize,
      convertToLlm,
      serializeConversation,
    );
    let basePrompt = preparation?.previousSummary
      ? UPDATE_SUMMARIZATION_PROMPT
      : SUMMARIZATION_PROMPT;
    if (customInstructions) {
      basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
    }
    let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
    if (preparation?.previousSummary) {
      promptText += `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n`;
    }
    promptText += basePrompt;
    requests.push({
      kind: "history",
      systemPrompt: NATIVE_SUMMARIZATION_SYSTEM_PROMPT,
      promptText,
      messages: [requestMessage(promptText)],
      maxTokens: undefined,
      ...(model ? estimateDefaultCompactionOutputBudget(model, [requestMessage(promptText)], NATIVE_SUMMARIZATION_SYSTEM_PROMPT) : {}),
    });
  }

  if (preparation?.isSplitTurn) {
    const conversationText = serializeNativeConversation(
      turnPrefixMessages,
      convertToLlm,
      serializeConversation,
    );
    let promptText =
      `# Conversation\n${conversationText}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
    if (customInstructions) {
      promptText = `${promptText}\n\nAdditional focus: ${customInstructions}`;
    }
    requests.push({
      kind: "turn-prefix",
      systemPrompt: NATIVE_SUMMARIZATION_SYSTEM_PROMPT,
      promptText,
      messages: [requestMessage(promptText)],
      maxTokens: undefined,
      ...(model ? estimateDefaultCompactionOutputBudget(model, [requestMessage(promptText)], NATIVE_SUMMARIZATION_SYSTEM_PROMPT) : {}),
    });
  }

  return { requests };
}
