import {
  convertToLlm as defaultConvertToLlm,
  serializeConversation as defaultSerializeConversation,
} from "@earendil-works/pi-coding-agent";
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

/**
 * Pi 1.4 omits the summary request's explicit cap. The shared simple-provider
 * layer still defaults to the model output limit and reserves context room.
 * Keep this planning value separate from the options sent to the stream.
 * Invalid model declarations are errors: a NaN budget must never silently
 * choose destructive hard truncation.
 */
export function estimateDefaultCompactionOutputTokens(
  model: Pick<Model<Api>, "maxTokens"> & { contextWindow?: number; api?: string },
  messages: Message[],
  systemPrompt = "",
  tools: Tool[] = [],
) {
  const maxTokens = Number(model?.maxTokens);
  const contextWindow = Number(model?.contextWindow ?? 0);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || !Number.isFinite(contextWindow)) {
    throw new Error("Compaction output estimation requires a finite positive model.maxTokens and finite contextWindow");
  }
  const outputTokens = clampMaxTokensToContext(
    { ...model, maxTokens, contextWindow } as Model<Api>,
    normalizeContext({ systemPrompt, messages, tools }),
    maxTokens,
  );
  return model?.api === "openai-responses" || model?.api === "azure-openai-responses"
    ? Math.max(16, outputTokens)
    : outputTokens;
}

function requestMessage(promptText: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text: promptText }],
    timestamp: Date.now(),
  };
}

function serializeNativeConversation(messages: any[], convertToLlm, serializeConversation) {
  return serializeConversation(convertToLlm(messages));
}

export function buildNativeCompactionRequestShapes({
  preparation,
  model,
  customInstructions,
  convertToLlm = defaultConvertToLlm,
  serializeConversation = defaultSerializeConversation,
}: {
  preparation?: any;
  model?: any;
  customInstructions?: any;
  convertToLlm?: (messages: any[]) => any[];
  serializeConversation?: (messages: any[]) => string;
} = {}) {
  const messagesToSummarize = Array.isArray(preparation?.messagesToSummarize)
    ? preparation.messagesToSummarize
    : [];
  const turnPrefixMessages = Array.isArray(preparation?.turnPrefixMessages)
    ? preparation.turnPrefixMessages
    : [];
  const requests: any[] = [];

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
      outputBudgetTokens: model ? estimateDefaultCompactionOutputTokens(model, [requestMessage(promptText)], NATIVE_SUMMARIZATION_SYSTEM_PROMPT) : undefined,
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
      outputBudgetTokens: model ? estimateDefaultCompactionOutputTokens(model, [requestMessage(promptText)], NATIVE_SUMMARIZATION_SYSTEM_PROMPT) : undefined,
    });
  }

  return { requests };
}
